/**
 * Co-sign link: carries only the pool and borrower public keys. The co-sign page reads the
 * on-chain LoanRequest (PDA ["request", pool, borrower]) and shows its terms.
 */
import { address, type Address } from "@solana/kit";

export const COSIGN_PATH = "/cosign";

export type CosignRef = { pool: Address; borrower: Address };

export type ParsedCosignLink =
  | { ok: true; ref: CosignRef }
  | { ok: false; reason: "missing" | "invalid" };

export function buildCosignLink(origin: string, ref: { pool: string; borrower: string }): string {
  const q = new URLSearchParams({ pool: ref.pool, borrower: ref.borrower });
  return `${origin}${COSIGN_PATH}?${q.toString()}`;
}

/** "missing" when the query carries no link at all; "invalid" when it does but the keys don't parse. */
export function parseCosignLink(search: string): ParsedCosignLink {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const pool = q.get("pool");
  const borrower = q.get("borrower");
  if (pool === null && borrower === null) return { ok: false, reason: "missing" };
  try {
    if (!pool || !borrower) throw new Error("incomplete");
    return { ok: true, ref: { pool: address(pool), borrower: address(borrower) } };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
