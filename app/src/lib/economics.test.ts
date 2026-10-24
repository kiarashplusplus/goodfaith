import { describe, expect, it } from "vitest";
import {
  balanceSheet,
  BASE,
  correlatedShock,
  evaluate,
  issuerCompromise,
  lossPerDefault,
  outageAcrossCutoff,
  sponsorAbuse,
  trajectory,
} from "./economics";

describe("economic model", () => {
  it("reproduces the reviewer's example: $100k fund, 10% default, 25% escrow, nothing repaid → $7,500 per cycle", () => {
    const r = evaluate({ ...BASE, fund: 100_000, utilisation: 1, defaultRate: 0.1, escrowRate: 0.25, repaidBeforeDefault: 0 });
    expect(r.lossPerCycle).toBeCloseTo(7_500, 6);
    expect(r.collusionPayoff).toBe(225);
  });
  it("escrow equal to the unpaid share makes a default free; more escrow never goes negative", () => {
    expect(lossPerDefault(300, 0.25, 0.75)).toBe(0);
    expect(lossPerDefault(300, 1, 0)).toBe(0);
    expect(lossPerDefault(300, 0.25, 0)).toBe(225);
    expect(evaluate({ ...BASE, repaidBeforeDefault: 0.4 }).breakEvenEscrowRate).toBeCloseTo(0.6);
  });
  it("scales with utilisation and cycle length, and splits recurring from one-off costs", () => {
    const base = evaluate(BASE);
    expect(evaluate({ ...BASE, utilisation: 0.4 }).lossPerYear).toBeCloseTo(base.lossPerYear / 2);
    expect(evaluate({ ...BASE, cycleDays: 60 }).lossPerYear).toBeCloseTo(base.lossPerYear * 2);
    expect(base.donationsNeededPerYear).toBeCloseTo(base.lossPerYear + base.operatingPerYear);
    expect(base.recurringPerYear).toBeCloseTo(2.5 * 600 + 0.6 * base.loansPerYear + 1_800 + 6_000 + 1_500 + 1_500 + 2_400);
    expect(base.oneOffTotal).toBe(65_000);
    expect(base.oneOffPerYear).toBeCloseTo(65_000 / 3);
    expect(base.operatingPerYear).toBeCloseTo(base.recurringPerYear + base.oneOffPerYear);
    expect(evaluate({ ...BASE, defaultRate: 0 }).yearsToDepletion).toBe(Infinity);
    expect(() => evaluate({ ...BASE, fund: 0 })).toThrow();
  });
  it("prices a completed loan and compares with grants", () => {
    const r = evaluate(BASE);
    expect(r.completedLoansPerYear).toBeCloseTo(r.loansPerYear * 0.95);
    expect(r.subsidyPerCompletedLoan).toBeCloseTo(r.donationsNeededPerYear / r.completedLoansPerYear);
    expect(r.grantsInsteadPerYear).toBeCloseTo(r.donationsNeededPerYear / 300);
    expect(r.completedLoansPerYear).toBeGreaterThan(r.grantsInsteadPerYear); // loans reach more people than grants of the same money
  });
  it("balance sheet and trajectory", () => {
    const b = balanceSheet(BASE);
    expect(b.cashToLend + b.outstandingPrincipal).toBeCloseTo(BASE.fund);
    expect(b.escrowHeld).toBeCloseTo(80_000 * 0.25);
    const t = trajectory(BASE, 5);
    expect(t[0]).toEqual({ year: 0, fund: 100_000, loans: 0, loss: 0 });
    expect(t[1]!.fund).toBeCloseTo(100_000 - evaluate(BASE).lossPerYear);
    expect(t[2]!.loss).toBeLessThan(t[1]!.loss); // a smaller fund loses less
    expect(evaluate(BASE).yearsToDepletion).toBeCloseTo(100_000 / evaluate(BASE).lossPerYear);
    expect(evaluate(BASE).yearsToHalf).toBeCloseTo(Math.log(2) / -Math.log(1 - evaluate(BASE).lossRatePerYear));
    expect(evaluate({ ...BASE, defaultRate: 0 }).yearsToHalf).toBe(Infinity);
    expect(trajectory({ ...BASE, defaultRate: 1, repaidBeforeDefault: 0 }, 50).length).toBeLessThan(10);
  });
  it("bounds the attacks", () => {
    const shock = correlatedShock(BASE, 0.3);
    expect(shock.shockCycleLoss).toBeCloseTo(evaluate({ ...BASE, defaultRate: 0.3 }).lossPerCycle);
    expect(shock.yearLoss).toBeGreaterThan(evaluate(BASE).lossPerYear);
    const capped = issuerCompromise({
      firstLoanCap: 150,
      escrowRate: 0.25,
      disbursementCap: 5_000,
      windowDays: 1,
      detectionDays: 3,
      fakeLoansPerDay: 50,
    });
    expect(capped).toEqual({ maxDisbursed: 15_000, maxLoss: 11_250, fakeLoans: 100 });
    const uncapped = issuerCompromise({
      firstLoanCap: 150,
      escrowRate: 0.25,
      disbursementCap: 0,
      windowDays: 1,
      detectionDays: 3,
      fakeLoansPerDay: 50,
    });
    expect(uncapped.maxLoss).toBeGreaterThan(capped.maxLoss);
    const abuse = sponsorAbuse({ wallets: 1_000, days: 1, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3 });
    expect(abuse.perWallet).toBeCloseTo(40 * 0.001 + 12 * 0.3);
    expect(abuse.maxCost).toBeCloseTo(abuse.perWallet * 1_000);
    expect(outageAcrossCutoff(BASE, 24).loansWithDeadlineInside).toBeCloseTo(evaluate(BASE).loansPerYear / 365);
  });
});
