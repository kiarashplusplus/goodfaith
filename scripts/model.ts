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
const yrs = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : 'never');

if (json) {
  console.log(JSON.stringify({ scenarios: rows.map(({ s, r }) => ({ ...s, ...r })), balance: eco.balanceSheet(BASE), trajectory: eco.trajectory(BASE, 10) }, null, 1));
} else {
  console.log(`Base assumptions: fund ${money(BASE.fund)} | ${pct(BASE.utilisation)} lent | average loan ${money(BASE.avgLoan)} | ${BASE.cycleDays}-day cycle | default rate ${pct(BASE.defaultRate)} of loans per cycle | escrow ${pct(BASE.escrowRate)} | ${pct(BASE.repaidBeforeDefault)} repaid before a default\n`);

  console.log('## Scenarios (one input changed per row)\n');
  table(
    ['scenario', 'loans/yr', 'completed/yr', 'loss/cycle', 'loss/yr', 'loss % fund', 'gifts needed/yr', 'subsidy per completed loan', 'years to half', 'collusion payoff'],
    rows.map(({ s, r }) => [s.name, Math.round(r.loansPerYear).toString(), Math.round(r.completedLoansPerYear).toString(), money(r.lossPerCycle), money(r.lossPerYear), pct(r.lossRatePerYear), money(r.donationsNeededPerYear), money(r.subsidyPerCompletedLoan), yrs(r.yearsToHalf), money(r.collusionPayoff)]),
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
      ['operating total', '', money(base.operatingPerYear)],
      ['capital lost', '', money(base.lossPerYear)],
      ['gifts needed', '', money(base.donationsNeededPerYear)],
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

  console.log('## Ten years with no new gifts (base; capital only)\n');
  table(
    ['year', 'fund at year end', 'loans that year', 'capital lost that year'],
    eco.trajectory(BASE, 10).slice(1).map((t) => [String(t.year), money(t.fund), Math.round(t.loans).toString(), money(t.loss)]),
  );

  console.log('## Stress (base unless stated)\n');
  const shock = eco.correlatedShock(BASE, 0.3);
  const issuerCapped = eco.issuerCompromise({ firstLoanCap: 150, escrowRate: 0.25, disbursementCap: 5_000, windowDays: 1, detectionDays: 3, fakeLoansPerDay: 50 });
  const issuerUncapped = eco.issuerCompromise({ firstLoanCap: 150, escrowRate: 0.25, disbursementCap: 0, windowDays: 1, detectionDays: 3, fakeLoansPerDay: 50 });
  const abuse = eco.sponsorAbuse({ wallets: 1_000, days: 1, dailyTxsPerWallet: 40, atasPerWallet: 12, txCost: 0.001, ataRent: 0.3 });
  const outage = eco.outageAcrossCutoff(BASE, 24);
  table(
    ['stress', 'bounded by', 'cost'],
    [
      ['one cycle at a 30% default rate (correlated trouble)', 'escrow rate, loan cap', `${money(shock.shockCycleLoss)} that cycle; ${money(shock.yearLoss)} that year (${pct(shock.shareOfFund)} of the fund)`],
      ['compromised issuer, found after 3 days', 'disbursement cap $5,000/day, first-loan cap $150, 25% escrow forfeited', `at most ${money(issuerCapped.maxDisbursed)} lent to ${issuerCapped.fakeLoans} fake members, ${money(issuerCapped.maxLoss)} lost`],
      ['same, with no disbursement cap', 'how fast fake people can be registered (50/day assumed)', `${money(issuerUncapped.maxDisbursed)} lent, ${money(issuerUncapped.maxLoss)} lost`],
      ['1,000 abusive wallets for a day', 'proxy caps: 40 tx/day, 12 token accounts per wallet', `${money(abuse.maxCost)} of sponsor money (${money(abuse.perWallet)} per wallet)`],
      ['24-hour outage across deadlines', 'grace period; money unaffected', `about ${outage.loansWithDeadlineInside.toFixed(1)} members marked late through no fault of theirs`],
    ],
  );
}
