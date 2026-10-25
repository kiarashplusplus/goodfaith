import { chromium } from 'playwright-core';
const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const pages = ['/', '/join', '/borrow', '/cosign', '/repay', '/donate', '/fund'];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let fail = 0;
// Turnkey's captcha (Cloudflare Turnstile, on in the dashboard) loads on every signed-out page: its iframe keeps
// polling, so the network never goes idle, and it logs its own CSP errors. Only that traffic is ignored.
const thirdParty = (url?: string) => {
  try {
    return !!url && new URL(url).hostname.endsWith('challenges.cloudflare.com');
  } catch {
    return false;
  }
};
for (const p of pages) {
  const page = await browser.newPage();
  const errors: string[] = [];
  let ignored = 0;
  page.on('pageerror', (e: Error) => errors.push('pageerror: ' + e.message));
  page.on('console', (m: any) => {
    if (m.type() !== 'error') return;
    if (thirdParty(m.location()?.url)) ignored++;
    else errors.push('console: ' + m.text());
  });
  page.on('requestfailed', (r: any) => {
    if (thirdParty(r.url())) ignored++;
    else errors.push('reqfailed: ' + r.url() + ' ' + r.failure()?.errorText);
  });
  page.on('response', (r: any) => {
    if (r.status() < 400) return;
    if (thirdParty(r.url())) ignored++;
    else errors.push('http ' + r.status() + ': ' + r.url());
  });
  const resp = await page.goto(BASE + p, { waitUntil: 'load' });
  await page.waitForTimeout(4000);
  const text = (await page.innerText('body')).replace(/\s+/g, ' ');
  console.log(`${p} -> ${resp?.status()} errors=${errors.length} ignored(captcha)=${ignored} | ${text.slice(0, 200)}`);
  for (const e of errors) console.log('   ', e.slice(0, 300));
  if (resp?.status() !== 200 || errors.length) fail++;
  await page.close();
}
await browser.close();
console.log(fail ? `SMOKE FAIL (${fail})` : 'SMOKE PASS');
