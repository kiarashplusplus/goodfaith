import { describe, expect, it } from "vitest";
import {
  balanceSheet,
  BASE,
  cashRunway,
  collusionRing,
  compareWithGrants,
  correlatedShock,
  depositUsedPerDefault,
  evaluate,
  issuerCompromise,
  LAUNCH,
  launchFirstYear,
  launchRamp,
  lossPerDefault,
  RAMP,
  settlementSplit,
  outageAcrossCutoff,
  sponsorAbuse,
  trajectory,
} from "./economics";

describe("economic model", () => {
  it("reproduces the reviewer's example: $100k fund, 10% default, 25% escrow, nothing repaid → $7,500 per cycle", () => {
    const r = evaluate({ ...BASE, fund: 100_000, utilisation: 1, settlementRate: 0.1, escrowRate: 0.25, repaidBeforeDefault: 0 });
    expect(r.lossPerCycle).toBeCloseTo(7_500, 6);
    expect(r.collusionPayoff).toBe(225);
  });
  it("escrow equal to the unpaid share makes a default free; more escrow never goes negative", () => {
    expect(lossPerDefault(300, 0.25, 0.75)).toBe(0);
    expect(depositUsedPerDefault(300, 0.25, 0.2)).toBe(75);
    expect(depositUsedPerDefault(300, 0.25, 0.9)).toBeCloseTo(30);
    const r = evaluate(BASE);
    expect(r.cosignerDepositsLostPerYear).toBeCloseTo(r.loansPerYear * 0.05 * 75);
    expect(r.conversionPerLoan).toBe(6);
    expect(r.borrowerConversionPerYear).toBeCloseTo(r.loansPerYear * 6);
    expect(lossPerDefault(300, 1, 0)).toBe(0);
    expect(lossPerDefault(300, 0.25, 0)).toBe(225);
    expect(evaluate({ ...BASE, repaidBeforeDefault: 0.4 }).breakEvenEscrowRate).toBeCloseTo(0.6);
  });
  it("scales with utilisation and cycle length, and splits recurring from one-off costs", () => {
    const base = evaluate(BASE);
    expect(evaluate({ ...BASE, utilisation: 0.4 }).lossPerYear).toBeCloseTo(base.lossPerYear / 2);
    expect(evaluate({ ...BASE, cycleDays: 60 }).lossPerYear).toBeCloseTo(base.lossPerYear * 2);
    expect(base.donationsNeededPerYear).toBeCloseTo(base.lossPerYear + base.operatingPerYear);
    expect(base.recurringPerYear).toBeCloseTo(2.5 * 600 + 0.01 * 1_000 + 0.6 * base.loansPerYear + 1_800 + 6_000 + 1_500 + 1_500 + 2_400);
    expect(base.oneOffTotal).toBe(65_000);
    expect(base.oneOffPerYear).toBeCloseTo(65_000 / 3);
    expect(base.operatingPerYear).toBeCloseTo(base.recurringPerYear + base.oneOffPerYear);
    expect(evaluate({ ...BASE, settlementRate: 0 }).yearsToDepletion).toBe(Infinity);
    expect(() => evaluate({ ...BASE, fund: 0 })).toThrow();
  });
  it("prices a completed loan and a borrower, and compares like with like against grants", () => {
    const r = evaluate(BASE);
    expect(r.completedLoansPerYear).toBeCloseTo(r.loansPerYear * 0.95);
    expect(r.distinctBorrowersPerYear).toBeCloseTo(r.completedLoansPerYear / 2);
    expect(r.subsidyPerCompletedLoan).toBeCloseTo(r.donationsNeededPerYear / r.completedLoansPerYear);
    expect(r.subsidyPerBorrower).toBeCloseTo(2 * r.subsidyPerCompletedLoan);
    expect(r.grantsInsteadPerYear).toBeCloseTo(r.donationsNeededPerYear / 300);
    // year one pays the one-off items in full; later years only the recurring ones
    expect(r.cashYearOne).toBeCloseTo(r.lossPerYear + r.recurringPerYear + 65_000);
    expect(r.cashLaterYears).toBeCloseTo(r.lossPerYear + r.recurringPerYear);
    expect(r.cashYearOne).toBeGreaterThan(r.donationsNeededPerYear);
    // over a horizon, the same endowment and gifts as grants versus as loans: the one-off items are charged once, not
    // once per amortisation period; borrower-years become people with the repeat rate
    const c = compareWithGrants(BASE, 10);
    expect(c.moneyIn).toBeCloseTo(100_000 + 10 * (r.lossPerYear + r.recurringPerYear) + 65_000);
    expect(c.moneyIn).toBeLessThan(100_000 + 10 * r.donationsNeededPerYear);
    expect(c.grants).toBeCloseTo(c.moneyIn / 300);
    expect(c.borrowerYears).toBeCloseTo(10 * r.distinctBorrowersPerYear);
    expect(c.people).toBeCloseTo(r.distinctBorrowersPerYear * (1 + 9 * 0.5));
    expect(compareWithGrants({ ...BASE, repeatRate: 0 }, 10).people).toBeCloseTo(c.borrowerYears);
    expect(compareWithGrants({ ...BASE, repeatRate: 1 }, 10).people).toBeCloseTo(r.distinctBorrowersPerYear);
    expect(c.fundLeft).toBe(100_000);
    expect(c.cosignerDepositsLost).toBeCloseTo(10 * r.cosignerDepositsLostPerYear);
    expect(c.borrowerConversion).toBeCloseTo(10 * r.loansPerYear * 6);
    expect(c.borrowerYears).toBeGreaterThan(c.grants);
    // at launch scale (a quarter of the fund out at most) the fixed costs dominate and grants reach more people
    const l = evaluate(LAUNCH);
    expect(l.loansPerYear).toBeCloseTo(r.loansPerYear / 3.2);
    expect(l.subsidyPerCompletedLoan).toBeGreaterThan(2 * r.subsidyPerCompletedLoan);
    const lc = compareWithGrants(LAUNCH, 10);
    expect(lc.grants).toBeGreaterThan(lc.people);
    // the fund paying its own way runs out, and sooner than the capital-only half-life suggests
    expect(r.cashRunwayYears).toBeLessThan(r.yearsToHalf);
    expect(cashRunway({ ...BASE, fund: 1_000_000 })).toBeGreaterThan(cashRunway(BASE));
    expect(
      cashRunway({
        ...BASE,
        settlementRate: 0,
        costs: {
          ...BASE.costs,
          identityCheck: 0,
          newMembersPerYear: 0,
          sponsorPerLoan: 0,
          recurring: { hosting: 0, support: 0, disputes: 0, fraudResponse: 0, bookkeeping: 0 },
          oneOff: { audit: 0, legal: 0, development: 0 },
        },
      }),
    ).toBe(50);
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
    expect(evaluate({ ...BASE, settlementRate: 0 }).yearsToHalf).toBe(Infinity);
    expect(trajectory({ ...BASE, settlementRate: 1, repaidBeforeDefault: 0 }, 50).length).toBeLessThan(10);
  });
  it("splits a settlement into escrow, later pay-backs and ultimate loss", () => {
    // $300, a fifth repaid, 25% escrow: $240 unpaid, $75 from the escrow, $165 the fund's claim
    expect(settlementSplit(300, 0.25, 0.2)).toEqual({ unpaid: 240, escrow: 75, later: 0, ultimateLoss: 165 });
    // half of what is owed paid back later: the fund's claim is paid first
    expect(settlementSplit(300, 0.25, 0.2, 0.5)).toEqual({ unpaid: 240, escrow: 75, later: 120, ultimateLoss: 45 });
    const r = evaluate({ ...BASE, paybackRate: 0.5 });
    expect(r.principalAtSettlementPerYear).toBeCloseTo(r.escrowRecoveriesPerYear + r.laterRecoveriesPerYear + r.lossPerYear);
    expect(r.lossPerYear).toBeLessThan(evaluate(BASE).lossPerYear);
    // pay-backs beyond the fund's claim give the co-signers their deposits back
    expect(evaluate({ ...BASE, paybackRate: 1 }).cosignerDepositsLostPerYear).toBe(0);
  });
  it("ramps the average loan up from the first-loan cap", () => {
    const ramp = launchRamp({ ...RAMP, months: 24 });
    expect(ramp[0]!.avgLoan).toBe(150);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]!.avgLoan).toBeGreaterThanOrEqual(ramp[i - 1]!.avgLoan - 1e-9);
    expect(ramp[23]!.avgLoan).toBeLessThan(300);
    const first = launchFirstYear();
    expect(first.avgLoan).toBeGreaterThan(150);
    expect(first.avgLoan).toBeLessThan(BASE.avgLoan);
  });
  it("bounds the attacks", () => {
    const shock = correlatedShock(BASE, 0.3);
    expect(shock.shockCycleLoss).toBeCloseTo(evaluate({ ...BASE, settlementRate: 0.3 }).lossPerCycle);
    expect(shock.yearLoss).toBeGreaterThan(evaluate(BASE).lossPerYear);
    // three days to contain spans four one-day windows in the worst case (the first one straddled)
    const capped = issuerCompromise({
      firstLoanCap: 150,
      escrowRate: 0.25,
      disbursementCap: 5_000,
      windowDays: 1,
      containmentDays: 3,
      fakeLoansPerDay: 50,
    });
    expect(capped).toEqual({ maxDisbursed: 20_000, maxLoss: 15_000, fakeLoans: 133, windows: 4 });
    const ceiling = issuerCompromise({
      ...{ firstLoanCap: 150, escrowRate: 0.25, disbursementCap: 5_000, windowDays: 1, containmentDays: 3, fakeLoansPerDay: 50 },
      outstandingCeiling: 25_000,
      outstandingNow: 20_000,
    });
    expect(ceiling.maxDisbursed).toBe(5_000);
    // a settlement frees ceiling capacity; the lifetime budget is what bounds the total
    const budget = issuerCompromise({
      ...{ firstLoanCap: 150, escrowRate: 0.25, disbursementCap: 5_000, windowDays: 1, containmentDays: 7, fakeLoansPerDay: 50 },
      outstandingCeiling: 25_000,
      outstandingNow: 0,
      budgetLeft: 3_000,
    });
    expect(budget.maxDisbursed).toBe(3_000);
    const uncapped = issuerCompromise({
      firstLoanCap: 150,
      escrowRate: 0.25,
      disbursementCap: 0,
      windowDays: 1,
      containmentDays: 3,
      fakeLoansPerDay: 50,
    });
    expect(uncapped.maxLoss).toBeGreaterThan(capped.maxLoss);
    const abuse = sponsorAbuse({ wallets: 1_000, days: 1, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3 });
    expect(abuse.perWallet).toBeCloseTo(40 * 0.001 + 12 * 0.3);
    expect(abuse.maxCost).toBeCloseTo(abuse.perWallet * 1_000);
    const budgeted = sponsorAbuse({
      wallets: 1_000,
      days: 1,
      dailyTxsPerWallet: 40,
      atasPerWallet: 12,
      txCost: 0.001,
      ataRent: 0.3,
      dailyBudgetTx: 2_000,
      dailyNewWallets: 200,
    });
    expect(budgeted.newWallets).toBe(200);
    expect(budgeted.txs).toBe(2_000);
    expect(budgeted.maxCost).toBeCloseTo(2_000 * 0.001 + 200 * 12 * 0.3);
    const yearly = sponsorAbuse({
      ...{ wallets: 100_000, days: 365, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3 },
      dailyBudgetTx: 2_000,
      dailyNewWallets: 200,
    });
    expect(yearly.newWallets).toBe(200 * 365);
    expect(yearly.txs).toBe(2_000 * 365);
    const outage = outageAcrossCutoff(BASE, 24);
    expect(outage.loansWithDeadlineInside).toBeCloseTo(evaluate(BASE).loansPerYear / 365);
    expect(outage.reviewCost).toBeCloseTo(outage.loansWithDeadlineInside * 0.5 * 40);
    const ring = collusionRing({ people: 3, loanCap: 150, escrowRate: 0.25, exposure: 1_000 });
    expect(ring).toEqual({ feasible: true, loans: 3, payoff: 337.5, fundLoss: 337.5, perPerson: 112.5 });
    expect(collusionRing({ people: 2, loanCap: 150, escrowRate: 0.25, exposure: 1_000 }).feasible).toBe(false);
    expect(collusionRing({ people: 3, loanCap: 600, escrowRate: 0.25, exposure: 1_000 }).feasible).toBe(false);
  });
});
