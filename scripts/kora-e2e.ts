// Sponsored flows through the web app's own code path (app/src/lib/tx.ts + kora.ts + program.ts) with Kora as
// fee and rent payer, on a Surfpool fork with the program planted by `npm run deploy-fork` and a pool from `npm run e2e`.
// Requires Kora at KORA_URL (default http://127.0.0.1:8080). Set KORA_URL=http://localhost:3000/api/sponsor to go
// through the app's proxy instead (start the app with KORA_URL/KORA_* set).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AccountRole, address, createKeyPairSignerFromBytes, createNoopSigner, partiallySignTransaction, type Address, type Instruction } from '@solana/kit';
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { ata, cheat, clockTs, rpc, RPC_URL, send, setSol, setUsdc, sol, tok, USDC, wallet } from './lib.ts';

process.env.NEXT_PUBLIC_KORA_URL = process.env.KORA_URL ?? 'http://127.0.0.1:8080';
process.env.NEXT_PUBLIC_RPC_URL = RPC_URL;
// The app modules read NEXT_PUBLIC_* at import time, so import them after setting the environment.
const tx = await import('../app/src/lib/tx.ts');
const kora = await import('../app/src/lib/kora.ts');
const prog = await import('../app/src/lib/program.ts');
const sendLib = await import('../app/src/lib/send.ts');
const { gatewayFixture } = await import('./gateway-fixture.ts');
const { escrowFor } = await import('../app/src/lib/escrow.ts');
const cfg = await import('../app/src/lib/config.ts');

const here = path.dirname(new URL(import.meta.url).pathname);
const rows: string[][] = [];
const row = (step: string, ...cols: string[]) => { rows.push([step, ...cols]); console.log(`[ok] ${step} ${cols.join(' | ')}`); };
const fmt = (n: bigint) => (Number(n) / 1e6).toFixed(2);
const txRpc = rpc as unknown as Parameters<typeof tx.sendInstructions>[0] & Parameters<typeof prog.fetchPool>[0];
type Signer = Awaited<ReturnType<typeof wallet>>;
const sponsored = (w: Signer, ixs: Instruction[] | ((feePayer: Address) => Promise<Instruction[]>)) => tx.sendInstructions(txRpc, w as never, ixs as never);
const ataCreate = (payer: Address, a: Address, owner: Address, mint: Address) =>
  getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata: a, owner, mint }) as Instruction;

// ---------- Kora up, payer funded ----------
assert.ok(kora.kora, 'NEXT_PUBLIC_KORA_URL must be set');
await kora.kora!.liveness();
const payer = await kora.getKoraPayer();
assert.ok(payer, 'getPayerSigner failed');
await setSol(payer!, 20_000_000_000n);
row('kora', `payer ${payer!.slice(0, 6)}..`, `url ${process.env.NEXT_PUBLIC_KORA_URL}`);

// ---------- actors ----------
const [poolAddr] = await prog.findPoolPda(cfg.POOL_MINT);
const poolMaybe = await prog.fetchPool(txRpc, poolAddr);
if (!poolMaybe) throw new Error('pool missing: run `npm run e2e` first');
const pool = poolMaybe;
const network = pool.gatekeeperNetwork;
const MINT = pool.mint;
const gateway = await gatewayFixture(network);
assert.equal(gateway.network, network, 'gatekeeper.json network must match the pool (re-run e2e after gatekeeper-setup)');
const plantGateway = (owner: Address) => gateway.tokenFor(owner);
const borrower = await wallet(), cosigner = await wallet(), third = await wallet(), donor = await wallet(), borrower2 = await wallet(), cosigner2 = await wallet();
for (const w of [borrower, cosigner, third, donor, borrower2, cosigner2]) await setSol(w.address, 1_000_000_000n);
// borrower and borrower2 deliberately have NO token account: the co-sign prefix must create it (sponsor pays that rent)
await setUsdc(cosigner.address, 500n * USDC); await setUsdc(third.address, 200n * USDC); await setUsdc(donor.address, 1000n * USDC);
for (const w of [borrower, cosigner, borrower2, cosigner2]) await plantGateway(w.address);
const gw = (w: Address) => gateway.addressOf(w);
const base = Object.fromEntries(await Promise.all([borrower, cosigner, donor, borrower2, cosigner2].map(async w => [w.address, await sol(w.address)])));
const koraBase = await sol(payer!);
let sponsoredTxs = 0;
const sp = async (w: Signer, ixs: Parameters<typeof sponsored>[1], label: string) => { const sig = await sponsored(w, ixs); sponsoredTxs++; return sig; };

// ---------- register (Person + Member rent sponsored; the issuer co-signs, as the identity service does) ----------
const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
assert.equal(pool.issuer, admin.address, 'the fork pool must use the admin key as issuer (npm run e2e)');
const idOf = (a: Address) => new Uint8Array(createHash('sha256').update(`kora-e2e:${a}`).digest());
for (const w of [borrower, cosigner, borrower2, cosigner2]) {
  // Prepared-transaction path: build for the sponsor, the issuer and the wallet sign, Kora adds its signature and sends.
  const ix = await prog.registerMemberIx({ wallet: w.address, payer: payer!, issuer: admin.address, pool, gatewayToken: await gw(w.address), personId: idOf(w.address) });
  const built = await tx.buildTransaction(txRpc, payer!, [ix]);
  await tx.simulate(txRpc, built);
  const signed = await partiallySignTransaction([admin.keyPair, (w as unknown as { keyPair: CryptoKeyPair }).keyPair], built);
  await tx.submit(txRpc, signed, true, payer!);
  sponsoredTxs++;
}
row('register_member x4', 'Kora paid the Person + Member rent; wallet + issuer + Kora signatures (3 = max_signatures)');
const personOf = async (w: Address) => (await prog.fetchMember(txRpc, pool.address, w))!.person;

// ---------- request + cosign for a borrower with no token account ----------
const amount = 100n * USDC, term = 7;
await sp(borrower, async (feePayer) => [await prog.requestLoanIx({ payer: feePayer, borrower: borrower.address, borrowerPerson: await personOf(borrower.address), pool, borrowerGatewayToken: await gw(borrower.address), amount, termDays: term, cosigner: cosigner.address })], 'request');
const borrowerAta = await ata(borrower.address);
assert.equal(await sendLib.ataExists(txRpc, borrowerAta), false, 'borrower must start without a token account');
async function cosignFor(b: Signer, c: Signer) {
  const p = (await prog.fetchPool(txRpc, pool.address))!;
  const req = (await prog.fetchRequest(txRpc, p.address, b.address))!;
  const escrow = escrowFor(req.amount, p.cosignerEscrowBps);
  await sp(c, async (feePayer) => {
    const { ix, borrowerToken } = await prog.cosignLoanIx({ payer: feePayer, pool: p, request: req, borrowerPerson: await personOf(req.borrower), cosignerPerson: await personOf(req.cosigner), borrowerGatewayToken: await gw(req.borrower), cosignerGatewayToken: await gw(req.cosigner), expectedAmount: req.amount, expectedTermDays: req.termDays, maxEscrow: escrow });
    return [ataCreate(feePayer, borrowerToken, req.borrower, p.mint), ix];
  }, 'cosign');
  return { id: p.loanCount, escrow };
}
const L1 = await cosignFor(borrower, cosigner);
assert.equal(await tok(borrowerAta), amount);
assert.equal(await tok(await ata(cosigner.address)), 500n * USDC - L1.escrow);
row('cosign (borrower had no token account)', `loan#${L1.id}`, `escrow ${fmt(L1.escrow)}`, `ATA created by the sponsor, within max_allowed_lamports`);

// ---------- repay, then the claim that releases the escrow ----------
const loanOf = async (id: bigint) => (await prog.fetchLoanById(txRpc, pool.address, id))!;
let l = await loanOf(L1.id);
const cw = (loan: typeof l) => prog.cosignerWalletOf(txRpc, loan);
await sp(third, [await prog.repayIx({ payer: third.address, pool, loan: l, amount: 30n * USDC })], 'repay partial');
l = await loanOf(L1.id);
await sp(borrower, [await prog.repayIx({ payer: borrower.address, pool, loan: l, amount: 70n * USDC })], 'repay full');
l = await loanOf(L1.id);
assert.equal(l.status, 'Repaid');
assert.equal(l.refundPending, L1.escrow);
assert.equal(await tok(await ata(cosigner.address)), 500n * USDC - L1.escrow, 'repay pushes nothing to the co-signer');
// the co-signer presses "Release escrow" in the app: sponsored, the token account already exists
await sp(cosigner, async () => [(await prog.claimEscrowIx({ claimer: cosigner.address, pool, loan: l, cosignerWallet: await cw(l) })).ix], 'claim');
assert.equal(await tok(await ata(cosigner.address)), 500n * USDC);
assert.equal((await loanOf(L1.id)).refundPending, 0n);
row('repay 30 (third) + 70 (borrower) + claim', 'Repaid', `escrow claimed ${fmt(await tok(await ata(cosigner.address)))}`, 'escrow rent back to Kora (the co-sign payer)');

// ---------- donate ----------
const vaultBefore = await tok(pool.vault);
await sp(donor, [await prog.donateIx({ donor: donor.address, pool, amount: 50n * USDC })], 'donate');
assert.equal(await tok(pool.vault), vaultBefore + 50n * USDC);
row('donate 50', 'sponsored');

// ---------- request + cancel ----------
await sp(borrower, async (feePayer) => [await prog.requestLoanIx({ payer: feePayer, borrower: borrower.address, borrowerPerson: await personOf(borrower.address), pool, borrowerGatewayToken: await gw(borrower.address), amount: 10n * USDC, termDays: 3, cosigner: cosigner.address })], 'request 2');
const req2 = (await prog.fetchRequest(txRpc, pool.address, borrower.address))!;
assert.equal(req2.rentPayer, payer, 'Kora is the request rent payer');
await sp(borrower, [prog.cancelRequestIx({ canceller: borrower.address, pool: pool.address, request: req2 })], 'cancel');
assert.equal(await prog.fetchRequest(txRpc, pool.address, borrower.address), null);
row('request + cancel', 'request rent returned to Kora');

// ---------- loan 2: default, then a claim that re-creates the co-signer's closed token account at the sponsor's expense ----------
await sp(borrower2, async (feePayer) => [await prog.requestLoanIx({ payer: feePayer, borrower: borrower2.address, borrowerPerson: await personOf(borrower2.address), pool, borrowerGatewayToken: await gw(borrower2.address), amount, termDays: term, cosigner: cosigner2.address })], 'request b2');
const escrow2 = escrowFor(amount, pool.cosignerEscrowBps);
await setUsdc(cosigner2.address, escrow2); // exactly the escrow, so the account is empty afterwards
const L2 = await cosignFor(borrower2, cosigner2);
const c2ata = await ata(cosigner2.address);
assert.equal(await tok(c2ata), 0n);
// close the empty token account (user pays: the sponsor never closes accounts)
await tx.sendInstructions(txRpc, cosigner2 as never, [getCloseAccountInstruction({ account: c2ata, destination: cosigner2.address, owner: cosigner2 }) as never], { sponsor: false });
assert.equal(await sendLib.ataExists(txRpc, c2ata), false);
l = await loanOf(L2.id);
// Repayment and default never touch the co-signer's token account, so a closed account cannot block either.
await sp(third, [await prog.repayIx({ payer: third.address, pool, loan: l, amount: 80n * USDC })], 'repay partial 2');
assert.equal(await sendLib.ataExists(txRpc, c2ata), false, 'repayment left the closed account alone');
const target = Number(l.dueAt) + l.graceDays * 86400 + 3600;
await cheat('surfnet_timeTravel', [{ absoluteTimestamp: target * 1000 }]);
await new Promise(r => setTimeout(r, 1500));
assert.ok((await clockTs()) > Number(l.dueAt) + l.graceDays * 86400);
await sp(third, [await prog.markDefaultIx({ caller: third.address, pool, loan: l })], 'mark_default');
l = await loanOf(L2.id);
assert.equal(l.status, 'Defaulted');
assert.equal(l.refundPending, escrow2 - 20n * USDC, 'shortfall 20 came out of the escrow, the rest is owed to the co-signer');
// the claim (by anyone) re-creates the token account, the sponsor paying its rent
await sp(third, async (feePayer) => {
  const cosignerWallet = await cw(l);
  const { ix, cosignerToken } = await prog.claimEscrowIx({ claimer: third.address, pool, loan: l, cosignerWallet });
  return [ataCreate(feePayer, cosignerToken, cosignerWallet, pool.mint), ix];
}, 'claim 2');
assert.equal(await tok(c2ata), escrow2 - 20n * USDC);
assert.equal((await loanOf(L2.id)).refundPending, 0n);
row('repay 80 + mark_default + claim after the co-signer closed their token account', `loan#${L2.id}`, 'Defaulted, shortfall 20 recovered', `claim re-created the account (sponsor paid), ${fmt(escrow2 - 20n * USDC)} returned`);

// ---------- Checking-style send: no sponsor for creating a stranger's token account ----------
const fresh = await wallet();
const plan1 = await sendLib.planTokenSend(txRpc, third.address, fresh.address, MINT, 1n * USDC);
assert.equal(plan1.sponsor, false);
const thirdSolBefore = await sol(third.address), koraMid = await sol(payer!);
await tx.sendInstructions(txRpc, third as never, plan1.instructions as never, { sponsor: plan1.sponsor });
assert.ok((await sol(third.address)) < thirdSolBefore - 2_000_000n, 'sender paid the new account rent');
assert.equal(await sol(payer!), koraMid, 'Kora paid nothing for the stranger account');
const plan2 = await sendLib.planTokenSend(txRpc, third.address, fresh.address, MINT, 1n * USDC);
assert.equal(plan2.sponsor, true);
await sp(third, plan2.instructions as never, 'send sponsored');
assert.equal(await tok(await ata(fresh.address)), 2n * USDC);
row('send to a new wallet', 'first transfer: sender pays rent', 'second transfer: sponsored');

// ---------- negative: a program outside the allow-list ----------
const memo: Instruction = { programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), accounts: [{ address: third.address, role: AccountRole.READONLY_SIGNER }], data: new TextEncoder().encode('hi') };
let rejected: unknown = null;
try { await sponsored(third, [memo]); } catch (e) { rejected = e; }
assert.ok(rejected instanceof kora.KoraError, `expected a KoraError, got ${String(rejected)}`);
console.log('kora rejection:', (rejected as Error).message);
assert.equal(prog.friendlyError(rejected), "The fee sponsor doesn't cover this kind of transaction.");
row('memo instruction', 'rejected by Kora', prog.friendlyError(rejected));

// ---------- proxy boundary (only when KORA_URL is the app's /api/sponsor) ----------
const viaProxy = /\/api\/sponsor$/.test(process.env.NEXT_PUBLIC_KORA_URL!);
if (viaProxy) {
  const direct = process.env.KORA_DIRECT_URL ?? 'http://127.0.0.1:8080';
  const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // 1. Kora itself refuses an unsigned request (auth is on), so only the proxy can reach it.
  const unsigned = await post(direct, { jsonrpc: '2.0', id: 1, method: 'getPayerSigner', params: {} });
  assert.equal(unsigned.status, 401, `direct unsigned call should be 401, got ${unsigned.status}`);
  // 2. The proxy forwards only three methods.
  const cfgRes = await post(process.env.NEXT_PUBLIC_KORA_URL!, { jsonrpc: '2.0', id: 2, method: 'getConfig', params: {} });
  const cfgJson = await cfgRes.json() as { error?: { code: number } };
  assert.equal(cfgJson.error?.code, -32601, 'getConfig must be refused by the proxy');
  // 3. A burst trips the per-client limit (SPONSOR_RATE_CAPACITY tokens, cost 1 for liveness; the app server
  //    for this run should be started with the same value, default 30).
  const capacity = Number(process.env.SPONSOR_RATE_CAPACITY) || 30;
  let limited = 0;
  for (let i = 0; i < capacity * 2; i++) {
    const r = await post(process.env.NEXT_PUBLIC_KORA_URL!, { jsonrpc: '2.0', id: 3, method: 'liveness', params: {} });
    if (r.status === 429) limited++;
  }
  assert.ok(limited > 0, 'burst should hit the rate limit');
  row('proxy boundary', 'direct unsigned: 401', 'getConfig: -32601', `burst: ${limited} x 429`);
}

// ---------- who paid ----------
for (const w of [borrower, cosigner, donor, borrower2]) assert.equal(await sol(w.address), base[w.address], `${w.address} paid nothing`);
// cosigner2 paid one unsponsored close (fee) and got the account rent back
const koraSpent = koraBase - (await sol(payer!));
const rent = async (n: number) => BigInt(await rpc.getMinimumBalanceForRentExemption(BigInt(n)).send());
// 4 people (Person 174 + Member 74 bytes each), 2 loans (237 bytes, permanent), 3 token accounts (two borrowers, the
// second co-signer's re-created by the claim), two signatures per transaction (three for registrations).
const expected = 4n * ((await rent(174)) + (await rent(74))) + 2n * (await rent(237)) + 3n * (await rent(165)) + 10_000n * BigInt(sponsoredTxs) + 5_000n * 4n;
console.log('Kora spent', koraSpent, 'lamports; expected about', expected, `(${sponsoredTxs} sponsored txs; request + escrow rents came back)`);
assert.ok(koraSpent >= expected - 100_000n && koraSpent <= expected + 200_000n, 'Kora spend within the expected range');
row('accounting', `users paid 0`, `Kora spent ${koraSpent} lamports (${sponsoredTxs} sponsored txs)`);

console.log('\n' + ['step', 'detail...'].join(' | ')); for (const r of rows) console.log(r.join(' | '));
console.log('\nKORA E2E PASS');
