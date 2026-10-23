/** Amount helpers. All token math uses bigint base units; never floats. */

export function parseAmount(input: string, decimals = 6): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function formatAmount(base: bigint, decimals = 6, opts: { minFraction?: number } = {}): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const unit = 10n ** BigInt(decimals);
  const whole = (abs / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  const min = opts.minFraction ?? 2;
  if (frac.length < min) frac = frac.padEnd(min, "0");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function formatUsdc(base: bigint): string {
  return `$${formatAmount(base, 6)}`;
}

export function formatSol(lamports: bigint): string {
  return formatAmount(lamports, 9, { minFraction: 0 }).replace(/(\.\d{4})\d+$/, "$1");
}

export function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a;
}
