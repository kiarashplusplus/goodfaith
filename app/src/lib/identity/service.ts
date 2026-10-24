/**
 * The identity issuer: runs the provider check, keeps the person registry, issues gateway tokens on the fund's
 * network, and prepares the on-chain join (or wallet recovery) with the issuer's signature. The wallet adds
 * its own signature in the browser; the fee sponsor pays when it is configured.
 *
 * A person is an opaque random id. The keyed fingerprint of their ID fields stays in the store so the same human
 * resolves to the same person on a later check; nothing derived from the credential reaches the chain.
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
import { ageAt, fromHex, personHash, toHex } from "./person-hash";
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
  hashSecret: string;
  /** Fee payer for prepared transactions, or null to let the wallet pay. */
  feePayer?: () => Promise<Address | null>;
  /** Token validity, seconds (default one year). */
  tokenTtlSec?: number;
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
  };
  /** This wallet's on-chain membership. */
  member: null | { retired: boolean };
  /**
   * What the wallet can do now. `recover` proposes moving the membership here; `pending` means that move is in
   * its veto window; `finalize` completes it.
   */
  next: "verify" | "wait" | "join" | "recover" | "pending" | "finalize" | "done" | "blocked";
};

export type PreparedTx = { transaction: string; feePayer: Address; sponsored: boolean; kind: "register" | "propose" | "finalize" };

export class IdentityError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const when = (unixSec: bigint) => new Date(Number(unixSec) * 1000).toUTCString();
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
    const existing = this.d.store.getWallet(wallet);
    if (existing?.status === "issued") throw new IdentityError(409, "This wallet is already verified.");
    if (existing?.status === "pending" && existing.url) return { inquiryId: existing.inquiryId, url: existing.url, status: "pending" };
    if (existing?.status === "review") throw new IdentityError(409, "Your check is being reviewed. Please wait.");
    const { inquiryId, url } = await this.d.provider.createInquiry(wallet);
    const t = this.now();
    this.d.store.putWallet({ wallet, inquiryId, url, status: "pending", createdAt: existing?.createdAt ?? t, updatedAt: t });
    return { inquiryId, url, status: "pending" };
  }

  /** A provider webhook. Returns what happened, for logs; the HTTP answer is 200 whenever the signature is good. */
  async handleWebhook(
    headers: HeaderBag,
    rawBody: string,
  ): Promise<"bad_signature" | "ignored" | "duplicate" | "unknown_inquiry" | WalletRecord["status"]> {
    if (!this.d.provider.verifyWebhook(headers, rawBody, Math.floor(this.now() / 1000))) return "bad_signature";
    const ev = this.d.provider.parseEvent(rawBody);
    if (!ev) return "ignored";
    if (!this.d.store.firstTime(ev.eventId)) return "duplicate";
    const rec = this.d.store.getByInquiry(ev.inquiryId) ?? (ev.referenceId ? this.d.store.getWallet(ev.referenceId) : null);
    if (!rec || rec.inquiryId !== ev.inquiryId) return "unknown_inquiry";
    if (rec.status === "issued") return "issued"; // never downgrade a finished wallet from a late event
    switch (ev.outcome) {
      case "pending":
        return rec.status;
      case "needs_review":
        return this.update(rec, { status: "review", reason: "Your check needs a closer look." });
      case "declined":
        return this.update(rec, { status: "declined", reason: "The identity check was not approved." });
      case "approved":
        return this.approve(rec);
    }
  }

  private update(rec: WalletRecord, patch: Partial<WalletRecord>): WalletRecord["status"] {
    const next = { ...rec, ...patch, updatedAt: this.now() };
    this.d.store.putWallet(next);
    return next.status;
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
    const hash = toHex(personHash(this.d.hashSecret, fields));
    const known = this.d.store.getPersonByCredential(hash);
    if (known?.bannedAt)
      return this.update(rec, { status: "ineligible", personId: known.personId, reason: "This person can no longer use Good Faith." });
    const personId = known?.personId ?? toHex(randomBytes(32));
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
          personId: known ? personId : undefined,
          reason: `Could not issue your pass: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    if (!known) this.d.store.putPerson({ personId, credentialHash: hash, wallet: rec.wallet, createdAt: this.now() });
    return this.update(rec, { status: "issued", personId, tokenAddress, reason: undefined, url: undefined });
  }

  async status(wallet: Address): Promise<StatusView> {
    const rec = this.d.store.getWallet(wallet);
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
      view.person = {
        onChain: !!p,
        currentWallet: p?.wallet ?? null,
        isThisWallet: p?.wallet === wallet,
        ineligible: p ? !eligibleAt(p, now) : false,
        pendingWallet: p?.pendingWallet ?? null,
        pendingWalletAt: p ? Number(p.pendingWalletAt) : 0,
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
      } else view.next = "recover";
    }
    return view;
  }

  private async pool(): Promise<Pool | null> {
    return fetchCanonicalPool(this.d.rpc);
  }

  private async preparedFor(wallet: Address): Promise<{ rec: WalletRecord; pool: Pool; personId: Uint8Array; gatewayToken: Address }> {
    const rec = this.d.store.getWallet(wallet);
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
   * Wallet recovery for a verified wallet whose person already has a membership elsewhere. The first call proposes
   * the move (issuer and recovery authority sign; the old wallet may veto during the delay); once the delay has
   * passed, the call returns the finalize transaction instead, which the new wallet pays for itself.
   */
  async prepareRebind(wallet: Address): Promise<PreparedTx> {
    const { pool, personId, gatewayToken } = await this.preparedFor(wallet);
    const [pda] = await findPersonPda(pool.address, personId);
    const person = await fetchPerson(this.d.rpc, pda);
    if (!person) throw new IdentityError(409, "No membership to move yet. Join instead.");
    if (person.wallet === wallet) throw new IdentityError(409, "This wallet is already linked.");
    const now = await this.chainNow();
    if (person.pendingWallet === wallet) {
      if (now < person.pendingWalletAt)
        throw new IdentityError(409, `The move to this wallet is pending until ${when(person.pendingWalletAt)}.`);
      return this.sign(wallet, (payer) => finalizeRebindIx({ payer, pool, person }), "finalize", [], { sponsorable: false });
    }
    if (person.pendingWallet) throw new IdentityError(409, "A move of this membership to another wallet is already pending.");
    if (!eligibleAt(person, now)) throw new IdentityError(403, "This membership is on hold.");
    const recovery = this.d.recovery;
    if (!recovery) throw new IdentityError(503, "Wallet recovery is not enabled on this service.");
    if (pool.recoveryAuthority !== recovery.address)
      throw new IdentityError(500, "The identity service's recovery key is not the fund's recovery authority.");
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

  /** The on-chain Person for a verified wallet, or null when there is none yet. */
  async personOf(wallet: Address): Promise<Person | null> {
    const { pool, personId } = await this.preparedFor(wallet);
    const [pda] = await findPersonPda(pool.address, personId);
    return fetchPerson(this.d.rpc, pda);
  }

  /**
   * Bars a person (after a default): revokes the current wallet's pass and refuses future verifications. The chain
   * carries the eligibility bar itself; this keeps the person from re-verifying onto a fresh wallet meanwhile.
   */
  async ban(personIdHex: string): Promise<{ banned: boolean; revoked: Address[] }> {
    const person = this.d.store.getPerson(personIdHex);
    if (!person) return { banned: false, revoked: [] };
    if (!person.bannedAt) this.d.store.putPerson({ ...person, bannedAt: this.now() });
    const wallets = new Set<Address>([person.wallet as Address, ...(this.d.store.walletsOf(personIdHex) as Address[])]);
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
      const rec = this.d.store.getWallet(w);
      if (rec) this.update(rec, { status: "ineligible", reason: "This person can no longer use Good Faith." });
    }
    return { banned: true, revoked };
  }

  /** The credential fingerprint the service would compute for these fields (tests and tooling). */
  hashOf(fields: VerifiedFields): string {
    return toHex(personHash(this.d.hashSecret, fields));
  }
}
