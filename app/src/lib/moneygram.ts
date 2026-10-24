/**
 * MoneyGram Ramps: USDC cash-out and cash-in at MoneyGram counters, through MoneyGram's web widget.
 *
 * The browser asks `/api/moneygram/session` for a widget session; that route calls MoneyGram with the server-side
 * secret (`MONEYGRAM_SK`), which never reaches the browser. The widget runs MoneyGram's own identity check and quote.
 * On a cash-out it asks the app to send USDC to an address it names; `checkCashOut` checks that request against the
 * pool's mint and the cluster, and `planCashOut` builds the transfer, before the wallet is asked to sign. On a cash-in
 * MoneyGram sends USDC to the wallet and the app signs nothing. No Next.js imports, so everything here is unit-testable.
 */
import {
  address,
  createNoopSigner,
  fetchEncodedAccount,
  getUtf8Encoder,
  type Address,
  type GetAccountInfoApi,
  type Instruction,
  type Rpc,
} from "@solana/kit";
import { AccountState, decodeToken, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { parseAmount } from "./format";
import type { Cluster } from "./config";
import { findAta } from "./program";
import { planTokenSend } from "./send";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Widget and SDK origin (client-safe). Empty: the cash card is hidden. */
export const RAMPS_ORIGIN = (process.env.NEXT_PUBLIC_RAMPS_ORIGIN ?? "").trim().replace(/\/+$/, "");
export const RAMPS_SDK_PATH = "/sdk/index.global.js";
export const DEFAULT_SESSIONS_URL = "https://playground.xramps.moneygram.com/api/v1/sessions";
export const MEMO_PROGRAM: Address = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Longer memos are refused rather than sent: nothing MoneyGram documents needs more. */
export const MAX_MEMO_BYTES = 128;

// Shapes of the Ramps web SDK (the global `window.RampsSDK`), as the Solana Foundation's MoneyGram template uses them.
export interface RampsWallet {
  address: string;
  chain: "solana";
  asset: "USDC";
  walletType: "custodial" | "non-custodial";
  displayName?: string;
}

export interface OnChainTransaction {
  chain: string;
  to: string;
  amount: string;
  asset: string;
  requiredNetwork?: "mainnet" | "testnet";
  tokenAddress?: string;
  tokenDecimals?: number;
  memo?: string;
  rawTransaction?: unknown;
}

export interface TransactionRecord {
  id: string;
  type: "off-ramp" | "on-ramp";
  status: string;
  chain: string;
  asset: string;
  walletAddress: string;
  amount: number;
  referenceNumber?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RampsConfig {
  container: HTMLElement;
  sessionToken: string;
  widgetUrl?: string;
  wallet?: RampsWallet;
  transaction?: {
    type: "off-ramp" | "on-ramp";
    asset?: "USDC";
    amount?: number;
    destinationCountry?: string;
    destinationCurrency?: string;
    destinationSubdivision?: string;
  };
  theme?: "dark" | "light";
  onSignTransaction?: (tx: OnChainTransaction) => Promise<string>;
  onReady?: () => void;
  onComplete?: (transaction: TransactionRecord) => void;
  onError?: (error: { transactionId?: string; reason: string }) => void;
  onClose?: () => void;
}

export interface RampsInstance {
  open(): void;
  close(): void;
  destroy(): void;
}

export type CreateRamps = (config: RampsConfig) => RampsInstance;

export type RampsSession = { sessionToken: string; sessionId: string; widgetUrl: string };

declare global {
  interface Window {
    RampsSDK?: { createRamps: CreateRamps };
  }
}

export type CashOut = { to: Address; amount: bigint; memo: string | null };

/**
 * What a cash-out request from the widget may ask for: USDC of the pool's mint on this cluster, a positive amount
 * with no more decimals than the mint has (never rounded), to someone other than the wallet itself.
 */
export function checkCashOut(
  tx: OnChainTransaction,
  ctx: { wallet: Address; mint: Address; decimals: number; cluster: Cluster },
): { ok: true; cashOut: CashOut } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (tx.chain?.toLowerCase() !== "solana") return no(`MoneyGram asked for a transfer on ${tx.chain}, not Solana.`);
  if (tx.asset?.toUpperCase() !== "USDC") return no(`MoneyGram asked for ${tx.asset}, not USDC.`);
  if (tx.tokenAddress !== undefined && tx.tokenAddress !== ctx.mint)
    return no("MoneyGram asked for a different token than this fund's USDC.");
  if (tx.tokenDecimals !== undefined && tx.tokenDecimals !== ctx.decimals)
    return no("MoneyGram's token decimals don't match this fund's USDC.");
  if (tx.requiredNetwork === "mainnet" && ctx.cluster !== "mainnet-beta") return no("MoneyGram expects mainnet; this app runs on devnet.");
  if (tx.requiredNetwork === "testnet" && ctx.cluster === "mainnet-beta")
    return no("MoneyGram expects a test network; this app runs on mainnet.");
  let to: Address;
  try {
    to = address(tx.to);
  } catch {
    return no("MoneyGram's destination isn't a Solana address.");
  }
  if (to === ctx.wallet) return no("MoneyGram's destination is your own wallet.");
  const amount = typeof tx.amount === "string" ? parseAmount(tx.amount, ctx.decimals) : null;
  if (amount === null || amount <= 0n) return no(`MoneyGram asked for an amount this app can't send exactly (${String(tx.amount)}).`);
  const memo = tx.memo?.trim() ? tx.memo.trim() : null;
  if (memo && getUtf8Encoder().encode(memo).length > MAX_MEMO_BYTES) return no("MoneyGram's transfer reference is too long.");
  return { ok: true, cashOut: { to, amount, memo } };
}

export type CashOutPlan = {
  /** False when the transfer carries MoneyGram's reference (the fee sponsor refuses memos) or creates an account. */
  sponsor: boolean;
  instructions: (feePayer: Address) => Promise<Instruction[]>;
};

/**
 * The transfer MoneyGram asked for. Its destination can be a token account (what the sandbox sends: MoneyGram's own
 * USDC account) or a wallet. A token account is paid into directly, and only if it holds this mint; deriving an
 * associated account from it, as one would for a wallet, would send the USDC where MoneyGram never looks.
 */
export async function planCashOut(
  rpc: Rpc<GetAccountInfoApi>,
  wallet: Address,
  mint: Address,
  decimals: number,
  c: CashOut,
): Promise<CashOutPlan> {
  const account = await fetchEncodedAccount(rpc, c.to, { commitment: "confirmed" });
  const memo = c.memo ? [memoInstruction(c.memo)] : [];
  if (account.exists && account.programAddress === TOKEN_PROGRAM_ADDRESS) {
    const token = decodeToken(account).data;
    if (token.mint !== mint) throw new Error("MoneyGram's destination holds a different token than this fund's USDC.");
    if (token.state !== AccountState.Initialized) throw new Error("MoneyGram's destination account can't receive USDC right now.");
    const transfer = getTransferCheckedInstruction({
      source: await findAta(wallet, mint),
      mint,
      destination: c.to,
      authority: createNoopSigner(wallet),
      amount: c.amount,
      decimals,
    });
    return { sponsor: !c.memo, instructions: async () => [transfer, ...memo] };
  }
  if (account.exists && account.programAddress !== SYSTEM_PROGRAM)
    throw new Error("MoneyGram's destination is neither a wallet nor a USDC account.");
  const plan = await planTokenSend(rpc, wallet, c.to, mint, c.amount);
  return { sponsor: plan.sponsor && !c.memo, instructions: async (payer) => [...(await plan.instructions(payer)), ...memo] };
}

/** An SPL Memo instruction with no signers: the reference MoneyGram matches the deposit by, when it asks for one. */
export function memoInstruction(memo: string): Instruction {
  return { programAddress: MEMO_PROGRAM, accounts: [], data: new Uint8Array(getUtf8Encoder().encode(memo)) };
}

export type SessionEnv = { secretKey?: string; sessionsUrl?: string; origin?: string };

export function sessionEnv(env: Record<string, string | undefined> = process.env): SessionEnv {
  return {
    secretKey: env.MONEYGRAM_SK?.trim() || undefined,
    sessionsUrl: env.MONEYGRAM_SESSIONS_URL?.trim() || DEFAULT_SESSIONS_URL,
    origin: (env.NEXT_PUBLIC_RAMPS_ORIGIN ?? "").trim().replace(/\/+$/, "") || undefined,
  };
}

/**
 * Creates a widget session with MoneyGram. Only the token, id and widget URL go back to the browser, and the widget
 * URL must be on the configured widget origin, so a changed upstream cannot point the app's page at another host.
 */
export async function createRampsSession(
  env: SessionEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; session: RampsSession } | { ok: false; status: number; error: string }> {
  if (!env.secretKey || !env.origin) return { ok: false, status: 503, error: "MoneyGram cash access is not configured on the server." };
  let res: Response;
  try {
    res = await fetchImpl(env.sessionsUrl ?? DEFAULT_SESSIONS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.secretKey },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, status: 502, error: "MoneyGram didn't answer. Try again in a minute." };
  }
  const data = (await res.json().catch(() => null)) as Partial<RampsSession> | null;
  if (!res.ok || !data) return { ok: false, status: 502, error: `MoneyGram refused the session (HTTP ${res.status}).` };
  const { sessionToken, sessionId, widgetUrl } = data;
  if (typeof sessionToken !== "string" || typeof sessionId !== "string" || typeof widgetUrl !== "string")
    return { ok: false, status: 502, error: "MoneyGram's session reply was incomplete." };
  let widget: URL;
  try {
    widget = new URL(widgetUrl);
  } catch {
    return { ok: false, status: 502, error: "MoneyGram's widget address was invalid." };
  }
  if (widget.origin !== env.origin) return { ok: false, status: 502, error: "MoneyGram's widget is not on the configured origin." };
  return { ok: true, session: { sessionToken, sessionId, widgetUrl } };
}
