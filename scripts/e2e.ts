import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { address, createKeyPairSignerFromBytes, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, none, type Address } from '@solana/kit';
import { getMintEncoder } from '@solana-program/token';
import { ata, ATA_PROGRAM, cheat, clockTs, expectFail, fetchPool, gf, loanPda, MINT, GATEWAY_PROGRAM, rpc, send, setSol, setUsdc, sol, tok, TOKEN_PROGRAM, USDC, wallet } from './lib.ts';
import { gatewayFixture } from './gateway-fixture.ts';

const here = path.dirname(new URL(import.meta.url).pathname);
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
const errName = (m: string) => m.match(/Error Code: (\w+)|0x[0-9a-f]+|Custom[^"]*/)?.[1] ?? m.match(/0x[0-9a-f]+|Custom[^"]*/)?.[0] ?? m.slice(0, 60);

const real = await realToken();
assert.equal(real.owner, GATEWAY_PROGRAM);
const realBytes = Buffer.from(real.data, 'hex');
const dec = decodeGateway(realBytes);
console.log('REAL civic token', real.pubkey, { ...dec, expiry: String(dec.expiry), expiryDate: dec.expiry ? new Date(Number(dec.expiry) * 1000).toISOString() : null });
assert.equal(dec.consumed, dec.len, 'layout consumed exactly all bytes');
assert.equal(dec.state, 0); assert.ok(dec.expiry! > BigInt(Math.floor(Date.now() / 1000)));
row('civic layout', `real token ${real.pubkey.slice(0, 6)}.. v${dec.version} state=${dec.state} net=${dec.network.slice(0, 6)}..`, `parsed ${dec.consumed}/${dec.len} bytes`);
// Our own gatekeeper network when `npm run gatekeeper-setup` has run (tokens issued by the real gateway program);
// otherwise cloned Civic bytes on the token's original network.
const gateway = await gatewayFixture(dec.network);
const NETWORK = gateway.network;
const plantGateway = (owner: Address) => gateway.tokenFor(owner);
row('gateway tokens', gateway.mode === 'issued' ? `issued by the gateway program on our network ${NETWORK.slice(0, 6)}..` : 'planted (run gatekeeper-setup for real issuance)');

// ---------- Setup ----------
// The admin key doubles as the identity issuer on the fork (the issuer service holds a separate key in production).
const admin = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/solana/id.json'), 'utf8'))));
const donor = await wallet(), borrower = await wallet(), cosigner = await wallet(), cosigner2 = await wallet(), third = await wallet();
for (const w of [donor, borrower, cosigner, cosigner2, third]) await setSol(w.address, 2_000_000_000n);
await setUsdc(donor.address, 5_000n * USDC);
await setUsdc(borrower.address, 0n);
await setUsdc(cosigner.address, 500n * USDC);
await setUsdc(cosigner2.address, 500n * USDC);
await setUsdc(third.address, 200n * USDC);
/** One stable opaque 32-byte person id per e2e wallet (the issuer service assigns random ones). */
const idOf = (a: Address) => new Uint8Array(createHash('sha256').update(`e2e:${a}`).digest());
const DAY = 86_400n;
const PERMANENT = 9223372036854775807n;
/** The bar a person carries after `at` for `seconds` (the program saturates at i64::MAX). */
const barAfter = (at: bigint, seconds: bigint) => (seconds === PERMANENT ? PERMANENT : at + seconds);
const adminCli = await import('./admin.ts');
const adminRun = async (args: string[]) => { const lines: string[] = []; await adminCli.run(args, (l) => lines.push(l)); return lines.join(' '); };
/**
 * Pool settings when no pool exists yet (`npm run launch` normally creates it from launch.json first): the admin key
 * plays every role (issuer, recovery and pause authority).
 */
const params = (timelockSeconds: bigint) => ({
  gatekeeperNetwork: NETWORK, maxLoan: 1000n * USDC, maxTermDays: 30, graceDays: 3, maxGuaranteesPerMember: 2, cosignerEscrowBps: 2500,
  issuer: admin.address, timelockSeconds, recoveryAuthority: admin.address, pauseAuthority: admin.address,
  recoveryDelaySeconds: 3600n, requestTtlSeconds: 7n * DAY, firstLoanCap: 1000n * USDC, loanCapStep: 100n * USDC, cooldownSeconds: 0n,
  maxExposurePerPerson: 10_000n * USDC, disbursementWindowSeconds: DAY, disbursementCapPerWindow: 0n,
  defaultBanSeconds: PERMANENT, lateBanSeconds: 0n, cosignerBanSeconds: PERMANENT,
});

const [pool] = await gf.findPoolPda({ mint: MINT });
const [vault] = await gf.findVaultPda({ pool });
const existing = await rpc.getAccountInfo(pool, { encoding: 'base64' }).send();
if (!existing.value) {
  await send([await gf.getInitializePoolInstructionAsync({ payer: admin, mint: MINT, params: params(3600n) })], admin, 'initialize_pool');
}
const p0 = await fetchPool(pool);
const TIMELOCK = p0.timelockSeconds;
assert.equal(p0.gatekeeperNetwork, NETWORK, 'existing pool uses a different gatekeeper network');
assert.equal(p0.mint, MINT);
assert.equal(p0.issuer, admin.address, 'existing pool has a different issuer');
assert.equal(p0.recoveryAuthority, admin.address);
assert.equal(p0.paused, false);
row('initialize_pool', existing.value ? 'reused existing pool (launch)' : 'created', `net=${p0.gatekeeperNetwork.slice(0, 6)}.. bps=${p0.cosignerEscrowBps} grace=${p0.graceDays}d timelock=${p0.timelockSeconds}s recovery delay=${p0.recoveryDelaySeconds}s request ttl=${p0.requestTtlSeconds}s issuer=recovery=pause=admin`);

const ataOf = { donor: await ata(donor.address), borrower: await ata(borrower.address), cosigner: await ata(cosigner.address), cosigner2: await ata(cosigner2.address), third: await ata(third.address) };

// ---------- Donate ----------
const v0 = await tok(vault);
await send([await gf.getDonateInstructionAsync({ donor, mint: MINT, vault, donorToken: ataOf.donor, amount: 1000n * USDC })], donor, 'donate');
assert.equal(await tok(vault), v0 + 1000n * USDC);
assert.equal(await tok(ataOf.donor), 4000n * USDC);
let p = await fetchPool(pool);
assert.equal(p.totalDonated, p0.totalDonated + 1000n * USDC);
row('donate 1000', `vault ${fmt(await tok(vault))}`, `donor ${fmt(await tok(ataOf.donor))}`);

// ---------- Register (issuer co-signs) ----------
const gwB = await plantGateway(borrower.address), gwC = await plantGateway(cosigner.address), gwC2 = await plantGateway(cosigner2.address), gwThird = await plantGateway(third.address);
const registerIx = (w: typeof borrower, gatewayToken: Address, issuer: typeof borrower | typeof admin = admin) =>
  gf.getRegisterMemberInstructionAsync({ wallet: w, payer: w, issuer, pool, gatewayToken, personId: idOf(w.address) });
// negatives: a token owned by someone else, and a registration the issuer did not sign
const negErr = await expectFail(send([await registerIx(borrower, gwThird)], borrower, 'register wrong token'), 'wrong-owner gateway token');
row('register w/ wrong-owner token', 'rejected', errName(negErr));
const noIssuer = await expectFail(send([await registerIx(borrower, gwB, third)], borrower, 'register without issuer'), 'register without the issuer');
row('register w/o issuer signature', 'rejected', errName(noIssuer));
await send([await registerIx(borrower, gwB)], borrower, 'register borrower');
await send([await registerIx(cosigner, gwC)], cosigner, 'register cosigner');
const [mB] = await gf.findMemberPda({ pool, wallet: borrower.address });
const [mC] = await gf.findMemberPda({ pool, wallet: cosigner.address });
const [pB] = await gf.findPersonPda({ pool, personId: idOf(borrower.address) });
const [pC] = await gf.findPersonPda({ pool, personId: idOf(cosigner.address) });
const getMember = async (a: Address) => (await gf.fetchMember(rpc as any, a, { commitment: 'confirmed' })).data;
const getPerson = async (a: Address) => (await gf.fetchPerson(rpc as any, a, { commitment: 'confirmed' })).data;
assert.equal((await getMember(mB)).person, pB);
assert.equal((await getPerson(pB)).ineligibleUntil, 0n);
assert.equal((await getPerson(pB)).wallet, borrower.address);
assert.equal((await getPerson(pB)).pendingWallet.__option, 'None');
// one person, one wallet: the same id with a second wallet is refused
const dup = await expectFail(send([await gf.getRegisterMemberInstructionAsync({ wallet: third, payer: third, issuer: admin, pool, gatewayToken: gwThird, personId: idOf(borrower.address) })], third, 'duplicate person'), 'duplicate person');
row('register_member', `borrower+cosigner accepted (issuer-signed, ${gateway.mode === 'issued' ? 'tokens issued by the gateway program' : 'cloned REAL civic token bytes'})`, `same person, second wallet: rejected (${errName(dup).slice(0, 40)})`);

const loanOf = async (a: Address) => (await gf.fetchLoan(rpc as any, a, { commitment: 'confirmed' })).data;

// ---------- Loan 1 ----------
type Party = { signer: typeof borrower; gw: Address; person: Address; token: Address };
const B: Party = { signer: borrower, gw: gwB, person: pB, token: ataOf.borrower };
let C: Party = { signer: cosigner, gw: gwC, person: pC, token: ataOf.cosigner };
async function openLoan(amount: bigint, termDays: number, b: Party = B, c: Party = C) {
  const [request] = await gf.findRequestPda({ pool, borrower: b.signer.address });
  const [cosignerMember] = await gf.findMemberPda({ pool, wallet: c.signer.address });
  await send([await gf.getRequestLoanInstructionAsync({ payer: b.signer, borrower: b.signer, mint: MINT, borrowerPerson: b.person, cosignerMember, borrowerGatewayToken: b.gw, amount, termDays, cosigner: c.signer.address })], b.signer, 'request_loan');
  const pBefore = await fetchPool(pool);
  const id = pBefore.loanCount;
  const loan = await loanPda(pool, id);
  const escrow = (amount * BigInt(pBefore.cosignerEscrowBps) + 9999n) / 10000n;
  const before = { vault: await tok(vault), b: await tok(b.token), c: await tok(c.token) };
  await send([await gf.getCosignLoanInstructionAsync({ payer: c.signer, cosigner: c.signer, mint: MINT, vault, request, requestRentPayer: b.signer.address, borrowerPerson: b.person, cosignerPerson: c.person, borrowerToken: b.token, cosignerToken: c.token, loan, borrowerGatewayToken: b.gw, cosignerGatewayToken: c.gw, expectedAmount: amount, expectedTermDays: termDays, maxEscrow: escrow })], c.signer, 'cosign_loan');
  const [escrowAddr] = await gf.findEscrowPda({ loan });
  assert.equal(await tok(vault), before.vault - amount);
  assert.equal(await tok(b.token), before.b + amount);
  assert.equal(await tok(c.token), before.c - escrow);
  assert.equal(await tok(escrowAddr), escrow);
  const pa = await fetchPool(pool);
  assert.equal(pa.totalLent, pBefore.totalLent + amount);
  assert.equal(pa.loanCount, id + 1n);
  assert.equal(pa.activeLoans, pBefore.activeLoans + 1n);
  return { loan, escrow: escrowAddr, escrowAmt: escrow, id, request };
}
const claimIx = async (claimer: any, loan: Address) => {
  const l = await loanOf(loan);
  const cosignerWallet = (await getPerson(l.cosignerPerson)).wallet;
  return gf.getClaimEscrowInstructionAsync({ claimer, mint: MINT, loan, cosignerPerson: l.cosignerPerson, cosignerToken: await ata(cosignerWallet), rentPayer: l.rentPayer });
};
const L1 = await openLoan(100n * USDC, 7);
row('request+cosign loan#1 100', `escrow ${fmt(L1.escrowAmt)}`, `borrower ${fmt(await tok(ataOf.borrower))}`, `cosigner ${fmt(await tok(ataOf.cosigner))}`, `vault ${fmt(await tok(vault))}`);
assert.equal((await getPerson(pB)).activeLoan.__option, 'Some');
const rq = await rpc.getAccountInfo((await gf.findRequestPda({ pool, borrower: borrower.address }))[0], { encoding: 'base64' }).send();
assert.equal(rq.value, null, 'request closed');

/** Repay touches no co-signer account: the escrow waits in the loan until it is claimed. */
const repayIx = async (payer: any, payerToken: Address, loan: Address, escrow: Address, rentPayer: Address, amount: bigint) => {
  const l = await loanOf(loan);
  return gf.getRepayInstructionAsync({ payer, mint: MINT, vault, loan, escrow, payerToken, borrowerPerson: l.borrowerPerson, cosignerPerson: l.cosignerPerson, rentPayer, amount });
};

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
assert.equal(await tok(ataOf.cosigner), cBefore, 'nothing is pushed to the co-signer at repayment');
assert.equal(await tok(ataOf.borrower), 40n * USDC);
assert.equal(await tok(L1.escrow), L1.escrowAmt, 'escrow still holds the deposit');
l = await loanOf(L1.loan); assert.equal(l.status, gf.LoanStatus.Repaid); assert.equal(l.refundPending, L1.escrowAmt); assert.ok(l.closedAt > 0n);
assert.equal((await getPerson(pB)).activeLoan.__option, 'None');
assert.equal((await getPerson(pB)).completedLoans, 1);
assert.equal((await getPerson(pC)).activeGuarantees, 0);
assert.equal((await getPerson(pC)).activeGuaranteeAmount, 0n);
p = await fetchPool(pool);
assert.equal(p.totalRepaid, p0.totalRepaid + 100n * USDC);
assert.equal(p.activeLoans, 0n);
assert.equal(p.pendingClaims, p0.pendingClaims + L1.escrowAmt);
row('full repay 60', `Repaid, refund_pending ${fmt(l.refundPending)} waits in the escrow`, `completed_loans 1`, `vault ${fmt(await tok(vault))}`, `totalRepaid +${fmt(p.totalRepaid - p0.totalRepaid)}`);
// claim_escrow: anyone releases the deposit to the co-signer's current wallet and the escrow rent goes back to its payer
await send([await claimIx(third, L1.loan)], third, 'claim_escrow');
assert.equal(await tok(ataOf.cosigner), cBefore + L1.escrowAmt);
assert.equal((await rpc.getAccountInfo(L1.escrow, { encoding: 'base64' }).send()).value, null, 'escrow closed');
assert.equal((await loanOf(L1.loan)).refundPending, 0n);
assert.equal((await fetchPool(pool)).pendingClaims, p0.pendingClaims);
assert.ok((await sol(l.rentPayer)) > rentBefore - 1n);
const twice = await expectFail(send([await gf.getClaimEscrowInstructionAsync({ claimer: third, mint: MINT, loan: L1.loan, cosignerPerson: pC, cosignerToken: ataOf.cosigner, rentPayer: l.rentPayer })], third, 'claim twice'), 'second claim');
row('claim_escrow (third party)', `escrow ${fmt(L1.escrowAmt)} to the co-signer`, 'escrow acct closed, rent back', `second claim: ${errName(twice)}`);

// ---------- cancel_request ----------
{
  const [cosignerMember] = await gf.findMemberPda({ pool, wallet: cosigner.address });
  const reqIx = () => gf.getRequestLoanInstructionAsync({ payer: borrower, borrower, mint: MINT, borrowerPerson: pB, cosignerMember, borrowerGatewayToken: gwB, amount: 10n * USDC, termDays: 5, cosigner: cosigner.address });
  const [request] = await gf.findRequestPda({ pool, borrower: borrower.address });
  const open = async () => (await rpc.getAccountInfo(request, { encoding: 'base64' }).send()).value !== null;
  await send([await reqIx()], borrower, 'request (to cancel)');
  assert.ok(await open());
  const solBefore = await sol(borrower.address);
  await send([await gf.getCancelRequestInstruction({ canceller: borrower, pool, request, rentPayer: borrower.address })], borrower, 'cancel by borrower');
  assert.equal(await open(), false, 'request closed by borrower');
  assert.ok((await sol(borrower.address)) > solBefore - 10_000n, 'request rent returned to the borrower');
  row('cancel_request (borrower)', 'request closed, rent back');
  await send([await reqIx()], borrower, 'request again');
  const strangerErr = await expectFail(send([await gf.getCancelRequestInstruction({ canceller: third, pool, request, rentPayer: borrower.address })], third, 'cancel by stranger'), 'stranger cancel');
  row('cancel_request (stranger)', 'rejected', errName(strangerErr));
  await send([await gf.getCancelRequestInstruction({ canceller: cosigner, pool, request, rentPayer: borrower.address })], cosigner, 'cancel by cosigner');
  assert.equal(await open(), false, 'request closed by cosigner');
  row('cancel_request (cosigner)', 'request closed');
}

// ---------- wallet recovery: the co-signer loses their keys and moves to cosigner2 (propose, veto, propose, finalize) ----------
{
  const propose = (issuer: typeof admin | typeof third, recoveryAuthority: typeof admin | typeof third = admin) =>
    gf.getProposeRebindInstruction({ newWallet: cosigner2, issuer, recoveryAuthority, pool, person: pC, gatewayToken: gwC2 });
  const impostor = await expectFail(send([propose(third)], cosigner2, 'propose without issuer'), 'propose without the issuer');
  const noRecovery = await expectFail(send([propose(admin, third)], cosigner2, 'propose without recovery'), 'propose without the recovery authority');
  await send([propose(admin)], cosigner2, 'propose_rebind');
  let pc = await getPerson(pC);
  assert.equal(pc.pendingWallet.__option === 'Some' ? pc.pendingWallet.value : null, cosigner2.address, 'proposal recorded');
  assert.equal(pc.wallet, cosigner.address, 'nothing moves yet');
  const [mC2] = await gf.findMemberPda({ pool, wallet: cosigner2.address });
  const early = await expectFail(send([await gf.getFinalizeRebindInstructionAsync({ payer: third, pool, person: pC, newWallet: cosigner2.address, oldMember: mC, newMember: mC2 })], third, 'finalize early'), 'finalize before the delay');
  // the old wallet still has its keys after all and objects
  const strangerVeto = await expectFail(send([gf.getVetoRebindInstruction({ signer: third, pool, person: pC })], third, 'veto by stranger'), 'stranger veto');
  await send([gf.getVetoRebindInstruction({ signer: cosigner, pool, person: pC })], cosigner, 'veto_rebind');
  assert.equal((await getPerson(pC)).pendingWallet.__option, 'None', 'proposal dropped');
  row('propose_rebind + veto', `impostor issuer ${errName(impostor)}`, `no recovery authority ${errName(noRecovery)}`, `finalize early ${errName(early)}`, `stranger veto ${errName(strangerVeto)}`, 'old wallet vetoed');
  // proposed again; after the delay anyone finalises
  await send([propose(admin)], cosigner2, 'propose_rebind again');
  pc = await getPerson(pC);
  await cheat('surfnet_timeTravel', [{ absoluteTimestamp: (Number(pc.pendingWalletAt) + 60) * 1000 }]);
  await new Promise(r => setTimeout(r, 1500));
  await send([await gf.getFinalizeRebindInstructionAsync({ payer: third, pool, person: pC, newWallet: cosigner2.address, oldMember: mC, newMember: mC2 })], third, 'finalize_rebind');
  assert.equal((await getMember(mC)).retired, true, 'old wallet retired');
  assert.equal((await getMember(mC2)).person, pC, 'new wallet bound to the same person');
  assert.equal((await getPerson(pC)).wallet, cosigner2.address);
  assert.equal((await getPerson(pC)).pendingWallet.__option, 'None');
  // the retired wallet can no longer be named as a co-signer
  const retired = await expectFail(send([await gf.getRequestLoanInstructionAsync({ payer: borrower, borrower, mint: MINT, borrowerPerson: pB, cosignerMember: mC, borrowerGatewayToken: gwB, amount: 10n * USDC, termDays: 5, cosigner: cosigner.address })], borrower, 'request naming retired wallet'), 'retired co-signer');
  row('finalize_rebind (third party, after the delay)', 'co-signer moved to a new wallet, old one retired', `request naming old wallet: ${errName(retired)}`);
  C = { signer: cosigner2, gw: gwC2, person: pC, token: ataOf.cosigner2 };
}

// ---------- Loan 2 (co-signed from the new wallet) -> default ----------
const L2 = await openLoan(100n * USDC, 7);
row('loan#2 100 (new co-signer wallet)', `escrow ${fmt(L2.escrowAmt)}`, `borrower ${fmt(await tok(ataOf.borrower))}`, `cosigner2 ${fmt(await tok(ataOf.cosigner2))}`, `vault ${fmt(await tok(vault))}`);
l = await loanOf(L2.loan);
const frozenAtStart = p0.authority.__option === 'None';
const paramsOf = (x: Awaited<ReturnType<typeof fetchPool>>) => ({
  gatekeeperNetwork: x.gatekeeperNetwork, maxLoan: x.maxLoan, maxTermDays: x.maxTermDays, graceDays: x.graceDays, maxGuaranteesPerMember: x.maxGuaranteesPerMember, cosignerEscrowBps: x.cosignerEscrowBps,
  issuer: x.issuer, timelockSeconds: x.timelockSeconds, recoveryAuthority: x.recoveryAuthority, pauseAuthority: x.pauseAuthority, recoveryDelaySeconds: x.recoveryDelaySeconds, requestTtlSeconds: x.requestTtlSeconds,
  firstLoanCap: x.firstLoanCap, loanCapStep: x.loanCapStep, cooldownSeconds: x.cooldownSeconds, maxExposurePerPerson: x.maxExposurePerPerson, disbursementWindowSeconds: x.disbursementWindowSeconds,
  disbursementCapPerWindow: x.disbursementCapPerWindow, defaultBanSeconds: x.defaultBanSeconds, lateBanSeconds: x.lateBanSeconds, cosignerBanSeconds: x.cosignerBanSeconds,
});
let newGrace = p.graceDays;
if (frozenAtStart) {
  row('schedule_params', 'skipped: pool already frozen (restart surfpool for a fresh fork)');
} else {
  const pBefore = await fetchPool(pool);
  newGrace = pBefore.graceDays + 7;
  const strangerErr = await expectFail(send([gf.getScheduleParamsInstruction({ authority: third, pool, params: { ...paramsOf(pBefore), graceDays: newGrace } })], third, 'schedule by stranger'), 'stranger schedule');
  await adminRun(['schedule', '--set', `graceDays=${newGrace}`]);
  const ps = await fetchPool(pool);
  assert.match(await adminRun(['show']), new RegExp(`graceDays: ${pBefore.graceDays} -> ${newGrace}`));
  assert.equal(ps.graceDays, pBefore.graceDays, 'nothing changes at scheduling');
  assert.equal(ps.pendingParams.__option, 'Some');
  assert.ok(ps.paramsEffectiveAt >= BigInt(await clockTs()) + TIMELOCK - 60n, 'effective after the timelock');
  const early = await expectFail(send([gf.getApplyParamsInstruction({ pool })], third, 'apply early'), 'apply before the timelock');
  const tooShort = await expectFail(send([gf.getScheduleParamsInstruction({ authority: admin, pool, params: { ...paramsOf(pBefore), timelockSeconds: 0n } })], admin, 'schedule timelock 0'), 'notice period below the minimum');
  row('schedule_params grace +7 (admin CLI)', `stranger ${errName(strangerErr)}`, `pending, effective in ${ps.paramsEffectiveAt - BigInt(await clockTs())}s`, `apply now: ${errName(early)}`, `timelock -> 0: ${errName(tooShort)}`);
}
const earlyDefault = await expectFail(send([await gf.getMarkDefaultInstructionAsync({ caller: third, mint: MINT, vault, loan: L2.loan, escrow: L2.escrow, borrowerPerson: pB, cosignerPerson: pC, rentPayer: l.rentPayer })], third, 'early default'), 'early default');
row('mark_default too early', 'rejected', errName(earlyDefault));
// partial repay 30 so shortfall is 70 > escrow 25 -> recovered 25, lost 45, co-signer barred
await send([await repayIx(third, ataOf.third, L2.loan, L2.escrow, l.rentPayer, 30n * USDC)], third, 'repay partial 2');
const now0 = await clockTs();
const target = Number(l.dueAt) + l.graceDays * 86400 + 3600; // the loan's own grace, not the pool's pending one
await cheat('surfnet_timeTravel', [{ absoluteTimestamp: target * 1000 }]);
await new Promise(r => setTimeout(r, 1500));
const now1 = await clockTs();
console.log('clock', now0, '->', now1, 'due', l.dueAt, 'target', target);
assert.ok(now1 > Number(l.dueAt) + l.graceDays * 86400, 'time travel moved clock past due+grace');
if (!frozenAtStart) {
  // Anyone applies the change once the delay has passed (the operator's cranker, or the admin CLI, in production).
  await adminRun(['apply']);
  const pa = await fetchPool(pool);
  assert.equal(pa.graceDays, newGrace, 'pool grace updated');
  assert.equal(pa.pendingParams.__option, 'None');
  assert.equal((await loanOf(L2.loan)).graceDays, l.graceDays, 'open loan keeps the grace it was opened with');
  row('apply_params (by a third party, after the timelock)', `pool grace ${newGrace}d`, `loan#2 keeps ${l.graceDays}d`);
}
const pre = { vault: await tok(vault), c: await tok(ataOf.cosigner2), p: await fetchPool(pool) };
await send([await gf.getMarkDefaultInstructionAsync({ caller: third, mint: MINT, vault, loan: L2.loan, escrow: L2.escrow, borrowerPerson: pB, cosignerPerson: pC, rentPayer: l.rentPayer })], third, 'mark_default');
const shortfall = 70n * USDC, recovered = L2.escrowAmt < shortfall ? L2.escrowAmt : shortfall;
assert.equal(await tok(vault), pre.vault + recovered);
assert.equal(await tok(ataOf.cosigner2), pre.c, 'nothing pushed to the co-signer');
assert.equal((await rpc.getAccountInfo(L2.escrow, { encoding: 'base64' }).send()).value, null, 'fully absorbed escrow closes at once');
l = await loanOf(L2.loan); assert.equal(l.status, gf.LoanStatus.Defaulted); assert.equal(l.refundPending, L2.escrowAmt - recovered);
const personB = await getPerson(pB), personC = await getPerson(pC);
const defaultedAt = (await loanOf(L2.loan)).closedAt;
const poolNow = await fetchPool(pool);
assert.equal(personB.ineligibleUntil, barAfter(defaultedAt, poolNow.defaultBanSeconds));
assert.equal(personC.ineligibleUntil, barAfter(defaultedAt, poolNow.cosignerBanSeconds), 'the fund lost money, so the co-signer is barred too');
assert.equal(personB.activeLoan.__option, 'None'); assert.equal(personC.activeGuarantees, 0);
p = await fetchPool(pool);
assert.equal(p.totalRecovered, pre.p.totalRecovered + recovered);
assert.equal(p.totalLost, pre.p.totalLost + (shortfall - recovered));
assert.equal(p.activeLoans, 0n);
row('mark_default', `recovered ${fmt(recovered)}`, `lost ${fmt(shortfall - recovered)}`, `vault ${fmt(await tok(vault))}`, `both people barred (loss > 0): borrower ${poolNow.defaultBanSeconds === PERMANENT ? 'for good' : `${poolNow.defaultBanSeconds / DAY} days`}, co-signer ${poolNow.cosignerBanSeconds === PERMANENT ? 'for good' : `${poolNow.cosignerBanSeconds / DAY} days`}`);
// ineligible cannot request again, from any wallet of that person
{
  const [cosignerMember] = await gf.findMemberPda({ pool, wallet: cosigner2.address });
  await expectFail(send([await gf.getRequestLoanInstructionAsync({ payer: borrower, borrower, mint: MINT, borrowerPerson: pB, cosignerMember, borrowerGatewayToken: gwB, amount: 10n * USDC, termDays: 7, cosigner: cosigner2.address })], borrower, 'request after default'), 'ineligible request');
  row('request after default', 'rejected (ineligible)');
}

// ---------- pause_lending (instant brake) and request expiry ----------
if (!frozenAtStart) {
  const fourth = await wallet(), fifth = await wallet();
  for (const w of [fourth, fifth]) await setSol(w.address, 1_000_000_000n);
  await setUsdc(fourth.address, 0n);
  await setUsdc(fifth.address, 100n * USDC);
  const gw4 = await plantGateway(fourth.address), gw5 = await plantGateway(fifth.address);
  await send([await registerIx(fourth, gw4)], fourth, 'register fourth');
  await send([await registerIx(fifth, gw5)], fifth, 'register fifth');
  const [p4] = await gf.findPersonPda({ pool, personId: idOf(fourth.address) });
  const [m5] = await gf.findMemberPda({ pool, wallet: fifth.address });
  const reqIx = () => gf.getRequestLoanInstructionAsync({ payer: fourth, borrower: fourth, mint: MINT, borrowerPerson: p4, cosignerMember: m5, borrowerGatewayToken: gw4, amount: 10n * USDC, termDays: 5, cosigner: fifth.address });
  const strangerPause = await expectFail(send([gf.getPauseLendingInstruction({ signer: third, pool })], third, 'pause by stranger'), 'stranger pause');
  await adminRun(['pause']);
  assert.equal((await fetchPool(pool)).paused, true);
  assert.match(await adminRun(['show']), /PAUSED/);
  const whilePaused = await expectFail(send([await reqIx()], fourth, 'request while paused'), 'request while paused');
  await adminRun(['resume']);
  assert.equal((await fetchPool(pool)).paused, false);
  row('pause_lending / resume_lending (admin CLI)', `stranger ${errName(strangerPause)}`, `request while paused: ${errName(whilePaused)}`, 'resumed by the authority');
  await send([await reqIx()], fourth, 'request (to expire)');
  const [request] = await gf.findRequestPda({ pool, borrower: fourth.address });
  const req = (await gf.fetchLoanRequest(rpc as any, request, { commitment: 'confirmed' })).data;
  const notYet = await expectFail(send([gf.getCloseExpiredRequestInstruction({ closer: third, pool, request, rentPayer: fourth.address })], third, 'close before expiry'), 'close before expiry');
  await cheat('surfnet_timeTravel', [{ absoluteTimestamp: (Number(req.expiresAt) + 60) * 1000 }]);
  await new Promise(r => setTimeout(r, 1500));
  const [cm] = await gf.findMemberPda({ pool, wallet: fourth.address });
  const expiredCosign = await expectFail(send([await gf.getCosignLoanInstructionAsync({ payer: fifth, cosigner: fifth, mint: MINT, vault, request, requestRentPayer: fourth.address, borrowerPerson: p4, cosignerPerson: (await getMember(m5)).person, borrowerToken: await ata(fourth.address), cosignerToken: await ata(fifth.address), loan: await loanPda(pool, (await fetchPool(pool)).loanCount), borrowerGatewayToken: gw4, cosignerGatewayToken: gw5, expectedAmount: 10n * USDC, expectedTermDays: 5, maxEscrow: 3n * USDC })], fifth, 'cosign expired'), 'cosign an expired request');
  void cm;
  const solBefore = await sol(fourth.address);
  await send([gf.getCloseExpiredRequestInstruction({ closer: third, pool, request, rentPayer: fourth.address })], third, 'close_expired_request');
  assert.equal((await rpc.getAccountInfo(request, { encoding: 'base64' }).send()).value, null, 'request closed');
  assert.ok((await sol(fourth.address)) > solBefore, 'rent back to the borrower');
  row('request expiry', `close before expiry: ${errName(notYet)}`, `cosign after expiry: ${errName(expiredCosign)}`, 'closed by a third party after the TTL, rent back to the borrower');
}

// ---------- authority handover (two-step) ----------
if (!frozenAtStart) {
  const next = await wallet();
  await setSol(next.address, 1_000_000_000n);
  const strangerErr = await expectFail(send([gf.getProposeAuthorityInstruction({ authority: next, pool, newAuthority: next.address })], next, 'propose by stranger'), 'stranger propose');
  await send([gf.getProposeAuthorityInstruction({ authority: admin, pool, newAuthority: next.address })], admin, 'propose_authority');
  assert.equal((await fetchPool(pool)).pendingAuthority.__option, 'Some', 'proposal recorded');
  await expectFail(send([gf.getAcceptAuthorityInstruction({ newAuthority: third, pool })], third, 'accept by stranger'), 'stranger accept');
  await send([gf.getAcceptAuthorityInstruction({ newAuthority: next, pool })], next, 'accept_authority');
  let pa = await fetchPool(pool);
  assert.equal(pa.authority.__option === 'Some' ? pa.authority.value : null, next.address, 'authority changed');
  assert.equal(pa.pendingAuthority.__option, 'None');
  // and back, so the rest of the run (freeze) keeps using the admin key
  await send([gf.getProposeAuthorityInstruction({ authority: next, pool, newAuthority: admin.address })], next, 'propose back');
  await send([gf.getAcceptAuthorityInstruction({ newAuthority: admin, pool })], admin, 'accept back');
  pa = await fetchPool(pool);
  assert.equal(pa.authority.__option === 'Some' ? pa.authority.value : null, admin.address);
  row('authority handover', `stranger ${errName(strangerErr)}`, 'propose+accept to a new key and back');
}

// ---------- suspend_issuer: an instant brake; a new issuer goes through the timelock ----------
if (!frozenAtStart) {
  await adminRun(['suspend-issuer']);
  assert.equal((await fetchPool(pool)).issuer, address('11111111111111111111111111111111'));
  assert.match(await adminRun(['show']), /SUSPENDED/);
  const blocked = await expectFail(send([await registerIx(third, gwThird)], third, 'register while suspended'), 'register while suspended');
  await adminRun(['schedule', '--set', `issuer=${admin.address}`]);
  const stillBlocked = await expectFail(send([await registerIx(third, gwThird)], third, 'register while pending'), 'register while the new issuer is pending');
  await cheat('surfnet_timeTravel', [{ absoluteTimestamp: (await clockTs() + Number(TIMELOCK) + 60) * 1000 }]);
  await new Promise(r => setTimeout(r, 1500));
  await adminRun(['apply']);
  await send([await registerIx(third, gwThird)], third, 'register after restore');
  row('suspend_issuer (admin CLI)', `register: ${errName(blocked)}`, `scheduled new issuer, still ${errName(stillBlocked)}`, 'after the timelock: registrations resume');
}

// ---------- wind-down and sweep, on a second pool so the main one stays usable for the sponsor e2e ----------
{
  const M2 = (await wallet()).address;
  const mintData = Buffer.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: none() }));
  await cheat('surfnet_setAccount', [M2, { lamports: 1_461_600, owner: TOKEN_PROGRAM, data: mintData.toString('hex') }]);
  const [poolW] = await gf.findPoolPda({ mint: M2 });
  const [vaultW] = await gf.findVaultPda({ pool: poolW });
  await send([await gf.getInitializePoolInstructionAsync({ payer: admin, mint: M2, params: params(0n) })], admin, 'initialize_pool W');
  await cheat('surfnet_setTokenAccount', [donor.address, M2, { amount: Number(100n * USDC), state: 'initialized' }]);
  await cheat('surfnet_setTokenAccount', [third.address, M2, { amount: 0, state: 'initialized' }]);
  const ataFor = async (owner: Address, mint: Address): Promise<Address> => {
    const [a] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [getAddressEncoder().encode(owner), getAddressEncoder().encode(TOKEN_PROGRAM), getAddressEncoder().encode(mint)] });
    return a;
  };
  const donorW = await ataFor(donor.address, M2);
  const successor = await ataFor(third.address, M2);
  await send([await gf.getDonateInstructionAsync({ donor, mint: M2, vault: vaultW, donorToken: donorW, amount: 100n * USDC })], donor, 'donate W');
  const badSuccessor = await expectFail(send([gf.getAnnounceWindDownInstruction({ authority: admin, pool: poolW, successorVault: vaultW })], admin, 'announce with vault'), 'vault as successor');
  const stranger = await expectFail(send([gf.getAnnounceWindDownInstruction({ authority: third, pool: poolW, successorVault: successor })], third, 'announce by stranger'), 'stranger announce');
  await send([gf.getAnnounceWindDownInstruction({ authority: admin, pool: poolW, successorVault: successor })], admin, 'announce_wind_down');
  let pw = await fetchPool(poolW);
  assert.equal(pw.successor.__option === 'Some' ? pw.successor.value : null, successor);
  // zero timelock on this pool: in effect at once
  const closedDonate = await expectFail(send([await gf.getDonateInstructionAsync({ donor, mint: M2, vault: vaultW, donorToken: donorW, amount: 1n * USDC })], donor, 'donate while winding down'), 'donate while winding down');
  const noCancel = await expectFail(send([gf.getCancelWindDownInstruction({ authority: admin, pool: poolW })], admin, 'cancel after effect'), 'cancel after effect');
  await send([await gf.getSweepToSuccessorInstructionAsync({ mint: M2, vault: vaultW, successorVault: successor })], third, 'sweep_to_successor');
  pw = await fetchPool(poolW);
  assert.equal(await tok(vaultW), 0n);
  assert.equal(await tok(successor), 100n * USDC);
  assert.equal(pw.totalSwept, 100n * USDC);
  row('wind-down (pool W)', `vault as successor ${errName(badSuccessor)}`, `stranger ${errName(stranger)}`, `donate after effect ${errName(closedDonate)}`, `cancel after effect ${errName(noCancel)}`, `swept 100.00 to the successor by a third party`);
}

// ---------- freeze_pool (irreversible) ----------
if (!frozenAtStart) {
  await expectFail(adminRun(['freeze']), 'freeze without --yes');
  await adminRun(['freeze', '--yes']);
  assert.equal((await fetchPool(pool)).authority.__option, 'None', 'authority cleared');
  assert.match(await adminRun(['show']), /none \(frozen\)/);
  const pf = await fetchPool(pool);
  const afterFreeze = await expectFail(send([gf.getScheduleParamsInstruction({ authority: admin, pool, params: paramsOf(pf) })], admin, 'schedule after freeze'), 'schedule after freeze');
  row('freeze_pool (admin CLI, --yes required)', 'authority = none', `schedule now ${errName(afterFreeze)}`);
}

// final totals
p = await fetchPool(pool);
console.log('\nPool', pool, { donated: fmt(p.totalDonated), lent: fmt(p.totalLent), repaid: fmt(p.totalRepaid), recovered: fmt(p.totalRecovered), lost: fmt(p.totalLost), loanCount: String(p.loanCount), activeLoans: String(p.activeLoans) });
console.log('\n' + ['step', 'detail...'].join(' | ')); for (const r of rows) console.log(r.join(' | '));
console.log('\nE2E PASS');
fs.writeFileSync(path.join(here, 'e2e-result.json'), JSON.stringify({ pool, vault, authority: (await fetchPool(pool)).authority.__option === 'None' ? 'none' : admin.address, issuer: admin.address, recoveryAuthority: admin.address, pauseAuthority: admin.address, network: NETWORK, mint: MINT }, null, 1));
