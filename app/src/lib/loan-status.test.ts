import { describe, expect, it } from "vitest";
import { loanTiming, SECONDS_PER_DAY } from "./loan-status";

const DUE = 1_700_000_000n;
const active = { status: "Active" as const, dueAt: DUE, graceDays: 7 };

describe("loanTiming", () => {
  it("counts down to the due date", () => {
    expect(loanTiming(active, DUE - 10n * SECONDS_PER_DAY)).toMatchObject({ state: "open", label: "Due in 10 days.", daysUntilDue: 10, graceDaysLeft: 7 });
    expect(loanTiming(active, DUE - SECONDS_PER_DAY)).toMatchObject({ label: "Due tomorrow." });
    expect(loanTiming(active, DUE - 1n)).toMatchObject({ label: "Due today.", daysUntilDue: 0 });
    expect(loanTiming(active, DUE)).toMatchObject({ state: "open", label: "Due today." });
  });

  it("is overdue during the grace period", () => {
    expect(loanTiming(active, DUE + 1n)).toMatchObject({ state: "overdue", label: "Past due as of today. 7 days of grace left.", graceDaysLeft: 7 });
    expect(loanTiming(active, DUE + 3n * SECONDS_PER_DAY)).toMatchObject({ label: "Overdue by 3 days. 4 days of grace left.", daysUntilDue: -3 });
    expect(loanTiming(active, DUE + 6n * SECONDS_PER_DAY + 1n)).toMatchObject({ label: "Overdue by 6 days. 1 day of grace left." });
  });

  it("becomes defaultable strictly after due + grace, like mark_default", () => {
    const deadline = DUE + 7n * SECONDS_PER_DAY;
    expect(loanTiming(active, deadline)).toMatchObject({ state: "overdue", label: "Overdue by 7 days. The grace period ends today." });
    expect(loanTiming(active, deadline + 1n)).toMatchObject({ state: "defaultable", graceDaysLeft: 0 });
    expect(loanTiming({ ...active, graceDays: 0 }, DUE)).toMatchObject({ state: "open" });
    expect(loanTiming({ ...active, graceDays: 0 }, DUE + 1n)).toMatchObject({ state: "defaultable" });
  });

  it("ignores dates once the loan is closed, and says nothing without a clock", () => {
    expect(loanTiming({ ...active, status: "Repaid" }, DUE + 100n * SECONDS_PER_DAY)).toMatchObject({ state: "repaid" });
    expect(loanTiming({ ...active, status: "Defaulted" }, DUE - 100n)).toMatchObject({ state: "defaulted" });
    expect(loanTiming(active, 0n)).toMatchObject({ state: "open", label: "" });
  });
});
