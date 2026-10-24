// The identity issuer end to end against a running app (IDENTITY_PROVIDER=mock) on the Surfpool fork: a wallet proves
// control, passes the (mock) check, gets a real gateway token on our network, and joins with the issuer-signed
// transaction the app prepared; a second wallet of the same person moves the membership; declined, out-of-state
// and banned people are turned away. Wallet recovery is two-step: the app proposes the move (issuer + recovery
// authority signatures), the old wallet may object during the pool's recovery delay, then the new wallet finalises
// (or the cranker does). Run after `npm run e2e` with the app started as in CI (see ci.yml).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createKeyPairSignerFromPrivateKeyBytes, generateKeyPairSigner, getAddressEncoder, getBase64Decoder, getBase64Encoder, getTransactionDecoder, partiallySignTransaction, signBytes, type Address, type KeyPairSigner } from '@solana/kit';
import { cheat, clockTs, rpc, RPC_URL, setSol } from './lib.ts';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3100';
process.env.NEXT_PUBLIC_KORA_URL = `${APP}/api/sponsor`;
process.env.NEXT_PUBLIC_RPC_URL = RPC_URL;
const tx = await import('../app/src/lib/tx.ts');
const kora = await import('../app/src/lib/kora.ts');
const prog = await import('../app/src/lib/program.ts');
const cfg = await import('../app/src/lib/config.ts');
const { proofMessage } = await import('../app/src/lib/identity/wallet-proof.ts');
const { MOCK_FIELDS_TX: MOCK_BASE } = await import('../app/src/lib/identity/mock.ts');
// Fresh ID numbers per run so the script can be repeated against the same app (people banned earlier stay banned).
const runId = Date.now().toString(36);
const MOCK_FIELDS_TX = { ...MOCK_BASE, idNumber: `TX-${runId}-1` };
const { gatewayTokenAddress } = await import('../app/src/lib/gateway.ts');
type StatusView = import('../app/src/lib/identity/service.ts').StatusView;
type PreparedTx = import('../app/src/lib/identity/service.ts').PreparedTx;

const rows: string[][] = [];
const row = (step: string, ...cols: string[]) => { rows.push([step, ...cols]); console.log(`[ok] ${step} ${cols.join(' | ')}`); };
const txRpc = rpc as unknown as Parameters<typeof tx.submit>[0] & Parameters<typeof prog.fetchPool>[0];

async function api<T>(path: string, init: RequestInit = {}, expectStatus = 200): Promise<T> {
  const res = await fetch(`${APP}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  assert.equal(res.status, expectStatus, `${path}: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}
const status = (w: Address) => api<StatusView>(`/api/identity/status?wallet=${w}`);
async function start(w: KeyPairSigner, tamper = false, route: 'start' | 'link' = 'start') {
  const message = proofMessage(w.address, Math.floor(Date.now() / 1000));
  const sig = await signBytes(w.keyPair.privateKey, new TextEncoder().encode(tamper ? message + '!' : message));
  return api<{ inquiryId: string; url: string }>(`/api/identity/${route}`, { method: 'POST', body: JSON.stringify({ wallet: w.address, message, signature: getBase64Decoder().decode(sig) }) }, tamper ? 401 : 200);
}
const decide = (inquiryId: string, outcome: string, fields: object = MOCK_FIELDS_TX) => api<{ result: string }>('/api/identity/mock', { method: 'POST', body: JSON.stringify({ inquiryId, outcome, fields }) });
async function finish(w: KeyPairSigner, kind: 'join' | 'rebind', expectKind: PreparedTx['kind']) {
  const prepared = await api<PreparedTx>(`/api/identity/${kind}`, { method: 'POST', body: JSON.stringify({ wallet: w.address }) });
  assert.equal(prepared.kind, expectKind);
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
  if (expectKind === 'finalize') {
    assert.equal(prepared.sponsored, false, 'the new wallet pays for its own finalize');
    assert.equal(prepared.feePayer, w.address);
    assert.equal(pool.issuer in decoded.signatures, false, 'no issuer signature needed to finalise');
  } else {
    assert.ok(decoded.signatures[pool.issuer], 'issuer signature present');
    if (expectKind === 'propose') assert.ok(decoded.signatures[pool.recoveryAuthority], 'recovery authority signature present');
  }
  assert.equal(decoded.signatures[w.address], null, 'wallet signature still missing');
  const signed = await partiallySignTransaction([w.keyPair], decoded);
  // The proxy's per-client limiter may still be drained by kora-e2e's burst test; wait it out like a patient user.
  for (let attempt = 0; ; attempt++) {
    try {
      const sig = await tx.submit(txRpc, signed, prepared.sponsored, prepared.feePayer);
      return { prepared, sig };
    } catch (e) {
      if (!(e instanceof kora.KoraError) || e.code !== kora.KORA_CODES.RATE_LIMITED || attempt >= 12) throw e;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

const [poolAddr] = await prog.findPoolPda(cfg.POOL_MINT);
const pool = (await prog.fetchPool(txRpc, poolAddr))!;
assert.ok(pool, 'pool missing: run `npm run e2e` first');
const adminKey = process.env.IDENTITY_ADMIN_KEY;
assert.ok(adminKey, 'IDENTITY_ADMIN_KEY must be set to the value the app runs with');

// ---------- a new person joins ----------
const w1 = await generateKeyPairSigner();
await setSol(w1.address, 1_000_000_000n);
await start(w1, true);
row('start with a tampered signature', '401');
const s1 = await start(w1);
assert.ok(s1.url.includes(s1.inquiryId));
assert.deepEqual(await start(w1), s1, 'a second start resumes the same inquiry');
assert.equal((await status(w1.address)).next, 'wait');
assert.equal((await decide(s1.inquiryId, 'approved')).result, 'issued');
let st = await status(w1.address);
assert.equal(st.next, 'join');
assert.equal(st.person?.onChain, false);
const tokenW1 = await gatewayTokenAddress(w1.address, pool.gatekeeperNetwork);
const tokenInfo = await rpc.getAccountInfo(tokenW1, { encoding: 'base64' }).send();
assert.ok(tokenInfo.value, 'gateway token issued on chain');
const j1 = await finish(w1, 'join', 'register');
const m1 = await prog.fetchMember(txRpc, pool.address, w1.address);
assert.ok(m1 && !m1.retired && !m1.ineligible, 'member on chain');
assert.equal((await status(w1.address)).next, 'done');
row('verify + join', `inquiry ${s1.inquiryId}`, `pass ${tokenW1.slice(0, 6)}.. issued by the gateway program`, `register_member ${j1.prepared.sponsored ? 'sponsored by Kora' : 'paid by the wallet'}`, `sig ${j1.sig.slice(0, 8)}..`);

// ---------- a renewed document is linked to the same person; someone else's is refused ----------
const renewed = { ...MOCK_FIELDS_TX, idNumber: `TX-${runId}-1-renewed` };
const l1 = await start(w1, false, 'link');
assert.equal((await status(w1.address)).status, 'pending');
assert.equal((await decide(l1.inquiryId, 'approved', renewed)).result, 'issued');
assert.equal((await status(w1.address)).next, 'done');
const wR = await generateKeyPairSigner();
const sR = await start(wR);
assert.equal((await decide(sR.inquiryId, 'approved', renewed)).result, 'issued');
assert.equal((await status(wR.address)).next, 'recover', 'the renewed document resolves to the same person');
assert.equal((await status(wR.address)).person?.currentWallet, w1.address);
const wX = await generateKeyPairSigner();
const sX = await start(wX);
assert.equal((await decide(sX.inquiryId, 'approved', { ...MOCK_FIELDS_TX, idNumber: `TX-${runId}-x` })).result, 'issued');
const l1b = await start(w1, false, 'link');
assert.equal((await decide(l1b.inquiryId, 'approved', { ...MOCK_FIELDS_TX, idNumber: `TX-${runId}-x` })).result, 'issued');
assert.equal((await status(w1.address)).reason, 'That document already belongs to another membership.');
row('link a renewed document', 'same person from a new wallet after linking: recover', `someone else's document: refused`);

// ---------- the same person, new wallet: the membership moves after the recovery delay ----------
// w2's seed is kept so cranker-e2e can borrow with this member later (test keys only).
const w2Seed = crypto.getRandomValues(new Uint8Array(32));
const w2 = await createKeyPairSignerFromPrivateKeyBytes(w2Seed);
await setSol(w2.address, 1_000_000_000n);
const s2 = await start(w2);
assert.equal((await decide(s2.inquiryId, 'approved')).result, 'issued');
st = await status(w2.address);
assert.equal(st.next, 'recover');
assert.equal(st.person?.currentWallet, w1.address);
await api('/api/identity/join', { method: 'POST', body: JSON.stringify({ wallet: w2.address }) }, 409);
const r2 = await finish(w2, 'rebind', 'propose');
st = await status(w2.address);
assert.equal(st.next, 'pending');
assert.equal(st.person?.pendingWallet, w2.address);
assert.ok(st.person!.pendingWalletAt >= (await clockTs()) + Number(pool.recoveryDelaySeconds) - 120, 'finalise after the pool delay');
await api('/api/identity/rebind', { method: 'POST', body: JSON.stringify({ wallet: w2.address }) }, 409); // not yet
assert.equal((await status(w1.address)).next, 'done', 'the old wallet still works during the delay');
assert.equal((await prog.fetchMember(txRpc, pool.address, w2.address)), null, 'nothing moved yet');
await cheat('surfnet_timeTravel', [{ absoluteTimestamp: (st.person!.pendingWalletAt + 60) * 1000 }]);
await new Promise((r) => setTimeout(r, 1500));
assert.equal((await status(w2.address)).next, 'finalize');
const f2 = await finish(w2, 'rebind', 'finalize');
const [m1b, m2] = await Promise.all([prog.fetchMember(txRpc, pool.address, w1.address), prog.fetchMember(txRpc, pool.address, w2.address)]);
assert.equal(m1b?.retired, true);
assert.equal(m2?.retired, false);
assert.equal(m2?.person, m1!.person, 'same person');
assert.equal((await status(w1.address)).next, 'blocked');
assert.equal((await status(w2.address)).next, 'done');
row('lost keys: verify again + recover', `propose_rebind ${r2.prepared.sponsored ? 'sponsored' : 'wallet-paid'} (issuer + recovery signatures)`, `after the ${pool.recoveryDelaySeconds}s delay: finalize_rebind by the new wallet (${f2.sig.slice(0, 8)}..)`, `old wallet retired, new wallet linked to person ${m2!.person.slice(0, 6)}..`);

// a further recovery (to w8) is proposed and left pending: cranker-e2e finalises it once the delay has passed
const w8 = await generateKeyPairSigner();
await setSol(w8.address, 1_000_000_000n);
const s8 = await start(w8);
assert.equal((await decide(s8.inquiryId, 'approved')).result, 'issued');
assert.equal((await status(w8.address)).next, 'recover');
await finish(w8, 'rebind', 'propose');
assert.equal((await status(w8.address)).next, 'pending');
const w9 = await generateKeyPairSigner();
const s9 = await start(w9);
assert.equal((await decide(s9.inquiryId, 'approved')).result, 'issued');
assert.equal((await status(w9.address)).next, 'blocked', 'one recovery at a time');
await api('/api/identity/rebind', { method: 'POST', body: JSON.stringify({ wallet: w9.address }) }, 409);
row('second recovery proposed (left pending for the cranker)', `w8 pending`, 'w9 same person: blocked while another move is pending');

// ---------- declined and out-of-state ----------
const w3 = await generateKeyPairSigner();
const s3 = await start(w3);
assert.equal((await decide(s3.inquiryId, 'declined')).result, 'declined');
st = await status(w3.address);
assert.equal(st.next, 'blocked');
const w4 = await generateKeyPairSigner();
const s4 = await start(w4);
assert.equal((await decide(s4.inquiryId, 'approved', { ...MOCK_FIELDS_TX, idNumber: 'CA-1', issuingState: 'CA' })).result, 'ineligible');
assert.equal((await status(w4.address)).reason, 'Good Faith is for Texas residents only.');
assert.equal((await rpc.getAccountInfo(await gatewayTokenAddress(w4.address, pool.gatekeeperNetwork), { encoding: 'base64' }).send()).value, null, 'no pass for an ineligible person');
row('declined / out of state', `w3 ${st.reason}`, 'w4 Good Faith is for Texas residents only. (no pass issued)');

// ---------- ban after a default: pass revoked, the person cannot come back on a new wallet ----------
// A second person (different ID) joins and is then barred; the first person stays eligible for cranker-e2e.
const other = { ...MOCK_FIELDS_TX, idNumber: `TX-${runId}-2` };
const w6 = await generateKeyPairSigner();
await setSol(w6.address, 1_000_000_000n);
const s6 = await start(w6);
assert.equal((await decide(s6.inquiryId, 'approved', other)).result, 'issued');
await finish(w6, 'join', 'register');
await api('/api/identity/ban', { method: 'POST', body: JSON.stringify({ wallet: w6.address }) }, 401);
const ban = await api<{ banned: boolean; revoked: string[] }>('/api/identity/ban', { method: 'POST', headers: { 'x-identity-admin-key': adminKey }, body: JSON.stringify({ wallet: w6.address }) });
assert.equal(ban.banned, true);
assert.ok(ban.revoked.includes(w6.address));
const tokenW6 = await rpc.getAccountInfo(await gatewayTokenAddress(w6.address, pool.gatekeeperNetwork), { encoding: 'base64' }).send();
const state = Buffer.from(tokenW6.value!.data[0], 'base64')[99]; // version, parent tag, owner, identity tag, network, gatekeeper, then state
assert.equal(state, 2, 'gateway token revoked');
const w5 = await generateKeyPairSigner();
const s5 = await start(w5);
assert.equal((await decide(s5.inquiryId, 'approved', other)).result, 'ineligible');
assert.equal((await status(w5.address)).reason, 'This person can no longer use Good Faith.');
row('ban', 'without the admin key: 401', `pass of ${w6.address.slice(0, 6)}.. revoked on chain (state=2)`, 'same person, new wallet: ineligible');
// hand the still-eligible member to cranker-e2e (test keys only)
const here = path.dirname(new URL(import.meta.url).pathname);
fs.writeFileSync(path.join(here, 'identity-e2e-result.json'), JSON.stringify({ member: w2.address, memberSecret: [...w2Seed, ...getAddressEncoder().encode(w2.address)], pendingWallet: w8.address }));

console.log('\n' + ['step', 'detail...'].join(' | ')); for (const r of rows) console.log(r.join(' | '));
console.log('\nIDENTITY E2E PASS');
