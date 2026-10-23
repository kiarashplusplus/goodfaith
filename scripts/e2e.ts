import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { address, createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { ata, cheat, clockTs, expectFail, fetchPool, gf, loanPda, MINT, GATEWAY_PROGRAM, rpc, send, setSol, setUsdc, sol, tok, USDC, wallet } from './lib.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
import { getAddressDecoder, getAddressEncoder } from '@solana/kit';
const addrDec = getAddressDecoder();

// ---------- Task 1: real Civic layout ----------
const REAL_TOKEN = '1TooKmvEanuR75v38CdbqZT9dUiQdRKKE1dMHK7KCuK'; // real devnet gateway token (Uniqueness network)
function decodeGateway(d: Buffer) {
  let p = 0;
  const version = d[p++];
  const parent = d[p++]; if (parent) p += 32;
  const owner = addrDec.decode(d.subarray(p, p + 32)); p += 32;
  const ident = d[p++]; if (ident) p += 32;
  const network = addrDec.decode(d.subarray(p, p + 32)); p += 32;
  const gatekeeper = addrDec.decode(d.subarray(p, p + 32)); p += 32;
  const state = d[p++];
  const hasExp = d[p++]; let expiry: bigint | null = null; if (hasExp) { expiry = d.readBigInt64LE(p); p += 8; }
  return { version, parent, owner, ident, network, gatekeeper, state, expiry, consumed: p, len: d.length };
}
async function realToken() {
  const cache = path.join(here, 'civic-token.json');
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const r = await (await fetch('https://api.devnet.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [REAL_TOKEN, { encoding: 'base64' }] }) })).json() as any;
  const v = r.result.value;
  const out = { pubkey: REAL_TOKEN, owner: v.owner, lamports: v.lamports, data: Buffer.from(v.data[0], 'base64').toString('hex') };
  fs.writeFileSync(cache, JSON.stringify(out, null, 1));
  return out;
}

const rows: string[][] = [];
const row = (step: string, ...cols: string[]) => { rows.push([step, ...cols]); console.log(`[ok] ${step} ${cols.join(' | ')}`); };
const fmt = (n: bigint) => (Number(n) / 1e6).toFixed(2);

const real = await realToken();
assert.equal(real.owner, GATEWAY_PROGRAM);
const realBytes = Buffer.from(real.data, 'hex');
const dec = decodeGateway(realBytes);
console.log('REAL civic token', real.pubkey, { ...dec, expiry: String(dec.expiry), expiryDate: dec.expiry ? new Date(Number(dec.expiry) * 1000).toISOString() : null });
assert.equal(dec.consumed, dec.len, 'layout consumed exactly all bytes');
assert.equal(dec.state, 0); assert.ok(dec.expiry! > BigInt(Math.floor(Date.now() / 1000)));
const NETWORK = dec.network;
row('civic layout', `real token ${real.pubkey.slice(0, 6)}.. v${dec.version} state=${dec.state} net=${NETWORK.slice(0, 6)}..`, `parsed ${dec.consumed}/${dec.len} bytes`);

async function plantGateway(owner: Address): Promise<Address> {
  const addr = (await wallet()).address;
  const bytes = Buffer.from(realBytes);
  Buffer.from(getAddressEncoder().encode(owner)).copy(bytes, 1 + 1); // version(1)+parent opt tag(1, None) -> owner_wallet at offset 2
  assert.equal(dec.parent, 0);
  await cheat('surfnet_setAccount', [addr, { lamports: real.lamports, owner: GATEWAY_PROGRAM, data: bytes.toString('hex') }]);
  return addr;
}

// ---------- Setup ----------
const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const donor = await wallet(), borrower = await wallet(), cosigner = await wallet(), third = await wallet();
for (const w of [donor, borrower, cosigner, third]) await setSol(w.address, 2_000_000_000n);
await setUsdc(donor.address, 5_000n * USDC);
await setUsdc(borrower.address, 0n);
await setUsdc(cosigner.address, 500n * USDC);
await setUsdc(third.address, 200n * USDC);

const [pool] = await gf.findPoolPda({ mint: MINT });
const [vault] = await gf.findVaultPda({ pool });
const existing = await rpc.getAccountInfo(pool, { encoding: 'base64' }).send();
if (!existing.value) {
  await send([await gf.getInitializePoolInstructionAsync({ payer: admin, mint: MINT, params: { gatekeeperNetwork: NETWORK, maxLoan: 1000n * USDC, maxTermDays: 30, graceDays: 3, maxGuaranteesPerMember: 2, cosignerEscrowBps: 2500 } })], admin, 'initialize_pool');
}
const p0 = await fetchPool(pool);
assert.equal(p0.gatekeeperNetwork, NETWORK, 'existing pool uses a different gatekeeper network');
assert.equal(p0.mint, MINT);
row('initialize_pool', existing.value ? 'reused existing pool' : 'created', `net=${p0.gatekeeperNetwork.slice(0, 6)}.. bps=${p0.cosignerEscrowBps} grace=${p0.graceDays}d`);

const ataOf = { donor: await ata(donor.address), borrower: await ata(borrower.address), cosigner: await ata(cosigner.address), third: await ata(third.address) };

// ---------- Donate ----------
const v0 = await tok(vault);
await send([await gf.getDonateInstructionAsync({ donor, mint: MINT, vault, donorToken: ataOf.donor, amount: 1000n * USDC })], donor, 'donate');
assert.equal(await tok(vault), v0 + 1000n * USDC);
assert.equal(await tok(ataOf.donor), 4000n * USDC);
let p = await fetchPool(pool);
assert.equal(p.totalDonated, p0.totalDonated + 1000n * USDC);
row('donate 1000', `vault ${fmt(await tok(vault))}`, `donor ${fmt(await tok(ataOf.donor))}`);

// ---------- Register ----------
const gwB = await plantGateway(borrower.address), gwC = await plantGateway(cosigner.address);
// negative: a token owned by someone else is rejected
const gwThird = await plantGateway(third.address);
const negErr = await expectFail(send([await gf.getRegisterMemberInstructionAsync({ wallet: borrower, payer: borrower, pool, gatewayToken: gwThird })], borrower, 'register wrong token'), 'wrong-owner gateway token');
row('register w/ wrong-owner token', 'rejected', negErr.match(/InvalidGatewayToken|0x[0-9a-f]+|Custom[^"]*/)?.[0] ?? negErr.slice(0, 80));
await send([await gf.getRegisterMemberInstructionAsync({ wallet: borrower, payer: borrower, pool, gatewayToken: gwB })], borrower, 'register borrower');
await send([await gf.getRegisterMemberInstructionAsync({ wallet: cosigner, payer: cosigner, pool, gatewayToken: gwC })], cosigner, 'register cosigner');
const [mB] = await gf.findMemberPda({ pool, wallet: borrower.address });
const [mC] = await gf.findMemberPda({ pool, wallet: cosigner.address });
const getMember = async (a: Address) => (await gf.fetchMember(rpc as any, a, { commitment: 'confirmed' })).data;
assert.equal((await getMember(mB)).ineligible, false);
row('register_member', 'borrower+cosigner accepted using cloned REAL civic token bytes');

// ---------- Loan 1 ----------
async function openLoan(amount: bigint, termDays: number) {
  const [request] = await gf.findRequestPda({ pool, borrower: borrower.address });
  await send([await gf.getRequestLoanInstructionAsync({ payer: borrower, borrower, mint: MINT, borrowerGatewayToken: gwB, amount, termDays, cosigner: cosigner.address })], borrower, 'request_loan');
  const pBefore = await fetchPool(pool);
  const id = pBefore.loanCount;
  const loan = await loanPda(pool, id);
  const escrow = (amount * BigInt(pBefore.cosignerEscrowBps) + 9999n) / 10000n;
  const before = { vault: await tok(vault), b: await tok(ataOf.borrower), c: await tok(ataOf.cosigner) };
  await send([await gf.getCosignLoanInstructionAsync({ payer: cosigner, cosigner, mint: MINT, vault, request, requestRentPayer: borrower.address, borrowerMember: mB, cosignerMember: mC, borrowerToken: ataOf.borrower, cosignerToken: ataOf.cosigner, loan, borrowerGatewayToken: gwB, cosignerGatewayToken: gwC, expectedAmount: amount, expectedTermDays: termDays, maxEscrow: escrow })], cosigner, 'cosign_loan');
  const [escrowAddr] = await gf.findEscrowPda({ loan });
  assert.equal(await tok(vault), before.vault - amount);
  assert.equal(await tok(ataOf.borrower), before.b + amount);
  assert.equal(await tok(ataOf.cosigner), before.c - escrow);
  assert.equal(await tok(escrowAddr), escrow);
  const pa = await fetchPool(pool);
  assert.equal(pa.totalLent, pBefore.totalLent + amount);
  assert.equal(pa.loanCount, id + 1n);
  return { loan, escrow: escrowAddr, escrowAmt: escrow, id, request };
}
const L1 = await openLoan(100n * USDC, 7);
row('request+cosign loan#1 100', `escrow ${fmt(L1.escrowAmt)}`, `borrower ${fmt(await tok(ataOf.borrower))}`, `cosigner ${fmt(await tok(ataOf.cosigner))}`, `vault ${fmt(await tok(vault))}`);
assert.equal((await getMember(mB)).activeLoan.__option, 'Some');
const rq = await rpc.getAccountInfo((await gf.findRequestPda({ pool, borrower: borrower.address }))[0], { encoding: 'base64' }).send();
assert.equal(rq.value, null, 'request closed');

const repayIx = async (payer: any, payerToken: Address, loan: Address, escrow: Address, rentPayer: Address, amount: bigint) =>
  gf.getRepayInstructionAsync({ payer, mint: MINT, vault, loan, escrow, payerToken, cosignerToken: ataOf.cosigner, borrowerMember: mB, cosignerMember: mC, rentPayer, amount });
const loanOf = async (a: Address) => (await gf.fetchLoan(rpc as any, a, { commitment: 'confirmed' })).data;

// partial repay by third party
let l = await loanOf(L1.loan);
let vb = await tok(vault);
await send([await repayIx(third, ataOf.third, L1.loan, L1.escrow, l.rentPayer, 40n * USDC)], third, 'repay partial');
assert.equal(await tok(vault), vb + 40n * USDC); assert.equal(await tok(ataOf.third), 160n * USDC);
l = await loanOf(L1.loan); assert.equal(l.repaid, 40n * USDC); assert.equal(l.status, gf.LoanStatus.Active);
row('partial repay 40 (third party)', `loan.repaid ${fmt(l.repaid)}`, `third ${fmt(await tok(ataOf.third))}`, `vault ${fmt(await tok(vault))}`);
await expectFail(send([await repayIx(third, ataOf.third, L1.loan, L1.escrow, l.rentPayer, 61n * USDC)], third, 'overpay'), 'overpay');
row('overpay 61 (rem 60)', 'rejected');

// full repay: remaining 60 by borrower (needs USDC: borrower has 100)
const cBefore = await tok(ataOf.cosigner), rentBefore = await sol(l.rentPayer);
await send([await repayIx(borrower, ataOf.borrower, L1.loan, L1.escrow, l.rentPayer, 60n * USDC)], borrower, 'repay full');
assert.equal(await tok(ataOf.cosigner), cBefore + L1.escrowAmt);
assert.equal(await tok(ataOf.borrower), 40n * USDC);
assert.equal((await rpc.getAccountInfo(L1.escrow, { encoding: 'base64' }).send()).value, null, 'escrow closed');
l = await loanOf(L1.loan); assert.equal(l.status, gf.LoanStatus.Repaid);
assert.equal((await getMember(mB)).activeLoan.__option, 'None');
assert.equal((await getMember(mC)).activeGuarantees, 0);
p = await fetchPool(pool);
assert.equal(p.totalRepaid, p0.totalRepaid + 100n * USDC);
assert.ok((await sol(l.rentPayer)) > rentBefore - 1n);
row('full repay 60', `escrow back to cosigner ${fmt(await tok(ataOf.cosigner))}`, `escrow acct closed`, `vault ${fmt(await tok(vault))}`, `totalRepaid +${fmt(p.totalRepaid - p0.totalRepaid)}`);

// ---------- Loan 2 -> default ----------
const L2 = await openLoan(100n * USDC, 7);
row('loan#2 100', `escrow ${fmt(L2.escrowAmt)}`, `borrower ${fmt(await tok(ataOf.borrower))}`, `vault ${fmt(await tok(vault))}`);
l = await loanOf(L2.loan);
const early = await expectFail(send([await gf.getMarkDefaultInstructionAsync({ caller: third, mint: MINT, vault, loan: L2.loan, escrow: L2.escrow, cosignerToken: ataOf.cosigner, borrowerMember: mB, cosignerMember: mC, rentPayer: l.rentPayer })], third, 'early default'), 'early default');
row('mark_default too early', 'rejected', early.match(/NotYetDefaultable|0x[0-9a-f]+/)?.[0] ?? '');
// partial repay 30 so shortfall is 70 < escrow 25? escrow=25, shortfall=70 -> recovered 25, lost 45
await send([await repayIx(third, ataOf.third, L2.loan, L2.escrow, l.rentPayer, 30n * USDC)], third, 'repay partial 2');
const now0 = await clockTs();
const target = Number(l.dueAt) + 3 * 86400 + 3600;
await cheat('surfnet_timeTravel', [{ absoluteTimestamp: target * 1000 }]);
await new Promise(r => setTimeout(r, 1500));
const now1 = await clockTs();
console.log('clock', now0, '->', now1, 'due', l.dueAt, 'target', target);
assert.ok(now1 > Number(l.dueAt) + 3 * 86400, 'time travel moved clock past due+grace');
const pre = { vault: await tok(vault), c: await tok(ataOf.cosigner), p: await fetchPool(pool) };
await send([await gf.getMarkDefaultInstructionAsync({ caller: third, mint: MINT, vault, loan: L2.loan, escrow: L2.escrow, cosignerToken: ataOf.cosigner, borrowerMember: mB, cosignerMember: mC, rentPayer: l.rentPayer })], third, 'mark_default');
const shortfall = 70n * USDC, recovered = L2.escrowAmt < shortfall ? L2.escrowAmt : shortfall;
assert.equal(await tok(vault), pre.vault + recovered);
assert.equal(await tok(ataOf.cosigner), pre.c + (L2.escrowAmt - recovered));
assert.equal((await rpc.getAccountInfo(L2.escrow, { encoding: 'base64' }).send()).value, null);
l = await loanOf(L2.loan); assert.equal(l.status, gf.LoanStatus.Defaulted);
const mb = await getMember(mB), mc = await getMember(mC);
assert.equal(mb.ineligible, true); assert.equal(mc.ineligible, true);
assert.equal(mb.activeLoan.__option, 'None'); assert.equal(mc.activeGuarantees, 0);
p = await fetchPool(pool);
assert.equal(p.totalRecovered, pre.p.totalRecovered + recovered);
assert.equal(p.totalLost, pre.p.totalLost + (shortfall - recovered));
row('mark_default', `recovered ${fmt(recovered)}`, `lost ${fmt(shortfall - recovered)}`, `vault ${fmt(await tok(vault))}`, `both ineligible`);
// ineligible cannot request again
await expectFail(send([await gf.getRequestLoanInstructionAsync({ payer: borrower, borrower, mint: MINT, borrowerGatewayToken: gwB, amount: 10n * USDC, termDays: 7, cosigner: cosigner.address })], borrower, 'request after default'), 'ineligible request');
row('request after default', 'rejected (ineligible)');

// final totals
p = await fetchPool(pool);
console.log('\nPool', pool, { donated: fmt(p.totalDonated), lent: fmt(p.totalLent), repaid: fmt(p.totalRepaid), recovered: fmt(p.totalRecovered), lost: fmt(p.totalLost), loanCount: String(p.loanCount) });
console.log('\n' + ['step', 'detail...'].join(' | ')); for (const r of rows) console.log(r.join(' | '));
console.log('\nE2E PASS');
fs.writeFileSync(path.join(here, 'e2e-result.json'), JSON.stringify({ pool, vault, authority: admin.address, network: NETWORK, mint: MINT }, null, 1));
