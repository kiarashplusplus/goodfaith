"use client";

import { useSponsor } from "@/lib/hooks";

/** Whether network fees (and account rent) are covered by the fee sponsor right now. */
export function SponsorBadge() {
  const s = useSponsor();
  let text: string;
  let cls: string;
  if (!s.enabled) {
    text = "You pay network fees";
    cls = "bg-stone-100 text-stone-700";
  } else if (s.isLoading) {
    text = "Checking fee sponsor...";
    cls = "bg-stone-100 text-stone-500";
  } else if (s.available) {
    text = "Fees covered";
    cls = "bg-emerald-100 text-emerald-900";
  } else {
    text = "Fee sponsor unavailable: you pay fees";
    cls = "bg-amber-100 text-amber-900";
  }
  return (
    <span
      role="status"
      title="Who pays Solana network fees for your transactions"
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {text}
    </span>
  );
}
