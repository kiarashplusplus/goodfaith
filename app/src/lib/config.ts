import { address, type Address } from "@solana/kit";

/**
 * App configuration from NEXT_PUBLIC_* variables.
 * Parsing never throws at import time: a bad value is recorded in `CONFIG_ERRORS`
 * (shown by the pool warning banner, which also disables loan actions) and the
 * safe default is used instead.
 */
export type Cluster = "devnet" | "mainnet-beta";

export type RawConfig = {
  cluster?: string;
  rpcUrl?: string;
  koraUrl?: string;
  poolMint?: string;
  programId?: string;
  gatekeeperNetwork?: string;
  poolAddress?: string;
  poolAuthority?: string;
};

export type AppConfig = {
  cluster: Cluster;
  rpcUrl: string;
  koraUrl: string;
  poolMint: Address;
  programId: Address;
  /** Civic gatekeeper network, or "" to rely on the value stored in the pool. */
  gatekeeperNetwork: string;
  /** Pinned pool address, or "" for the PDA of the mint. */
  poolAddress: string;
  /** Expected pool authority: an address, "none" for a frozen pool, or "" if unset. */
  poolAuthority: string;
  errors: string[];
};

export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
/** Devnet USDC. */
export const DEFAULT_POOL_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** The id in the program's target/deploy keypair; override once deployed elsewhere. */
export const DEFAULT_PROGRAM_ID = "BM71D4Kdnq3Mtc2cqDuMBLyYguFihDqsjk9btdTWtoRd";

const clean = (v: string | undefined) => (v ?? "").trim();

function isAddress(v: string): boolean {
  try {
    address(v);
    return true;
  } catch {
    return false;
  }
}

function requiredAddress(name: string, value: string | undefined, fallback: string, errors: string[]): Address {
  const v = clean(value);
  if (!v) return address(fallback);
  if (isAddress(v)) return address(v);
  errors.push(`${name} is not a valid address.`);
  return address(fallback);
}

/** "" (off), an absolute http(s) URL (Kora itself), or a path such as "/api/sponsor" (this app's proxy). */
function koraUrlOf(value: string | undefined, errors: string[]): string {
  const v = clean(value);
  if (!v || v.startsWith("/")) return v;
  try {
    const u = new URL(v);
    if (u.protocol === "http:" || u.protocol === "https:") return v;
  } catch {
    // reported below
  }
  errors.push('NEXT_PUBLIC_KORA_URL must be an http(s) URL or a path such as "/api/sponsor".');
  return "";
}

function optionalAddress(name: string, value: string | undefined, errors: string[]): string {
  const v = clean(value);
  if (!v || isAddress(v)) return v;
  errors.push(`${name} is not a valid address.`);
  return "";
}

export function parseConfig(raw: RawConfig): AppConfig {
  const errors: string[] = [];

  let cluster: Cluster = "devnet";
  const c = clean(raw.cluster);
  if (c === "devnet" || c === "mainnet-beta") cluster = c;
  else if (c) errors.push(`NEXT_PUBLIC_CLUSTER must be "devnet" or "mainnet-beta" (got "${c}").`);

  const authority = clean(raw.poolAuthority);
  let poolAuthority = authority;
  if (authority && authority !== "none" && !isAddress(authority)) {
    errors.push('NEXT_PUBLIC_POOL_AUTHORITY must be an address or "none".');
    poolAuthority = "";
  }

  return {
    cluster,
    rpcUrl: clean(raw.rpcUrl) || DEFAULT_RPC_URL,
    koraUrl: koraUrlOf(raw.koraUrl, errors),
    poolMint: requiredAddress("NEXT_PUBLIC_POOL_MINT", raw.poolMint, DEFAULT_POOL_MINT, errors),
    programId: requiredAddress("NEXT_PUBLIC_PROGRAM_ID", raw.programId, DEFAULT_PROGRAM_ID, errors),
    gatekeeperNetwork: optionalAddress("NEXT_PUBLIC_GATEKEEPER_NETWORK", raw.gatekeeperNetwork, errors),
    poolAddress: optionalAddress("NEXT_PUBLIC_POOL_ADDRESS", raw.poolAddress, errors),
    poolAuthority,
    errors,
  };
}

// Each variable is read literally so Next can inline it at build time.
const config = parseConfig({
  cluster: process.env.NEXT_PUBLIC_CLUSTER,
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL,
  koraUrl: process.env.NEXT_PUBLIC_KORA_URL,
  poolMint: process.env.NEXT_PUBLIC_POOL_MINT,
  programId: process.env.NEXT_PUBLIC_PROGRAM_ID,
  gatekeeperNetwork: process.env.NEXT_PUBLIC_GATEKEEPER_NETWORK,
  poolAddress: process.env.NEXT_PUBLIC_POOL_ADDRESS,
  poolAuthority: process.env.NEXT_PUBLIC_POOL_AUTHORITY,
});

export const CLUSTER: Cluster = config.cluster;
export const CHAIN = CLUSTER === "devnet" ? "solana:devnet" : "solana:mainnet";
export const IS_DEVNET = CLUSTER === "devnet";

export const RPC_URL = config.rpcUrl;
export const KORA_URL = config.koraUrl;

export const POOL_MINT: Address = config.poolMint;
export const PROGRAM_ID: Address = config.programId;
export const GATEKEEPER_NETWORK: string = config.gatekeeperNetwork;
/** Canonical pool address. Anyone can create a pool for a mint, so the app pins one. Defaults to the PDA for POOL_MINT. */
export const POOL_ADDRESS: string = config.poolAddress;
/** Expected pool authority: a public key, or "none" for a frozen pool. Required. */
export const POOL_AUTHORITY: string = config.poolAuthority;
/** Configuration problems found at startup. Non-empty means loan actions stay off. */
export const CONFIG_ERRORS: readonly string[] = config.errors;

/** Pool mint decimals (USDC = 6). */
export const TOKEN_DECIMALS = 6;
export const TOKEN_SYMBOL = "USDC";

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}${IS_DEVNET ? "?cluster=devnet" : ""}`;
}
export function explorerAddress(a: string): string {
  return `https://explorer.solana.com/address/${a}${IS_DEVNET ? "?cluster=devnet" : ""}`;
}
