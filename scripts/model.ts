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
  vary('settlement 2%', { settlementRate: 0.02 }),
  vary('settlement 10%', { settlementRate: 0.1 }),
  vary('settlement 15%', { settlementRate: 0.15 }),
  vary('nothing repaid before settlement', { repaidBeforeDefault: 0 }),
  vary('half of what settlements leave is paid back later', { paybackRate: 0.5 }),
  vary('escrow 50%', { escrowRate: 0.5 }),
  vary('escrow 100%', { escrowRate: 1 }),
  vary('60-day cycle', { cycleDays: 60 }),
  vary('fund $25k', { fund: 25_000 }),
  vary('average loan $150 (first-loan cap)', { avgLoan: 150 }),
  vary('average loan $500', { avgLoan: 500 }),
  vary('one loan per borrower a year', { loansPerBorrowerPerYear: 1 }),
  vary('reviewer: 10% settled, nothing repaid, fully lent (three inputs)', { utilisation: 1, settlementRate: 0.1, repaidBeforeDefault: 0 }),
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
const FIRST = eco.launchFirstYear();
const first = evaluate(FIRST);
const ramp = eco.launchRamp({ ...eco.RAMP, months: 24 });
const yrs = (n: number) => (n >= 50 ? '50+' : Number.isFinite(n) ? n.toFixed(1) : 'never');
const scenarioRow = (s: Scenario, r: ReturnType<typeof evaluate>) => [s.name, Math.round(r.loansPerYear).toString(), Math.round(r.completedLoansPerYear).toString(), Math.round(r.distinctBorrowersPerYear).toString(), money(r.lossPerCycle), money(r.lossPerYear), pct(r.lossRatePerYear), money(r.donationsNeededPerYear), money(r.subsidyPerCompletedLoan), money(r.subsidyPerBorrower), yrs(r.yearsToHalf), yrs(r.cashRunwayYears), money(r.collusionPayoff)];
const grantsAssumptions = (s: Scenario) => {
  const r = evaluate(s);
  return [
    ['completed loans per year', Math.round(r.completedLoansPerYear).toString(), `loans in the year that were not settled (settlement rate ${pct(s.settlementRate)})`],
    ['loans per borrower per year', String(s.loansPerBorrowerPerYear), 'turns completed loans into borrower-years'],
    ['unique borrowers in year one', Math.round(r.distinctBorrowersPerYear).toString(), 'every borrower in the first year is new'],
    ["share of a later year's borrowers who borrowed before", pct(s.repeatRate), 'retention: the rest are new people'],
    ['new borrowers each later year', Math.round(r.distinctBorrowersPerYear * (1 - s.repeatRate)).toString(), ''],
    ['terminal value of the fund', money(s.fund), 'the endowment is still there after ten years (with the gifts the table counts); grants leave nothing'],
    ['benefit compared', 'people reached', "not equal: a loan is the use of the money for a few months; a grant is the money, with no co-signer, deposit or bar"],
  ];
};
const grantsRows = (s: Scenario) => {
  const g = eco.compareWithGrants(s, 10);
  return [
    ['grants of one average loan each', money(g.moneyIn), `${Math.round(g.grants)} people, once`, '$0', '-'],
    ['loans', money(g.moneyIn), `${Math.round(g.people)} people (${Math.round(g.borrowerYears)} borrower-years, ${Math.round(g.loansCompleted)} completed loans; ${pct(s.repeatRate)} of a year's borrowers borrowed before)`, `${money(g.fundLeft)} still lending`, `co-signers lost ${money(g.cosignerDepositsLost)} of deposits; borrowers paid ${money(g.borrowerConversion)} to convert`],
  ];
};

if (json) {
  console.log(JSON.stringify({ launch: { ...LAUNCH, ...launch, grants: eco.compareWithGrants(LAUNCH, 10) }, launchFirstYear: { ...FIRST, ...first }, ramp, scenarios: rows.map(({ s, r }) => ({ ...s, ...r })), balance: eco.balanceSheet(BASE), trajectory: eco.trajectory(BASE, 10), grants: eco.compareWithGrants(BASE, 10) }, null, 1));
} else {
  console.log(`Launch assumptions: fund ${money(LAUNCH.fund)} | the $25,000 ceiling on principal out on loan binds, so ${pct(LAUNCH.utilisation)} lent | average loan ${money(LAUNCH.avgLoan)} | ${LAUNCH.cycleDays}-day cycle | settlement rate ${pct(LAUNCH.settlementRate)} of loans per cycle | escrow ${pct(LAUNCH.escrowRate)} | ${pct(LAUNCH.repaidBeforeDefault)} repaid before a settlement | ${pct(LAUNCH.paybackRate)} of what is left paid back later | ${LAUNCH.loansPerBorrowerPerYear} loans per borrower a year\n`);
  console.log('## At launch scale (the headline: what the fund can do under its launch settings)\n');
  table(
    ['scenario', 'loans/yr', 'completed/yr', 'borrower-years/yr', 'loss/cycle', 'loss/yr', 'loss % fund', 'gifts needed/yr', 'per completed loan', 'per borrower-year', 'half-life (capital only)', 'runway (pays its own way)', 'collusion payoff'],
    [scenarioRow(FIRST, first), scenarioRow(LAUNCH, launch), scenarioRow({ ...LAUNCH, name: 'launch, settlement 10%', settlementRate: 0.1 }, evaluate({ ...LAUNCH, settlementRate: 0.1 })), scenarioRow({ ...LAUNCH, name: 'launch, settlement 2%', settlementRate: 0.02 }, evaluate({ ...LAUNCH, settlementRate: 0.02 }))],
  );
  console.log('## The launch ramp (average loan opened each month; members join steadily and borrow back to back)\n');
  table(
    ['month', ...[1, 3, 6, 9, 12, 18, 24].map(String)],
    [['average loan', ...[1, 3, 6, 9, 12, 18, 24].map((m) => money(ramp[m - 1]!.avgLoan))]],
  );
  console.log(`New members borrow at most ${money(eco.RAMP.firstLoanCap)}; each loan repaid on time and held 30 days adds ${money(eco.RAMP.step)}, so with ${eco.RAMP.cycleDays}-day cycles a member reaches the ${money(eco.RAMP.need)} need on their third loan, about eight months in. A steady stream of new members keeps the average below the mature ${money(BASE.avgLoan)}: about ${money(FIRST.avgLoan)} in the first year.\n`);
  console.log('## What a settlement leaves (launch scale, per year)\n');
  const split = (r: ReturnType<typeof evaluate>) => [money(r.principalAtSettlementPerYear), money(r.escrowRecoveriesPerYear), money(r.laterRecoveriesPerYear), money(r.lossPerYear)];
  const payback = evaluate({ ...LAUNCH, paybackRate: 0.5 });
  table(
    ['', 'principal unpaid at settlement', 'covered by escrow', 'paid back later (to the fund)', 'ultimate loss'],
    [['launch, nothing paid back later', ...split(launch)], ['launch, half paid back later', ...split(payback)]],
  );
  console.log('## Lending against giving at launch scale, ten years, same money\n');
  table(['', 'money in over ten years', 'people reached', 'what is left', 'costs the fund does not pay'], grantsRows(LAUNCH));
  console.log('Assumptions behind that comparison:\n');
  table(['assumption', 'value', 'note'], grantsAssumptions(LAUNCH));
  console.log(`At launch scale the fixed costs of running the fund are spread over about ${Math.round(launch.completedLoansPerYear)} completed loans a year, so each costs the donors about ${money(launch.subsidyPerCompletedLoan)} against ${money(LAUNCH.avgLoan)} lent, and the same money as grants would reach more people. Loan volume against fixed costs decides the result, not the settlement rate; the design pays off only once the ceiling is raised (the base scale below, 80% of the fund lent).\n`);

  console.log(`Base assumptions: fund ${money(BASE.fund)} | ${pct(BASE.utilisation)} lent | average loan ${money(BASE.avgLoan)} | ${BASE.cycleDays}-day cycle | settlement rate ${pct(BASE.settlementRate)} of loans per cycle | escrow ${pct(BASE.escrowRate)} | ${pct(BASE.repaidBeforeDefault)} repaid before a settlement | ${BASE.loansPerBorrowerPerYear} loans per borrower a year\n`);

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
      ["co-signers' deposits used by settlements (their money, not the fund's)", 'per year', money(base.cosignerDepositsLostPerYear)],
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
  // The pilot's lifetime budget is $40,000; a fund that has lent $30,000 of it has $10,000 left, whatever has settled.
  const issuerBudget = eco.issuerCompromise({ ...issuerArgs, outstandingNow: 0, containmentDays: 30, budgetLeft: 10_000 });
  // Strangers draw on the onboarding lane only, and get no token accounts (the sponsor pays rent for members' accounts
  // only), so they cost transaction fees: 60 a day. Verified members cost what their per-wallet caps allow.
  const abuse = eco.sponsorAbuse({ wallets: 1_000, days: 1, dailyTxsPerWallet: 40, atasPerWallet: 0, txCost: 0.001, ataRent: 0.3, dailyBudgetTx: 60, dailyNewWallets: 20 });
  const abuseYear = eco.sponsorAbuse({ wallets: 100_000, days: 365, dailyTxsPerWallet: 40, atasPerWallet: 0, txCost: 0.001, ataRent: 0.3, dailyBudgetTx: 60, dailyNewWallets: 20 });
  const v5Year = eco.sponsorAbuse({ wallets: 100_000, days: 365, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3, dailyBudgetTx: 2_000, dailyNewWallets: 200 });
  const memberYear = eco.sponsorAbuse({ wallets: 600, days: 365, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3, dailyBudgetTx: 300 });
  const outage = eco.outageAcrossCutoff(BASE, 24);
  const ring = eco.collusionRing({ people: 3, loanCap: 150, escrowRate: 0.25, exposure: 1_000 });
  const ringGrown = eco.collusionRing({ people: 3, loanCap: 500, escrowRate: 0.25, exposure: 1_000 });
  table(
    ['scenario', 'assumptions', 'cost'],
    [
      ['one cycle at a 30% settlement rate (correlated trouble)', 'base, one cycle at 30% instead of 5%; escrow 25%; nothing paid back', `${money(shock.shockCycleLoss)} that cycle; ${money(shock.yearLoss)} that year (${pct(shock.shareOfFund)} of the fund)`],
      ['compromised identity service (issuer and gatekeeper), contained in 3 days, fund in normal use', `no loan settles or is repaid before containment; $5,000 per fixed one-day window (${issuerCapped.windows} windows straddled), first-loan cap $150, 25% escrow forfeited, $25,000 outstanding ceiling with ${money(outstandingNow)} already out`, `up to ${money(issuerCapped.maxDisbursed)} to ${issuerCapped.fakeLoans} fake members, ${money(issuerCapped.maxLoss)} lost (the ceiling's headroom binds)`],
      ['compromised identity service, contained in 3 days, nothing out', 'as above with the whole ceiling free', `up to ${money(issuerEmpty.maxDisbursed)} to ${issuerEmpty.fakeLoans} fake members, ${money(issuerEmpty.maxLoss)} lost`],
      ['compromised identity service, contained in 7 days, nothing out', 'as above, a week to notice and pause', `up to ${money(issuerLate.maxDisbursed)} (the ceiling binds), ${money(issuerLate.maxLoss)} lost`],
      ['compromised identity service, no window cap, nothing out', '50 fake memberships a day, 3 days, the ceiling still binds', `${money(issuerUncapped.maxDisbursed)} lent, ${money(issuerUncapped.maxLoss)} lost`],
      ['compromised identity service, unnoticed for a month', `settlements free the ceiling as fast as the attacker lends; only the $40,000 lifetime budget, with ${money(10_000)} of it left, binds`, `${money(issuerBudget.maxDisbursed)} lent, ${money(issuerBudget.maxLoss)} lost, then nothing until the administrator raises the budget, with notice`],
      ['1,000 strangers\' wallets for a day', 'onboarding lane: 60 sponsored transactions and 20 new wallets a day; no token accounts for non-members', `$${abuse.maxCost.toFixed(2)} of sponsor money (${abuse.newWallets} wallets get in); the protected and member lanes are untouched`],
      ['strangers every day for a year', 'the same lane, 365 days', `${money(abuseYear.maxCost)} a year (v5's single 2,000-transaction budget allowed ${money(v5Year.maxCost)})`],
      ['every verified member at their caps for a year', '600 members, 40 tx a day and 12 token accounts each, member lane 300 tx a day', `${money(memberYear.maxCost)} a year at most; each of them passed an identity check`],
      ['24-hour outage across deadlines', `base volume; each affected loan is settled and reviewed (half an hour at $40)`, `about ${outage.loansWithDeadlineInside.toFixed(1)} loans settled late through no fault of theirs; ${money(outage.reviewCost)} of review; the fund's money is unchanged, but each co-signer's deposit is used until the borrower pays back and each borrower loses the loan's cap credit`],
      ['a ring of three who never repay', 'each borrows the $150 first-loan cap once with the next as co-signer (no reciprocal pair), 25% escrow', `${money(ring.payoff)} taken (${money(ring.perPerson)} each), ${money(ring.fundLoss)} lost; ${money(ringGrown.payoff)} if all three had grown to the $500 cap (${ringGrown.feasible ? 'fits the $1,000 exposure limit' : 'does not fit the $1,000 exposure limit'})`],
    ],
  );
}
