// Prints the economic tables behind docs/economics.md and the white paper. Pure arithmetic, no network.
export {};
// Usage: npm run model            (tables)   |   npm run model -- --json   (machine-readable)
const eco = await import('../app/src/lib/economics.ts');
const { BASE, LAUNCH, evaluate, money, pct } = eco;
type Scenario = import('../app/src/lib/economics.ts').Scenario;

const json = process.argv.includes('--json');
const vary = (name: string, patch: Partial<Scenario>): Scenario => ({ ...BASE, ...patch, name });
// Every row shares the base assumptions and changes exactly one input (the reviewer's case changes three, and says so).
const scenarios: Scenario[] = [
  vary('base', {}),
  vary('default 2%', { defaultRate: 0.02 }),
  vary('default 10%', { defaultRate: 0.1 }),
  vary('default 15%', { defaultRate: 0.15 }),
  vary('nothing repaid before default', { repaidBeforeDefault: 0 }),
  vary('escrow 50%', { escrowRate: 0.5 }),
  vary('escrow 100%', { escrowRate: 1 }),
  vary('60-day cycle', { cycleDays: 60 }),
  vary('fund $25k', { fund: 25_000 }),
  vary('average loan $150 (first-loan cap)', { avgLoan: 150 }),
  vary('average loan $500', { avgLoan: 500 }),
  vary('one loan per borrower a year', { loansPerBorrowerPerYear: 1 }),
  vary('reviewer: 10% default, nothing repaid, fully lent (three inputs)', { utilisation: 1, defaultRate: 0.1, repaidBeforeDefault: 0 }),
];
const rows = scenarios.map((s) => ({ s, r: evaluate(s) }));
const table = (header: string[], body: string[][]) => {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ') + ' |';
  console.log(line(header));
  console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
  for (const row of body) console.log(line(row));
  console.log();
};
const base = evaluate(BASE);
const launch = evaluate(LAUNCH);
const yrs = (n: number) => (n >= 50 ? '50+' : Number.isFinite(n) ? n.toFixed(1) : 'never');
const scenarioRow = (s: Scenario, r: ReturnType<typeof evaluate>) => [s.name, Math.round(r.loansPerYear).toString(), Math.round(r.completedLoansPerYear).toString(), Math.round(r.distinctBorrowersPerYear).toString(), money(r.lossPerCycle), money(r.lossPerYear), pct(r.lossRatePerYear), money(r.donationsNeededPerYear), money(r.subsidyPerCompletedLoan), money(r.subsidyPerBorrower), yrs(r.yearsToHalf), yrs(r.cashRunwayYears), money(r.collusionPayoff)];
const grantsRows = (s: Scenario) => {
  const g = eco.compareWithGrants(s, 10);
  return [
    ['grants of one average loan each', money(g.moneyIn), `${Math.round(g.grants)} people, once`, '$0', '-'],
    ['loans', money(g.moneyIn), `${Math.round(g.people)} people (${Math.round(g.borrowerYears)} borrower-years, ${Math.round(g.loansCompleted)} completed loans; ${pct(s.repeatRate)} of a year's borrowers borrowed before)`, `${money(g.fundLeft)} still lending`, `co-signers lost ${money(g.cosignerDepositsLost)} of deposits; borrowers paid ${money(g.borrowerConversion)} to convert`],
  ];
};

if (json) {
  console.log(JSON.stringify({ launch: { ...LAUNCH, ...launch, grants: eco.compareWithGrants(LAUNCH, 10) }, scenarios: rows.map(({ s, r }) => ({ ...s, ...r })), balance: eco.balanceSheet(BASE), trajectory: eco.trajectory(BASE, 10), grants: eco.compareWithGrants(BASE, 10) }, null, 1));
} else {
  console.log(`Launch assumptions: fund ${money(LAUNCH.fund)} | the $25,000 ceiling on principal out on loan binds, so ${pct(LAUNCH.utilisation)} lent | average loan ${money(LAUNCH.avgLoan)} | ${LAUNCH.cycleDays}-day cycle | default rate ${pct(LAUNCH.defaultRate)} of loans per cycle | escrow ${pct(LAUNCH.escrowRate)} | ${pct(LAUNCH.repaidBeforeDefault)} repaid before a default | ${LAUNCH.loansPerBorrowerPerYear} loans per borrower a year\n`);
  console.log('## At launch scale (the headline: what the fund can do under its launch settings)\n');
  table(
    ['scenario', 'loans/yr', 'completed/yr', 'borrower-years/yr', 'loss/cycle', 'loss/yr', 'loss % fund', 'gifts needed/yr', 'per completed loan', 'per borrower-year', 'half-life (capital only)', 'runway (pays its own way)', 'collusion payoff'],
    [scenarioRow(LAUNCH, launch), scenarioRow({ ...LAUNCH, name: 'launch, default 10%', defaultRate: 0.1 }, evaluate({ ...LAUNCH, defaultRate: 0.1 })), scenarioRow({ ...LAUNCH, name: 'launch, default 2%', defaultRate: 0.02 }, evaluate({ ...LAUNCH, defaultRate: 0.02 }))],
  );
  console.log('## Lending against giving at launch scale, ten years, same money\n');
  table(['', 'money in over ten years', 'people reached', 'what is left', 'costs the fund does not pay'], grantsRows(LAUNCH));
  console.log(`At launch scale the fixed costs of running the fund are spread over about ${Math.round(launch.completedLoansPerYear)} completed loans a year, so each costs the donors about ${money(launch.subsidyPerCompletedLoan)} against ${money(LAUNCH.avgLoan)} lent, and the same money as grants would reach more people. Loan volume against fixed costs decides the result, not the default rate; the design pays off only once the ceiling is raised (the base scale below, 80% of the fund lent).\n`);

  console.log(`Base assumptions: fund ${money(BASE.fund)} | ${pct(BASE.utilisation)} lent | average loan ${money(BASE.avgLoan)} | ${BASE.cycleDays}-day cycle | default rate ${pct(BASE.defaultRate)} of loans per cycle | escrow ${pct(BASE.escrowRate)} | ${pct(BASE.repaidBeforeDefault)} repaid before a default | ${BASE.loansPerBorrowerPerYear} loans per borrower a year\n`);

  console.log('## Scenarios at the base scale (one input changed per row)\n');
  table(
    ['scenario', 'loans/yr', 'completed/yr', 'borrower-years/yr', 'loss/cycle', 'loss/yr', 'loss % fund', 'gifts needed/yr', 'per completed loan', 'per borrower-year', 'half-life (capital only)', 'runway (pays its own way)', 'collusion payoff'],
    rows.map(({ s, r }) => scenarioRow(s, r)),
  );

  console.log('## Costs (base)\n');
  const c = BASE.costs;
  table(
    ['item', 'kind', 'per year'],
    [
      ['identity checks', 'recurring, per new member', `$${c.identityCheck} x ${c.newMembersPerYear} = ${money(c.identityCheck * c.newMembersPerYear)}`],
      ['pass renewals', 'recurring, per member a year (a signed message and a transaction fee)', `$${c.passRenewal} x ${c.renewalsPerYear} = ${money(c.passRenewal * c.renewalsPerYear)}`],
      ['sponsor rent and fees', 'recurring, per loan', `$${c.sponsorPerLoan} x ${Math.round(base.loansPerYear)} = ${money(c.sponsorPerLoan * base.loansPerYear)}`],
      ...Object.entries(c.recurring).map(([k, v]) => [k, 'recurring', money(v)]),
      ...Object.entries(c.oneOff).map(([k, v]) => [k, `one-off, ${money(v)} over ${c.oneOffYears} years`, money(v / c.oneOffYears)]),
      ['recurring total', '', money(base.recurringPerYear)],
      ['one-off total (amortised)', '', money(base.oneOffPerYear)],
      ['operating total (amortised)', '', money(base.operatingPerYear)],
      ['capital lost', '', money(base.lossPerYear)],
      ['gifts needed (amortised)', '', money(base.donationsNeededPerYear)],
      ['cash needed, year one (one-offs paid in full)', '', money(base.cashYearOne)],
      ['cash needed, each later year', '', money(base.cashLaterYears)],
      ["co-signers' deposits used by defaults (their money, not the fund's)", 'per year', money(base.cosignerDepositsLostPerYear)],
      ["borrowers' conversion fees (their money, not the fund's)", `per year, $${BASE.conversionFeeUsd} each way per loan`, money(base.borrowerConversionPerYear)],
    ],
  );

  console.log('## Balance sheet (base, a moment in time)\n');
  const b = eco.balanceSheet(BASE);
  table(
    ['line', 'amount'],
    [
      ['cash in the vault, available to lend', money(b.cashToLend)],
      ['principal out on loan', money(b.outstandingPrincipal)],
      ["co-signers' escrow held against those loans (not the fund's)", money(b.escrowHeld)],
      ['expected loss on the open loans', money(b.expectedLossOnOpenLoans)],
    ],
  );

  console.log('## Ten years with no new gifts (base; capital only, operating costs paid from elsewhere)\n');
  table(
    ['year', 'fund at year end', 'loans that year', 'capital lost that year'],
    eco.trajectory(BASE, 10).slice(1).map((t) => [String(t.year), money(t.fund), Math.round(t.loans).toString(), money(t.loss)]),
  );
  console.log(`Paying its own way (capital losses and operating costs out of the vault, no gifts): the base fund lasts about ${yrs(base.cashRunwayYears)} years.\n`);

  console.log('## Lending against giving at the base scale, ten years, same money\n');
  table(['', 'money in over ten years', 'people reached', 'what is left', 'costs the fund does not pay'], grantsRows(BASE));

  console.log('## Stress scenarios (assumptions in each row; these are scenarios, not bounds)\n');
  const shock = eco.correlatedShock(BASE, 0.3);
  // The fund at launch scale normally has most of the ceiling in use, so the attacker gets the headroom, not the ceiling.
  const outstandingNow = Math.round(LAUNCH.fund * LAUNCH.utilisation * 0.8);
  const issuerArgs = { firstLoanCap: 150, escrowRate: 0.25, disbursementCap: 5_000, windowDays: 1, containmentDays: 3, fakeLoansPerDay: 50, outstandingCeiling: 25_000, outstandingNow };
  const issuerCapped = eco.issuerCompromise(issuerArgs);
  const issuerEmpty = eco.issuerCompromise({ ...issuerArgs, outstandingNow: 0 });
  const issuerLate = eco.issuerCompromise({ ...issuerArgs, outstandingNow: 0, containmentDays: 7 });
  const issuerUncapped = eco.issuerCompromise({ ...issuerArgs, outstandingNow: 0, disbursementCap: 0 });
  const abuse = eco.sponsorAbuse({ wallets: 1_000, days: 1, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3, dailyBudgetTx: 2_000, dailyNewWallets: 200 });
  const abuseNoBudget = eco.sponsorAbuse({ wallets: 1_000, days: 1, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3 });
  const abuseYear = eco.sponsorAbuse({ wallets: 100_000, days: 365, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3, dailyBudgetTx: 2_000, dailyNewWallets: 200 });
  const outage = eco.outageAcrossCutoff(BASE, 24);
  const ring = eco.collusionRing({ people: 3, loanCap: 150, escrowRate: 0.25, exposure: 1_000 });
  const ringGrown = eco.collusionRing({ people: 3, loanCap: 500, escrowRate: 0.25, exposure: 1_000 });
  table(
    ['scenario', 'assumptions', 'cost'],
    [
      ['one cycle at a 30% default rate (correlated trouble)', 'base, one cycle at 30% instead of 5%; escrow 25%', `${money(shock.shockCycleLoss)} that cycle; ${money(shock.yearLoss)} that year (${pct(shock.shareOfFund)} of the fund)`],
      ['compromised issuer, contained in 3 days, fund in normal use', `$5,000 per fixed one-day window (${issuerCapped.windows} windows straddled), first-loan cap $150, 25% escrow forfeited, $25,000 outstanding ceiling with ${money(outstandingNow)} already out`, `up to ${money(issuerCapped.maxDisbursed)} to ${issuerCapped.fakeLoans} fake members, ${money(issuerCapped.maxLoss)} lost (the ceiling's headroom binds)`],
      ['compromised issuer, contained in 3 days, nothing out', 'as above with the whole ceiling free', `up to ${money(issuerEmpty.maxDisbursed)} to ${issuerEmpty.fakeLoans} fake members, ${money(issuerEmpty.maxLoss)} lost`],
      ['compromised issuer, contained in 7 days, nothing out', 'as above, a week to notice and pause', `up to ${money(issuerLate.maxDisbursed)} (the ceiling binds), ${money(issuerLate.maxLoss)} lost`],
      ['compromised issuer, no window cap, nothing out', '50 fake memberships a day, 3 days, the ceiling still binds', `${money(issuerUncapped.maxDisbursed)} lent, ${money(issuerUncapped.maxLoss)} lost`],
      ['1,000 abusive wallets for a day', 'per-wallet caps 40 tx/day and 12 token accounts; fund-wide budget 2,000 tx and 200 new wallets a day', `${money(abuse.maxCost)} of sponsor money (${abuse.newWallets} wallets get in; ${money(abuseNoBudget.maxCost)} with per-wallet caps alone)`],
      ['abusive wallets every day for a year', 'the same budget, 365 days', `${money(abuseYear.maxCost)} of sponsor money a year at most (${abuseYear.newWallets.toLocaleString('en-US')} wallets, ${abuseYear.txs.toLocaleString('en-US')} transactions)`],
      ['24-hour outage across deadlines', `base volume; each affected loan is settled and reviewed (half an hour at $40)`, `about ${outage.loansWithDeadlineInside.toFixed(1)} loans settled late through no fault of theirs; ${money(outage.reviewCost)} of review; the fund's money is unchanged, but each co-signer's deposit is used until the borrower pays back and each borrower loses the loan's cap credit`],
      ['a ring of three who never repay', 'each borrows the $150 first-loan cap once with the next as co-signer (no reciprocal pair), 25% escrow', `${money(ring.payoff)} taken (${money(ring.perPerson)} each), ${money(ring.fundLoss)} lost; ${money(ringGrown.payoff)} if all three had grown to the $500 cap (${ringGrown.feasible ? 'fits the $1,000 exposure limit' : 'does not fit the $1,000 exposure limit'})`],
    ],
  );
}
