import type { Loan } from "./program";

/** Pure helpers for where a loan stands in time. Mirrors the program: repayment is possible while now <= due_at + grace; after that the loan is settled. */
export const SECONDS_PER_DAY = 86_400n;

export type LoanState = "open" | "overdue" | "defaultable" | "repaid" | "defaulted" | "restituted";

export type LoanTiming = {
  state: LoanState;
  /** Short sentence for the UI; empty when `nowSec` is unknown (0). */
  label: string;
  /** Last second at which a repayment is accepted; after it the loan is settled. */
  deadline: bigint;
  /** Whole days until due (negative when past due). */
  daysUntilDue: number;
  /** Whole days of grace still ahead (rounded up), 0 once the grace period has ended. */
  graceDaysLeft: number;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function loanTiming(
  loan: Pick<Loan, "status" | "dueAt" | "graceDays"> &
    Partial<Pick<Loan, "shortfall" | "restituted" | "cosignerWaivedAt" | "fundForgivenAt">>,
  nowSec: bigint,
): LoanTiming {
  const deadline = loan.dueAt + BigInt(loan.graceDays) * SECONDS_PER_DAY;
  const base = { deadline, daysUntilDue: 0, graceDaysLeft: 0 };
  if (loan.status === "Repaid") return { ...base, state: "repaid", label: "Repaid in full." };
  if (loan.status === "Restituted")
    return {
      ...base,
      state: "restituted",
      label: loan.fundForgivenAt
        ? "Settled after the deadline; the fund forgave its claim."
        : loan.cosignerWaivedAt
          ? "Settled after the deadline; the fund was paid back and the co-signer waived the rest."
          : "Settled after the deadline, then paid back in full.",
    };
  if (loan.status === "Defaulted") {
    const partly = loan.restituted !== undefined && loan.restituted > 0n ? " Partly paid back." : "";
    return { ...base, state: "defaulted", label: `Settled as defaulted.${partly}` };
  }
  if (nowSec <= 0n) return { ...base, state: "open", label: "" };

  const untilDue = loan.dueAt - nowSec;
  if (untilDue >= 0n) {
    const d = Number(untilDue / SECONDS_PER_DAY);
    const label = d === 0 ? "Due today." : d === 1 ? "Due tomorrow." : `Due in ${d} days.`;
    return { ...base, state: "open", label, daysUntilDue: d, graceDaysLeft: loan.graceDays };
  }
  const overdue = Number((nowSec - loan.dueAt) / SECONDS_PER_DAY);
  if (nowSec > deadline) {
    return {
      ...base,
      state: "defaultable",
      label: "Past the grace period. Repayment is closed: the loan is settled, and what is owed can be paid back afterwards.",
      daysUntilDue: -overdue,
    };
  }
  const left = Number(ceilDiv(deadline - nowSec, SECONDS_PER_DAY));
  const first = overdue === 0 ? "Past due as of today" : `Overdue by ${plural(overdue, "day")}`;
  const second = left === 0 ? "The grace period ends today." : `${plural(left, "day")} of grace left.`;
  return { ...base, state: "overdue", label: `${first}. ${second}`, daysUntilDue: -overdue, graceDaysLeft: left };
}
