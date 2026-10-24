// The cranker on the fork: a member from identity-e2e borrows a one-day loan and repays most of it, a request is left
// to expire, a wallet recovery is left pending; time travels past due + grace. The borrower settles the loan
// themselves and the escrow is frozen: one cranker pass finalises the recovery, reports the frozen escrow as waiting
// (not as an error) and reconciles the identity service with the chain's bar, whoever settled. The borrower pays the
// shortfall back while the escrow is still frozen (the uncollected recovery is released to the co-signer instead of
// being paid from the vault), the escrow thaws, the next pass releases the whole escrow to the co-signer; a later pass
// closes the expired request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { ata, cheat, clockTs, fetchPool, gf, loanPda, MINT, rpc, send, setSol, setUsdc, tok, TOKEN_PROGRAM, USDC, wallet } from './lib.ts';
import { gatewayFixture } from './gateway-fixture.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3100';
process.env.CRANKER_KEYPAIR ??= path.join(os.homedir(), '.config/solana/id.json'); // the fork's cranker is the default key (test harness only)
const { runOnce } = await import('./cranker.ts');
/** Flips the SPL token state byte of a loan's escrow (1 initialized, 2 frozen), as the mint's freeze authority could. */
async function setEscrowState(loanAddr: Address, state: 1 | 2) {
  const [escrow] = await gf.findEscrowPda({ loan: loanAddr });
  const acc = (await rpc.getAccountInfo(escrow, { encoding: 'base64' }).send()).value!;
  const data = Buffer.from(acc.data[0], 'base64');
  data[108] = state;
  await cheat('surfnet_setAccount', [escrow, { lamports: Number(acc.lamports), owner: TOKEN_PROGRAM, data: data.toString('hex') }]);
}
const statusOf = async (w: Address) => (await (await fetch(`${APP}/api/identity/status?wallet=${w}`)).json()) as { status: string; person: { ineligible: boolean; barredUntil: number } | null; next: string };
const { gatewayTokenAddress } = await import('../app/src/lib/gateway.ts');
const rows: string[][] = [];
const row = (step: string, ...cols: string[]) => { rows.push([step, ...cols]); console.log(`[ok] ${step} ${cols.join(' | ')}`); };
const PERMANENT = 9223372036854775807n;
const when = (t: bigint) => (t === PERMANENT ? 'for good' : new Date(Number(t) * 1000).toISOString());

const prev = JSON.parse(fs.readFileSync(path.join(here, 'identity-e2e-result.json'), 'utf8')) as { memberSecret: number[]; member: Address; pendingWallet: Address; newWalletSecret: number[] };
const borrower = await createKeyPairSignerFromBytes(Uint8Array.from(prev.memberSecret));
assert.equal(borrower.address, prev.member);
const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const [pool] = await gf.findPoolPda({ mint: MINT });
const [vault] = await gf.findVaultPda({ pool });
const p0 = await fetchPool(pool);
const gateway = await gatewayFixture(p0.gatekeeperNetwork);
const getPerson = async (a: Address) => (await gf.fetchPerson(rpc as any, a, { commitment: 'confirmed' })).data;
const getLoan = async (a: Address) => (await gf.fetchLoan(rpc as any, a, { commitment: 'confirmed' })).data;

// a co-signer registered straight through the program (no identity record on purpose)
const cosigner = await wallet();
await setSol(cosigner.address, 1_000_000_000n);
await setUsdc(cosigner.address, 100n * USDC);
await setUsdc(borrower.address, 0n);
const gwC = await gateway.tokenFor(cosigner.address);
const idC = new Uint8Array(createHash('sha256').update(`cranker-e2e:${cosigner.address}`).digest());
await send([await gf.getRegisterMemberInstructionAsync({ wallet: cosigner, payer: cosigner, issuer: admin, pool, gatewayToken: gwC, personId: idC })], cosigner, 'register cosigner');
const [pC] = await gf.findPersonPda({ pool, personId: idC });
const [mB] = await gf.findMemberPda({ pool, wallet: borrower.address });
const [mC] = await gf.findMemberPda({ pool, wallet: cosigner.address });
const pB = (await gf.fetchMember(rpc as any, mB, { commitment: 'confirmed' })).data.person;
const gwB = await gatewayTokenAddress(borrower.address, p0.gatekeeperNetwork);
const personBefore = await getPerson(pB);
assert.equal(personBefore.pendingWallet.__option === 'Some' ? personBefore.pendingWallet.value : null, prev.pendingWallet, 'identity-e2e left a recovery pending');

// a one-day loan (or the member's open loan from an earlier run), mostly repaid so the escrow is only partly used
const amount = 40n * USDC;
const existing = personBefore.activeLoan;
let loan: Address;
if (existing.__option === 'Some') {
  loan = existing.value;
} else {
  const [request] = await gf.findRequestPda({ pool, borrower: borrower.address });
  await send([await gf.getRequestLoanInstructionAsync({ payer: borrower, borrower, mint: MINT, borrowerPerson: pB, cosignerMember: mC, borrowerGatewayToken: gwB, amount, termDays: 1, cosigner: cosigner.address })], borrower, 'request');
  loan = await loanPda(pool, (await fetchPool(pool)).loanCount);
  const escrow = (amount * BigInt(p0.cosignerEscrowBps) + 9999n) / 10000n;
  await send([await gf.getCosignLoanInstructionAsync({ payer: cosigner, cosigner, mint: MINT, vault, request, requestRentPayer: borrower.address, borrowerPerson: pB, cosignerPerson: pC, borrowerToken: await ata(borrower.address), cosignerToken: await ata(cosigner.address), loan, borrowerGatewayToken: gwB, cosignerGatewayToken: gwC, expectedAmount: amount, expectedTermDays: 1, maxEscrow: escrow, expectedGraceDays: p0.graceDays, expectedCosignerBanSeconds: p0.cosignerBanSeconds })], cosigner, 'cosign');
  const [escrowAddr] = await gf.findEscrowPda({ loan });
  await send([await gf.getRepayInstructionAsync({ payer: borrower, mint: MINT, vault, loan, escrow: escrowAddr, payerToken: await ata(borrower.address), borrowerPerson: pB, cosignerPerson: pC, rentPayer: cosigner.address, amount: 35n * USDC })], borrower, 'repay 35');
}
const l = await getLoan(loan);
const id = l.id;
// On a fork reused across runs the open loan may come from an earlier run with another co-signer: follow the loan.
const cosignerWallet = (await getPerson(l.cosignerPerson)).wallet;
const cosignerAta = await ata(cosignerWallet);
row('loan opened', `#${id} ${Number(l.principal) / 1e6} USDC, 1 day, grace ${l.graceDays}d, repaid ${Number(l.repaid) / 1e6}`, `borrower ${borrower.address.slice(0, 6)}.. (identity-e2e member)`);

// nothing to do yet for this run's loan, request and recovery (a fork reused across runs may carry other due work)
const mine = (x: Awaited<ReturnType<typeof runOnce>>) =>
  x.defaults.filter((d) => d.loanId === id.toString()).length + x.claims.filter((c) => c.loanId === id.toString()).length +
  x.recoveries.filter((v) => v.person === pB).length;
const dry = await runOnce({ dryRun: true });
assert.equal(dry.dryRun, true);
assert.equal(mine(dry), 0, 'nothing due yet');
let r = await runOnce();
assert.equal(mine(r), 0, 'nothing due yet (the recovery delay has not passed)');
assert.equal(r.errors.length, 0, r.errors.join('; '));
row('cranker before the deadline', 'no defaults, claims, expiries or recoveries due', `apply ${r.applied ? 'applied' : 'nothing due'}`, `sweep ${r.swept ? 'swept' : 'n/a'}`);

// past due + grace (and past the recovery delay)
const target = Number(l.dueAt) + l.graceDays * 86400 + 3600;
await cheat('surfnet_timeTravel', [{ absoluteTimestamp: target * 1000 }]);
await new Promise((res) => setTimeout(res, 1500));
assert.ok((await clockTs()) > Number(l.dueAt) + l.graceDays * 86400);
const cosignerTokBefore = await tok(cosignerAta);
// the borrower settles the loan themselves (as the app's "settle and pay back" would), and the escrow is frozen by
// the mint's freeze authority before anyone moves it
await send([await gf.getSettleInstructionAsync({ caller: borrower, mint: MINT, loan, borrowerPerson: pB, cosignerPerson: l.cosignerPerson, rentPayer: l.rentPayer })], borrower, 'settle (borrower)');
const after = await getLoan(loan);
assert.equal(after.status, gf.LoanStatus.Defaulted);
assert.equal(after.recoveryPending, 5n * USDC, 'shortfall 5 set aside from the escrow');
assert.equal(after.refundPending, 5n * USDC, 'the other 5 wait for the co-signer');
await setEscrowState(loan, 2);
r = await runOnce();
assert.equal(r.errors.length, 0, r.errors.join('; '));
assert.equal(r.defaults.find((d) => d.loanId === id.toString()), undefined, 'the cranker did not settle: the borrower had');
assert.equal(r.collected.find((c) => c.loanId === id.toString()), undefined, 'frozen: nothing collected');
assert.equal(r.claims.find((c) => c.loanId === id.toString()), undefined, 'frozen: nothing claimed');
const waiting = r.waiting.filter((w) => w.includes(`#${id}`));
assert.equal(waiting.length, 2, `collect and claim wait on the frozen escrow: ${r.waiting.join('; ')}`);
assert.equal((await getLoan(loan)).recoveryPending, 5n * USDC, 'still in the frozen escrow');
// the recovery was finalised: the member now lives on the pending wallet, the loan and the bar followed the person
// (a fork reused across runs may carry other due recoveries; this member's is the one that matters)
const rec = r.recoveries.find((x) => x.person === pB);
assert.ok(rec, 'this member\'s recovery was finalised');
assert.equal(rec!.to, prev.pendingWallet);
const personB = await getPerson(pB);
assert.equal(personB.wallet, prev.pendingWallet);
assert.equal(personB.ineligibleUntil, after.defaultBanSeconds === PERMANENT ? PERMANENT : after.closedAt + after.defaultBanSeconds, 'the bar the loan opened with');
assert.equal(personB.borrowerBarUntil, personB.ineligibleUntil, 'a borrower bar');
assert.equal(personB.cosignerBarUntil, 0n);
assert.equal((await gf.fetchMember(rpc as any, mB, { commitment: 'confirmed' })).data.retired, true, 'old wallet retired');
assert.equal((await getPerson(l.cosignerPerson)).ineligibleUntil, 0n, 'escrow 10 covered the shortfall 5: the fund lost nothing, the co-signer stays in good standing');
// the identity service follows the chain, whoever settled: the bar is time-bounded (the pool's default ban), so no
// pass is frozen; the person can still recover a wallet and collect what they are owed
assert.ok(r.reconcile, 'the identity service was reconciled');
assert.equal(r.reconcile!.note, undefined, r.reconcile!.note ?? 'reconciled');
assert.ok(r.reconcile!.barred >= 1, 'the chain\'s bars were mirrored');
assert.ok(r.reconcile!.recoveriesClosed >= 1, 'the finalised recovery request was closed');
const tokB = await rpc.getAccountInfo(gwB, { encoding: 'base64' }).send();
assert.equal(Buffer.from(tokB.value!.data[0], 'base64')[99], personB.ineligibleUntil === PERMANENT ? 1 : 0, 'pass state follows the kind of bar (0 active, 1 frozen)');
let st = await statusOf(prev.pendingWallet);
assert.equal(st.next, 'done', 'the recovered wallet is the member');
assert.equal(st.person?.ineligible, true, 'the status shows the bar');
assert.equal(BigInt(st.person!.barredUntil), personB.ineligibleUntil);
row('cranker after the deadline', `loan #${id} settled by the borrower, escrow frozen: collect and claim wait (${waiting.length} waiting, 0 errors)`, `recovery finalised -> ${prev.pendingWallet.slice(0, 6)}.. (${rec!.sig.slice(0, 8)}..)`, `identity service reconciled: barred until ${when(personB.ineligibleUntil)}, pass kept`);

// the borrower (now on the new wallet) pays the 5 back while the escrow is still frozen: the fund cannot collect its
// 5, so that 5 is released to the co-signer where it is and the vault keeps the payment; the loan is Restituted and
// the borrower's own pay-back relaxes their bar to the late bar from today
const newWallet = await createKeyPairSignerFromBytes(Uint8Array.from(prev.newWalletSecret));
assert.equal(newWallet.address, prev.pendingWallet);
await setSol(newWallet.address, 1_000_000_000n);
await setUsdc(newWallet.address, 5n * USDC);
const vaultBefore = await tok(vault);
await send([await gf.getRestituteInstructionAsync({ payer: newWallet, mint: MINT, vault, loan, borrowerPerson: pB, cosignerPerson: after.cosignerPerson, payerToken: await ata(newWallet.address), amount: 5n * USDC })], newWallet, 'restitute 5');
const paidBack = await getLoan(loan);
assert.equal(paidBack.status, gf.LoanStatus.Restituted);
assert.equal(paidBack.recoveryPending, 0n, 'the uncollected recovery was released to the co-signer');
assert.equal(paidBack.refundPending, 10n * USDC, 'the whole escrow is the co-signer\'s now');
assert.equal(paidBack.reimbursementPending, 0n, 'nothing owed from the vault');
assert.equal(await tok(vault), vaultBefore + 5n * USDC, 'the vault keeps the payment in place of the recovery');
const relaxed = await getPerson(pB);
const paidAt = BigInt(await clockTs());
if (after.lateBanSeconds === 0n) assert.ok(relaxed.ineligibleUntil <= paidAt, 'eligible again (no late bar)');
else assert.ok(relaxed.ineligibleUntil >= paidAt - 300n + after.lateBanSeconds && relaxed.ineligibleUntil <= paidAt + after.lateBanSeconds, 'bar relaxed to the late bar from the pay-back');
// still frozen: the cranker keeps waiting, then the escrow thaws and the next pass releases it
r = await runOnce();
assert.equal(r.errors.length, 0, r.errors.join('; '));
assert.equal(r.claims.find((c) => c.loanId === id.toString()), undefined, 'still frozen');
await setEscrowState(loan, 1);
r = await runOnce();
assert.equal(r.errors.length, 0, r.errors.join('; '));
const released = r.claims.find((c) => c.loanId === id.toString());
assert.ok(released, 'the cranker released the escrow to the co-signer');
assert.equal(BigInt(released!.amount), 10n * USDC);
assert.equal(released!.to, cosignerWallet);
assert.equal(await tok(cosignerAta), cosignerTokBefore + 10n * USDC, 'the co-signer has the whole escrow back');
assert.equal(r.waiting.filter((w) => w.includes(`#${id}`)).length, 0);
st = await statusOf(prev.pendingWallet);
assert.equal(BigInt(st.person?.barredUntil ?? 0), relaxed.ineligibleUntil > paidAt ? relaxed.ineligibleUntil : 0n, 'the identity service follows the relaxed bar');
row('borrower pays back 5 while frozen', 'Restituted; the recovery is released to the co-signer, the vault keeps the payment; bar relaxed to the late bar from today', `thawed: cranker released 10.00 to the co-signer (${released!.sig.slice(0, 8)}..)`);

// a request that will expire: the co-signer asks for a small loan naming the member's new wallet (the pool's grace
// is longer than the request TTL on the fork, so the request is made after the default pass)
const [reqAddr] = await gf.findRequestPda({ pool, borrower: cosigner.address });
const [mNew] = await gf.findMemberPda({ pool, wallet: prev.pendingWallet });
await send([await gf.getRequestLoanInstructionAsync({ payer: cosigner, borrower: cosigner, mint: MINT, borrowerPerson: pC, cosignerMember: mNew, borrowerGatewayToken: gwC, amount: 5n * USDC, termDays: 2, cosigner: prev.pendingWallet })], cosigner, 'request (to expire)');
const req = (await gf.fetchLoanRequest(rpc as any, reqAddr, { commitment: 'confirmed' })).data;
r = await runOnce();
assert.equal(r.errors.length, 0, r.errors.join('; '));
assert.equal(r.expired.filter((e) => e.borrower === cosigner.address).length, 0, 'the request has not expired yet');
// past the request's TTL
await cheat('surfnet_timeTravel', [{ absoluteTimestamp: (Number(req.expiresAt) + 60) * 1000 }]);
await new Promise((res) => setTimeout(res, 1500));
r = await runOnce();
assert.equal(r.errors.length, 0, r.errors.join('; '));
assert.equal(r.defaults.length, 0);
const exp = r.expired.find((e) => e.borrower === cosigner.address);
assert.ok(exp, 'the expired request was closed');
assert.equal((await rpc.getAccountInfo(reqAddr, { encoding: 'base64' }).send()).value, null, 'expired request closed');
row('cranker after the request TTL', `expired request of ${cosigner.address.slice(0, 6)}.. closed (${exp!.sig.slice(0, 8)}..)`, 'rent back to its payer');
r = await runOnce();
assert.equal(r.defaults.length + r.claims.length + r.expired.length + r.recoveries.length, 0);
assert.equal(r.errors.length, 0, r.errors.join('; '));
row('cranker again', 'idempotent: nothing due');

console.log('\n' + ['step', 'detail...'].join(' | ')); for (const x of rows) console.log(x.join(' | '));
console.log('\nCRANKER E2E PASS');
