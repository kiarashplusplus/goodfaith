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
  /** Loans one borrower takes in a year, so loans can be turned into people (default 2). */
  loansPerBorrowerPerYear: number;
  /** Share of a year's borrowers who also borrowed in an earlier year (0..1), so borrower-years can be turned into people over a horizon. */
  repeatRate: number;
  /** What a borrower pays to turn USDC into dollars and back, per conversion (a fixed fee; default $3 each way). Not the fund's cost, but the borrower's. */
  conversionFeeUsd: number;
  costs: Costs;
};

export type Costs = {
  /** Per identity check, dollars (provider fee). */
  identityCheck: number;
  /** New verified people per year (each pays one check). */
  newMembersPerYear: number;
  /** Pass renewals per year (members in good standing, once a year) and what one costs the fund (a signed message and a transaction fee, cents). */
  renewalsPerYear: number;
  passRenewal: number;
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
  /**
   * Years until the fund has halved with no donations, counting capital losses only (operating costs paid from
   * elsewhere; each year the smaller fund loses proportionally less). See `cashRunwayYears` for the fund paying its
   * own way.
   */
  yearsToHalf: number;
  /** Years the fund lasts with no donations when it pays both the capital losses and the operating costs. */
  cashRunwayYears: number;
  /** Loans repaid in full per year. */
  completedLoansPerYear: number;
  /** Borrower-years: people who completed a loan in the year, loans divided by loans per borrower (not one person per loan). Across years the same person can appear again; see `compareWithGrants`. */
  distinctBorrowersPerYear: number;
  /** Co-signer deposits used to cover defaults in the year: the co-signers' money, lost unless the borrower pays back. */
  cosignerDepositsLostPerYear: number;
  /** What borrowers pay in conversion fees in the year (one conversion out and one back per loan), at `conversionFeeUsd`. */
  borrowerConversionPerYear: number;
  /** Conversion fees per loan, both ways. */
  conversionPerLoan: number;
  /** Gifts spent per completed loan: capital lost plus operating cost, divided by the loans that worked. */
  subsidyPerCompletedLoan: number;
  /** Gifts spent per person helped in the year. */
  subsidyPerBorrower: number;
  /** How many people the same yearly gifts would reach as outright grants of one average loan each (endowment excluded). */
  grantsInsteadPerYear: number;
  /** Cash the fund needs in its first year: capital lost, recurring costs and the one-off items paid in full. */
  cashYearOne: number;
  /** Cash each later year: capital lost plus recurring costs (the one-offs are behind). */
  cashLaterYears: number;
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

/** The co-signer's deposit used on one defaulted loan: the unpaid part, up to the deposit. */
export function depositUsedPerDefault(avgLoan: number, escrowRate: number, repaidBeforeDefault: number): number {
  const unpaid = avgLoan * (1 - repaidBeforeDefault);
  return Math.min(unpaid, avgLoan * escrowRate);
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
  const recurringPerYear = recurringCosts(s.costs, loansPerYear);
  const oneOff = oneOffTotal(s.costs);
  const oneOffPerYear = s.costs.oneOffYears > 0 ? oneOff / s.costs.oneOffYears : oneOff;
  const operatingPerYear = recurringPerYear + oneOffPerYear;
  const completedLoansPerYear = loansPerYear * (1 - s.defaultRate);
  const donationsNeededPerYear = lossPerYear + operatingPerYear;
  const perBorrower = s.loansPerBorrowerPerYear > 0 ? s.loansPerBorrowerPerYear : 1;
  const distinctBorrowersPerYear = completedLoansPerYear / perBorrower;
  const defaultsPerYear = loansPerYear * s.defaultRate;
  const conversionPerLoan = 2 * s.conversionFeeUsd;
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
    cashRunwayYears: cashRunway(s),
    completedLoansPerYear,
    distinctBorrowersPerYear,
    cosignerDepositsLostPerYear: defaultsPerYear * depositUsedPerDefault(s.avgLoan, s.escrowRate, s.repaidBeforeDefault),
    borrowerConversionPerYear: loansPerYear * conversionPerLoan,
    conversionPerLoan,
    subsidyPerCompletedLoan: completedLoansPerYear > 0 ? donationsNeededPerYear / completedLoansPerYear : Infinity,
    subsidyPerBorrower: distinctBorrowersPerYear > 0 ? donationsNeededPerYear / distinctBorrowersPerYear : Infinity,
    grantsInsteadPerYear: donationsNeededPerYear / s.avgLoan,
    cashYearOne: lossPerYear + recurringPerYear + oneOff,
    cashLaterYears: lossPerYear + recurringPerYear,
    collusionPayoff: s.avgLoan - s.avgLoan * s.escrowRate,
    breakEvenEscrowRate: Math.min(1, 1 - s.repaidBeforeDefault),
  };
}

/**
 * The fund paying its own way with no gifts at all: each year it loses capital on what it lends and pays the
 * operating costs (one-offs in the first year, then the recurring ones) out of the vault. Returns the years until
 * it cannot cover the next year's costs, as a fraction; 50 means "longer than the model looks".
 */
/** The recurring costs for a year with `loansPerYear` loans: identity checks and renewals, the sponsor's rent and fees, and the fixed items. */
export function recurringCosts(c: Costs, loansPerYear: number): number {
  return c.identityCheck * c.newMembersPerYear + c.passRenewal * c.renewalsPerYear + c.sponsorPerLoan * loansPerYear + recurringTotal(c);
}

export function cashRunway(s: Scenario): number {
  let fund = s.fund;
  for (let year = 0; year < 50; year++) {
    const r = evaluateShallow({ ...s, fund });
    const recurring = recurringCosts(s.costs, r.loansPerYear);
    const spend = r.lossPerYear + recurring + (year === 0 ? oneOffTotal(s.costs) : 0);
    if (spend >= fund) return year + (spend > 0 ? fund / spend : 0);
    fund -= spend;
  }
  return 50;
}

/**
 * Lending against giving over `years`, with the same money on both sides: the endowment, the yearly gifts that cover
 * the capital lost and the recurring costs, and the one-off items charged once (not once per amortisation period).
 * Grants: everything is handed out as one average loan each. Loans: the fund is still there at the end.
 * `borrowerYears` counts a person once per year they borrowed; `people` turns that into distinct people with the
 * scenario's repeat rate (a repeat borrower is the same person as last year).
 */
export function compareWithGrants(s: Scenario, years: number) {
  const r = evaluate(s);
  const money = s.fund + (r.lossPerYear + r.recurringPerYear) * years + r.oneOffTotal;
  const borrowerYears = r.distinctBorrowersPerYear * years;
  const people = r.distinctBorrowersPerYear * (1 + Math.max(0, years - 1) * (1 - s.repeatRate));
  return {
    years,
    moneyIn: money,
    grants: money / s.avgLoan,
    loansCompleted: r.completedLoansPerYear * years,
    borrowerYears,
    people,
    fundLeft: s.fund,
    /** Deposits co-signers lost to defaults over the horizon (nobody's gift, but a real cost of the loan side). */
    cosignerDepositsLost: r.cosignerDepositsLostPerYear * years,
    /** Conversion fees borrowers paid over the horizon. */
    borrowerConversion: r.borrowerConversionPerYear * years,
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
 * A compromised identity issuer registering fake people and lending to them: a scenario, not a bound. The inputs are
 * the assumptions: `containmentDays` is the time from the first fake loan to the pause (detection plus reaction),
 * and the disbursement window is a fixed window (gross principal per window from `window_start`), so an attacker who
 * straddles a boundary gets two windows' worth in a short time; the ceiling on outstanding principal caps the total
 * whatever the timing. Each fake loan is at most the first-loan cap (new memberships stay on it for the cooldown) and
 * forfeits its escrow. Loss = disbursed x (1 - escrow); with the window cap off (0), the per-loan route applies.
 */
export function issuerCompromise(p: {
  firstLoanCap: number;
  escrowRate: number;
  disbursementCap: number;
  windowDays: number;
  containmentDays: number;
  /** Fake memberships the attacker can register and fund per day when there is no disbursement cap. */
  fakeLoansPerDay: number;
  /** Ceiling on principal out on loan (0: none); the attacker gets at most the headroom under it. */
  outstandingCeiling?: number;
  /** Principal already out on loan when the attack starts. */
  outstandingNow?: number;
}): { maxDisbursed: number; maxLoss: number; fakeLoans: number; windows: number } {
  const perLoanLoss = p.firstLoanCap * (1 - p.escrowRate);
  const headroom =
    p.outstandingCeiling && p.outstandingCeiling > 0 ? Math.max(0, p.outstandingCeiling - (p.outstandingNow ?? 0)) : Infinity;
  if (p.disbursementCap <= 0) {
    const fakeLoans = Math.min(Math.floor(p.fakeLoansPerDay * p.containmentDays), Math.floor(headroom / p.firstLoanCap));
    return { maxDisbursed: fakeLoans * p.firstLoanCap, maxLoss: fakeLoans * perLoanLoss, fakeLoans, windows: 0 };
  }
  // A fixed window can be straddled: the containment time spans ceil(days / window) + 1 windows in the worst case.
  const windows = Math.ceil(p.containmentDays / p.windowDays) + 1;
  const maxDisbursed = Math.min(windows * p.disbursementCap, headroom);
  const fakeLoans = Math.floor(maxDisbursed / p.firstLoanCap);
  return { maxDisbursed, maxLoss: maxDisbursed * (1 - p.escrowRate), fakeLoans, windows };
}

/**
 * What abusive wallets can cost the fee sponsor over `days`: each wallet is held to the per-wallet caps, and the
 * whole crowd to the fund-wide daily budget (transactions, and wallets sponsored for the first time).
 */
export function sponsorAbuse(p: {
  /** Distinct abusive wallets; with a budget on first-time wallets only `dailyNewWallets x days` of them get in. */
  wallets: number;
  days: number;
  dailyTxsPerWallet: number;
  atasPerWallet: number;
  /** Sponsor cost per transaction (fee), dollars. */
  txCost: number;
  /** Rent of one token account, dollars (about 0.002 SOL). */
  ataRent: number;
  /** Fund-wide daily budget: sponsored transactions, and wallets sponsored for the first time (0: no budget). */
  dailyBudgetTx?: number;
  dailyNewWallets?: number;
}): { maxCost: number; perWallet: number; txs: number; newWallets: number } {
  const perWallet = p.dailyTxsPerWallet * p.days * p.txCost + p.atasPerWallet * p.ataRent;
  const budgetTx = p.dailyBudgetTx && p.dailyBudgetTx > 0 ? p.dailyBudgetTx : Infinity;
  const budgetWallets = p.dailyNewWallets && p.dailyNewWallets > 0 ? p.dailyNewWallets : Infinity;
  const newWallets = Math.min(p.wallets, budgetWallets * p.days);
  const txs = Math.min(newWallets * p.dailyTxsPerWallet * p.days, budgetTx * p.days);
  return { maxCost: txs * p.txCost + newWallets * p.atasPerWallet * p.ataRent, perWallet, txs, newWallets };
}

/**
 * A network or operator outage of `outageHours` that spans some loans' deadlines. The money works out the same
 * either way (a late payer settles and pays back exactly like the cranker's settlement), but every loan whose
 * deadline fell inside the window is settled and its borrower barred until they pay back; each is a case for the
 * operator to review and, where the outage was the cause, to lift. That review is the cost.
 */
export function outageAcrossCutoff(
  s: Scenario,
  outageHours: number,
  review: { hoursPerCase: number; hourlyRate: number } = { hoursPerCase: 0.5, hourlyRate: 40 },
): { loansWithDeadlineInside: number; reviewHours: number; reviewCost: number } {
  const r = evaluate(s);
  const cases = (r.loansPerYear * outageHours) / (365 * 24);
  const reviewHours = cases * review.hoursPerCase;
  return { loansWithDeadlineInside: cases, reviewHours, reviewCost: reviewHours * review.hourlyRate };
}

/**
 * A ring of `people` who never mean to repay: each borrows once with the next as co-signer (so a ring of three or
 * more needs no reciprocal guarantee, which the program refuses). Each loan pays out the cap minus the escrow; the
 * exposure limit must fit one loan and one guarantee per person. Collusion is limited, not prevented: it costs each
 * person their eligibility for the configured durations and an ID on record, and the ring cannot repeat with the
 * same people. Returns the payoff and what it costs the fund (the escrow stays with the fund).
 */
export function collusionRing(p: { people: number; loanCap: number; escrowRate: number; exposure: number }): {
  feasible: boolean;
  loans: number;
  payoff: number;
  fundLoss: number;
  perPerson: number;
} {
  const feasible = p.people >= 3 && 2 * p.loanCap <= p.exposure;
  const loans = feasible ? p.people : 0;
  const perLoan = p.loanCap * (1 - p.escrowRate);
  return { feasible, loans, payoff: loans * perLoan, fundLoss: loans * perLoan, perPerson: perLoan };
}

/**
 * The assumptions behind the tables. `LAUNCH` is what the fund can do under its launch settings: the ceiling on
 * principal out on loan is $25,000, so with a $100,000 fund at most a quarter is ever lent. `BASE` is the same fund
 * with the ceiling raised to lend 80% of it, which is the scale the design was costed at; `scripts/model.ts` varies
 * BASE one input at a time and prints LAUNCH first.
 */
export const BASE: Scenario = {
  name: "base",
  fund: 100_000,
  utilisation: 0.8,
  avgLoan: 300,
  cycleDays: 120,
  defaultRate: 0.05,
  escrowRate: 0.25,
  repaidBeforeDefault: 0.2,
  loansPerBorrowerPerYear: 2,
  repeatRate: 0.5,
  conversionFeeUsd: 3,
  costs: {
    identityCheck: 2.5,
    newMembersPerYear: 600,
    renewalsPerYear: 1_000,
    passRenewal: 0.01,
    sponsorPerLoan: 0.6,
    recurring: { hosting: 1_800, support: 6_000, disputes: 1_500, fraudResponse: 1_500, bookkeeping: 2_400 },
    oneOff: { audit: 30_000, legal: 15_000, development: 20_000 },
    oneOffYears: 3,
  },
};

/** The launch settings: the $25,000 outstanding-principal ceiling binds, so a quarter of the fund is out at most. */
export const LAUNCH: Scenario = { ...BASE, name: "launch ($25,000 ceiling)", utilisation: 0.25 };

export const money = (n: number) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : "never");
export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
