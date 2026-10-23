// Prints the economic scenarios behind docs/economics.md and the white paper. Pure arithmetic, no network.
export {};
// Usage: npm run model            (tables)   |   npm run model -- --json   (machine-readable)
const { BASE, evaluate, money, pct } = await import('../app/src/lib/economics.ts');
type Scenario = import('../app/src/lib/economics.ts').Scenario;

const json = process.argv.includes('--json');
const vary = (name: string, patch: Partial<Scenario>): Scenario => ({ ...BASE, ...patch, name });
const scenarios: Scenario[] = [
  vary('base: 5% default, 25% escrow', {}),
  vary('reviewer: 10% default, 25% escrow, nothing repaid, fully lent', { utilisation: 1, defaultRate: 0.1, repaidBeforeDefault: 0 }),
  vary('good year: 2% default', { defaultRate: 0.02 }),
  vary('bad year: 15% default', { defaultRate: 0.15 }),
  vary('higher escrow: 50%', { escrowRate: 0.5 }),
  vary('escrow 100% (co-signer fully covers)', { escrowRate: 1 }),
  vary('shorter loans: 60-day cycle', { cycleDays: 60 }),
  vary('small fund: $25k, 60% lent', { fund: 25_000, utilisation: 0.6, costs: { ...BASE.costs, newMembersPerYear: 150 } }),
  vary('larger loans: $500 average', { avgLoan: 500 }),
];
const rows = scenarios.map((s) => ({ s, r: evaluate(s) }));
if (json) {
  console.log(JSON.stringify(rows.map(({ s, r }) => ({ ...s, ...r })), null, 1));
} else {
  console.log('Assumptions (base): fund', money(BASE.fund), '| lent', pct(BASE.utilisation), '| avg loan', money(BASE.avgLoan), '| cycle', BASE.cycleDays, 'days | repaid before default', pct(BASE.repaidBeforeDefault));
  console.log('Operating costs: identity check', money(BASE.costs.identityCheck), 'x', BASE.costs.newMembersPerYear, '/yr | sponsor', `$${BASE.costs.sponsorPerLoan}`, '/loan | hosting', money(BASE.costs.hostingPerYear), '/yr | audit', money(BASE.costs.auditPerYear), '/yr\n');
  const header = ['scenario', 'loans/yr', 'loss/cycle', 'loss/yr', 'loss % fund', 'operating/yr', 'donations needed/yr', 'years to depletion', 'collusion payoff'];
  const table = rows.map(({ s, r }) => [s.name, Math.round(r.loansPerYear).toString(), money(r.lossPerCycle), money(r.lossPerYear), pct(r.lossRatePerYear), money(r.operatingPerYear), money(r.donationsNeededPerYear), Number.isFinite(r.yearsToDepletion) ? r.yearsToDepletion.toFixed(1) : 'never', money(r.collusionPayoff)]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
  const line = (cells: string[]) => '| ' + cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ') + ' |';
  console.log(line(header));
  console.log('|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|');
  for (const row of table) console.log(line(row));
}
