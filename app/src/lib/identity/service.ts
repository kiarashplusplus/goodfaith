/**
 * The identity issuer: runs the provider check, keeps the person registry, issues gateway tokens on the fund's
 * network, and prepares the on-chain join (or wallet recovery) with the issuer's signature. The wallet adds
 * its own signature in the browser; the fee sponsor pays when it is configured.
 *
 * A person is an opaque random id. The keyed fingerprints of their ID credentials stay in the store so the same
 * human resolves to the same person on a later check (and a renewed or second document can be linked to the same
 * person); nothing derived from a credential reaches the chain. Duplicate detection reduces abuse, it does not
 * prove uniqueness: a person with two unlinked credentials can hold two memberships until they are found.
 */
import { randomBytes } from "node:crypto";
import {
  type Address,
  type KeyPairSigner,
  type Rpc,
  type GetAccountInfoApi,
  type GetLatestBlockhashApi,
  type SendTransactionApi,
  type SimulateTransactionApi,
  type GetSignatureStatusesApi,
  partiallySignTransaction,
} from "@solana/kit";
import {
  eligibleAt,
  fetchCanonicalPool,
  fetchMember,
  fetchPerson,
  finalizeRebindIx,
  findPersonPda,
  proposeRebindIx,
  registerMemberIx,
  type Person,
  type Pool,
} from "../program";
import { buildTransaction, toBase64 } from "../tx";
import type { IdentityProvider, HeaderBag, VerifiedFields } from "./provider";
import type { Notifier, NotifyKind } from "./notify";
import {
  PERMANENT_UNTIL,
  type IdentityStore,
  type PersonRecord,
  type RecoveryClosedAs,
  type RecoveryRecord,
  type WalletRecord,
} from "./store";
import type { PassView, TokenIssuer } from "./gatekeeper";
import { ageAt, fromHex, HashKeyring, toHex } from "./person-hash";
import { gatewayTokenAddress } from "../gateway";

export type ServiceRpc = Rpc<
  GetAccountInfoApi & GetLatestBlockhashApi & SendTransactionApi & SimulateTransactionApi & GetSignatureStatusesApi
>;

export type ServiceDeps = {
  provider: IdentityProvider;
  store: IdentityStore;
  /** Issues gateway tokens; null in unit tests that only exercise the registry. */
  gatekeeper: TokenIssuer | null;
  issuer: KeyPairSigner;
  rpc: ServiceRpc;
  /** Current and previous fingerprint keys. */
  keyring: HashKeyring;
  /** Fee payer for prepared transactions, or null to let the wallet pay. */
  feePayer?: () => Promise<Address | null>;
  /** Token validity, seconds (default one year). */
  tokenTtlSec?: number;
  /** Where notices go (recovery requests, bars); the server log when absent. */
  notifier?: Notifier;
  /** A recovery request must be at least this old before the operator may propose it (default one day). */
  recoveryMinAgeSec?: number;
  /** A pass may be renewed once it expires within this window (default 30 days). */
  renewWindowSec?: number;
  requiredState?: string;
  minAge?: number;
  now?: () => number;
};

export type StatusView = {
  /** "none" before any check; otherwise the wallet record's status. */
  status: WalletRecord["status"] | "none";
  /** Why a check ended as it did, or why a member wallet is blocked. A check's reason is a detail (below). */
  reason?: string;
  /** The provider's one-time link for a pending check. A detail. */
  url?: string;
  /**
   * True when this view leaves details out: anyone can ask for a wallet's status, so the check's reason (which can
   * say a person's age or state) and the pending check's link are only in the view the wallet itself signs for.
   */
  detailsHidden?: boolean;
  /** The person behind the approved check, as the chain sees it. */
  person: null | {
    onChain: boolean;
    currentWallet: Address | null;
    isThisWallet: boolean;
    ineligible: boolean;
    /** Unix seconds until which the person is barred on chain (0 none; a very large value means for good). */
    barredUntil: number;
    /** A recovery in flight: the wallet it moves to and when (unix seconds) it may be finalised. */
    pendingWallet: Address | null;
    pendingWalletAt: number;
    /** A recovery request for this wallet waiting for the operator: when (unix seconds) it was opened. */
    requestedAt: number | null;
  };
  /** This wallet's on-chain membership. */
  member: null | { retired: boolean };
  /** The wallet's pass: when it expires (unix seconds, null when it never does) and whether it is usable. */
  pass: null | { expiresAt: number | null; state: "active" | "frozen" | "revoked" };
  /**
   * What the wallet can do now. `recover` asks to move the membership here; `review` means that request waits for
   * the operator; `pending` means the on-chain proposal is in its veto window; `finalize` completes it; `renew`
   * means the member's pass expires soon (or has expired) and can be renewed.
   */
  next: "verify" | "wait" | "join" | "recover" | "review" | "pending" | "finalize" | "done" | "blocked" | "renew";
};

export type PreparedTx = { transaction: string; feePayer: Address; sponsored: boolean; kind: "register" | "propose" | "finalize" };
/** A recovery request recorded for the operator's review. */
export type RecoveryReview = { kind: "review"; requestedAt: number };
/** What the operator sees about a recovery request: the chain's view of the person next to the request. */
export type RecoveryView = {
  personId: string;
  newWallet: Address;
  /** The new wallet's verification, so the operator can look it up at the provider directly. */
  inquiryId: string | null;
  requestedAt: number;
  hasContact: boolean;
  /** Whether the notice about the request reached the configured channel (null: nothing to notify, or not yet). */
  delivery: "sent" | "failed" | null;
  /** When the operator's proposal went on chain (unix seconds; 0 when not yet). */
  proposedAt: number;
  onChain: boolean;
  currentWallet: Address | null;
  pendingWallet: Address | null;
  pendingWalletAt: number;
  barredUntil: number;
};

/** What one reconciliation pass did. */
export type ReconcileReport = {
  /** Bars set or extended from the chain's list. */
  barred: number;
  /** Stored bars the chain no longer has. */
  lifted: number;
  /** Recovery requests closed because the chain finalised or vetoed them. */
  recoveriesClosed: { personId: string; as: RecoveryClosedAs }[];
  /** Request notices sent again after a failed delivery. */
  noticesRetried: number;
};

export class IdentityError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const when = (unixSec: bigint | number) => new Date(Number(unixSec) * 1000).toUTCString();
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address;

export class IdentityService {
  private readonly now: () => number;
  constructor(private readonly d: ServiceDeps) {
    this.now = d.now ?? Date.now;
  }

  get issuerAddress(): Address {
    return this.d.issuer.address;
  }

  private nowSec(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  /** The chain's clock for comparisons with on-chain deadlines (it is what the program checks); wall clock as a fallback. */
  private async chainNow(): Promise<bigint> {
    try {
      const r = await this.d.rpc.getAccountInfo(CLOCK_SYSVAR, { encoding: "base64" }).send();
      const data = r.value?.data?.[0];
      if (data) return Buffer.from(data, "base64").readBigInt64LE(32);
    } catch {
      // no clock available (unit tests); fall through
    }
    return this.nowSec();
  }

  /** Permanent, temporary or no bar, as the store knows it (the chain is authoritative for lending). */
  private barOf(person: PersonRecord | null | undefined): "none" | "temporary" | "permanent" {
    if (!person?.bannedUntil) return "none";
    if (person.bannedUntil >= PERMANENT_UNTIL) return "permanent";
    return Number(this.nowSec()) < person.bannedUntil ? "temporary" : "none";
  }

  /**
   * Sends a notice to the person's contact on file (and to `extra.also`, when it differs). Returns whether the
   * channel took it; true as well when there is no channel or no contact, since nothing was lost in that case.
   */
  private async notify(
    kind: NotifyKind,
    personId: string,
    detail: string,
    extra: { wallet?: Address; data?: Record<string, string | number>; also?: string; contact?: string } = {},
  ): Promise<boolean> {
    if (!this.d.notifier) return true;
    const person = await this.d.store.getPerson(personId);
    const contact = extra.contact ?? person?.contact;
    const targets: (string | undefined)[] = [contact];
    if (extra.also && extra.also !== contact) targets.push(extra.also);
    let ok = true;
    for (const to of targets) {
      const sent = await this.d.notifier.send({
        kind,
        personId,
        wallet: extra.wallet,
        contact: to,
        at: this.now(),
        detail,
        data: extra.data,
      });
      if (to && !sent) ok = false;
    }
    return ok;
  }

  private minAgeSec(): number {
    return this.d.recoveryMinAgeSec ?? 86_400;
  }

  /** Starts (or resumes) the hosted identity check for a wallet; `contact` is where notices may go. */
  async start(wallet: Address, contact?: string): Promise<{ inquiryId: string; url: string; status: WalletRecord["status"] }> {
    const existing = await this.d.store.getWallet(wallet);
    if (existing?.status === "issued") throw new IdentityError(409, "This wallet is already verified.");
    if (existing?.status === "pending" && existing.url) return { inquiryId: existing.inquiryId, url: existing.url, status: "pending" };
    if (existing?.status === "review") throw new IdentityError(409, "Your check is being reviewed. Please wait.");
    return this.open(wallet, existing ? { ...existing, contact: contact ?? existing.contact } : existing, undefined, contact);
  }

  /**
   * A verified wallet re-checks to attach another credential (a renewed or second document) to its person. The
   * wallet keeps its pass meanwhile; the outcome only adds a fingerprint or refuses.
   */
  async startLink(wallet: Address): Promise<{ inquiryId: string; url: string; status: WalletRecord["status"] }> {
    const existing = await this.d.store.getWallet(wallet);
    if (!existing?.personId) throw new IdentityError(409, "Verify your identity first.");
    if (existing.status === "pending" && existing.linkTo && existing.url)
      return { inquiryId: existing.inquiryId, url: existing.url, status: "pending" };
    if (existing.status !== "issued") throw new IdentityError(409, "This wallet is not in good standing.");
    const person = await this.d.store.getPerson(existing.personId);
    if (!person || this.barOf(person) === "permanent") throw new IdentityError(403, "This person can no longer use Good Faith.");
    return this.open(wallet, existing, existing.personId);
  }

  private async open(wallet: Address, existing: WalletRecord | null, linkTo: string | undefined, contact?: string) {
    const { inquiryId, url } = await this.d.provider.createInquiry(wallet);
    const t = this.now();
    await this.d.store.putWallet({
      ...(existing ?? { createdAt: t }),
      wallet,
      inquiryId,
      url,
      status: "pending",
      linkTo,
      reason: undefined,
      contact: contact ?? existing?.contact,
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
    });
    return { inquiryId, url, status: "pending" as const };
  }

  /** A provider webhook. Returns what happened, for logs; the HTTP answer is 200 whenever the signature is good. */
  async handleWebhook(
    headers: HeaderBag,
    rawBody: string,
  ): Promise<"bad_signature" | "ignored" | "duplicate" | "unknown_inquiry" | WalletRecord["status"]> {
    if (!this.d.provider.verifyWebhook(headers, rawBody, Math.floor(this.now() / 1000))) return "bad_signature";
    const ev = this.d.provider.parseEvent(rawBody);
    if (!ev) return "ignored";
    if (!(await this.d.store.firstTime(ev.eventId))) return "duplicate";
    const rec = (await this.d.store.getByInquiry(ev.inquiryId)) ?? (ev.referenceId ? await this.d.store.getWallet(ev.referenceId) : null);
    if (!rec || rec.inquiryId !== ev.inquiryId) return "unknown_inquiry";
    if (rec.status === "issued") return "issued"; // never downgrade a finished wallet from a late event
    switch (ev.outcome) {
      case "pending":
        return rec.status;
      case "needs_review":
        return this.update(rec, { status: "review", reason: "Your check needs a closer look." });
      case "declined":
        return rec.linkTo
          ? this.update(rec, { status: "issued", linkTo: undefined, reason: "The additional document was not approved." })
          : this.update(rec, { status: "declined", reason: "The identity check was not approved." });
      case "approved":
        return this.approve(rec);
    }
  }

  private async update(rec: WalletRecord, patch: Partial<WalletRecord>): Promise<WalletRecord["status"]> {
    const next = { ...rec, ...patch, updatedAt: this.now() };
    await this.d.store.putWallet(next);
    return next.status;
  }

  /** The person a set of verified fields resolves to, re-linking under the current key after a rotation. */
  private async resolve(fields: VerifiedFields): Promise<{ personId: string; hash: string; version: number; known: boolean }> {
    const prints = this.d.keyring.fingerprints(fields);
    const current = prints[0]!;
    for (const p of prints) {
      const cred = await this.d.store.getCredential(p.hash);
      if (!cred) continue;
      if (p.version !== current.version) {
        await this.d.store.putCredential({
          hash: current.hash,
          keyVersion: current.version,
          personId: cred.personId,
          linkedAt: this.now(),
          via: "rotate",
        });
      }
      return { personId: cred.personId, hash: current.hash, version: current.version, known: true };
    }
    return { personId: toHex(randomBytes(32)), hash: current.hash, version: current.version, known: false };
  }

  private async approve(rec: WalletRecord): Promise<WalletRecord["status"]> {
    let fields: VerifiedFields | null;
    try {
      fields = await this.d.provider.fetchVerified(rec.inquiryId);
    } catch {
      return this.update(rec, { status: "error", reason: "Could not read the result of your check. Please try again." });
    }
    if (!fields)
      return this.update(rec, { status: "error", reason: "The check was approved but its details were missing. Please try again." });
    const state = fields.issuingState.trim().toUpperCase();
    if (state !== (this.d.requiredState ?? "TX"))
      return this.update(rec, { status: "ineligible", reason: "Good Faith is for Texas residents only." });
    if (ageAt(fields.birthdate, new Date(this.now())) < (this.d.minAge ?? 18))
      return this.update(rec, { status: "ineligible", reason: "You must be 18 or older." });
    const found = await this.resolve(fields);
    if (rec.linkTo) return this.link(rec, found);
    const person = found.known ? await this.d.store.getPerson(found.personId) : null;
    // A permanent bar refuses the person on any wallet. A temporary one does not: the chain refuses their loans and
    // guarantees anyway, and a pass lets them recover a lost wallet and collect what they are owed meanwhile.
    if (this.barOf(person) === "permanent")
      return this.update(rec, { status: "ineligible", personId: found.personId, reason: "This person can no longer use Good Faith." });
    if (rec.personId && rec.personId !== found.personId)
      return this.update(rec, { status: "ineligible", reason: "This wallet already belongs to another verified person." });
    let tokenAddress: string | undefined;
    if (this.d.gatekeeper) {
      try {
        tokenAddress = await this.d.gatekeeper.issue(
          rec.wallet as Address,
          Math.floor(this.now() / 1000) + (this.d.tokenTtlSec ?? 365 * 86_400),
        );
      } catch (e) {
        return this.update(rec, {
          status: "error",
          personId: found.known ? found.personId : undefined,
          reason: `Could not issue your pass: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    if (!found.known) {
      await this.d.store.putPerson({ personId: found.personId, wallet: rec.wallet, contact: rec.contact, createdAt: this.now() });
      await this.d.store.putCredential({
        hash: found.hash,
        keyVersion: found.version,
        personId: found.personId,
        linkedAt: this.now(),
        via: "verify",
      });
    } else if (person && rec.contact && !person.contact) {
      // A contact given at a later wallet's check fills an empty slot only: a stranger verifying from a new wallet
      // must never replace where the real member's notices go (see `setContact`).
      await this.d.store.putPerson({ ...person, contact: rec.contact });
    }
    return this.update(rec, { status: "issued", personId: found.personId, tokenAddress, reason: undefined, url: undefined });
  }

  /**
   * Changes where a member's notices go. Only the person's current on-chain wallet may (the route checks its
   * signature); the previous contact hears about the change, so a takeover of the wallet cannot silently redirect
   * the notices that protect it.
   */
  async setContact(wallet: Address, contact: string | undefined): Promise<{ changed: boolean }> {
    const rec = await this.d.store.getWallet(wallet);
    if (!rec?.personId || rec.status !== "issued") throw new IdentityError(409, "Verify your identity first.");
    const person = await this.d.store.getPerson(rec.personId);
    if (!person) throw new IdentityError(409, "Verify your identity first.");
    const pool = await this.pool();
    if (pool) {
      const [pda] = await findPersonPda(pool.address, fromHex(rec.personId));
      const onChain = await fetchPerson(this.d.rpc, pda);
      if (onChain && onChain.wallet !== wallet) throw new IdentityError(403, "Only the wallet linked to the membership can change this.");
    }
    if ((person.contact ?? undefined) === (contact ?? undefined)) return { changed: false };
    const previous = person.contact;
    await this.d.store.putPerson({ ...person, contact });
    await this.update(rec, { contact });
    // Older wallet records of the person may still hold the previous email (a wallet keeps the contact it had):
    // replace those copies so a removed or changed email does not linger. A contact given on another wallet's own
    // check is that wallet's, and a wallet asking to recover the membership keeps its own: both stay as they are.
    if (previous) {
      const open = await this.d.store.getRecovery(rec.personId);
      const requester = open && !open.closedAs ? open.newWallet : null;
      for (const w of await this.d.store.walletsOf(rec.personId)) {
        if (w === wallet || w === requester) continue;
        const r = await this.d.store.getWallet(w as Address);
        if (r && r.contact === previous) await this.update(r, { contact });
      }
    }
    if (previous)
      await this.notify("contact_changed", rec.personId, "The contact for your Good Faith notices was changed from this wallet.", {
        wallet,
        contact: previous,
        data: { to: contact ?? "" },
      });
    return { changed: true };
  }

  /** The outcome of a linking check: the new credential joins the wallet's person unless it belongs to someone else. */
  private async link(rec: WalletRecord, found: Awaited<ReturnType<IdentityService["resolve"]>>): Promise<WalletRecord["status"]> {
    const personId = rec.linkTo!;
    if (found.known && found.personId !== personId)
      return this.update(rec, {
        status: "issued",
        linkTo: undefined,
        url: undefined,
        reason: "That document already belongs to another membership.",
      });
    if (!found.known)
      await this.d.store.putCredential({ hash: found.hash, keyVersion: found.version, personId, linkedAt: this.now(), via: "link" });
    return this.update(rec, { status: "issued", personId, linkTo: undefined, url: undefined, reason: undefined });
  }

  /** A wallet's standing. Without `details` (the wallet's own signed request) the check's reason and link are left out. */
  async status(wallet: Address, opts: { details?: boolean } = {}): Promise<StatusView> {
    const view = await this.fullStatus(wallet);
    if (opts.details) return view;
    const { url, reason, ...rest } = view;
    // A replaced member wallet is public on chain; that reason stays.
    const publicReason = view.member?.retired ? reason : undefined;
    return { ...rest, ...(publicReason ? { reason: publicReason } : {}), detailsHidden: !!url || (!!reason && !publicReason) };
  }

  private async fullStatus(wallet: Address): Promise<StatusView> {
    const rec = await this.d.store.getWallet(wallet);
    const pool = await this.pool();
    const member = pool ? await fetchMember(this.d.rpc, pool.address, wallet) : null;
    const pass = rec?.status === "issued" || member ? await this.passOf(wallet) : null;
    const view: StatusView = {
      status: rec?.status ?? "none",
      reason: rec?.reason,
      url: rec?.status === "pending" ? rec.url : undefined,
      person: null,
      member: member ? { retired: member.retired } : null,
      pass: pass ? { expiresAt: pass.expiresAt, state: pass.state } : null,
      next: "verify",
    };
    if (member) {
      view.next = member.retired ? "blocked" : this.renewDue(pass) ? "renew" : "done";
      if (member.retired) view.reason = "This wallet was replaced. Use the wallet now linked to your membership.";
      // A member sees their own standing: a bar (and its end) and any move of the membership in flight.
      const p = await fetchPerson(this.d.rpc, member.person);
      if (p) {
        const now = await this.chainNow();
        view.person = {
          onChain: true,
          currentWallet: p.wallet,
          isThisWallet: p.wallet === wallet,
          ineligible: !eligibleAt(p, now),
          barredUntil: !eligibleAt(p, now) ? Number(p.ineligibleUntil) : 0,
          pendingWallet: p.pendingWallet,
          pendingWalletAt: Number(p.pendingWalletAt),
          requestedAt: null,
        };
      }
      return view;
    }
    if (rec?.status === "pending" || rec?.status === "review") view.next = "wait";
    else if (rec?.status === "declined" || rec?.status === "ineligible") view.next = "blocked";
    else if (rec?.status === "error") view.next = "verify";
    if (rec?.status === "issued" && rec.personId && pool) {
      const [pda] = await findPersonPda(pool.address, fromHex(rec.personId));
      const p = await fetchPerson(this.d.rpc, pda);
      const now = await this.chainNow();
      const request = p && p.wallet !== wallet ? await this.d.store.getRecovery(rec.personId) : null;
      const requestedAt = request?.newWallet === wallet ? Math.floor(request.openedAt / 1000) : null;
      view.person = {
        onChain: !!p,
        currentWallet: p?.wallet ?? null,
        isThisWallet: p?.wallet === wallet,
        ineligible: p ? !eligibleAt(p, now) : false,
        barredUntil: p && !eligibleAt(p, now) ? Number(p.ineligibleUntil) : 0,
        pendingWallet: p?.pendingWallet ?? null,
        pendingWalletAt: p ? Number(p.pendingWalletAt) : 0,
        requestedAt,
      };
      if (!p) view.next = "join";
      else if (p.wallet === wallet) view.next = "done";
      else if (p.pendingWallet === wallet) {
        if (now >= p.pendingWalletAt) view.next = "finalize";
        else {
          view.next = "pending";
          view.reason = `Your membership moves to this wallet after ${when(p.pendingWalletAt)} unless your old wallet objects.`;
        }
      } else if (p.pendingWallet) {
        view.next = "blocked";
        view.reason = "A move of this membership to another wallet is already pending.";
      } else if (request && request.newWallet !== wallet) {
        view.next = "blocked";
        view.reason = "A move of this membership to another wallet is already requested.";
      } else if (requestedAt !== null) {
        view.next = "review";
        view.reason = "Your request to move the membership here is waiting for the operator's review.";
      } else view.next = "recover";
    }
    return view;
  }

  private async pool(): Promise<Pool | null> {
    return fetchCanonicalPool(this.d.rpc);
  }

  private async passOf(wallet: Address): Promise<PassView | null> {
    if (!this.d.gatekeeper) return null;
    try {
      return await this.d.gatekeeper.pass(wallet);
    } catch {
      return null;
    }
  }

  /** A pass that expires within the renewal window (or has expired) can be renewed. */
  private renewDue(pass: PassView | null): boolean {
    if (!pass || pass.state !== "active" || pass.expiresAt === null) return false;
    return pass.expiresAt - Number(this.nowSec()) <= (this.d.renewWindowSec ?? 30 * 86_400);
  }

  /**
   * Yearly renewal of a member's pass, without a new paid check: the wallet proves control (the route checks the
   * signature), the person is in good standing with the store (not barred for good) and the chain (not barred now),
   * and the pass gets a fresh expiry.
   */
  async renew(wallet: Address): Promise<{ tokenAddress: Address; expiresAt: number }> {
    const rec = await this.d.store.getWallet(wallet);
    if (!rec || rec.status !== "issued" || !rec.personId) throw new IdentityError(409, "Verify your identity first.");
    const person = await this.d.store.getPerson(rec.personId);
    if (this.barOf(person) === "permanent") throw new IdentityError(403, "This person can no longer use Good Faith.");
    const pool = await this.pool();
    if (pool) {
      const [pda] = await findPersonPda(pool.address, fromHex(rec.personId));
      const onChain = await fetchPerson(this.d.rpc, pda);
      if (onChain && onChain.wallet !== wallet) throw new IdentityError(409, "This wallet is no longer the one linked to the membership.");
      if (onChain && !eligibleAt(onChain, await this.chainNow()))
        throw new IdentityError(
          403,
          `Your membership is barred until ${when(onChain.ineligibleUntil)}; the pass renews once the bar ends.`,
        );
    }
    if (!this.d.gatekeeper) throw new IdentityError(503, "The pass issuer is not configured.");
    const expiresAt = Math.floor(this.now() / 1000) + (this.d.tokenTtlSec ?? 365 * 86_400);
    const tokenAddress = await this.d.gatekeeper.renew(wallet, expiresAt);
    await this.update(rec, { tokenAddress });
    await this.notify("pass_renewed", rec.personId, `The pass of wallet ${wallet} was renewed until ${when(expiresAt)}.`, { wallet });
    return { tokenAddress, expiresAt };
  }

  private async preparedFor(wallet: Address): Promise<{ rec: WalletRecord; pool: Pool; personId: Uint8Array; gatewayToken: Address }> {
    const rec = await this.d.store.getWallet(wallet);
    if (!rec || rec.status !== "issued" || !rec.personId) throw new IdentityError(409, "Verify your identity first.");
    const pool = await this.pool();
    if (!pool) throw new IdentityError(503, "The fund is not set up.");
    if (pool.issuer !== this.d.issuer.address) throw new IdentityError(500, "The identity service's key is not the fund's issuer.");
    const gatewayToken = (rec.tokenAddress as Address | undefined) ?? (await gatewayTokenAddress(wallet, pool.gatekeeperNetwork));
    return { rec, pool, personId: fromHex(rec.personId), gatewayToken };
  }

  private async sign(
    wallet: Address,
    build: (feePayer: Address) => Promise<Parameters<typeof buildTransaction>[2][number]>,
    kind: PreparedTx["kind"],
    signers: KeyPairSigner[],
    opts: { sponsorable?: boolean } = {},
  ): Promise<PreparedTx> {
    const payer = opts.sponsorable === false ? null : this.d.feePayer ? await this.d.feePayer() : null;
    const feePayer = payer ?? wallet;
    const tx = await buildTransaction(this.d.rpc, feePayer, [await build(feePayer)]);
    const signed = signers.length
      ? await partiallySignTransaction(
          signers.map((s) => s.keyPair),
          tx,
        )
      : tx;
    return { transaction: toBase64(signed), feePayer, sponsored: payer !== null, kind };
  }

  /** The register_member transaction for a verified wallet whose person is new to the chain, issuer-signed. */
  async prepareJoin(wallet: Address): Promise<PreparedTx> {
    const { pool, personId, gatewayToken } = await this.preparedFor(wallet);
    const [pda] = await findPersonPda(pool.address, personId);
    if (await fetchPerson(this.d.rpc, pda))
      throw new IdentityError(409, "You already have a membership. Recover it to this wallet instead.");
    return this.sign(
      wallet,
      (payer) => registerMemberIx({ wallet, payer, issuer: this.d.issuer.address, pool, gatewayToken, personId }),
      "register",
      [this.d.issuer],
    );
  }

  /**
   * Wallet recovery for a verified wallet whose person already has a membership elsewhere. The call records a
   * request for the operator (who proposes it on chain with the recovery key, see `prepareProposal`); the old wallet
   * may veto during the on-chain delay; once that delay has passed the call returns the finalize transaction, which
   * the new wallet pays for itself. A barred person may recover too: the bar follows the person, and the new wallet
   * is how they reach what they are owed.
   */
  async prepareRebind(wallet: Address): Promise<PreparedTx | RecoveryReview> {
    const { rec, pool, personId } = await this.preparedFor(wallet);
    const [pda] = await findPersonPda(pool.address, personId);
    const person = await fetchPerson(this.d.rpc, pda);
    if (!person) throw new IdentityError(409, "No membership to move yet. Join instead.");
    if (person.wallet === wallet) throw new IdentityError(409, "This wallet is already linked.");
    const now = await this.chainNow();
    if (person.pendingWallet === wallet) {
      if (now < person.pendingWalletAt)
        throw new IdentityError(409, `The move to this wallet is pending until ${when(person.pendingWalletAt)}.`);
      await this.d.store.closeRecovery(rec.personId!, "finalized", this.now());
      return this.sign(wallet, (payer) => finalizeRebindIx({ payer, pool, person }), "finalize", [], { sponsorable: false });
    }
    if (person.pendingWallet) throw new IdentityError(409, "A move of this membership to another wallet is already pending.");
    let request = await this.d.store.getRecovery(rec.personId!);
    if (request && request.newWallet !== wallet)
      throw new IdentityError(409, "A move of this membership to another wallet is already requested.");
    if (!request) {
      request = { personId: rec.personId!, newWallet: wallet, openedAt: this.now() };
      await this.d.store.putRecovery(request);
      await this.sendRequestNotice(request, person.wallet, rec.contact);
    }
    return { kind: "review", requestedAt: Math.floor(request.openedAt / 1000) };
  }

  /**
   * The notice that protects the real member: it goes to the contact on file from before the request (never one a
   * new wallet just supplied) and, when different, to the requester's own contact. The outcome is recorded on the
   * request so the operator sees it and the cranker can retry a failed delivery.
   */
  private async sendRequestNotice(request: RecoveryRecord, currentWallet: Address, requesterContact?: string): Promise<void> {
    const person = await this.d.store.getPerson(request.personId);
    const ok = await this.notify(
      "recovery_requested",
      request.personId,
      `A request to move your membership to wallet ${request.newWallet} was opened. If this was not you, keep your current wallet: it can object once the move is proposed.`,
      { wallet: request.newWallet as Address, data: { currentWallet }, also: requesterContact },
    );
    await this.d.store.putRecovery({
      ...request,
      notifiedAt: this.now(),
      delivery: person?.contact || requesterContact ? (ok ? "sent" : "failed") : undefined,
    });
  }

  /** Withdraws a recovery request for this wallet; once proposed on chain, the old wallet vetoes it there instead. */
  async cancelRecovery(wallet: Address): Promise<boolean> {
    const rec = await this.d.store.getWallet(wallet);
    if (!rec?.personId) return false;
    const request = await this.d.store.getRecovery(rec.personId);
    if (!request || request.newWallet !== wallet) return false;
    if (request.proposedAt) throw new IdentityError(409, "The move is already proposed on chain; the old wallet can object there.");
    await this.d.store.closeRecovery(rec.personId, "withdrawn", this.now());
    return true;
  }

  /** The operator's queue: every open request with the chain's view of the person. */
  async listRecoveries(): Promise<RecoveryView[]> {
    const pool = await this.pool();
    const now = await this.chainNow();
    const out: RecoveryView[] = [];
    for (const r of await this.d.store.listRecoveries()) {
      const stored = await this.d.store.getPerson(r.personId);
      const p = pool ? await fetchPerson(this.d.rpc, (await findPersonPda(pool.address, fromHex(r.personId)))[0]) : null;
      out.push({
        personId: r.personId,
        newWallet: r.newWallet as Address,
        inquiryId: (await this.d.store.getWallet(r.newWallet as Address))?.inquiryId ?? null,
        requestedAt: Math.floor(r.openedAt / 1000),
        hasContact: !!stored?.contact,
        delivery: r.delivery ?? null,
        proposedAt: r.proposedAt ? Math.floor(r.proposedAt / 1000) : 0,
        onChain: !!p,
        currentWallet: p?.wallet ?? null,
        pendingWallet: p?.pendingWallet ?? null,
        pendingWalletAt: p ? Number(p.pendingWalletAt) : 0,
        barredUntil: p && !eligibleAt(p, now) ? Number(p.ineligibleUntil) : 0,
      });
    }
    return out;
  }

  private async requestOf(personIdHex: string): Promise<RecoveryRecord> {
    const request = await this.d.store.getRecovery(personIdHex);
    if (!request) throw new IdentityError(404, "No recovery request for this person.");
    return request;
  }

  /**
   * For the operator's recovery CLI: the `propose_rebind` for a recorded request, built with the operator's key as
   * fee payer and signed by the issuer. The CLI adds the recovery authority's signature and sends it; the web
   * service never holds that key. The CLI names the wallet it expects, so a request swapped underneath it is
   * refused; a request younger than the minimum age, or whose notice did not reach the member, needs the
   * operator's explicit override; a request is never proposed twice.
   */
  async prepareProposal(personIdHex: string, newWallet: Address, feePayer: Address, opts: { force?: boolean } = {}): Promise<PreparedTx> {
    const request = await this.requestOf(personIdHex);
    const wallet = request.newWallet as Address;
    if (wallet !== newWallet) throw new IdentityError(409, `The recorded request names wallet ${wallet}, not ${newWallet}.`);
    if (request.proposedAt)
      throw new IdentityError(409, `This request was already proposed on chain (${request.signature ?? "signature unknown"}).`);
    const ageSec = Math.floor((this.now() - request.openedAt) / 1000);
    if (!opts.force && ageSec < this.minAgeSec())
      throw new IdentityError(
        409,
        `The request is ${ageSec}s old; the member gets ${this.minAgeSec()}s to see the notice before a move is proposed (--force to override).`,
      );
    if (!opts.force && request.delivery === "failed")
      throw new IdentityError(409, "The notice about this request did not reach the member; retry it or override with --force.");
    const { pool, personId, gatewayToken } = await this.preparedFor(wallet);
    const [pda] = await findPersonPda(pool.address, personId);
    const person = await fetchPerson(this.d.rpc, pda);
    if (!person) throw new IdentityError(409, "The person has no membership on chain.");
    if (person.wallet === wallet) throw new IdentityError(409, "That wallet is already the current one.");
    if (person.pendingWallet) throw new IdentityError(409, "A move of this membership is already pending on chain.");
    if (pool.recoveryAuthority !== feePayer)
      throw new IdentityError(400, "The fee payer must be the fund's recovery authority (the key that signs next).");
    const tx = await buildTransaction(this.d.rpc, feePayer, [
      await proposeRebindIx({ newWallet: wallet, issuer: this.d.issuer.address, recoveryAuthority: feePayer, pool, person, gatewayToken }),
    ]);
    const signed = await partiallySignTransaction([this.d.issuer.keyPair], tx);
    return { transaction: toBase64(signed), feePayer, sponsored: false, kind: "propose" };
  }

  /** The operator reports that the proposal is on chain: it is recorded and the member hears about the veto window. */
  async recoveryProposed(personIdHex: string, signature: string): Promise<{ notified: boolean }> {
    const request = await this.requestOf(personIdHex);
    await this.d.store.putRecovery({ ...request, proposedAt: this.now(), signature });
    const pool = await this.pool();
    const p = pool ? await fetchPerson(this.d.rpc, (await findPersonPda(pool.address, fromHex(personIdHex)))[0]) : null;
    const until = p?.pendingWallet === request.newWallet ? when(p.pendingWalletAt) : "the recovery delay has passed";
    await this.notify(
      "recovery_proposed",
      personIdHex,
      `The move of your membership to wallet ${request.newWallet} is proposed on chain (${signature}). Your current wallet can object until ${until}; otherwise the move completes.`,
      {
        wallet: request.newWallet as Address,
        data: { signature, currentWallet: p?.wallet ?? "", pendingWalletAt: p ? Number(p.pendingWalletAt) : 0 },
      },
    );
    return { notified: !!this.d.notifier };
  }

  /** The operator turns a request down; the member can ask again. */
  async rejectRecovery(personIdHex: string): Promise<boolean> {
    const request = await this.d.store.getRecovery(personIdHex);
    if (!request) return false;
    await this.d.store.closeRecovery(personIdHex, "rejected", this.now());
    await this.notify(
      "recovery_rejected",
      personIdHex,
      `The request to move your membership to wallet ${request.newWallet} was not approved.`,
      {
        wallet: request.newWallet as Address,
      },
    );
    return true;
  }

  /** The on-chain Person for a verified wallet, or null when there is none yet. */
  async personOf(wallet: Address): Promise<Person | null> {
    const { pool, personId } = await this.preparedFor(wallet);
    const [pda] = await findPersonPda(pool.address, personId);
    return fetchPerson(this.d.rpc, pda);
  }

  /**
   * Mirrors a bar the chain set: `untilSec` as the chain has it. A permanent bar (no `untilSec`, or the chain's i64
   * max) freezes the passes of every wallet the person verified with and refuses future checks; a temporary bar is
   * only recorded: the chain refuses the person's loans and guarantees meanwhile, their passes stay so they can
   * recover a wallet and collect what they are owed, and it ends by itself. An `untilSec` in the past lifts a bar
   * (the authority's `lift_bar`, or a pay-back that relaxed it), unfreezing passes a permanent bar froze. Calling it
   * again with the same value changes nothing, so the cranker can reconcile every pass.
   */
  async ban(
    personIdHex: string,
    untilSec?: number,
  ): Promise<{ banned: boolean; until: number | null; permanent: boolean; frozen: Address[]; unfrozen: Address[] }> {
    const person = await this.d.store.getPerson(personIdHex);
    if (!person) return { banned: false, until: null, permanent: false, frozen: [], unfrozen: [] };
    const permanent = untilSec === undefined || untilSec >= PERMANENT_UNTIL;
    const wasPermanent = (person.bannedUntil ?? 0) >= PERMANENT_UNTIL;
    if (!permanent && untilSec! <= Number(this.nowSec())) {
      let unfrozen: Address[] = [];
      if (person.bannedUntil) {
        if (wasPermanent) unfrozen = await this.setPassesFrozen(personIdHex, person, false);
        await this.d.store.putPerson({ ...person, bannedUntil: undefined });
        await this.notify("bar_lifted", personIdHex, "Your Good Faith membership is in good standing again.");
      }
      return { banned: false, until: null, permanent: false, frozen: [], unfrozen };
    }
    const until = permanent ? PERMANENT_UNTIL : untilSec!;
    let frozen: Address[] = [];
    let unfrozen: Address[] = [];
    if (person.bannedUntil !== until) {
      await this.d.store.putPerson({ ...person, bannedAt: this.now(), bannedUntil: until });
      await this.notify(
        "barred",
        personIdHex,
        permanent
          ? "Your Good Faith membership is barred. Paying back what the fund lost restores it; you can still collect what you are owed."
          : `Your Good Faith membership is barred until ${when(until)}. Paying back what the fund lost shortens that; you can still collect what you are owed.`,
        { data: { until } },
      );
      if (permanent && !wasPermanent) frozen = await this.setPassesFrozen(personIdHex, person, true);
      if (!permanent && wasPermanent) unfrozen = await this.setPassesFrozen(personIdHex, person, false);
    } else if (permanent) {
      // Same bar as before: make sure every pass is frozen (a wallet verified since, a failed earlier call).
      frozen = await this.setPassesFrozen(personIdHex, person, true);
    }
    if (permanent) {
      const open = await this.d.store.getRecovery(personIdHex);
      if (open && !open.proposedAt) await this.d.store.closeRecovery(personIdHex, "barred", this.now());
    }
    return { banned: true, until, permanent, frozen, unfrozen };
  }

  /** Every wallet of a person: the ones the store knows and the one the chain binds now. */
  private async walletsOf(personIdHex: string, person: PersonRecord): Promise<Address[]> {
    const wallets = new Set<Address>([person.wallet as Address, ...((await this.d.store.walletsOf(personIdHex)) as Address[])]);
    const pool = await this.pool();
    if (pool) {
      const [pda] = await findPersonPda(pool.address, fromHex(personIdHex));
      const onChain = await fetchPerson(this.d.rpc, pda);
      if (onChain) wallets.add(onChain.wallet);
    }
    return [...wallets];
  }

  private async setPassesFrozen(personIdHex: string, person: PersonRecord, frozen: boolean): Promise<Address[]> {
    const done: Address[] = [];
    for (const w of await this.walletsOf(personIdHex, person)) {
      if (this.d.gatekeeper) {
        const pass = await this.passOf(w);
        if (!pass || pass.state === "revoked" || pass.state === (frozen ? "frozen" : "active")) continue;
        if (frozen) await this.d.gatekeeper.freeze(w);
        else await this.d.gatekeeper.unfreeze(w);
      }
      done.push(w);
    }
    return done;
  }

  /**
   * The cranker's pass: `barred` is every person the chain bars right now and until when. Each is mirrored; every
   * stored bar the chain no longer has is lifted; recovery requests the chain finalised or vetoed are closed; the
   * request notices whose delivery failed are sent again.
   */
  async reconcile(barred: { personId: string; until: number }[]): Promise<ReconcileReport> {
    const report: ReconcileReport = { barred: 0, lifted: 0, recoveriesClosed: [], noticesRetried: 0 };
    const seen = new Set<string>();
    for (const b of barred) {
      seen.add(b.personId);
      const r = await this.ban(b.personId, b.until);
      if (r.banned) report.barred++;
    }
    for (const p of await this.d.store.listBarredPersons()) {
      if (seen.has(p.personId)) continue;
      const r = await this.ban(p.personId, 0);
      if (!r.banned) report.lifted++;
    }
    const pool = await this.pool();
    for (const r of await this.d.store.listRecoveries()) {
      const person = pool ? await fetchPerson(this.d.rpc, (await findPersonPda(pool.address, fromHex(r.personId)))[0]) : null;
      if (r.proposedAt && person) {
        const as: RecoveryClosedAs | null = person.wallet === r.newWallet ? "finalized" : person.pendingWallet === null ? "vetoed" : null;
        if (as) {
          await this.d.store.closeRecovery(r.personId, as, this.now());
          report.recoveriesClosed.push({ personId: r.personId, as });
          continue;
        }
      }
      if (r.delivery === "failed" && person) {
        const requester = await this.d.store.getWallet(r.newWallet);
        await this.sendRequestNotice(r, person.wallet, requester?.contact);
        report.noticesRetried++;
      }
    }
    return report;
  }

  /** The credential fingerprint the service would compute for these fields under the current key (tests and tooling). */
  hashOf(fields: VerifiedFields): string {
    return this.d.keyring.fingerprint(fields).hash;
  }
}
