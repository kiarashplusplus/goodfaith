/** escrow = ceil(amount * bps / 10000), matching the program spec. */
export const BPS_DENOMINATOR = 10_000n;

export function escrowFor(amount: bigint, bps: number | bigint): bigint {
  const b = BigInt(bps);
  if (amount < 0n || b < 0n || b > BPS_DENOMINATOR) throw new RangeError("invalid escrow inputs");
  return (amount * b + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
}
