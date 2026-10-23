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
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import {
  GoodfaithAccount,
  identifyGoodfaithAccount,
  decodeLoan,
  decodeMember,
  decodePool,
  getDonateInstruction,
  getRequestLoanInstruction,
  getCosignLoanInstruction,
  getCancelRequestInstruction,
  decodeLoanRequest,
  type LoanRequest as LoanRequestData,
  getLoanRequestDiscriminatorBytes,
  getRegisterMemberInstruction,
  getRepayInstruction,
} from "@/generated";
import { GATEKEEPER_NETWORK, POOL_ADDRESS, POOL_AUTHORITY, POOL_MINT, PROGRAM_ID } from "./config";

export { TOKEN_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS };

const enc = getUtf8Encoder();
const addr = getAddressEncoder();
const cfg = { programAddress: PROGRAM_ID };
const signer = (a: Address) => createNoopSigner(a);

// ---------- types ----------
export type LoanStatus = "Active" | "Repaid" | "Defaulted";

export type Pool = {
  address: Address;
  authority: Address | null;
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
};

export type Member = {
  address: Address;
  wallet: Address;
  activeLoan: Address | null;
  activeGuarantees: number;
  ineligible: boolean;
};

export type Loan = {
  graceDays: number;
  address: Address;
  id: bigint;
  borrower: Address;
  cosigner: Address;
  rentPayer: Address;
  principal: bigint;
  repaid: bigint;
  escrowed: bigint;
  openedAt: bigint;
  dueAt: bigint;
  status: LoanStatus;
};

export type LoanRequest = {
  address: Address;
  borrower: Address;
  cosigner: Address;
  amount: bigint;
  termDays: number;
  createdAt: bigint;
  rentPayer: Address;
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

const unwrap = (o: Option<Address>): Address | null => (isSome(o) ? o.value : null);
const STATUSES: LoanStatus[] = ["Active", "Repaid", "Defaulted"];

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
  const [derived] = await findPoolPda(POOL_MINT);
  const expected = POOL_ADDRESS ? address(POOL_ADDRESS) : derived;
  if (expected !== derived) throw new Error("Configured pool address doesn't match the pool for this mint.");
  const pool = await fetchPoolAt(rpc, expected);
  if (!pool) return null;
  if (pool.mint !== POOL_MINT) throw new Error("This pool uses a different token than expected. Not safe to use.");
  if (!GATEKEEPER_NETWORK) throw new Error("App isn't configured: set NEXT_PUBLIC_GATEKEEPER_NETWORK.");
  if (pool.gatekeeperNetwork !== GATEKEEPER_NETWORK) throw new Error("This pool uses a different verification network than expected. Not safe to use.");
  if (!POOL_AUTHORITY) throw new Error("App isn't configured: set NEXT_PUBLIC_POOL_AUTHORITY (an address, or \"none\" if frozen).");
  const wantAuthority = POOL_AUTHORITY === "none" ? null : address(POOL_AUTHORITY);
  if (pool.authority !== wantAuthority) throw new Error("This pool is controlled by a different authority than expected. Not safe to use.");
  const mintAcc = await fetchEncodedAccount(rpc, pool.mint, { commitment: "confirmed" });
  if (!mintAcc.exists || mintAcc.programAddress !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error("Only the classic SPL Token program is supported.");
  }
  return pool;
}

async function fetchPoolAt(rpc: ReadRpc, a: Address): Promise<Pool | null> {
  const acc = await fetchChecked(rpc, a, GoodfaithAccount.Pool);
  if (!acc) return null;
  const d = decodePool(acc).data;
  return {
    address: a,
    authority: unwrap(d.authority),
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
  };
}
export async function fetchMember(rpc: ReadRpc, pool: Address, wallet: Address): Promise<Member | null> {
  const [a] = await findMemberPda(pool, wallet);
  const acc = await fetchChecked(rpc, a, GoodfaithAccount.Member);
  if (!acc) return null;
  const d = decodeMember(acc).data;
  return {
    address: a,
    wallet: d.wallet,
    activeLoan: unwrap(d.activeLoan),
    activeGuarantees: d.activeGuarantees,
    ineligible: d.ineligible,
  };
}
export async function fetchLoan(rpc: ReadRpc, loan: Address): Promise<Loan | null> {
  const acc = await fetchChecked(rpc, loan, GoodfaithAccount.Loan);
  if (!acc) return null;
  const d = decodeLoan(acc).data;
  return {
    address: loan,
    id: d.id,
    borrower: d.borrower,
    cosigner: d.cosigner,
    rentPayer: d.rentPayer,
    principal: d.principal,
    repaid: d.repaid,
    escrowed: d.escrowed,
    openedAt: d.openedAt,
    dueAt: d.dueAt,
    graceDays: d.graceDays,
    status: STATUSES[Number(d.status)] ?? "Active",
  };
}
export async function fetchLoanById(rpc: ReadRpc, pool: Address, id: bigint): Promise<Loan | null> {
  const [a] = await findLoanPda(pool, id);
  return fetchLoan(rpc, a);
}

/** Find a wallet's loans (as borrower or co-signer) among the most recent loans. */
export async function fetchLoansFor(rpc: ReadRpc, pool: Pool, wallet: Address, max = 25): Promise<Loan[]> {
  const out: Loan[] = [];
  const start = pool.loanCount;
  for (let i = 0n; i < BigInt(max) && start - 1n - i >= 0n; i++) {
    const l = await fetchLoanById(rpc, pool.address, start - 1n - i);
    if (l && (l.borrower === wallet || l.cosigner === wallet)) out.push(l);
  }
  return out;
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
  };
}

export async function fetchRequest(rpc: ReadRpc, pool: Address, borrower: Address): Promise<LoanRequest | null> {
  const [a] = await findRequestPda(pool, borrower);
  const acc = await fetchChecked(rpc, a, GoodfaithAccount.LoanRequest);
  return acc ? toRequest(a, decodeLoanRequest(acc).data) : null;
}

/** Requests waiting on this co-signer (memcmp on the cosigner field, after 8-byte discriminator + 32-byte borrower). */
export async function fetchRequestsForCosigner(
  rpc: Rpc<GetProgramAccountsApi>,
  cosigner: Address,
): Promise<LoanRequest[]> {
  const disc = getBase58Decoder().decode(getLoanRequestDiscriminatorBytes());
  const res = await rpc
    .getProgramAccounts(PROGRAM_ID, {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0n, bytes: disc as never, encoding: "base58" } },
        { memcmp: { offset: 40n, bytes: cosigner as never, encoding: "base58" } },
      ],
    })
    .send();
  const out: LoanRequest[] = [];
  for (const item of res) {
    try {
      const data = new Uint8Array(getBase64Encoder().encode(item.account.data[0]));
      const acc = { address: item.pubkey, data, executable: false, lamports: item.account.lamports, programAddress: PROGRAM_ID, space: BigInt(data.length) };
      out.push(toRequest(item.pubkey, decodeLoanRequest(acc as never).data));
    } catch {
      // ignore accounts that fail to decode
    }
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

export async function registerMemberIx(a: { wallet: Address; payer: Address; pool: Pool; gatewayToken: Address }): Promise<Instruction> {
  const [member] = await findMemberPda(a.pool.address, a.wallet);
  return getRegisterMemberInstruction(
    {
      wallet: signer(a.wallet),
      payer: signer(a.payer),
      pool: a.pool.address,
      member,
      gatewayToken: a.gatewayToken,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
    },
    cfg,
  );
}

export async function requestLoanIx(a: {
  payer: Address;
  borrower: Address;
  pool: Pool;
  borrowerGatewayToken: Address;
  amount: bigint;
  termDays: number;
  cosigner: Address;
}): Promise<Instruction> {
  const [borrowerMember] = await findMemberPda(a.pool.address, a.borrower);
  const [request] = await findRequestPda(a.pool.address, a.borrower);
  return getRequestLoanInstruction(
    {
      payer: signer(a.payer),
      borrower: signer(a.borrower),
      pool: a.pool.address,
      mint: a.pool.mint,
      borrowerMember,
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
  borrowerGatewayToken: Address;
  cosignerGatewayToken: Address;
  /** exactly what the co-signer was shown; the program rejects the tx if the request no longer matches */
  expectedAmount: bigint;
  expectedTermDays: number;
  maxEscrow: bigint;
}): Promise<{ ix: Instruction; borrowerToken: Address }> {
  const p = a.pool;
  const r = a.request;
  const [borrowerMember] = await findMemberPda(p.address, r.borrower);
  const [cosignerMember] = await findMemberPda(p.address, r.cosigner);
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
      borrowerMember,
      cosignerMember,
      borrowerToken,
      cosignerToken: await findAta(r.cosigner, p.mint),
      loan,
      escrow,
      borrowerGatewayToken: a.borrowerGatewayToken,
      cosignerGatewayToken: a.cosignerGatewayToken,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
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

export async function repayIx(a: { payer: Address; pool: Pool; loan: Loan; amount: bigint }): Promise<Instruction> {
  const [borrowerMember] = await findMemberPda(a.pool.address, a.loan.borrower);
  const [cosignerMember] = await findMemberPda(a.pool.address, a.loan.cosigner);
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
      cosignerToken: await findAta(a.loan.cosigner, a.pool.mint),
      borrowerMember,
      cosignerMember,
      rentPayer: a.loan.rentPayer,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      amount: a.amount,
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
];
const ERROR_COPY: Record<string, string> = {
  AmountZero: "Enter an amount greater than zero.",
  OverLoanCap: "That is more than the loan limit.",
  TermTooLong: "That term is longer than allowed.",
  SelfCosign: "You can't co-sign your own loan.",
  BorrowerHasLoan: "This borrower already has an open loan.",
  CosignerLimit: "This co-signer is already backing as many loans as allowed.",
  Ineligible: "This member can't take part right now.",
  InvalidGatewayToken: "A valid Civic Pass is needed (it may have expired).",
  InsufficientFund: "The fund doesn't have enough to cover this loan right now.",
  OverRepay: "That is more than what is still owed.",
  LoanNotActive: "This loan is no longer active.",
  NotYetDefaultable: "Not yet.",
  Unauthorized: "Not allowed.",
  InvalidBps: "Invalid setting.",
  MathOverflow: "Number too large.",
  RequestMismatch: "The request changed. Please review again.",
  EscrowTooHigh: "The escrow is higher than what you were shown. Please review again.",
  InvalidParams: "Invalid settings.",
};

/** Turn any thrown error into a short human message. */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(msg) ?? /"Custom":\s*(\d+)/.exec(msg);
  if (m) {
    const code = /0x/i.test(m[0]) ? parseInt(m[1]!, 16) : Number(m[1]);
    const name = ERROR_NAMES[code - 6000];
    if (name) return ERROR_COPY[name] ?? name;
  }
  if (/reject|denied|cancel/i.test(msg)) return "You cancelled the request.";
  if (/insufficient/i.test(msg)) return "Not enough balance for this.";
  if (/blockhash/i.test(msg)) return "That took too long. Please try again.";
  return msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
}
