/** Solana Pay transfer request URL (https://docs.solanapay.com/spec). */
export function solanaPayUrl(opts: {
  recipient: string;
  splToken?: string;
  /** decimal user-facing amount, e.g. "12.5" */
  amount?: string;
  label?: string;
  message?: string;
  memo?: string;
}): string {
  const p = new URLSearchParams();
  if (opts.amount) p.set("amount", opts.amount);
  if (opts.splToken) p.set("spl-token", opts.splToken);
  if (opts.label) p.set("label", opts.label);
  if (opts.message) p.set("message", opts.message);
  if (opts.memo) p.set("memo", opts.memo);
  const q = p.toString();
  return `solana:${opts.recipient}${q ? "?" + q : ""}`;
}
