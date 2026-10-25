// Checks that the public site (site/index.html) states the launch settings in launch.json: every figure the site
// shows is a `<span data-launch="key" [data-unit="percent|years"]>value</span>`, and each must match. Exits 1 on any
// difference or on a required figure the page no longer shows.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const launch = JSON.parse(fs.readFileSync(path.join(here, 'launch.json'), 'utf8')) as Record<string, unknown>;
const html = fs.readFileSync(process.env.SITE_HTML ?? path.join(here, '..', 'site', 'index.html'), 'utf8');

const REQUIRED = [
  'firstLoanCap', 'loanCapStep', 'maxLoan', 'maxTermDays', 'graceDays', 'cooldownDays', 'requestTtlDays',
  'cosignerEscrowBps', 'maxGuaranteesPerMember', 'cosignerBanDays', 'lateBanDays', 'defaultBanDays',
];
const shown = (value: number, unit: string | undefined) =>
  unit === 'percent' ? value / 100 : unit === 'years' ? value / 365 : value;

const problems: string[] = [];
const seen = new Set<string>();
for (const m of html.matchAll(/<span data-launch="(\w+)"(?: data-unit="(\w+)")?>([^<]*)<\/span>/g)) {
  const [, key, unit, text] = m;
  seen.add(key);
  const v = launch[key];
  if (typeof v !== 'number') { problems.push(`${key}: not a number in launch.json`); continue; }
  const want = shown(v, unit);
  if (Number(text.replace(/,/g, '')) !== want) problems.push(`${key}: the site says ${text}${unit ? ` (${unit})` : ''}, launch.json gives ${want}`);
}
for (const k of REQUIRED) if (!seen.has(k)) problems.push(`${k}: not shown on the site`);

// The worked loan example: its deposit and loss follow the program's formula (escrow = ceil(amount × bps / 10000),
// in base units) for its amount, so they cannot drift from cosignerEscrowBps.
const ex = (kind: string) => [...html.matchAll(new RegExp(`<span data-example="${kind}">([^<]*)</span>`, 'g'))].map((m) => m[1]);
const amounts = ex('amount');
if (!amounts.length) problems.push('the worked example has no data-example="amount"');
else {
  const amount = Number(amounts[0]);
  if (amounts.some((a) => Number(a) !== amount)) problems.push(`the worked example uses more than one amount: ${amounts.join(', ')}`);
  const base = Math.round(amount * 1e6);
  const deposit = Math.ceil((base * Number(launch.cosignerEscrowBps)) / 10000);
  const fmt = (units: number) => (units / 1e6).toFixed(2);
  for (const d of ex('deposit')) if (d !== fmt(deposit)) problems.push(`worked example deposit ${d}, the formula gives ${fmt(deposit)}`);
  for (const l of ex('loss')) if (l !== fmt(base - deposit)) problems.push(`worked example loss ${l}, the formula gives ${fmt(base - deposit)}`);
  if (amount > Number(launch.firstLoanCap)) problems.push(`the worked example (${amount}) is above the first-loan limit`);
}

// The page's shape: the requirements come first, and the explorer and the questions exist.
const firstSection = html.match(/<main[^>]*>\s*<section id="([^"]+)"/)?.[1];
if (firstSection !== 'before') problems.push(`the first section of the page must be the requirements (#before), not #${firstSection}`);
for (const id of ['explorer', 'faq']) if (!html.includes(`<section id="${id}"`)) problems.push(`the page has no #${id} section`);

if (problems.length) {
  console.error(problems.map((p) => `  ${p}`).join('\n'));
  console.error('SITE-CHECK FAIL');
  process.exit(1);
}
console.log(`${seen.size} figures and the worked example match launch.json`);
console.log('SITE-CHECK PASS');
