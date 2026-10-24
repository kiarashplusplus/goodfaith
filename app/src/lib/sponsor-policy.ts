/**
 * What the fee sponsor will pay for. Kora enforces an allow-list of programs and a lamport outflow cap; this is the
 * finer policy in front of it: the transaction is decoded and every instruction must be one of
 *   - a Good Faith program instruction (the program enforces its own rules),
 *   - a compute-budget instruction,
 *   - an associated-token-account creation whose account a Good Faith instruction in the same transaction uses
 *     (the borrower's or co-signer's token account) or whose owner signs the transaction (their own account),
 *   - a token transfer or close signed by the wallet itself,
 * with Kora as the fee payer and the wallet the sponsorship is attributed to as the next signer; further signers (the
 * issuer and the recovery authority co-sign registrations and recovery proposals) are allowed only when a Good Faith
 * instruction is present. Anything else (a system transfer, a memo, an account for a stranger, a lookup table) is
 * refused before it reaches Kora.
 * Per-wallet caps (sponsored transactions per day, token accounts created in total) bound what one person can cost;
 * a global daily budget (transactions, and wallets sponsored for the first time) bounds what a crowd can.
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

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111" as Address;

export type CreatedAta = { ata: Address; owner: Address };
export type Inspection = { ok: true; wallet: Address; atas: CreatedAta[]; goodFaithInstructions: number } | { ok: false; reason: string };

/** Decodes a base64 wire transaction and checks it against the sponsorship policy. */
export function inspectTransaction(base64: string, policy: { payer: Address; programId: Address }): Inspection {
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
  const pending: { ix: Instruction; what: string }[] = [];
  for (const ix of instructions) {
    const accounts = ix.accounts ?? [];
    const data = ix.data ?? new Uint8Array();
    if (ix.programAddress === policy.programId) {
      goodFaithInstructions++;
      for (const a of accounts) goodFaithAccounts.add(a.address);
      continue;
    }
    if (ix.programAddress === COMPUTE_BUDGET_PROGRAM) continue;
    if (ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      const kind = data.length === 0 ? 0 : data[0];
      if (kind !== 0 && kind !== 1) return { ok: false, reason: "Only token account creation is sponsored on the token-account program." };
      const [payer, ata, owner] = accounts;
      if (!payer || !ata || !owner) return { ok: false, reason: "Malformed token account creation." };
      if (payer.address !== policy.payer) return { ok: false, reason: "Token account rent must be paid by the sponsor." };
      atas.push({ ata: ata.address, owner: owner.address });
      if (owner.address !== wallet) pending.push({ ix, what: ata.address });
      continue;
    }
    if (ix.programAddress === TOKEN_PROGRAM_ADDRESS) {
      const kind = data[0];
      let authority;
      if (kind === TokenInstruction.Transfer) authority = accounts[2];
      else if (kind === TokenInstruction.TransferChecked) authority = accounts[3];
      else if (kind === TokenInstruction.CloseAccount) authority = accounts[2];
      else return { ok: false, reason: "Only token transfers and account closes are sponsored on the token program." };
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
  return { ok: true, wallet, atas, goodFaithInstructions };
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

/** The fund-wide daily budget: sponsored transactions, and wallets sponsored for the first time. */
export type BudgetLimits = { dailyTxs: number; dailyNewWallets: number };

/**
 * The global counters live in two usage rows (`GLOBAL_TX_ROW`, `GLOBAL_WALLETS_ROW`); `dayTxs` carries today's count
 * in both. A new wallet is one the store has no usage row for yet.
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

/** SPONSOR_DAILY_BUDGET_TX (default 2000) and SPONSOR_DAILY_NEW_WALLETS (default 200). */
export function budgetFromEnv(env: Record<string, string | undefined>): BudgetLimits {
  return {
    dailyTxs: Number(env.SPONSOR_DAILY_BUDGET_TX) || 2000,
    dailyNewWallets: Number(env.SPONSOR_DAILY_NEW_WALLETS) || 200,
  };
}

export { AccountRole };
