/**
 * The fund's economics as plain arithmetic: how much capital a given default rate burns, what running the fund
 * costs, how long the fund lasts without new gifts, what each completed loan costs the donors, and what the bounded
 * attacks (a correlated shock, a compromised issuer, sponsor abuse, an outage across a deadline) can cost. Pure
 * functions; `scripts/model.ts` prints the tables and docs/economics.md explains them.
 *
 * Definitions. A "cycle" is the average term plus the time to re-lend repaid money. The default rate is the share
 * of loans originated in a cycle that end in default (per originated loan, per cycle), not a share of the fund.
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
  /** Share of loans originated in a cycle that default (0..1). */
  defaultRate: number;
  /** Co-signer escrow as a share of the loan (0..1). */
  escrowRate: number;
  /** Average share of principal repaid before a default (0..1). Zero is the worst case. */
  repaidBeforeDefault: number;
  costs: Costs;
};

export type Costs = {
  /** Per identity check, dollars (provider fee). */
  identityCheck: number;
  /** New verified people per year (each pays one check; renewals excluded). */
  newMembersPerYear: number;
  /** Sponsor's unrecoverable cost per loan: Loan account rent + fees, dollars. */
  sponsorPerLoan: number;
  /** Recurring, dollars per year. */
  recurring: { hosting: number; support: number; disputes: number; fraudResponse: number; bookkeeping: number };
  /** One-off, dollars, spread over `oneOffYears`. */
  oneOff: { audit: number; legal: number; development: number };
  oneOffYears: number;
};

export type Result = {
  loansPerYear: number;
  cyclesPerYear: number;
  /** Capital lost per full cycle of the deployed fund. */
  lossPerCycle: number;
  lossPerYear: number;
  /** Loss as a share of the whole fund per year. */
  lossRatePerYear: number;
  recurringPerYear: number;
  oneOffTotal: number;
  oneOffPerYear: number;
  operatingPerYear: number;
  donationsNeededPerYear: number;
  /** Years until the fund is gone with no donations at all, at today's loss (a straight line). */
  yearsToDepletion: number;
  /** Years until the fund has halved with no donations (each year the smaller fund loses proportionally less). */
  yearsToHalf: number;
  /** Loans repaid in full per year. */
  completedLoansPerYear: number;
  /** Gifts spent per completed loan: capital lost plus operating cost, divided by the loans that worked. */
  subsidyPerCompletedLoan: number;
  /** How many people the same yearly gifts would reach as outright grants of one average loan each. */
  grantsInsteadPerYear: number;
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

export const recurringTotal = (c: Costs) => Object.values(c.recurring).reduce((a, b) => a + b, 0);
export const oneOffTotal = (c: Costs) => Object.values(c.oneOff).reduce((a, b) => a + b, 0);

export function evaluate(s: Scenario): Result {
  if (s.fund <= 0 || s.avgLoan <= 0 || s.cycleDays <= 0) throw new Error("fund, avgLoan and cycleDays must be positive");
  const deployed = s.fund * s.utilisation;
  const cyclesPerYear = 365 / s.cycleDays;
  const loansPerCycle = deployed / s.avgLoan;
  const loansPerYear = loansPerCycle * cyclesPerYear;
  const perDefault = lossPerDefault(s.avgLoan, s.escrowRate, s.repaidBeforeDefault);
  const lossPerCycle = loansPerCycle * s.defaultRate * perDefault;
  const lossPerYear = lossPerCycle * cyclesPerYear;
  const recurringPerYear =
    s.costs.identityCheck * s.costs.newMembersPerYear + s.costs.sponsorPerLoan * loansPerYear + recurringTotal(s.costs);
  const oneOff = oneOffTotal(s.costs);
  const oneOffPerYear = s.costs.oneOffYears > 0 ? oneOff / s.costs.oneOffYears : oneOff;
  const operatingPerYear = recurringPerYear + oneOffPerYear;
  const completedLoansPerYear = loansPerYear * (1 - s.defaultRate);
  const donationsNeededPerYear = lossPerYear + operatingPerYear;
  return {
    loansPerYear,
    cyclesPerYear,
    lossPerCycle,
    lossPerYear,
    lossRatePerYear: lossPerYear / s.fund,
    recurringPerYear,
    oneOffTotal: oneOff,
    oneOffPerYear,
    operatingPerYear,
    donationsNeededPerYear,
    yearsToDepletion: lossPerYear > 0 ? s.fund / lossPerYear : Infinity,
    yearsToHalf:
      lossPerYear > 0 && lossPerYear < s.fund ? Math.log(2) / -Math.log(1 - lossPerYear / s.fund) : lossPerYear >= s.fund ? 1 : Infinity,
    completedLoansPerYear,
    subsidyPerCompletedLoan: completedLoansPerYear > 0 ? donationsNeededPerYear / completedLoansPerYear : Infinity,
    grantsInsteadPerYear: donationsNeededPerYear / s.avgLoan,
    collusionPayoff: s.avgLoan - s.avgLoan * s.escrowRate,
    breakEvenEscrowRate: Math.min(1, 1 - s.repaidBeforeDefault),
  };
}

/** Where the money sits at a moment in time, for a fund of `fund` dollars under scenario `s`. */
export function balanceSheet(s: Scenario, fund = s.fund) {
  const outstandingPrincipal = fund * s.utilisation;
  return {
    /** In the vault, available to lend. */
    cashToLend: fund - outstandingPrincipal,
    /** Lent out and expected back. */
    outstandingPrincipal,
    /** Co-signer money locked in escrows against the open loans; not the fund's, but it is what covers defaults. */
    escrowHeld: outstandingPrincipal * s.escrowRate,
    /** Expected to be lost from the open loans at the scenario's default rate. */
    expectedLossOnOpenLoans:
      (outstandingPrincipal / s.avgLoan) * s.defaultRate * lossPerDefault(s.avgLoan, s.escrowRate, s.repaidBeforeDefault),
  };
}

/**
 * The fund year by year with no new gifts, capital losses only (operating costs are paid from elsewhere): each
 * year the smaller fund lends less and loses less. Stops at `maxYears` or when the fund is below one average loan.
 */
export function trajectory(s: Scenario, maxYears = 10): { year: number; fund: number; loans: number; loss: number }[] {
  const out: { year: number; fund: number; loans: number; loss: number }[] = [{ year: 0, fund: s.fund, loans: 0, loss: 0 }];
  let fund = s.fund;
  for (let year = 1; year <= maxYears; year++) {
    const r = evaluateShallow({ ...s, fund });
    fund = Math.max(0, fund - r.lossPerYear);
    out.push({ year, fund, loans: r.loansPerYear, loss: r.lossPerYear });
    if (fund < s.avgLoan) break;
  }
  return out;
}

function evaluateShallow(s: Scenario): { loansPerYear: number; lossPerYear: number } {
  const deployed = s.fund * s.utilisation;
  const cyclesPerYear = 365 / s.cycleDays;
  const loansPerCycle = deployed / s.avgLoan;
  const lossPerYear = loansPerCycle * s.defaultRate * lossPerDefault(s.avgLoan, s.escrowRate, s.repaidBeforeDefault) * cyclesPerYear;
  return { loansPerYear: loansPerCycle * cyclesPerYear, lossPerYear };
}

/** One cycle at a shock default rate (many people in trouble at once), on top of a normal year. */
export function correlatedShock(s: Scenario, shockDefaultRate: number): { shockCycleLoss: number; yearLoss: number; shareOfFund: number } {
  const normal = evaluate(s);
  const shock = evaluate({ ...s, defaultRate: shockDefaultRate });
  const yearLoss = normal.lossPerYear - normal.lossPerCycle + shock.lossPerCycle;
  return { shockCycleLoss: shock.lossPerCycle, yearLoss, shareOfFund: yearLoss / s.fund };
}

/**
 * A compromised identity issuer registering fake people and lending to them. The on-chain bounds: each fake loan is at
 * most the first-loan cap (new memberships stay on it for the cooldown), every fake loan needs an escrow the attacker
 * forfeits, and the pool disburses at most `disbursementCap` per window. Loss = windows until detection x cap x
 * (1 - escrow), or the per-loan route when the cap is off (0).
 */
export function issuerCompromise(p: {
  firstLoanCap: number;
  escrowRate: number;
  disbursementCap: number;
  windowDays: number;
  detectionDays: number;
  /** Fake memberships the attacker can register and fund per day when there is no disbursement cap. */
  fakeLoansPerDay: number;
}): { maxDisbursed: number; maxLoss: number; fakeLoans: number } {
  const perLoanLoss = p.firstLoanCap * (1 - p.escrowRate);
  if (p.disbursementCap <= 0) {
    const fakeLoans = Math.floor(p.fakeLoansPerDay * p.detectionDays);
    return { maxDisbursed: fakeLoans * p.firstLoanCap, maxLoss: fakeLoans * perLoanLoss, fakeLoans };
  }
  const windows = Math.ceil(p.detectionDays / p.windowDays);
  const maxDisbursed = windows * p.disbursementCap;
  const fakeLoans = Math.floor(maxDisbursed / p.firstLoanCap);
  return { maxDisbursed, maxLoss: maxDisbursed * (1 - p.escrowRate), fakeLoans };
}

/** What `wallets` abusive wallets can cost the fee sponsor under the proxy's per-wallet caps over `days`. */
export function sponsorAbuse(p: {
  wallets: number;
  days: number;
  dailyTxsPerWallet: number;
  atasPerWallet: number;
  /** Sponsor cost per transaction (fee), dollars. */
  txCost: number;
  /** Rent of one token account, dollars (about 0.002 SOL). */
  ataRent: number;
}): { maxCost: number; perWallet: number } {
  const perWallet = p.dailyTxsPerWallet * p.days * p.txCost + p.atasPerWallet * p.ataRent;
  return { maxCost: perWallet * p.wallets, perWallet };
}

/**
 * A network or operator outage of `outageHours` that spans some loans' deadlines. Money is unaffected (a late
 * repayment and a default give the same result in either order); the cost is the members whose deadline fell inside
 * the window and who are marked late through no fault of their own.
 */
export function outageAcrossCutoff(s: Scenario, outageHours: number): { loansWithDeadlineInside: number } {
  const r = evaluate(s);
  return { loansWithDeadlineInside: (r.loansPerYear * outageHours) / (365 * 24) };
}

/** The launch assumptions; `scripts/model.ts` varies them one at a time. */
export const BASE: Scenario = {
  name: "base",
  fund: 100_000,
  utilisation: 0.8,
  avgLoan: 300,
  cycleDays: 120,
  defaultRate: 0.05,
  escrowRate: 0.25,
  repaidBeforeDefault: 0.2,
  costs: {
    identityCheck: 2.5,
    newMembersPerYear: 600,
    sponsorPerLoan: 0.6,
    recurring: { hosting: 1_800, support: 6_000, disputes: 1_500, fraudResponse: 1_500, bookkeeping: 2_400 },
    oneOff: { audit: 30_000, legal: 15_000, development: 20_000 },
    oneOffYears: 3,
  },
};

export const money = (n: number) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : "never");
export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
