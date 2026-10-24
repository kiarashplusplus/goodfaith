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
import type { IdentityStore, WalletRecord } from "./store";
import type { TokenIssuer } from "./gatekeeper";
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
  /** The pool's recovery authority, when this service may propose wallet recoveries; absent otherwise. */
  recovery?: KeyPairSigner;
  rpc: ServiceRpc;
  /** Current and previous fingerprint keys. */
  keyring: HashKeyring;
  /** Fee payer for prepared transactions, or null to let the wallet pay. */
  feePayer?: () => Promise<Address | null>;
  /** Token validity, seconds (default one year). */
  tokenTtlSec?: number;
  /** Seconds a recovery request waits on the service before the proposal is signed (default 0). */
  recoveryReviewSec?: number;
  requiredState?: string;
  minAge?: number;
  now?: () => number;
};

export type StatusView = {
  /** "none" before any check; otherwise the wallet record's status. */
  status: WalletRecord["status"] | "none";
  reason?: string;
  url?: string;
  /** The person behind the approved check, as the chain sees it. */
  person: null | {
    onChain: boolean;
    currentWallet: Address | null;
    isThisWallet: boolean;
    ineligible: boolean;
    /** A recovery in flight: the wallet it moves to and when (unix seconds) it may be finalised. */
    pendingWallet: Address | null;
    pendingWalletAt: number;
    /** A service-side recovery request for this wallet: when (unix seconds) the proposal can be signed. */
    reviewUntil: number | null;
  };
  /** This wallet's on-chain membership. */
  member: null | { retired: boolean };
  /**
   * What the wallet can do now. `recover` asks to move the membership here; `review` means that request waits on
   * the service; `pending` means the on-chain proposal is in its veto window; `finalize` completes it.
   */
  next: "verify" | "wait" | "join" | "recover" | "review" | "pending" | "finalize" | "done" | "blocked";
};

export type PreparedTx = { transaction: string; feePayer: Address; sponsored: boolean; kind: "register" | "propose" | "finalize" };
/** A recovery request that is not yet due for signing. */
export type RecoveryReview = { kind: "review"; readyAt: number };

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

  /** Starts (or resumes) the hosted identity check for a wallet. */
  async start(wallet: Address): Promise<{ inquiryId: string; url: string; status: WalletRecord["status"] }> {
    const existing = await this.d.store.getWallet(wallet);
    if (existing?.status === "issued") throw new IdentityError(409, "This wallet is already verified.");
    if (existing?.status === "pending" && existing.url) return { inquiryId: existing.inquiryId, url: existing.url, status: "pending" };
    if (existing?.status === "review") throw new IdentityError(409, "Your check is being reviewed. Please wait.");
    return this.open(wallet, existing, undefined);
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
    if (!person || person.bannedAt) throw new IdentityError(403, "This person can no longer use Good Faith.");
    return this.open(wallet, existing, existing.personId);
  }

  private async open(wallet: Address, existing: WalletRecord | null, linkTo: string | undefined) {
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
    if (person?.bannedAt)
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
      await this.d.store.putPerson({ personId: found.personId, wallet: rec.wallet, createdAt: this.now() });
      await this.d.store.putCredential({
        hash: found.hash,
        keyVersion: found.version,
        personId: found.personId,
        linkedAt: this.now(),
        via: "verify",
      });
    }
    return this.update(rec, { status: "issued", personId: found.personId, tokenAddress, reason: undefined, url: undefined });
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

  async status(wallet: Address): Promise<StatusView> {
    const rec = await this.d.store.getWallet(wallet);
    const pool = await this.pool();
    const member = pool ? await fetchMember(this.d.rpc, pool.address, wallet) : null;
    const view: StatusView = {
      status: rec?.status ?? "none",
      reason: rec?.reason,
      url: rec?.status === "pending" ? rec.url : undefined,
      person: null,
      member: member ? { retired: member.retired } : null,
      next: "verify",
    };
    if (member) {
      view.next = member.retired ? "blocked" : "done";
      if (member.retired) view.reason = "This wallet was replaced. Use the wallet now linked to your membership.";
      return view;
    }
    if (rec?.status === "pending" || rec?.status === "review") view.next = "wait";
    else if (rec?.status === "declined" || rec?.status === "ineligible") view.next = "blocked";
    else if (rec?.status === "error") view.next = "verify";
    if (rec?.status === "issued" && rec.personId && pool) {
      const [pda] = await findPersonPda(pool.address, fromHex(rec.personId));
      const p = await fetchPerson(this.d.rpc, pda);
      const now = await this.chainNow();
      const review = p && p.wallet !== wallet ? await this.d.store.getRecovery(rec.personId) : null;
      const reviewUntil = review?.newWallet === wallet ? Math.floor(review.openedAt / 1000) + (this.d.recoveryReviewSec ?? 0) : null;
      view.person = {
        onChain: !!p,
        currentWallet: p?.wallet ?? null,
        isThisWallet: p?.wallet === wallet,
        ineligible: p ? !eligibleAt(p, now) : false,
        pendingWallet: p?.pendingWallet ?? null,
        pendingWalletAt: p ? Number(p.pendingWalletAt) : 0,
        reviewUntil,
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
      } else if (review && review.newWallet !== wallet) {
        view.next = "blocked";
        view.reason = "A move of this membership to another wallet is already requested.";
      } else if (reviewUntil !== null && Math.floor(this.now() / 1000) < reviewUntil) {
        view.next = "review";
        view.reason = `Your request to move the membership here is being reviewed until ${when(reviewUntil)}.`;
      } else view.next = "recover";
    }
    return view;
  }

  private async pool(): Promise<Pool | null> {
    return fetchCanonicalPool(this.d.rpc);
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
   * Wallet recovery for a verified wallet whose person already has a membership elsewhere. The first call opens a
   * request; once the service-side review period has passed the call returns the proposal (issuer and recovery
   * authority sign; the old wallet may veto during the on-chain delay); once that delay has passed too, the call
   * returns the finalize transaction instead, which the new wallet pays for itself.
   */
  async prepareRebind(wallet: Address): Promise<PreparedTx | RecoveryReview> {
    const { rec, pool, personId, gatewayToken } = await this.preparedFor(wallet);
    const [pda] = await findPersonPda(pool.address, personId);
    const person = await fetchPerson(this.d.rpc, pda);
    if (!person) throw new IdentityError(409, "No membership to move yet. Join instead.");
    if (person.wallet === wallet) throw new IdentityError(409, "This wallet is already linked.");
    const now = await this.chainNow();
    if (person.pendingWallet === wallet) {
      if (now < person.pendingWalletAt)
        throw new IdentityError(409, `The move to this wallet is pending until ${when(person.pendingWalletAt)}.`);
      await this.d.store.deleteRecovery(rec.personId!);
      return this.sign(wallet, (payer) => finalizeRebindIx({ payer, pool, person }), "finalize", [], { sponsorable: false });
    }
    if (person.pendingWallet) throw new IdentityError(409, "A move of this membership to another wallet is already pending.");
    if (!eligibleAt(person, now)) throw new IdentityError(403, "This membership is on hold.");
    const recovery = this.d.recovery;
    if (!recovery) throw new IdentityError(503, "Wallet recovery is not enabled on this service.");
    if (pool.recoveryAuthority !== recovery.address)
      throw new IdentityError(500, "The identity service's recovery key is not the fund's recovery authority.");
    // Service-side review: the request is recorded first and signed only once the review period has passed.
    const reviewSec = this.d.recoveryReviewSec ?? 0;
    let request = await this.d.store.getRecovery(rec.personId!);
    if (request && request.newWallet !== wallet)
      throw new IdentityError(409, "A move of this membership to another wallet is already requested.");
    if (!request) {
      request = { personId: rec.personId!, newWallet: wallet, openedAt: this.now() };
      await this.d.store.putRecovery(request);
    }
    const readyAt = Math.floor(request.openedAt / 1000) + reviewSec;
    if (Math.floor(this.now() / 1000) < readyAt) return { kind: "review", readyAt };
    return this.sign(
      wallet,
      () =>
        proposeRebindIx({
          newWallet: wallet,
          issuer: this.d.issuer.address,
          recoveryAuthority: recovery.address,
          pool,
          person,
          gatewayToken,
        }),
      "propose",
      [this.d.issuer, recovery],
    );
  }

  /** Withdraws a service-side recovery request for this wallet (an on-chain proposal is vetoed on chain instead). */
  async cancelRecovery(wallet: Address): Promise<boolean> {
    const rec = await this.d.store.getWallet(wallet);
    if (!rec?.personId) return false;
    const request = await this.d.store.getRecovery(rec.personId);
    if (!request || request.newWallet !== wallet) return false;
    await this.d.store.deleteRecovery(rec.personId);
    return true;
  }

  /** The on-chain Person for a verified wallet, or null when there is none yet. */
  async personOf(wallet: Address): Promise<Person | null> {
    const { pool, personId } = await this.preparedFor(wallet);
    const [pda] = await findPersonPda(pool.address, personId);
    return fetchPerson(this.d.rpc, pda);
  }

  /**
   * Bars a person (after a default): revokes the passes of every wallet they verified with and refuses future
   * checks. The chain carries the eligibility bar itself; this keeps the person from re-verifying onto a fresh
   * wallet meanwhile.
   */
  async ban(personIdHex: string): Promise<{ banned: boolean; revoked: Address[] }> {
    const person = await this.d.store.getPerson(personIdHex);
    if (!person) return { banned: false, revoked: [] };
    if (!person.bannedAt) await this.d.store.putPerson({ ...person, bannedAt: this.now() });
    await this.d.store.deleteRecovery(personIdHex);
    const wallets = new Set<Address>([person.wallet as Address, ...((await this.d.store.walletsOf(personIdHex)) as Address[])]);
    const pool = await this.pool();
    if (pool) {
      const [pda] = await findPersonPda(pool.address, fromHex(personIdHex));
      const onChain = await fetchPerson(this.d.rpc, pda);
      if (onChain) wallets.add(onChain.wallet);
    }
    const revoked: Address[] = [];
    for (const w of wallets) {
      if (this.d.gatekeeper) await this.d.gatekeeper.revoke(w);
      revoked.push(w);
      const rec = await this.d.store.getWallet(w);
      if (rec) await this.update(rec, { status: "ineligible", linkTo: undefined, reason: "This person can no longer use Good Faith." });
    }
    return { banned: true, revoked };
  }

  /** The credential fingerprint the service would compute for these fields under the current key (tests and tooling). */
  hashOf(fields: VerifiedFields): string {
    return this.d.keyring.fingerprint(fields).hash;
  }
}
