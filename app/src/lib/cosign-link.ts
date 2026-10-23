/**
 * Co-sign link: carries only the pool and borrower public keys. The co-sign page reads the
 * on-chain LoanRequest (PDA ["request", pool, borrower]) and shows its terms.
 */
export const COSIGN_PATH = "/cosign";

export type CosignRef = { pool: string; borrower: string };

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function buildCosignLink(origin: string, ref: CosignRef): string {
  const q = new URLSearchParams({ pool: ref.pool, borrower: ref.borrower });
  return `${origin}${COSIGN_PATH}?${q.toString()}`;
}

export function parseCosignLink(search: string): CosignRef | null {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const pool = q.get("pool");
  const borrower = q.get("borrower");
  if (!pool || !borrower || !B58.test(pool) || !B58.test(borrower)) return null;
  return { pool, borrower };
}
