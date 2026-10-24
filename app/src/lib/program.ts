/**
 * Program access layer for `goodfaith`, built on the Codama client in src/generated
 * (regenerate with `npm run codegen` after `anchor build`).
 * On-chain data is untrusted: owner and discriminator are checked before decoding.
 */
import {
  type Address,
  type Instruction,
  type Rpc,
  type GetProgramAccountsApi,
  getBase16Encoder,
  getBase58Decoder,
  getBase64Encoder,
  type GetAccountInfoApi,
  createNoopSigner,
  fetchEncodedAccount,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
  isSome,
  type Option,
  type EncodedAccount,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  GoodfaithAccount,
  identifyGoodfaithAccount,
  decodeLoan,
  decodeMember,
  decodePerson,
  decodePool,
  getDonateInstruction,
  getRequestLoanInstruction,
  getCosignLoanInstruction,
  getCancelRequestInstruction,
  decodeLoanRequest,
  type LoanRequest as LoanRequestData,
  type Loan as LoanData,
  getLoanRequestDiscriminatorBytes,
  getRegisterMemberInstruction,
  getProposeRebindInstruction,
  getVetoRebindInstruction,
  getFinalizeRebindInstruction,
  getRepayInstruction,
  getMarkDefaultInstruction,
  getClaimEscrowInstruction,
  getCloseExpiredRequestInstruction,
  getApplyParamsInstruction,
  getSweepToSuccessorInstruction,
  getPauseLendingInstruction,
  getResumeLendingInstruction,
  getLoanDiscriminatorBytes,
  getLoanSize,
  getPersonDiscriminatorBytes,
  type Person as PersonData,
  type PoolParams as PoolParamsData,
} from "@/generated";
import { CONFIG_ERRORS, GATEKEEPER_NETWORK, POOL_ADDRESS, POOL_AUTHORITY, POOL_MINT, PROGRAM_ID } from "./config";
import { KORA_CODES, KoraError } from "./kora";

export { TOKEN_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS };

const enc = getUtf8Encoder();
const addr = getAddressEncoder();
const cfg = { programAddress: PROGRAM_ID };
const signer = (a: Address) => createNoopSigner(a);

// ---------- types ----------
export type LoanStatus = "Active" | "Repaid" | "Defaulted" | "RepaidLate";

/** Settings the authority can schedule (applied after the timelock). */
export type PoolParams = {
  gatekeeperNetwork: Address;
  maxLoan: bigint;
  maxTermDays: number;
  graceDays: number;
  maxGuaranteesPerMember: number;
  cosignerEscrowBps: number;
  issuer: Address;
  timelockSeconds: bigint;
  recoveryAuthority: Address;
  pauseAuthority: Address;
  recoveryDelaySeconds: bigint;
  requestTtlSeconds: bigint;
  firstLoanCap: bigint;
  loanCapStep: bigint;
  cooldownSeconds: bigint;
  maxExposurePerPerson: bigint;
  disbursementWindowSeconds: bigint;
  disbursementCapPerWindow: bigint;
  defaultBanSeconds: bigint;
  lateBanSeconds: bigint;
  cosignerBanSeconds: bigint;
};

export type Pool = {
  address: Address;
  authority: Address | null;
  /** Key that may take over the pool by calling accept_authority. */
  pendingAuthority: Address | null;
  mint: Address;
  vault: Address;
  gatekeeperNetwork: Address;
  maxLoan: bigint;
  maxTermDays: number;
  graceDays: number;
  maxGuaranteesPerMember: number;
  cosignerEscrowBps: number;
  loanCount: bigint;
  totalDonated: bigint;
  totalLent: bigint;
  totalRepaid: bigint;
  totalRecovered: bigint;
  totalLost: bigint;
  /** Key that vouches for people at registration; the zero address means suspended. */
  issuer: Address;
  timelockSeconds: bigint;
  /** A scheduled settings change and when anyone may apply it. */
  pendingParams: PoolParams | null;
  paramsEffectiveAt: bigint;
  /** When set and reached, no new loans or donations. */
  windDownAt: bigint | null;
  successor: Address | null;
  activeLoans: bigint;
  totalSwept: bigint;
  recoveryAuthority: Address;
  pauseAuthority: Address;
  paused: boolean;
  windowStart: bigint;
  windowDisbursed: bigint;
  /** Escrow owed to co-signers of closed loans, waiting to be claimed. */
  pendingClaims: bigint;
  recoveryDelaySeconds: bigint;
  requestTtlSeconds: bigint;
  firstLoanCap: bigint;
  loanCapStep: bigint;
  cooldownSeconds: bigint;
  maxExposurePerPerson: bigint;
  disbursementWindowSeconds: bigint;
  disbursementCapPerWindow: bigint;
  defaultBanSeconds: bigint;
  lateBanSeconds: bigint;
  cosignerBanSeconds: bigint;
};

/** One verified human; eligibility and open positions live here and follow a replaced wallet. */
export type Person = {
  address: Address;
  /** Opaque id the issuer assigned (hex); the credential behind it lives only in the identity service. */
  personId: string;
  wallet: Address;
  activeLoan: Address | null;
  activeGuarantees: number;
  activeGuaranteeAmount: bigint;
  completedLoans: number;
  /** 0: eligible; i64 max: barred for good; else barred until this unix time. */
  ineligibleUntil: bigint;
  /** Until this time the person is on the first-loan cap. */
  restrictedUntil: bigint;
  pendingWallet: Address | null;
  pendingWalletAt: bigint;
};

export const PERMANENT = 9223372036854775807n;
/** Whether a person may borrow or co-sign at `now`. */
export const eligibleAt = (p: Pick<Person, "ineligibleUntil">, now: bigint) => now >= p.ineligibleUntil;
/** The largest loan a person may take at `now`, mirroring `Person::loan_cap`. */
export function loanCapAt(p: Pick<Person, "restrictedUntil" | "completedLoans">, pool: Pool, now: bigint): bigint {
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  if (now < p.restrictedUntil) return min(pool.firstLoanCap, pool.maxLoan);
  return min(pool.firstLoanCap + pool.loanCapStep * BigInt(p.completedLoans), pool.maxLoan);
}

/** A wallet's membership together with the standing of the person behind it. */
export type Member = {
  address: Address;
  wallet: Address;
  person: Address;
  /** True once the wallet was replaced; it can no longer take part. */
  retired: boolean;
  activeLoan: Address | null;
  activeGuarantees: number;
  ineligibleUntil: bigint;
  restrictedUntil: bigint;
  completedLoans: number;
  /** Convenience: barred at the time of the read (use `eligibleAt` with a clock for exact boundaries). */
  ineligible: boolean;
};

export type Loan = {
  graceDays: number;
  address: Address;
  id: bigint;
  borrower: Address;
  cosigner: Address;
  borrowerPerson: Address;
  cosignerPerson: Address;
  rentPayer: Address;
  principal: bigint;
  repaid: bigint;
  escrowed: bigint;
  openedAt: bigint;
  dueAt: bigint;
  status: LoanStatus;
  /** When the loan left Active (0 while open). */
  closedAt: bigint;
  /** Escrow owed to the co-signer, still in the escrow account until claimed. */
  refundPending: bigint;
};

export type LoanRequest = {
  address: Address;
  borrower: Address;
  cosigner: Address;
  amount: bigint;
  termDays: number;
  createdAt: bigint;
  rentPayer: Address;
  expiresAt: bigint;
};

// ---------- PDAs ----------
export const findRequestPda = (pool: Address, borrower: Address) =>
  getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [enc.encode("request"), addr.encode(pool), addr.encode(borrower)],
  });

export const findPoolPda = (mint: Address) =>
  getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [enc.encode("pool"), addr.encode(mint)] });
export const findVaultPda = (pool: Address) =>
  getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [enc.encode("vault"), addr.encode(pool)] });
export const findMemberPda = (pool: Address, wallet: Address) =>
  getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [enc.encode("member"), addr.encode(pool), addr.encode(wallet)],
  });
export const findPersonPda = (pool: Address, personId: Uint8Array) => {
  if (personId.length !== 32) throw new Error("A person id is 32 bytes.");
  return getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [enc.encode("person"), addr.encode(pool), personId],
  });
};
export const findLoanPda = (pool: Address, id: bigint) => {
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, id, true);
  return getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [enc.encode("loan"), addr.encode(pool), idBytes],
  });
};
export const findEscrowPda = (loan: Address) =>
  getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [enc.encode("escrow"), addr.encode(loan)] });
export async function findAta(owner: Address, mint: Address): Promise<Address> {
  const [a] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return a;
}

const unwrap = <T>(o: Option<T>): T | null => (isSome(o) ? o.value : null);
const toParams = (d: PoolParamsData): PoolParams => ({
  gatekeeperNetwork: d.gatekeeperNetwork,
  maxLoan: d.maxLoan,
  maxTermDays: d.maxTermDays,
  graceDays: d.graceDays,
  maxGuaranteesPerMember: d.maxGuaranteesPerMember,
  cosignerEscrowBps: d.cosignerEscrowBps,
  issuer: d.issuer,
  timelockSeconds: d.timelockSeconds,
  recoveryAuthority: d.recoveryAuthority,
  pauseAuthority: d.pauseAuthority,
  recoveryDelaySeconds: d.recoveryDelaySeconds,
  requestTtlSeconds: d.requestTtlSeconds,
  firstLoanCap: d.firstLoanCap,
  loanCapStep: d.loanCapStep,
  cooldownSeconds: d.cooldownSeconds,
  maxExposurePerPerson: d.maxExposurePerPerson,
  disbursementWindowSeconds: d.disbursementWindowSeconds,
  disbursementCapPerWindow: d.disbursementCapPerWindow,
  defaultBanSeconds: d.defaultBanSeconds,
  lateBanSeconds: d.lateBanSeconds,
  cosignerBanSeconds: d.cosignerBanSeconds,
});
const STATUSES: LoanStatus[] = ["Active", "Repaid", "Defaulted", "RepaidLate"];

type ReadRpc = Rpc<GetAccountInfoApi>;

async function fetchChecked(rpc: ReadRpc, a: Address, kind: GoodfaithAccount) {
  const acc = await fetchEncodedAccount(rpc, a, { commitment: "confirmed" });
  if (!acc.exists) return null;
  if (acc.programAddress !== PROGRAM_ID) throw new Error("Account has an unexpected owner.");
  if (identifyGoodfaithAccount(acc) !== kind) throw new Error("Account has an unexpected type.");
  return acc;
}

/**
 * Load the canonical pool and refuse anything else (audit GF-05: anyone can create a pool for a mint).
 * Checks address, mint (classic SPL Token only), gatekeeper network and authority against env config.
 */
export async function fetchCanonicalPool(rpc: ReadRpc): Promise<Pool | null> {
  if (CONFIG_ERRORS.length) throw new Error(`App isn't configured: ${CONFIG_ERRORS.join(" ")}`);
  const [derived] = await findPoolPda(POOL_MINT);
  const expected = POOL_ADDRESS ? address(POOL_ADDRESS) : derived;
  if (expected !== derived) throw new Error("Configured pool address doesn't match the pool for this mint.");
  const pool = await fetchPool(rpc, expected);
  if (!pool) return null;
  if (pool.mint !== POOL_MINT) throw new Error("This pool uses a different token than expected. Not safe to use.");
  if (!GATEKEEPER_NETWORK) throw new Error("App isn't configured: set NEXT_PUBLIC_GATEKEEPER_NETWORK.");
  if (pool.gatekeeperNetwork !== GATEKEEPER_NETWORK)
    throw new Error("This pool uses a different verification network than expected. Not safe to use.");
  if (!POOL_AUTHORITY) throw new Error('App isn\'t configured: set NEXT_PUBLIC_POOL_AUTHORITY (an address, or "none" if frozen).');
  const wantAuthority = POOL_AUTHORITY === "none" ? null : address(POOL_AUTHORITY);
  if (pool.authority !== wantAuthority) throw new Error("This pool is controlled by a different authority than expected. Not safe to use.");
  const mintAcc = await fetchEncodedAccount(rpc, pool.mint, { commitment: "confirmed" });
  if (!mintAcc.exists || mintAcc.programAddress !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error("Only the classic SPL Token program is supported.");
  }
  return pool;
}

/** A pool by address, with owner and type checks but none of the canonical-pool pinning. */
export async function fetchPool(rpc: ReadRpc, a: Address): Promise<Pool | null> {
  const acc = await fetchChecked(rpc, a, GoodfaithAccount.Pool);
  if (!acc) return null;
  const d = decodePool(acc).data;
  return {
    address: a,
    authority: unwrap(d.authority),
    pendingAuthority: unwrap(d.pendingAuthority),
    mint: d.mint,
    vault: d.vault,
    gatekeeperNetwork: d.gatekeeperNetwork,
    maxLoan: d.maxLoan,
    maxTermDays: d.maxTermDays,
    graceDays: d.graceDays,
    maxGuaranteesPerMember: d.maxGuaranteesPerMember,
    cosignerEscrowBps: d.cosignerEscrowBps,
    loanCount: d.loanCount,
    totalDonated: d.totalDonated,
    totalLent: d.totalLent,
    totalRepaid: d.totalRepaid,
    totalRecovered: d.totalRecovered,
    totalLost: d.totalLost,
    issuer: d.issuer,
    timelockSeconds: d.timelockSeconds,
    pendingParams: isSome(d.pendingParams) ? toParams(d.pendingParams.value) : null,
    paramsEffectiveAt: d.paramsEffectiveAt,
    windDownAt: unwrap(d.windDownAt),
    successor: unwrap(d.successor),
    activeLoans: d.activeLoans,
    totalSwept: d.totalSwept,
    recoveryAuthority: d.recoveryAuthority,
    pauseAuthority: d.pauseAuthority,
    paused: d.paused,
    windowStart: d.windowStart,
    windowDisbursed: d.windowDisbursed,
    pendingClaims: d.pendingClaims,
    recoveryDelaySeconds: d.recoveryDelaySeconds,
    requestTtlSeconds: d.requestTtlSeconds,
    firstLoanCap: d.firstLoanCap,
    loanCapStep: d.loanCapStep,
    cooldownSeconds: d.cooldownSeconds,
    maxExposurePerPerson: d.maxExposurePerPerson,
    disbursementWindowSeconds: d.disbursementWindowSeconds,
    disbursementCapPerWindow: d.disbursementCapPerWindow,
    defaultBanSeconds: d.defaultBanSeconds,
    lateBanSeconds: d.lateBanSeconds,
    cosignerBanSeconds: d.cosignerBanSeconds,
  };
}

/** New loans and guarantees are possible: not paused and not winding down. */
export const lendingOpen = (pool: Pool, now: bigint) => !pool.paused && !windingDown(pool, now);

/** True once an announced wind-down has taken effect: no new loans or donations. */
export const windingDown = (pool: Pool, now: bigint) => pool.windDownAt !== null && now >= pool.windDownAt;

function toPerson(address: Address, d: PersonData): Person {
  return {
    address,
    personId: Array.from(d.personId, (x) => x.toString(16).padStart(2, "0")).join(""),
    wallet: d.wallet,
    activeLoan: unwrap(d.activeLoan),
    activeGuarantees: d.activeGuarantees,
    activeGuaranteeAmount: d.activeGuaranteeAmount,
    completedLoans: d.completedLoans,
    ineligibleUntil: d.ineligibleUntil,
    restrictedUntil: d.restrictedUntil,
    pendingWallet: unwrap(d.pendingWallet),
    pendingWalletAt: d.pendingWalletAt,
  };
}

export async function fetchPerson(rpc: ReadRpc, a: Address): Promise<Person | null> {
  const acc = await fetchChecked(rpc, a, GoodfaithAccount.Person);
  return acc ? toPerson(a, decodePerson(acc).data) : null;
}

/** The wallet's membership merged with its person's standing; null when the wallet never joined. */
export async function fetchMember(rpc: ReadRpc, pool: Address, wallet: Address): Promise<Member | null> {
  const [a] = await findMemberPda(pool, wallet);
  const acc = await fetchChecked(rpc, a, GoodfaithAccount.Member);
  if (!acc) return null;
  const d = decodeMember(acc).data;
  const person = await fetchPerson(rpc, d.person);
  if (!person) throw new Error("Member account points at a missing person.");
  return {
    address: a,
    wallet: d.wallet,
    person: d.person,
    retired: d.retired,
    activeLoan: person.activeLoan,
    activeGuarantees: person.activeGuarantees,
    ineligibleUntil: person.ineligibleUntil,
    restrictedUntil: person.restrictedUntil,
    completedLoans: person.completedLoans,
    ineligible: !eligibleAt(person, BigInt(Math.floor(Date.now() / 1000))),
  };
}

/** The co-signer's current wallet (the escrow goes there), which differs from `loan.cosigner` after a wallet replacement. */
export async function cosignerWalletOf(rpc: ReadRpc, loan: Loan): Promise<Address> {
  const p = await fetchPerson(rpc, loan.cosignerPerson);
  return p?.wallet ?? loan.cosigner;
}
export async function fetchLoan(rpc: ReadRpc, loan: Address): Promise<Loan | null> {
  const acc = await fetchChecked(rpc, loan, GoodfaithAccount.Loan);
  return acc ? toLoan(loan, decodeLoan(acc).data) : null;
}
export async function fetchLoanById(rpc: ReadRpc, pool: Address, id: bigint): Promise<Loan | null> {
  const [a] = await findLoanPda(pool, id);
  return fetchLoan(rpc, a);
}

type ScanRpc = Rpc<GetProgramAccountsApi>;
type Filter = { dataSize: bigint } | { memcmp: { offset: bigint; bytes: string; encoding: "base58" } };

/** Program accounts matching `filters`, as encoded accounts ready for the Codama decoders. */
async function scanProgramAccounts(rpc: ScanRpc, filters: Filter[]): Promise<EncodedAccount[]> {
  const res = await rpc.getProgramAccounts(PROGRAM_ID, { encoding: "base64", commitment: "confirmed", filters: filters as never }).send();
  return res.map((item) => {
    const data = new Uint8Array(getBase64Encoder().encode(item.account.data[0]));
    return {
      address: item.pubkey,
      data,
      executable: false,
      lamports: item.account.lamports,
      programAddress: PROGRAM_ID,
      space: BigInt(data.length),
    };
  });
}

function decodeAll<T>(accounts: EncodedAccount[], decode: (acc: EncodedAccount) => T): T[] {
  const out: T[] = [];
  for (const acc of accounts) {
    try {
      out.push(decode(acc));
    } catch {
      // ignore accounts that fail to decode
    }
  }
  return out;
}

const b58 = (bytes: ReadonlyUint8Array) => getBase58Decoder().decode(bytes);

function toLoan(address: Address, d: LoanData): Loan {
  return {
    address,
    id: d.id,
    borrower: d.borrower,
    cosigner: d.cosigner,
    borrowerPerson: d.borrowerPerson,
    cosignerPerson: d.cosignerPerson,
    rentPayer: d.rentPayer,
    principal: d.principal,
    repaid: d.repaid,
    escrowed: d.escrowed,
    openedAt: d.openedAt,
    dueAt: d.dueAt,
    graceDays: d.graceDays,
    status: STATUSES[Number(d.status)] ?? "Active",
    closedAt: d.closedAt,
    refundPending: d.refundPending,
  };
}

/** Loan account layout: the person keys sit after escrow_bump, at 157 (borrower) and 189 (co-signer). */
const LOAN_BORROWER_PERSON_OFFSET = 157n;
const LOAN_COSIGNER_PERSON_OFFSET = 189n;

/**
 * Every loan a person took or co-signed, newest first, whichever wallet they used at the time. Two
 * getProgramAccounts calls instead of scanning loan ids one by one; `fetchLoanById` remains the
 * fallback for an RPC that disables getProgramAccounts.
 */
export async function fetchLoansForPerson(rpc: ScanRpc, pool: Pool, person: Address): Promise<Loan[]> {
  const disc = b58(getLoanDiscriminatorBytes());
  const base: Filter[] = [{ dataSize: BigInt(getLoanSize()) }, { memcmp: { offset: 0n, bytes: disc, encoding: "base58" } }];
  const [asBorrower, asCosigner] = await Promise.all([
    scanProgramAccounts(rpc, [...base, { memcmp: { offset: LOAN_BORROWER_PERSON_OFFSET, bytes: person, encoding: "base58" } }]),
    scanProgramAccounts(rpc, [...base, { memcmp: { offset: LOAN_COSIGNER_PERSON_OFFSET, bytes: person, encoding: "base58" } }]),
  ]);
  const seen = new Set<Address>();
  const out: Loan[] = [];
  for (const l of decodeAll([...asBorrower, ...asCosigner], (acc) => toLoan(acc.address, decodeLoan(acc).data))) {
    if (seen.has(l.address)) continue;
    seen.add(l.address);
    // Loans from another pool for the same wallet are filtered by their PDA.
    const [expected] = await findLoanPda(pool.address, l.id);
    if (expected === l.address) out.push(l);
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The loans of the person behind `wallet`; empty when the wallet never joined. */
export async function fetchLoansFor(rpc: ScanRpc & ReadRpc, pool: Pool, wallet: Address): Promise<Loan[]> {
  const m = await fetchMember(rpc, pool.address, wallet);
  return m ? fetchLoansForPerson(rpc, pool, m.person) : [];
}

/** The pool's newest loans (any borrower), for the public fund page. */
export async function fetchRecentLoans(rpc: ScanRpc, pool: Pool, limit = 50): Promise<Loan[]> {
  const disc = b58(getLoanDiscriminatorBytes());
  const accounts = await scanProgramAccounts(rpc, [
    { dataSize: BigInt(getLoanSize()) },
    { memcmp: { offset: 0n, bytes: disc, encoding: "base58" } },
  ]);
  const out: Loan[] = [];
  for (const l of decodeAll(accounts, (acc) => toLoan(acc.address, decodeLoan(acc).data))) {
    const [expected] = await findLoanPda(pool.address, l.id);
    if (expected === l.address) out.push(l);
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, limit);
}

function toRequest(address: Address, d: LoanRequestData): LoanRequest {
  return {
    address,
    borrower: d.borrower,
    cosigner: d.cosigner,
    amount: d.amount,
    termDays: d.termDays,
    createdAt: d.createdAt,
    rentPayer: d.rentPayer,
    expiresAt: d.expiresAt,
  };
}

export async function fetchRequest(rpc: ReadRpc, pool: Address, borrower: Address): Promise<LoanRequest | null> {
  const [a] = await findRequestPda(pool, borrower);
  const acc = await fetchChecked(rpc, a, GoodfaithAccount.LoanRequest);
  return acc ? toRequest(a, decodeLoanRequest(acc).data) : null;
}

/**
 * Requests waiting on this co-signer in this pool. The request account has no pool field, so the
 * memcmp (cosigner at offset 8 + 32) is followed by a PDA check against the pool.
 */
export async function fetchRequestsForCosigner(rpc: ScanRpc, pool: Address, cosigner: Address): Promise<LoanRequest[]> {
  const disc = b58(getLoanRequestDiscriminatorBytes());
  const accounts = await scanProgramAccounts(rpc, [
    { memcmp: { offset: 0n, bytes: disc, encoding: "base58" } },
    { memcmp: { offset: 40n, bytes: cosigner, encoding: "base58" } },
  ]);
  const out: LoanRequest[] = [];
  for (const r of decodeAll(accounts, (acc) => toRequest(acc.address, decodeLoanRequest(acc).data))) {
    const [expected] = await findRequestPda(pool, r.borrower);
    if (expected === r.address) out.push(r);
  }
  return out;
}

/**
 * Person layout: Borsh options are variable-length, so the `pending_wallet` tag sits at 100 while `active_loan`
 * is None and at 132 while it is Some (8 + 32 + 32 + 1 or 33 + 1 + 8 + 2 + 8 + 8).
 */
const PERSON_PENDING_TAG_OFFSETS = [100n, 132n];

/** Every person of this pool with a wallet recovery in flight (the cranker finalises the due ones). */
export async function fetchPendingRecoveries(rpc: ScanRpc, pool: Address): Promise<Person[]> {
  const disc = b58(getPersonDiscriminatorBytes());
  const some = b58(new Uint8Array([1]));
  const scans = await Promise.all(
    PERSON_PENDING_TAG_OFFSETS.map((offset) =>
      scanProgramAccounts(rpc, [
        { memcmp: { offset: 0n, bytes: disc, encoding: "base58" } },
        { memcmp: { offset, bytes: some, encoding: "base58" } },
      ]),
    ),
  );
  const seen = new Set<Address>();
  const out: Person[] = [];
  for (const p of decodeAll(scans.flat(), (acc) => toPerson(acc.address, decodePerson(acc).data))) {
    if (seen.has(p.address) || !p.pendingWallet) continue;
    seen.add(p.address);
    const [expected] = await findPersonPda(pool, new Uint8Array(getBase16Encoder().encode(p.personId)));
    if (expected === p.address) out.push(p);
  }
  return out;
}

/** Every open request in this pool (the cranker closes the expired ones). */
export async function fetchRequests(rpc: ScanRpc, pool: Address): Promise<LoanRequest[]> {
  const disc = b58(getLoanRequestDiscriminatorBytes());
  const accounts = await scanProgramAccounts(rpc, [{ memcmp: { offset: 0n, bytes: disc, encoding: "base58" } }]);
  const out: LoanRequest[] = [];
  for (const r of decodeAll(accounts, (acc) => toRequest(acc.address, decodeLoanRequest(acc).data))) {
    const [expected] = await findRequestPda(pool, r.borrower);
    if (expected === r.address) out.push(r);
  }
  return out;
}

// ---------- instructions ----------
// Signer accounts are passed as no-op signers: transactions are compiled first and
// signed afterwards by the wallet (and the fee payer), see tx.ts.

export async function donateIx(a: { donor: Address; pool: Pool; amount: bigint }): Promise<Instruction> {
  return getDonateInstruction(
    {
      donor: signer(a.donor),
      pool: a.pool.address,
      mint: a.pool.mint,
      vault: a.pool.vault,
      donorToken: await findAta(a.donor, a.pool.mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      amount: a.amount,
    },
    cfg,
  );
}

/** Joining: the wallet, the fee payer and the pool's issuer all sign (the issuer vouches for `personId`). */
export async function registerMemberIx(a: {
  wallet: Address;
  payer: Address;
  issuer: Address;
  pool: Pool;
  gatewayToken: Address;
  personId: Uint8Array;
}): Promise<Instruction> {
  const [member] = await findMemberPda(a.pool.address, a.wallet);
  const [person] = await findPersonPda(a.pool.address, a.personId);
  return getRegisterMemberInstruction(
    {
      wallet: signer(a.wallet),
      payer: signer(a.payer),
      issuer: signer(a.issuer),
      pool: a.pool.address,
      person,
      member,
      gatewayToken: a.gatewayToken,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      personId: a.personId,
    },
    cfg,
  );
}

/**
 * Wallet recovery, step one: the new wallet, the issuer and the recovery authority sign. Nothing moves until
 * `pool.recoveryDelaySeconds` pass without a veto from the old wallet.
 */
export async function proposeRebindIx(a: {
  newWallet: Address;
  issuer: Address;
  recoveryAuthority: Address;
  pool: Pool;
  person: Person;
  gatewayToken: Address;
}): Promise<Instruction> {
  return getProposeRebindInstruction(
    {
      newWallet: signer(a.newWallet),
      issuer: signer(a.issuer),
      recoveryAuthority: signer(a.recoveryAuthority),
      pool: a.pool.address,
      person: a.person.address,
      gatewayToken: a.gatewayToken,
    },
    cfg,
  );
}

/** The old wallet (or the authority) stops a pending recovery. */
export function vetoRebindIx(a: { signer: Address; pool: Pool; person: Person }): Instruction {
  return getVetoRebindInstruction({ signer: signer(a.signer), pool: a.pool.address, person: a.person.address }, cfg);
}

/** Wallet recovery, step two, by anyone once the delay has passed; `payer` covers the new Member's rent. */
export async function finalizeRebindIx(a: { payer: Address; pool: Pool; person: Person }): Promise<Instruction> {
  if (!a.person.pendingWallet) throw new Error("No recovery is pending for this person.");
  const [oldMember] = await findMemberPda(a.pool.address, a.person.wallet);
  const [newMember] = await findMemberPda(a.pool.address, a.person.pendingWallet);
  return getFinalizeRebindInstruction(
    {
      payer: signer(a.payer),
      pool: a.pool.address,
      person: a.person.address,
      newWallet: a.person.pendingWallet,
      oldMember,
      newMember,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
    },
    cfg,
  );
}

/**
 * Anyone moves a closed loan's leftover escrow to the co-signer's current wallet (`cosignerWalletOf`) and closes
 * the escrow account. The token account must exist; create it in the same transaction when needed.
 */
export async function claimEscrowIx(a: {
  claimer: Address;
  pool: Pool;
  loan: Loan;
  cosignerWallet: Address;
}): Promise<{ ix: Instruction; cosignerToken: Address }> {
  const [escrow] = await findEscrowPda(a.loan.address);
  const cosignerToken = await findAta(a.cosignerWallet, a.pool.mint);
  const ix = getClaimEscrowInstruction(
    {
      claimer: signer(a.claimer),
      pool: a.pool.address,
      mint: a.pool.mint,
      loan: a.loan.address,
      escrow,
      cosignerPerson: a.loan.cosignerPerson,
      cosignerToken,
      rentPayer: a.loan.rentPayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    cfg,
  );
  return { ix, cosignerToken };
}

/** Anyone closes an expired request; its rent goes back to whoever paid it. */
export function closeExpiredRequestIx(a: { closer: Address; pool: Address; request: LoanRequest }): Instruction {
  return getCloseExpiredRequestInstruction(
    { closer: signer(a.closer), pool: a.pool, request: a.request.address, rentPayer: a.request.rentPayer },
    cfg,
  );
}

/** The pause authority (or the authority) stops new lending at once; only the authority resumes. */
export function pauseLendingIx(a: { signer: Address; pool: Pool }): Instruction {
  return getPauseLendingInstruction({ signer: signer(a.signer), pool: a.pool.address }, cfg);
}
export function resumeLendingIx(a: { authority: Address; pool: Pool }): Instruction {
  return getResumeLendingInstruction({ authority: signer(a.authority), pool: a.pool.address }, cfg);
}

/** Permissionless: applies a scheduled settings change once its timelock has elapsed. */
export function applyParamsIx(pool: Pool): Instruction {
  return getApplyParamsInstruction({ pool: pool.address }, cfg);
}

/** Permissionless: moves the vault balance to the successor once a wind-down is in effect and no loan is open. */
export function sweepToSuccessorIx(pool: Pool): Instruction {
  if (!pool.successor) throw new Error("No successor has been named.");
  return getSweepToSuccessorInstruction(
    { pool: pool.address, mint: pool.mint, vault: pool.vault, successorVault: pool.successor, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    cfg,
  );
}

export async function requestLoanIx(a: {
  payer: Address;
  borrower: Address;
  /** The borrower's person account (`Member.person`). */
  borrowerPerson: Address;
  pool: Pool;
  borrowerGatewayToken: Address;
  amount: bigint;
  termDays: number;
  cosigner: Address;
}): Promise<Instruction> {
  const [cosignerMember] = await findMemberPda(a.pool.address, a.cosigner);
  const [request] = await findRequestPda(a.pool.address, a.borrower);
  return getRequestLoanInstruction(
    {
      payer: signer(a.payer),
      borrower: signer(a.borrower),
      pool: a.pool.address,
      mint: a.pool.mint,
      borrowerPerson: a.borrowerPerson,
      cosignerMember,
      borrowerGatewayToken: a.borrowerGatewayToken,
      request,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      amount: a.amount,
      termDays: a.termDays,
      cosigner: a.cosigner,
    },
    cfg,
  );
}

export async function cosignLoanIx(a: {
  payer: Address;
  pool: Pool;
  request: LoanRequest;
  /** Person accounts of the two wallets (`Member.person`). */
  borrowerPerson: Address;
  cosignerPerson: Address;
  borrowerGatewayToken: Address;
  cosignerGatewayToken: Address;
  /** The co-signer's own open loan (`Member.activeLoan`), required when they have one. */
  cosignerActiveLoan?: Address | null;
  /** exactly what the co-signer was shown; the program rejects the tx if the request no longer matches */
  expectedAmount: bigint;
  expectedTermDays: number;
  maxEscrow: bigint;
}): Promise<{ ix: Instruction; borrowerToken: Address }> {
  const p = a.pool;
  const r = a.request;
  const [loan] = await findLoanPda(p.address, p.loanCount);
  const [escrow] = await findEscrowPda(loan);
  const borrowerToken = await findAta(r.borrower, p.mint);
  const ix = getCosignLoanInstruction(
    {
      payer: signer(a.payer),
      cosigner: signer(r.cosigner),
      pool: p.address,
      mint: p.mint,
      vault: p.vault,
      request: r.address,
      requestRentPayer: r.rentPayer,
      borrowerPerson: a.borrowerPerson,
      cosignerPerson: a.cosignerPerson,
      borrowerToken,
      cosignerToken: await findAta(r.cosigner, p.mint),
      loan,
      escrow,
      borrowerGatewayToken: a.borrowerGatewayToken,
      cosignerGatewayToken: a.cosignerGatewayToken,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      cosignerActiveLoan: a.cosignerActiveLoan ?? undefined,
      expectedAmount: a.expectedAmount,
      expectedTermDays: a.expectedTermDays,
      maxEscrow: a.maxEscrow,
    },
    cfg,
  );
  return { ix, borrowerToken };
}

export function cancelRequestIx(a: { canceller: Address; pool: Address; request: LoanRequest }): Instruction {
  return getCancelRequestInstruction(
    { canceller: signer(a.canceller), pool: a.pool, request: a.request.address, rentPayer: a.request.rentPayer },
    cfg,
  );
}

/** Repayment never touches the co-signer's token account; the closing payment leaves the escrow to be claimed. */
export async function repayIx(a: { payer: Address; pool: Pool; loan: Loan; amount: bigint }): Promise<Instruction> {
  const [escrow] = await findEscrowPda(a.loan.address);
  return getRepayInstruction(
    {
      payer: signer(a.payer),
      pool: a.pool.address,
      mint: a.pool.mint,
      vault: a.pool.vault,
      loan: a.loan.address,
      escrow,
      payerToken: await findAta(a.payer, a.pool.mint),
      borrowerPerson: a.loan.borrowerPerson,
      cosignerPerson: a.loan.cosignerPerson,
      rentPayer: a.loan.rentPayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      amount: a.amount,
    },
    cfg,
  );
}

/** Anyone may call this once a loan is past due plus its grace period. Leftover escrow waits to be claimed. */
export async function markDefaultIx(a: { caller: Address; pool: Pool; loan: Loan }): Promise<Instruction> {
  const [escrow] = await findEscrowPda(a.loan.address);
  return getMarkDefaultInstruction(
    {
      caller: signer(a.caller),
      pool: a.pool.address,
      mint: a.pool.mint,
      vault: a.pool.vault,
      loan: a.loan.address,
      escrow,
      borrowerPerson: a.loan.borrowerPerson,
      cosignerPerson: a.loan.cosignerPerson,
      rentPayer: a.loan.rentPayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    cfg,
  );
}

/** Program error codes per docs/spec.md order (Anchor custom errors start at 6000). */
const ERROR_NAMES = [
  "AmountZero",
  "OverLoanCap",
  "TermTooLong",
  "SelfCosign",
  "BorrowerHasLoan",
  "CosignerLimit",
  "Ineligible",
  "InvalidGatewayToken",
  "InsufficientFund",
  "OverRepay",
  "LoanNotActive",
  "NotYetDefaultable",
  "Unauthorized",
  "InvalidBps",
  "MathOverflow",
  "RequestMismatch",
  "EscrowTooHigh",
  "InvalidParams",
  "WalletNotBound",
  "WalletRetired",
  "WindingDown",
  "NotWindingDown",
  "TimelockNotElapsed",
  "NothingPending",
  "LoansOutstanding",
  "InvalidSuccessor",
  "Paused",
  "RequestExpired",
  "RequestNotExpired",
  "OverPersonalCap",
  "OverExposure",
  "OverDisbursementCap",
  "ReciprocalGuarantee",
  "RecoveryPending",
  "RecoveryNotPending",
  "RecoveryDelayNotElapsed",
  "NothingToClaim",
  "TimelockBelowMinimum",
  "MissingCosignerLoan",
];
const ERROR_COPY: Record<string, string> = {
  AmountZero: "Enter an amount greater than zero.",
  OverLoanCap: "That is more than the loan limit.",
  TermTooLong: "That term is longer than allowed.",
  SelfCosign: "A borrower and their co-signer must be different people.",
  BorrowerHasLoan: "This borrower already has an open loan.",
  CosignerLimit: "This co-signer is already backing as many loans as allowed.",
  Ineligible: "This member can't take part right now.",
  InvalidGatewayToken: "A valid verification pass is needed (it may have expired).",
  InsufficientFund: "The fund doesn't have enough to cover this loan right now.",
  OverRepay: "That is more than what is still owed.",
  LoanNotActive: "This loan is no longer active.",
  NotYetDefaultable: "The grace period hasn't ended yet.",
  Unauthorized: "You're not allowed to do that.",
  InvalidBps: "Invalid setting.",
  MathOverflow: "Number too large.",
  RequestMismatch: "The request changed. Please review again.",
  EscrowTooHigh: "The escrow is higher than what you were shown. Please review again.",
  InvalidParams: "Invalid settings.",
  WalletNotBound: "This wallet is no longer the one linked to your membership.",
  WalletRetired: "This wallet was replaced and can't be used any more.",
  WindingDown: "The fund is winding down, so it no longer takes new loans or donations.",
  NotWindingDown: "The fund isn't winding down.",
  TimelockNotElapsed: "This change isn't in effect yet.",
  NothingPending: "There is no scheduled change.",
  LoansOutstanding: "Some loans are still open.",
  InvalidSuccessor: "That isn't a valid successor account.",
  Paused: "New loans are paused right now. Repayments still work.",
  RequestExpired: "This request has expired. Ask for a new one.",
  RequestNotExpired: "This request hasn't expired yet.",
  OverPersonalCap: "That is more than your current loan limit. It grows as you repay loans on time.",
  OverExposure: "That would put you or your co-signer over the limit of open loans and guarantees.",
  OverDisbursementCap: "The fund has lent its limit for now. Try again later.",
  ReciprocalGuarantee: "You and your co-signer can't guarantee each other at the same time.",
  RecoveryPending: "A wallet recovery is already in progress.",
  RecoveryNotPending: "No wallet recovery is in progress.",
  RecoveryDelayNotElapsed: "The recovery waiting period hasn't passed yet.",
  NothingToClaim: "Nothing to claim on this loan.",
  TimelockBelowMinimum: "The notice period can't be set below the minimum.",
  MissingCosignerLoan: "The co-signer's open loan must be included. Please try again.",
};

const WALLET_REJECTED = /user rejected|rejected the request|user denied|user declined|declined by user|rejected by user/i;

/** Plain copy for a fee-sponsor (Kora or proxy) error. */
export function sponsorErrorCopy(e: KoraError): string {
  switch (e.code) {
    case KORA_CODES.RATE_LIMITED:
      return "Too many requests. Wait a moment and try again.";
    case KORA_CODES.UNREACHABLE:
    case KORA_CODES.TIMEOUT:
      return "The fee sponsor didn't respond. Try again in a minute.";
    case KORA_CODES.NOT_CONFIGURED:
    case KORA_CODES.AUTH:
      return "The fee sponsor isn't set up correctly.";
  }
  const m = e.message;
  if (/not (in the )?allow|disallowed|not allowed/i.test(m)) return "The fee sponsor doesn't cover this kind of transaction.";
  if (/lamports|outflow/i.test(m)) return "This transaction needs more SOL than the fee sponsor covers.";
  if (/signature/i.test(m)) return "Too many signers for the fee sponsor.";
  const short = m.length > 120 ? m.slice(0, 120) + "..." : m;
  return `The fee sponsor declined this: ${short}`;
}

/** Turn any thrown error into a short human message. */
export function friendlyError(e: unknown): string {
  if (e instanceof KoraError) return sponsorErrorCopy(e);
  const msg = e instanceof Error ? e.message : String(e);
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(msg) ?? /"Custom":\s*(\d+)/.exec(msg);
  if (m) {
    const code = /0x/i.test(m[0]) ? parseInt(m[1]!, 16) : Number(m[1]);
    const name = ERROR_NAMES[code - 6000];
    if (name) return ERROR_COPY[name] ?? name;
  }
  // Only a wallet prompt rejection counts as "cancelled"; program logs may mention cancel_request.
  const fromChain = /^(Simulation|Transaction) failed/.test(msg);
  if (!fromChain && WALLET_REJECTED.test(msg)) return "You cancelled the request.";
  if (/insufficient/i.test(msg)) return "Not enough balance for this.";
  if (/blockhash/i.test(msg)) return "That took too long. Please try again.";
  return msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
}
