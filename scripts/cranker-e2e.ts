// The cranker on the fork: a member from identity-e2e borrows a one-day loan, time travels past due + grace, and one
// cranker pass marks the default, bars the people and has the identity service revoke the borrower's pass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createKeyPairSignerFromBytes, type Address } from '@solana/kit';
import { ata, cheat, clockTs, fetchPool, gf, loanPda, MINT, rpc, send, setSol, setUsdc, USDC, wallet } from './lib.ts';
import { gatewayFixture } from './gateway-fixture.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
const APP = process.env.APP_URL ?? 'http://127.0.0.1:3100';
const { runOnce } = await import('./cranker.ts');
const { gatewayTokenAddress } = await import('../app/src/lib/gateway.ts');
const rows: string[][] = [];
const row = (step: string, ...cols: string[]) => { rows.push([step, ...cols]); console.log(`[ok] ${step} ${cols.join(' | ')}`); };

const prev = JSON.parse(fs.readFileSync(path.join(here, 'identity-e2e-result.json'), 'utf8')) as { memberSecret: number[]; member: Address };
const borrower = await createKeyPairSignerFromBytes(Uint8Array.from(prev.memberSecret));
assert.equal(borrower.address, prev.member);
const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const [pool] = await gf.findPoolPda({ mint: MINT });
const [vault] = await gf.findVaultPda({ pool });
const p0 = await fetchPool(pool);
const gateway = await gatewayFixture(p0.gatekeeperNetwork);

// a co-signer registered straight through the program (no identity record on purpose)
const cosigner = await wallet();
await setSol(cosigner.address, 1_000_000_000n);
await setUsdc(cosigner.address, 100n * USDC);
await setUsdc(borrower.address, 0n);
const gwC = await gateway.tokenFor(cosigner.address);
const hashC = new Uint8Array(createHash('sha256').update(`cranker-e2e:${cosigner.address}`).digest());
await send([await gf.getRegisterMemberInstructionAsync({ wallet: cosigner, payer: cosigner, issuer: admin, pool, gatewayToken: gwC, personHash: hashC })], cosigner, 'register cosigner');
const [pC] = await gf.findPersonPda({ pool, personHash: hashC });
const [mB] = await gf.findMemberPda({ pool, wallet: borrower.address });
const pB = (await gf.fetchMember(rpc as any, mB, { commitment: 'confirmed' })).data.person;
const gwB = await gatewayTokenAddress(borrower.address, p0.gatekeeperNetwork);

// a one-day loan (or the member's open loan from an earlier run)
const amount = 40n * USDC;
const existing = (await gf.fetchPerson(rpc as any, pB, { commitment: 'confirmed' })).data.activeLoan;
let loan: Address;
if (existing.__option === 'Some') {
  loan = existing.value;
} else {
  const [cosignerMember] = await gf.findMemberPda({ pool, wallet: cosigner.address });
  const [request] = await gf.findRequestPda({ pool, borrower: borrower.address });
  await send([await gf.getRequestLoanInstructionAsync({ payer: borrower, borrower, mint: MINT, borrowerPerson: pB, cosignerMember, borrowerGatewayToken: gwB, amount, termDays: 1, cosigner: cosigner.address })], borrower, 'request');
  loan = await loanPda(pool, (await fetchPool(pool)).loanCount);
  const escrow = (amount * BigInt(p0.cosignerEscrowBps) + 9999n) / 10000n;
  await send([await gf.getCosignLoanInstructionAsync({ payer: cosigner, cosigner, mint: MINT, vault, request, requestRentPayer: borrower.address, borrowerPerson: pB, cosignerPerson: pC, borrowerToken: await ata(borrower.address), cosignerToken: await ata(cosigner.address), loan, borrowerGatewayToken: gwB, cosignerGatewayToken: gwC, expectedAmount: amount, expectedTermDays: 1, maxEscrow: escrow })], cosigner, 'cosign');
}
const l = (await gf.fetchLoan(rpc as any, loan, { commitment: 'confirmed' })).data;
const id = l.id;
row('loan opened', `#${id} ${Number(l.principal) / 1e6} USDC, 1 day, grace ${l.graceDays}d`, `borrower ${borrower.address.slice(0, 6)}.. (identity-e2e member)`);

// nothing to do yet
let r = await runOnce();
assert.equal(r.defaults.length, 0);
assert.equal(r.errors.length, 0);
row('cranker before the deadline', 'no defaults due', `apply ${r.applied ? 'applied' : 'nothing due'}`, `sweep ${r.swept ? 'swept' : 'n/a'}`);

// past due + grace
const target = Number(l.dueAt) + l.graceDays * 86400 + 3600;
await cheat('surfnet_timeTravel', [{ absoluteTimestamp: target * 1000 }]);
await new Promise((res) => setTimeout(res, 1500));
assert.ok((await clockTs()) > Number(l.dueAt) + l.graceDays * 86400);
r = await runOnce();
assert.equal(r.errors.length, 0, r.errors.join('; '));
assert.equal(r.defaults.length, 1);
assert.equal(r.defaults[0]!.loanId, id.toString());
assert.equal(r.defaults[0]!.borrowerBarred, true);
assert.equal(r.defaults[0]!.cosignerBarred, true, 'escrow 10 < shortfall 40: the co-signer is barred too');
const cosignerPersonKey = (await gf.fetchLoan(rpc as any, loan, { commitment: 'confirmed' })).data.cosignerPerson;
const after = (await gf.fetchLoan(rpc as any, loan, { commitment: 'confirmed' })).data;
assert.equal(after.status, gf.LoanStatus.Defaulted);
const bans = Object.fromEntries(r.bans.map((b) => [b.personHash, b]));
const personB = (await gf.fetchPerson(rpc as any, pB, { commitment: 'confirmed' })).data;
const hashB = Buffer.from(personB.personHash).toString('hex');
assert.equal(personB.ineligible, true);
assert.equal(bans[hashB]?.banned, true, 'identity service banned the borrower');
assert.ok(bans[hashB]!.revoked.includes(borrower.address));
const hashCHex = Buffer.from((await gf.fetchPerson(rpc as any, cosignerPersonKey, { commitment: 'confirmed' })).data.personHash).toString('hex');
assert.equal(bans[hashCHex]?.banned, false, 'the co-signer has no identity record, so nothing to revoke');
const tok = await rpc.getAccountInfo(gwB, { encoding: 'base64' }).send();
assert.equal(Buffer.from(tok.value!.data[0], 'base64')[99], 2, 'borrower pass revoked');
const st = await (await fetch(`${APP}/api/identity/status?wallet=${borrower.address}`)).json() as { status: string };
assert.equal(st.status, 'ineligible');
row('cranker after the deadline', `loan #${id} Defaulted (${r.defaults[0]!.sig.slice(0, 8)}..)`, 'borrower and co-signer barred on chain', `borrower pass revoked (state=2), identity status ineligible`, `co-signer: no identity record`);
r = await runOnce();
assert.equal(r.defaults.length, 0);
row('cranker again', 'idempotent: nothing due');

console.log('\n' + ['step', 'detail...'].join(' | ')); for (const x of rows) console.log(x.join(' | '));
console.log('\nCRANKER E2E PASS');
