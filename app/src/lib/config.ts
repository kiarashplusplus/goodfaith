import { address, type Address } from "@solana/kit";

export const CLUSTER = (process.env.NEXT_PUBLIC_CLUSTER ?? "devnet") as "devnet" | "mainnet-beta";
export const CHAIN = CLUSTER === "devnet" ? "solana:devnet" : "solana:mainnet";
export const IS_DEVNET = CLUSTER === "devnet";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
export const KORA_URL = process.env.NEXT_PUBLIC_KORA_URL || "";

export const POOL_MINT: Address = address(
  process.env.NEXT_PUBLIC_POOL_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);
// Default is the id in the program's target/deploy keypair; override once deployed.
export const PROGRAM_ID: Address = address(
  process.env.NEXT_PUBLIC_PROGRAM_ID || "BM71D4Kdnq3Mtc2cqDuMBLyYguFihDqsjk9btdTWtoRd",
);
export const GATEKEEPER_NETWORK: string = process.env.NEXT_PUBLIC_GATEKEEPER_NETWORK || "";
/** Canonical pool address. Anyone can create a pool for a mint, so the app pins one. Defaults to the PDA for POOL_MINT. */
export const POOL_ADDRESS: string = process.env.NEXT_PUBLIC_POOL_ADDRESS || "";
/** Expected pool authority: a public key, or "none" for a frozen pool. Required. */
export const POOL_AUTHORITY: string = process.env.NEXT_PUBLIC_POOL_AUTHORITY || "";

/** Pool mint decimals (USDC = 6). */
export const TOKEN_DECIMALS = 6;
export const TOKEN_SYMBOL = "USDC";

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}${IS_DEVNET ? "?cluster=devnet" : ""}`;
}
export function explorerAddress(a: string): string {
  return `https://explorer.solana.com/address/${a}${IS_DEVNET ? "?cluster=devnet" : ""}`;
}
