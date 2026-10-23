import { chromium } from 'playwright-core';
const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const pages = ['/', '/join', '/borrow', '/cosign', '/repay', '/donate', '/fund'];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fail = 0;
for (const p of pages) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push('pageerror: ' + e.message));
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r: any) => errors.push('reqfailed: ' + r.url() + ' ' + r.failure()?.errorText));
  page.on('response', (r: any) => { if (r.status() >= 400) errors.push('http ' + r.status() + ': ' + r.url()); });
  const resp = await page.goto(BASE + p, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const text = (await page.innerText('body')).replace(/\s+/g, ' ');
  console.log(`${p} -> ${resp?.status()} errors=${errors.length} | ${text.slice(0, 200)}`);
  for (const e of errors) console.log('   ', e.slice(0, 300));
  if (resp?.status() !== 200 || errors.length) fail++;
  await page.close();
}
await browser.close();
console.log(fail ? `SMOKE FAIL (${fail})` : 'SMOKE PASS');
