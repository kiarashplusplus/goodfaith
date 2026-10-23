/**
 * The fund's economics as plain arithmetic: how much capital a given default rate burns, what running the fund
 * costs, and how much has to be donated each year to stand still. Pure functions; `scripts/model.ts` prints the
 * scenarios and docs/economics.md explains them.
 */
export type Scenario = {
  name: string;
  /** Loan fund, dollars. */
  fund: number;
  /** Share of the fund out on loan at any time (0..1). */
  utilisation: number;
  /** Average loan, dollars. */
  avgLoan: number;
  /** Average term plus the time to redeploy repaid money, days. */
  cycleDays: number;
  /** Share of loans that default (0..1). */
  defaultRate: number;
  /** Co-signer escrow as a share of the loan (0..1). */
  escrowRate: number;
  /** Average share of principal repaid before a default (0..1). Zero is the worst case. */
  repaidBeforeDefault: number;
  costs: {
    /** Per identity check, dollars (provider fee). */
    identityCheck: number;
    /** New verified people per year (each pays one check; renewals excluded). */
    newMembersPerYear: number;
    /** Sponsor's unrecoverable cost per loan: Loan account rent + fees, dollars. */
    sponsorPerLoan: number;
    /** Hosting, RPC, monitoring, dollars per year. */
    hostingPerYear: number;
    /** Independent audit amortised per year, dollars. */
    auditPerYear: number;
  };
};

export type Result = {
  loansPerYear: number;
  cyclesPerYear: number;
  /** Capital lost per full cycle of the deployed fund. */
  lossPerCycle: number;
  lossPerYear: number;
  /** Loss as a share of the whole fund per year. */
  lossRatePerYear: number;
  operatingPerYear: number;
  donationsNeededPerYear: number;
  /** Years until the fund is gone with no donations at all. */
  yearsToDepletion: number;
  /** What a borrower and co-signer who collude walk away with on one loan (before losing eligibility). */
  collusionPayoff: number;
  /** Escrow rate at which a lone default costs the fund nothing (given repaidBeforeDefault). */
  breakEvenEscrowRate: number;
};

/** Loss on one defaulted loan: the unpaid part minus what the escrow covers, never below zero. */
export function lossPerDefault(avgLoan: number, escrowRate: number, repaidBeforeDefault: number): number {
  const unpaid = avgLoan * (1 - repaidBeforeDefault);
  return Math.max(0, unpaid - avgLoan * escrowRate);
}

export function evaluate(s: Scenario): Result {
  if (s.fund <= 0 || s.avgLoan <= 0 || s.cycleDays <= 0) throw new Error("fund, avgLoan and cycleDays must be positive");
  const deployed = s.fund * s.utilisation;
  const cyclesPerYear = 365 / s.cycleDays;
  const loansPerCycle = deployed / s.avgLoan;
  const loansPerYear = loansPerCycle * cyclesPerYear;
  const perDefault = lossPerDefault(s.avgLoan, s.escrowRate, s.repaidBeforeDefault);
  const lossPerCycle = loansPerCycle * s.defaultRate * perDefault;
  const lossPerYear = lossPerCycle * cyclesPerYear;
  const operatingPerYear =
    s.costs.identityCheck * s.costs.newMembersPerYear +
    s.costs.sponsorPerLoan * loansPerYear +
    s.costs.hostingPerYear +
    s.costs.auditPerYear;
  return {
    loansPerYear,
    cyclesPerYear,
    lossPerCycle,
    lossPerYear,
    lossRatePerYear: lossPerYear / s.fund,
    operatingPerYear,
    donationsNeededPerYear: lossPerYear + operatingPerYear,
    yearsToDepletion: lossPerYear > 0 ? s.fund / lossPerYear : Infinity,
    collusionPayoff: s.avgLoan - s.avgLoan * s.escrowRate,
    breakEvenEscrowRate: Math.min(1, 1 - s.repaidBeforeDefault),
  };
}

/** The launch assumptions; `scripts/model.ts` varies them. */
export const BASE: Scenario = {
  name: "base",
  fund: 100_000,
  utilisation: 0.8,
  avgLoan: 300,
  cycleDays: 120,
  defaultRate: 0.05,
  escrowRate: 0.25,
  repaidBeforeDefault: 0.2,
  costs: { identityCheck: 2.5, newMembersPerYear: 600, sponsorPerLoan: 0.6, hostingPerYear: 1_800, auditPerYear: 10_000 },
};

export const money = (n: number) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : "never");
export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
