import type { LoanState } from "@/lib/loan-status";

export const CHIP: Record<LoanState, { text: string; className: string }> = {
  open: { text: "Active", className: "bg-emerald-100 text-emerald-900" },
  overdue: { text: "Overdue", className: "bg-amber-100 text-amber-900" },
  defaultable: { text: "Past grace", className: "bg-red-100 text-red-900" },
  repaid: { text: "Repaid", className: "bg-stone-100 text-stone-700" },
  repaid_late: { text: "Repaid late", className: "bg-amber-100 text-amber-900" },
  defaulted: { text: "Defaulted", className: "bg-red-100 text-red-900" },
};

export function StatusChip({ state }: { state: LoanState }) {
  const c = CHIP[state];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.className}`}>{c.text}</span>;
}
