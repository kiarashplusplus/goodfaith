// The cranker on the fork: a member from identity-e2e borrows a one-day loan and repays most of it, a request is left
// to expire, a wallet recovery is left pending; time travels past due + grace, and one cranker pass settles the loan,
// bars the borrower, collects the fund's recovery, releases the co-signer's leftover escrow, finalises the recovery,
// has the identity service revoke the borrower's passes; the borrower pays the shortfall back and the bar relaxes; a
// later pass closes the expired request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { ata, cheat, clockTs, fetchPool, gf, loanPda, MINT, rpc, send, setSol, setUsdc, tok, USDC, wallet } from './lib.ts';
import { gatewayFixture } from './gateway-fixture.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const { runOnce } = await import('./cranker.ts');
const { gatewayTokenAddress } = await import('../app/src/lib/gateway.ts');
const rows: string[][] = [];
const row = (step: string, ...cols: string[]) => { rows.push([step, ...cols]); console.log(`[ok] ${step} ${cols.join(' | ')}`); };
const PERMANENT = 9223372036854775807n;
const hex = (b: Iterable<number>) => Buffer.from(Uint8Array.from(b)).toString('hex');
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
r = await runOnce();
assert.equal(r.errors.length, 0, r.errors.join('; '));
const dflt = r.defaults.find((d) => d.loanId === id.toString());
assert.ok(dflt, 'this loan was settled');
assert.equal(dflt!.borrowerBarred, true);
assert.equal(dflt!.cosignerBarred, false, 'escrow 10 covered the shortfall 5: the fund lost nothing, the co-signer stays in good standing');
const after = await getLoan(loan);
assert.equal(after.status, gf.LoanStatus.Defaulted);
assert.equal(after.refundPending, 0n, 'the cranker claimed the leftover escrow');
assert.equal(after.recoveryPending, 0n, 'the cranker collected the recovery');
const collected = r.collected.find((c) => c.loanId === id.toString());
assert.ok(collected, 'the recovery was collected into the vault');
assert.equal(BigInt(collected!.amount), 5n * USDC);
const claim = r.claims.find((c) => c.loanId === id.toString());
assert.ok(claim, 'the leftover escrow was claimed');
assert.equal(claim!.to, cosignerWallet);
assert.equal(BigInt(claim!.amount), 5n * USDC);
assert.equal(await tok(cosignerAta), cosignerTokBefore + 5n * USDC);
// the recovery was finalised: the member now lives on the pending wallet, the loan and the bar followed the person
// (a fork reused across runs may carry other due recoveries; this member's is the one that matters)
const rec = r.recoveries.find((x) => x.person === pB);
assert.ok(rec, 'this member\'s recovery was finalised');
assert.equal(rec!.to, prev.pendingWallet);
const personB = await getPerson(pB);
assert.equal(personB.wallet, prev.pendingWallet);
const poolNow = await fetchPool(pool);
assert.equal(personB.ineligibleUntil, after.defaultBanSeconds === PERMANENT ? PERMANENT : after.closedAt + after.defaultBanSeconds, 'the bar the loan opened with');
void poolNow;
assert.equal((await gf.fetchMember(rpc as any, mB, { commitment: 'confirmed' })).data.retired, true, 'old wallet retired');
assert.equal((await getPerson(l.cosignerPerson)).ineligibleUntil, 0n);
// the identity service mirrors the chain's bar: time-bounded (the pool's default ban), so no pass is revoked; the
// person can still recover a wallet and collect what they are owed, and the record lifts itself when the chain does
const bans = Object.fromEntries(r.bans.map((b) => [b.personId, b]));
const idB = hex(personB.personId);
assert.equal(bans[idB]?.banned, true, 'identity service recorded the bar');
assert.equal(bans[idB]!.revoked.length, personB.ineligibleUntil === PERMANENT ? 2 : 0, 'a temporary bar revokes nothing');
assert.equal(hex((await getPerson(l.cosignerPerson)).personId) in bans, false, 'the co-signer was not barred');
const tokB = await rpc.getAccountInfo(gwB, { encoding: 'base64' }).send();
assert.equal(Buffer.from(tokB.value!.data[0], 'base64')[99], personB.ineligibleUntil === PERMANENT ? 2 : 0, 'pass state follows the kind of bar');
const st = await (await fetch(`${APP}/api/identity/status?wallet=${prev.pendingWallet}`)).json() as { status: string; person: { ineligible: boolean; barredUntil: number } | null; next: string };
assert.equal(st.next, 'done', 'the recovered wallet is the member');
assert.equal(st.person?.ineligible, true, 'the status shows the bar');
assert.equal(BigInt(st.person!.barredUntil), personB.ineligibleUntil);
row('cranker after the deadline', `loan #${id} settled (${dflt!.sig.slice(0, 8)}..), borrower barred, co-signer not (no loss)`, `collected 5.00 for the fund (${collected!.sig.slice(0, 8)}..), claimed 5.00 to the co-signer (${claim!.sig.slice(0, 8)}..)`, `recovery finalised -> ${prev.pendingWallet.slice(0, 6)}.. (${rec!.sig.slice(0, 8)}..)`, `identity service: barred until ${when(personB.ineligibleUntil)}, passes kept`);

// the borrower (now on the new wallet) pays the 5 back: the co-signer's used escrow comes back from the vault, the
// loan is Restituted and the borrower's bar relaxes to the late bar from the settlement
const newWallet = await createKeyPairSignerFromBytes(Uint8Array.from(prev.newWalletSecret));
assert.equal(newWallet.address, prev.pendingWallet);
await setSol(newWallet.address, 1_000_000_000n);
await setUsdc(newWallet.address, 5n * USDC);
await send([await gf.getRestituteInstructionAsync({ payer: newWallet, mint: MINT, vault, loan, borrowerPerson: pB, cosignerPerson: after.cosignerPerson, payerToken: await ata(newWallet.address), amount: 5n * USDC })], newWallet, 'restitute 5');
const paidBack = await getLoan(loan);
assert.equal(paidBack.status, gf.LoanStatus.Restituted);
assert.equal(paidBack.reimbursementPending, 5n * USDC, 'owed to the co-signer out of the vault');
const relaxed = await getPerson(pB);
assert.equal(relaxed.ineligibleUntil, after.lateBanSeconds === 0n ? 0n : after.closedAt + after.lateBanSeconds, 'bar relaxed to the late bar');
r = await runOnce();
assert.equal(r.errors.length, 0, r.errors.join('; '));
const reimb = r.claims.find((c) => c.loanId === id.toString());
assert.ok(reimb, 'the cranker paid the reimbursement from the vault');
assert.equal(BigInt(reimb!.amount), 5n * USDC);
assert.equal(await tok(cosignerAta), cosignerTokBefore + 10n * USDC, 'the co-signer has the whole escrow back');
assert.equal((await getLoan(loan)).reimbursementPending, 0n);
row('borrower pays back 5', 'Restituted; bar relaxed to the late bar', `cranker reimbursed the co-signer 5.00 from the vault (${reimb!.sig.slice(0, 8)}..)`);

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
