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

if (problems.length) {
  console.error(problems.map((p) => `  ${p}`).join('\n'));
  console.error('SITE-CHECK FAIL');
  process.exit(1);
}
console.log(`${seen.size} figures match launch.json`);
console.log('SITE-CHECK PASS');
