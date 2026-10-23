// Runs request_loan, cosign_loan and repay with Kora as the fee payer / rent payer.
// Requires: Kora running at KORA_URL (default http://127.0.0.1:8080), signer funded on the fork (done here).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { address, appendTransactionMessageInstructions, createNoopSigner, createTransactionMessage, getAddressEncoder, getBase64EncodedWireTransaction, partiallySignTransactionMessageWithSigners, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Address, type Instruction } from '@solana/kit';
import { ata, cheat, gf, GATEWAY_PROGRAM, loanPda, MINT, rpc, send, setSol, setUsdc, sol, tok, USDC, wallet, fetchPool } from './lib.ts';

const KORA_URL = process.env.KORA_URL ?? 'http://127.0.0.1:8080';
const here = path.dirname(new URL(import.meta.url).pathname);
const kcall = async (method: string, params: any = {}) => {
  const r = await (await fetch(KORA_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as any;
  if (r.error) throw new Error(`kora ${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
const koraAddr = address((await kcall('getPayerSigner')).signer_address);
console.log('Kora fee payer', koraAddr);
await setSol(koraAddr, 10_000_000_000n);
const koraSigner = createNoopSigner(koraAddr);

async function ksend(ixs: Instruction[], label: string) {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  const msg = pipe(createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayer(koraAddr, m),
    m => setTransactionMessageLifetimeUsingBlockhash(bh, m), m => appendTransactionMessageInstructions(ixs, m));
  const tx = await partiallySignTransactionMessageWithSigners(msg);
  const res = await kcall('signAndSendTransaction', { transaction: getBase64EncodedWireTransaction(tx) }).catch(e => { throw new Error(`${label}: ${e.message}`); });
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([res.signature]).send();
    const s = value[0];
    if (s?.err) throw new Error(`${label} tx error ${JSON.stringify(s.err, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
    if (s && s.confirmationStatus !== 'processed') return res.signature as string;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} not confirmed`);
}

const real = JSON.parse(fs.readFileSync(path.join(here, 'civic-token.json'), 'utf8'));
const realBytes = Buffer.from(real.data, 'hex');
async function plantGateway(owner: Address) {
  const addr = (await wallet()).address;
  const b = Buffer.from(realBytes); Buffer.from(getAddressEncoder().encode(owner)).copy(b, 2);
  await cheat('surfnet_setAccount', [addr, { lamports: real.lamports, owner: GATEWAY_PROGRAM, data: b.toString('hex') }]);
  return addr;
}

const [pool] = await gf.findPoolPda({ mint: MINT });
const [vault] = await gf.findVaultPda({ pool });
const borrower = await wallet(), cosigner = await wallet(), third = await wallet();
for (const w of [borrower, cosigner, third]) await setSol(w.address, 1_000_000_000n);
await setUsdc(borrower.address, 0n); await setUsdc(cosigner.address, 500n * USDC); await setUsdc(third.address, 200n * USDC);
const aB = await ata(borrower.address), aC = await ata(cosigner.address), aT = await ata(third.address);
const gwB = await plantGateway(borrower.address), gwC = await plantGateway(cosigner.address);
// register_member: Kora pays Member rent too (separate payer signer), so onboarding costs the wallet nothing.
await ksend([await gf.getRegisterMemberInstructionAsync({ wallet: borrower, payer: koraSigner, pool, gatewayToken: gwB })], 'register b');
await ksend([await gf.getRegisterMemberInstructionAsync({ wallet: cosigner, payer: koraSigner, pool, gatewayToken: gwC })], 'register c');
const [mB] = await gf.findMemberPda({ pool, wallet: borrower.address });
const [mC] = await gf.findMemberPda({ pool, wallet: cosigner.address });
const base = { b: await sol(borrower.address), c: await sol(cosigner.address), t: await sol(third.address), k: await sol(koraAddr) };

const p0 = await fetchPool(pool);
const amount = 80n * USDC, escrowAmt = 20n * USDC; // 25% of 80
const [request] = await gf.findRequestPda({ pool, borrower: borrower.address });
await ksend([await gf.getRequestLoanInstructionAsync({ payer: koraSigner, borrower, mint: MINT, borrowerGatewayToken: gwB, amount, termDays: 7, cosigner: cosigner.address })], 'request_loan');
const loan = await loanPda(pool, p0.loanCount);
await ksend([await gf.getCosignLoanInstructionAsync({ payer: koraSigner, cosigner, mint: MINT, vault, request, requestRentPayer: koraAddr, borrowerMember: mB, cosignerMember: mC, borrowerToken: aB, cosignerToken: aC, loan, borrowerGatewayToken: gwB, cosignerGatewayToken: gwC, expectedAmount: amount, expectedTermDays: 7, maxEscrow: escrowAmt })], 'cosign_loan');
assert.equal(await tok(aB), amount); assert.equal(await tok(aC), 500n * USDC - escrowAmt);
const [escrow] = await gf.findEscrowPda({ loan });
const repay = async (payer: any, token: Address, n: bigint) => gf.getRepayInstructionAsync({ payer, mint: MINT, vault, loan, escrow, payerToken: token, cosignerToken: aC, borrowerMember: mB, cosignerMember: mC, rentPayer: koraAddr, amount: n });
await ksend([await repay(third, aT, 30n * USDC)], 'repay partial');
await ksend([await repay(borrower, aB, 50n * USDC)], 'repay full');
assert.equal(await tok(aC), 500n * USDC);
assert.equal((await rpc.getAccountInfo(escrow, { encoding: 'base64' }).send()).value, null);
const p1 = await fetchPool(pool);
assert.equal(p1.totalRepaid, p0.totalRepaid + amount);
const after = { b: await sol(borrower.address), c: await sol(cosigner.address), t: await sol(third.address), k: await sol(koraAddr) };
console.log('SOL lamports before -> after');
for (const k of ['b', 'c', 't', 'k'] as const) console.log({ b: 'borrower', c: 'cosigner', t: 'third', k: 'kora' }[k], base[k], '->', after[k]);
assert.equal(after.b, base.b); assert.equal(after.c, base.c); assert.equal(after.t, base.t);
console.log('kora fee payer spent (net of rent refunds):', base.k - after.k, 'lamports');
console.log('KORA E2E PASS');
