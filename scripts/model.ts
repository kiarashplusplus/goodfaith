// Prints the economic tables behind docs/economics.md and the white paper. Pure arithmetic, no network.
export {};
// Usage: npm run model            (tables)   |   npm run model -- --json   (machine-readable)
const eco = await import('../app/src/lib/economics.ts');
const { BASE, evaluate, money, pct } = eco;
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
const yrs = (n: number) => (n >= 50 ? '50+' : Number.isFinite(n) ? n.toFixed(1) : 'never');

if (json) {
  console.log(JSON.stringify({ scenarios: rows.map(({ s, r }) => ({ ...s, ...r })), balance: eco.balanceSheet(BASE), trajectory: eco.trajectory(BASE, 10), grants: eco.compareWithGrants(BASE, 10) }, null, 1));
} else {
  console.log(`Base assumptions: fund ${money(BASE.fund)} | ${pct(BASE.utilisation)} lent | average loan ${money(BASE.avgLoan)} | ${BASE.cycleDays}-day cycle | default rate ${pct(BASE.defaultRate)} of loans per cycle | escrow ${pct(BASE.escrowRate)} | ${pct(BASE.repaidBeforeDefault)} repaid before a default | ${BASE.loansPerBorrowerPerYear} loans per borrower a year\n`);

  console.log('## Scenarios (one input changed per row)\n');
  table(
    ['scenario', 'loans/yr', 'completed/yr', 'people/yr', 'loss/cycle', 'loss/yr', 'loss % fund', 'gifts needed/yr', 'per completed loan', 'per person', 'half-life (capital only)', 'runway (pays its own way)', 'collusion payoff'],
    rows.map(({ s, r }) => [s.name, Math.round(r.loansPerYear).toString(), Math.round(r.completedLoansPerYear).toString(), Math.round(r.distinctBorrowersPerYear).toString(), money(r.lossPerCycle), money(r.lossPerYear), pct(r.lossRatePerYear), money(r.donationsNeededPerYear), money(r.subsidyPerCompletedLoan), money(r.subsidyPerBorrower), yrs(r.yearsToHalf), yrs(r.cashRunwayYears), money(r.collusionPayoff)]),
  );

  console.log('## Costs (base)\n');
  const c = BASE.costs;
  table(
    ['item', 'kind', 'per year'],
    [
      ['identity checks', 'recurring, per new member', `$${c.identityCheck} x ${c.newMembersPerYear} = ${money(c.identityCheck * c.newMembersPerYear)}`],
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

  console.log('## Lending against giving, ten years, same money (base)\n');
  const g = eco.compareWithGrants(BASE, 10);
  table(
    ['', 'money in over ten years', 'people reached', 'what is left'],
    [
      ['grants of one average loan each', money(g.moneyIn), `${Math.round(g.grants)} people, once`, '$0'],
      ['loans', money(g.moneyIn), `${Math.round(g.borrowers)} people (${Math.round(g.loansCompleted)} completed loans, ${BASE.loansPerBorrowerPerYear} a year each)`, `${money(g.fundLeft)} still lending`],
    ],
  );

  console.log('## Stress scenarios (assumptions in each row; these are scenarios, not bounds)\n');
  const shock = eco.correlatedShock(BASE, 0.3);
  const issuerArgs = { firstLoanCap: 150, escrowRate: 0.25, disbursementCap: 5_000, windowDays: 1, containmentDays: 3, fakeLoansPerDay: 50, outstandingCeiling: 25_000, outstandingNow: 0 };
  const issuerCapped = eco.issuerCompromise(issuerArgs);
  const issuerLate = eco.issuerCompromise({ ...issuerArgs, containmentDays: 7 });
  const issuerUncapped = eco.issuerCompromise({ ...issuerArgs, disbursementCap: 0 });
  const abuse = eco.sponsorAbuse({ wallets: 1_000, days: 1, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3, dailyBudgetTx: 2_000, dailyNewWallets: 200 });
  const abuseNoBudget = eco.sponsorAbuse({ wallets: 1_000, days: 1, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3 });
  const outage = eco.outageAcrossCutoff(BASE, 24);
  const ring = eco.collusionRing({ people: 3, loanCap: 150, escrowRate: 0.25, exposure: 1_000 });
  const ringGrown = eco.collusionRing({ people: 3, loanCap: 500, escrowRate: 0.25, exposure: 1_000 });
  table(
    ['scenario', 'assumptions', 'cost'],
    [
      ['one cycle at a 30% default rate (correlated trouble)', 'base, one cycle at 30% instead of 5%; escrow 25%', `${money(shock.shockCycleLoss)} that cycle; ${money(shock.yearLoss)} that year (${pct(shock.shareOfFund)} of the fund)`],
      ['compromised issuer, contained in 3 days', `$5,000 per fixed one-day window (${issuerCapped.windows} windows straddled), first-loan cap $150, 25% escrow forfeited, $25,000 outstanding ceiling with nothing out`, `up to ${money(issuerCapped.maxDisbursed)} to ${issuerCapped.fakeLoans} fake members, ${money(issuerCapped.maxLoss)} lost`],
      ['compromised issuer, contained in 7 days', 'as above, a week to notice and pause', `up to ${money(issuerLate.maxDisbursed)} (the ceiling binds), ${money(issuerLate.maxLoss)} lost`],
      ['compromised issuer, no window cap', '50 fake memberships a day, 3 days, the ceiling still binds', `${money(issuerUncapped.maxDisbursed)} lent, ${money(issuerUncapped.maxLoss)} lost`],
      ['1,000 abusive wallets for a day', 'per-wallet caps 40 tx/day and 12 token accounts; fund-wide budget 2,000 tx and 200 new wallets a day', `${money(abuse.maxCost)} of sponsor money (${abuse.newWallets} wallets get in; ${money(abuseNoBudget.maxCost)} with per-wallet caps alone)`],
      ['24-hour outage across deadlines', `base volume; each affected loan is settled and reviewed (half an hour at $40)`, `about ${outage.loansWithDeadlineInside.toFixed(1)} loans settled late through no fault of theirs; ${money(outage.reviewCost)} of review; the money is unchanged`],
      ['a ring of three who never repay', 'each borrows the $150 first-loan cap once with the next as co-signer (no reciprocal pair), 25% escrow', `${money(ring.payoff)} taken (${money(ring.perPerson)} each), ${money(ring.fundLoss)} lost; ${money(ringGrown.payoff)} if all three had grown to the $500 cap (${ringGrown.feasible ? 'fits the $1,000 exposure limit' : 'does not fit the $1,000 exposure limit'})`],
    ],
  );
}
