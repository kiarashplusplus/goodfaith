/**
 * What the fee sponsor will pay for. Kora enforces an allow-list of programs and a lamport outflow cap; this is the
 * finer policy in front of it: the transaction is decoded and every instruction must be one of
 *   - a Good Faith program instruction (the program enforces its own rules),
 *   - a compute-budget instruction,
 *   - an associated-token-account creation, of the pool's mint only, whose account a Good Faith instruction in the
 *     same transaction uses (the borrower's or co-signer's token account) or whose owner signs the transaction (their
 *     own account); on its own (no Good Faith instruction) it is sponsored for members only (the route checks),
 *   - a token transfer signed by the wallet itself (never a close: the rent of an account the sponsor created would go
 *     to the wallet, a repeatable way to collect the sponsor's money),
 * with Kora as the fee payer and the wallet the sponsorship is attributed to as the next signer; further signers (the
 * issuer and the recovery authority co-sign registrations and recovery proposals) are allowed only when a Good Faith
 * instruction is present. Anything else (a system transfer, a memo, an account for a stranger, another mint, a lookup
 * table) is refused before it reaches Kora.
 * Per-wallet caps (sponsored transactions per day, token accounts created in total) bound what one person can cost.
 * The fund-wide daily budget is split into three lanes, so that exhausting one never blocks another:
 *   - protected: settling, repaying, paying back, releasing and collecting what is owed, waiving, vetoing or
 *     finalising a recovery (what a member needs to protect themselves or pay what they owe);
 *   - onboarding: a wallet's first sponsored transaction, or joining (small: this is where a crowd of strangers lands);
 *   - member: everything else a known wallet does.
 * Both caps are reserved in the store before the transaction is forwarded, so two requests in flight cannot both pass.
 * No Next.js imports, so everything here is unit-testable.
 */
import {
  AccountRole,
  decompileTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isSignerRole,
  type Address,
  type Instruction,
} from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, TokenInstruction } from "@solana-program/token";
import {
  CLAIM_ESCROW_DISCRIMINATOR,
  COLLECT_RECOVERY_DISCRIMINATOR,
  FINALIZE_REBIND_DISCRIMINATOR,
  REGISTER_MEMBER_DISCRIMINATOR,
  REPAY_DISCRIMINATOR,
  RESTITUTE_DISCRIMINATOR,
  SETTLE_DISCRIMINATOR,
  VETO_REBIND_DISCRIMINATOR,
  WAIVE_REIMBURSEMENT_DISCRIMINATOR,
} from "../generated";

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;

export type CreatedAta = { ata: Address; owner: Address };
export type Inspection =
  | {
      ok: true;
      wallet: Address;
      atas: CreatedAta[];
      goodFaithInstructions: number;
      /** Every Good Faith instruction is one a member needs to protect themselves or pay what they owe. */
      protectedOnly: boolean;
      /** The transaction registers a membership. */
      registers: boolean;
    }
  | { ok: false; reason: string };

/** Instructions that keep their own budget: nobody exhausting onboarding can stop a member settling up or objecting. */
const PROTECTED = [
  SETTLE_DISCRIMINATOR,
  REPAY_DISCRIMINATOR,
  RESTITUTE_DISCRIMINATOR,
  CLAIM_ESCROW_DISCRIMINATOR,
  COLLECT_RECOVERY_DISCRIMINATOR,
  WAIVE_REIMBURSEMENT_DISCRIMINATOR,
  VETO_REBIND_DISCRIMINATOR,
  FINALIZE_REBIND_DISCRIMINATOR,
];
const startsWith = (data: ArrayLike<number>, prefix: ArrayLike<number>) =>
  data.length >= prefix.length && Array.prototype.every.call(prefix, (b: number, i: number) => data[i] === b);
export type Policy = {
  payer: Address;
  programId: Address;
  /** The pool's mint; token accounts of any other are not sponsored. */ mint?: Address;
};

/** A transaction that only creates token accounts is sponsored for members: the route checks the wallet's membership. */
export const needsMembership = (i: Inspection & { ok: true }) => i.goodFaithInstructions === 0 && i.atas.length > 0;

/** Decodes a base64 wire transaction and checks it against the sponsorship policy. */
export function inspectTransaction(base64: string, policy: Policy): Inspection {
  let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
    compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    return { ok: false, reason: "The transaction could not be decoded." };
  }
  if ("addressTableLookups" in compiled && compiled.addressTableLookups?.length) {
    return { ok: false, reason: "Address lookup tables are not sponsored." };
  }
  const signers = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
  if (signers[0] !== policy.payer) return { ok: false, reason: "The fee payer is not the sponsor." };
  if (signers.length < 2) return { ok: false, reason: "A sponsored transaction needs the wallet's signature." };
  const wallet = signers[1]!;
  let instructions: readonly Instruction[];
  try {
    instructions = decompileTransactionMessage(compiled).instructions;
  } catch {
    return { ok: false, reason: "The transaction could not be decoded." };
  }
  if (!instructions.length) return { ok: false, reason: "The transaction is empty." };

  const goodFaithAccounts = new Set<Address>();
  const atas: CreatedAta[] = [];
  let goodFaithInstructions = 0;
  let protectedOnly = true;
  let registers = false;
  const pending: { ix: Instruction; what: string }[] = [];
  for (const ix of instructions) {
    const accounts = ix.accounts ?? [];
    const data = ix.data ?? new Uint8Array();
    if (ix.programAddress === policy.programId) {
      goodFaithInstructions++;
      if (!PROTECTED.some((d) => startsWith(data, d))) protectedOnly = false;
      if (startsWith(data, REGISTER_MEMBER_DISCRIMINATOR)) registers = true;
      for (const a of accounts) goodFaithAccounts.add(a.address);
      continue;
    }
    if (ix.programAddress === COMPUTE_BUDGET_PROGRAM) continue;
    if (ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      const kind = data.length === 0 ? 0 : data[0];
      if (kind !== 0 && kind !== 1) return { ok: false, reason: "Only token account creation is sponsored on the token-account program." };
      const [payer, ata, owner, ataMint] = accounts;
      if (!payer || !ata || !owner || !ataMint) return { ok: false, reason: "Malformed token account creation." };
      if (payer.address !== policy.payer) return { ok: false, reason: "Token account rent must be paid by the sponsor." };
      if (policy.mint && ataMint.address !== policy.mint)
        return { ok: false, reason: "Only token accounts of the fund's mint are sponsored." };
      atas.push({ ata: ata.address, owner: owner.address });
      if (owner.address !== wallet) pending.push({ ix, what: ata.address });
      continue;
    }
    if (ix.programAddress === TOKEN_PROGRAM_ADDRESS) {
      const kind = data[0];
      let authority;
      if (kind === TokenInstruction.Transfer) authority = accounts[2];
      else if (kind === TokenInstruction.TransferChecked) authority = accounts[3];
      else if (kind === TokenInstruction.CloseAccount)
        return {
          ok: false,
          reason: "Closing a token account is not sponsored: its rent would go to the wallet. Close it from your own wallet.",
        };
      else return { ok: false, reason: "Only token transfers are sponsored on the token program." };
      if (!authority || !isSignerRole(authority.role) || authority.address !== wallet)
        return { ok: false, reason: "Token instructions must be signed by the wallet itself." };
      continue;
    }
    return { ok: false, reason: "This program is not sponsored." };
  }
  for (const p of pending) {
    if (!goodFaithAccounts.has(p.what as Address))
      return { ok: false, reason: "A token account for someone else is only sponsored as part of a Good Faith transaction." };
  }
  if (signers.length > 2 && !goodFaithInstructions)
    return { ok: false, reason: "Extra signers are only sponsored on a Good Faith transaction." };
  if (!goodFaithInstructions && !atas.length && !instructions.some((ix) => ix.programAddress === TOKEN_PROGRAM_ADDRESS)) {
    return { ok: false, reason: "Nothing to sponsor." };
  }
  return { ok: true, wallet, atas, goodFaithInstructions, protectedOnly: goodFaithInstructions > 0 && protectedOnly, registers };
}

export type SponsorLimits = { dailyTxs: number; totalAtas: number };
export type Usage = { day: string; dayTxs: number; atasTotal: number };

export const utcDay = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);

/** Rolls the daily counter and decides whether one more transaction creating `newAtas` accounts fits the caps. */
export function checkCaps(
  usage: Usage | null,
  newAtas: number,
  limits: SponsorLimits,
  nowMs: number,
): { ok: true; next: Usage } | { ok: false; reason: string } {
  const day = utcDay(nowMs);
  const base: Usage = usage && usage.day === day ? usage : { day, dayTxs: 0, atasTotal: usage?.atasTotal ?? 0 };
  if (base.dayTxs >= limits.dailyTxs) return { ok: false, reason: "This wallet has used today's sponsored transactions." };
  if (base.atasTotal + newAtas > limits.totalAtas) return { ok: false, reason: "This wallet has used its sponsored token accounts." };
  return { ok: true, next: { day, dayTxs: base.dayTxs + 1, atasTotal: base.atasTotal + newAtas } };
}

/** Limits from the environment: SPONSOR_DAILY_TX_PER_WALLET (default 40), SPONSOR_ATA_PER_WALLET (default 12). */
export function limitsFromEnv(env: Record<string, string | undefined>): SponsorLimits {
  return {
    dailyTxs: Number(env.SPONSOR_DAILY_TX_PER_WALLET) || 40,
    totalAtas: Number(env.SPONSOR_ATA_PER_WALLET) || 12,
  };
}

/** The fund-wide daily budget of one lane: sponsored transactions, and wallets sponsored for the first time. */
export type BudgetLimits = { dailyTxs: number; dailyNewWallets: number };
export type Lane = "protected" | "onboarding" | "member";
export const LANES: Lane[] = ["protected", "onboarding", "member"];

/** Which budget a transaction draws on. A protected operation keeps its lane even from a wallet new to the sponsor. */
export function laneOf(i: Inspection & { ok: true }, newWallet: boolean): Lane {
  if (i.protectedOnly) return "protected";
  if (newWallet || i.registers) return "onboarding";
  return "member";
}

/** The store key of a lane's counters for a day. */
export const budgetKey = (day: string, lane: Lane) => `${day}:${lane}`;

/**
 * The budget arithmetic on its own (the stores apply it as one conditional update). A new wallet is one the store
 * has no usage row for yet.
 */
export function checkBudget(
  txs: Usage | null,
  wallets: Usage | null,
  newWallet: boolean,
  limits: BudgetLimits,
  nowMs: number,
): { ok: true; nextTxs: Usage; nextWallets: Usage } | { ok: false; reason: string } {
  const day = utcDay(nowMs);
  const t: Usage = txs && txs.day === day ? txs : { day, dayTxs: 0, atasTotal: 0 };
  const w: Usage = wallets && wallets.day === day ? wallets : { day, dayTxs: 0, atasTotal: 0 };
  if (t.dayTxs >= limits.dailyTxs) return { ok: false, reason: "The fee sponsor has used today's budget." };
  if (newWallet && w.dayTxs >= limits.dailyNewWallets)
    return { ok: false, reason: "The fee sponsor has welcomed today's share of new wallets." };
  return {
    ok: true,
    nextTxs: { ...t, dayTxs: t.dayTxs + 1 },
    nextWallets: { ...w, dayTxs: w.dayTxs + (newWallet ? 1 : 0) },
  };
}

/**
 * Each lane's daily budget, sized for the pilot (a few hundred members) rather than for growth:
 *   protected   SPONSOR_PROTECTED_DAILY_TX (default 400); no limit on new wallets (a friend paying back is welcome)
 *   onboarding  SPONSOR_ONBOARDING_DAILY_TX (default 60), SPONSOR_DAILY_NEW_WALLETS (default 20)
 *   member      SPONSOR_DAILY_BUDGET_TX (default 300)
 * At about 0.0025 SOL of rent and fees for a new wallet's first transaction, the onboarding lane costs at most a few
 * dollars a day however many strangers arrive.
 */
export function budgetFromEnv(env: Record<string, string | undefined>): Record<Lane, BudgetLimits> {
  const n = (k: string, d: number) => Number(env[k]) || d;
  return {
    protected: { dailyTxs: n("SPONSOR_PROTECTED_DAILY_TX", 400), dailyNewWallets: Number.MAX_SAFE_INTEGER },
    onboarding: { dailyTxs: n("SPONSOR_ONBOARDING_DAILY_TX", 60), dailyNewWallets: n("SPONSOR_DAILY_NEW_WALLETS", 20) },
    member: { dailyTxs: n("SPONSOR_DAILY_BUDGET_TX", 300), dailyNewWallets: 0 },
  };
}

/** Lanes past this share of their daily transactions are reported by the health route and logged as a warning. */
export const BUDGET_ALERT_SHARE = 0.8;

export { AccountRole };
