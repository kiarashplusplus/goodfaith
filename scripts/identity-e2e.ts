// The identity issuer end to end against a running app (IDENTITY_PROVIDER=mock) on the Surfpool fork: a wallet proves
// control, passes the (mock) check, gets a real gateway token on our network, and joins with the issuer-signed
// transaction the app prepared; a second wallet of the same person moves the membership; declined, out-of-state
// and banned people are turned away. Wallet recovery is two-step: the app records the request (signed by the new
// wallet), the operator's recovery CLI (scripts/recovery.ts, holding the recovery key) verifies and proposes the move
// with the issuer's signature once the request has aged, the old wallet may object during the pool's recovery delay,
// then the new wallet finalises (or the cranker does). Passes renew without a new check; a permanent bar freezes them
// and a lift thaws them. Run after `npm run e2e` with the app started as in CI (see ci.yml).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  // The app closes idle keep-alive sockets while the recovery CLI runs in a subprocess; a request sent on one of
  // those fails before it reaches the server ("other side closed"), so it is simply sent again on a fresh socket.
  let res!: Response;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${APP}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
      break;
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code ?? '';
      if (attempt >= 3 || !/UND_ERR_SOCKET|ECONNRESET/.test(code)) throw e;
    }
  }
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
/** The dated proof of control the wallet-acting routes want. */
async function proofOf(w: KeyPairSigner, extra: object = {}) {
  const message = proofMessage(w.address, Math.floor(Date.now() / 1000));
  const sig = await signBytes(w.keyPair.privateKey, new TextEncoder().encode(message));
  return JSON.stringify({ wallet: w.address, message, signature: getBase64Decoder().decode(sig), ...extra });
}
const rebind = async <T = { kind: string; requestedAt: number }>(w: KeyPairSigner, expectStatus: number, method: 'POST' | 'DELETE' = 'POST') =>
  api<T>('/api/identity/rebind', { method, body: await proofOf(w) }, expectStatus);
async function finish(w: KeyPairSigner, kind: 'join' | 'rebind', expectKind: PreparedTx['kind']) {
  const prepared = await api<PreparedTx>(`/api/identity/${kind}`, { method: 'POST', body: kind === 'rebind' ? await proofOf(w) : JSON.stringify({ wallet: w.address }) });
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
const here = path.dirname(new URL(import.meta.url).pathname);
type RecoveryView = import('../app/src/lib/identity/service.ts').RecoveryView;
/** The operator's recovery CLI, with the admin key as the recovery authority (the fork pool is launched that way). */
const recoveryCli = (args: string[]) =>
  execFileSync('npx', ['tsx', path.join(here, 'recovery.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, IDENTITY_URL: APP, IDENTITY_ADMIN_KEY: adminKey, RPC_URL, RECOVERY_KEYPAIR: process.env.RECOVERY_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json') },
  });
const queue = () => JSON.parse(recoveryCli(['list', '--json']).trim().split('\n').pop()!) as RecoveryView[];
/** The CLI's refusal text (it exits 1), or null when it succeeded. */
const cliFails = (args: string[]): string | null => {
  try {
    recoveryCli(args);
    return null;
  } catch (e) {
    return String((e as { stderr?: string }).stderr ?? e);
  }
};
/**
 * Asks to move the membership to `w` (the new wallet signs the request) and has the operator approve it: the request
 * shows in the queue with its notice outcome; a fresh request is too young for the CLI unless the operator overrides;
 * then the proposal is on chain.
 */
async function recoverVia(w: KeyPairSigner) {
  const r = await rebind(w, 202);
  assert.equal(r.kind, 'review');
  assert.equal((await status(w.address)).next, 'review', 'waiting for the operator');
  const mine = queue().find((q) => q.newWallet === w.address);
  assert.ok(mine, 'the request is in the operator queue');
  assert.equal(mine!.onChain, true);
  assert.equal(mine!.delivery, 'sent', 'the notice about the request went out');
  assert.match(cliFails(['approve', mine!.personId, w.address]) ?? '', /old;|--force/, 'a request younger than the minimum age is refused without --force');
  const other = (await generateKeyPairSigner()).address;
  assert.match(cliFails(['approve', mine!.personId, other, '--force']) ?? '', /names wallet/, 'the CLI names the wallet it checked');
  const outApprove = recoveryCli(['approve', mine!.personId, w.address, '--force']);
  assert.match(outApprove, /instruction\s+propose_rebind/);
  assert.match(outApprove, /proposed on chain/);
  assert.equal(queue().find((q) => q.newWallet === w.address)?.pendingWallet, w.address, 'the queue shows it proposed');
  assert.match(cliFails(['approve', mine!.personId, w.address, '--force']) ?? '', /already proposed|already pending/, 'never twice');
  return mine!.personId;
}

// ---------- a new person joins (and leaves a contact for notices) ----------
const w1 = await generateKeyPairSigner();
await setSol(w1.address, 1_000_000_000n);
await start(w1, true);
row('start with a tampered signature', '401');
{
  const message = proofMessage(w1.address, Math.floor(Date.now() / 1000));
  const sig = await signBytes(w1.keyPair.privateKey, new TextEncoder().encode(message));
  await api('/api/identity/start', { method: 'POST', body: JSON.stringify({ wallet: w1.address, message, signature: getBase64Decoder().decode(sig), contact: `member-${runId}@example.test` }) });
}
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

// ---------- the pass renews for another year without a new check; notices contact changes only from the member's wallet ----------
{
  const before = (await status(w1.address)).pass;
  assert.ok(before && before.state === 'active' && before.expiresAt, 'the status shows the pass and its expiry');
  await api('/api/identity/renew', { method: 'POST', body: JSON.stringify({ wallet: w1.address }) }, 400);
  const renewed = await api<{ expiresAt: number }>('/api/identity/renew', { method: 'POST', body: await proofOf(w1) });
  assert.ok(renewed.expiresAt >= before!.expiresAt!, 'a fresh year');
  assert.equal((await status(w1.address)).pass?.expiresAt, renewed.expiresAt, 'the chain shows the new expiry');
  const changed = await api<{ changed: boolean }>('/api/identity/contact', { method: 'POST', body: await proofOf(w1, { contact: `member-${runId}-new@example.test` }) });
  assert.equal(changed.changed, true);
  row('renew + contact', `pass renewed until ${new Date(renewed.expiresAt * 1000).toISOString().slice(0, 10)} (signed message, no new check)`, 'contact changed from the member wallet; the previous contact was told');
}

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
await api('/api/identity/contact', { method: 'POST', body: await proofOf(wR, { contact: 'thief@example.test' }) }, 403);
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
// a request needs the new wallet's signature; it can be withdrawn before the operator acts; a wrong key cannot read the queue
await api('/api/identity/rebind', { method: 'POST', body: JSON.stringify({ wallet: w2.address }) }, 400);
await api('/api/identity/rebind', { method: 'POST', body: JSON.stringify({ wallet: w2.address, message: proofMessage(w2.address, Math.floor(Date.now() / 1000)), signature: 'AAAA' }) }, 401);
await rebind(w2, 202);
assert.equal((await rebind<{ cancelled: boolean }>(w2, 200, 'DELETE')).cancelled, true);
assert.equal((await status(w2.address)).next, 'recover');
await api('/api/identity/recoveries', { headers: { 'x-identity-admin-key': 'wrong' } }, 401);
// the operator's CLI refuses anything but the one expected instruction: a register_member transaction, or the wrong wallet
{
  const { verifyProposal } = await import('./recovery.ts');
  assert.throws(() => verifyProposal(j1.prepared.transaction, { person: m1!.person, newWallet: w2.address, recoveryAuthority: pool.recoveryAuthority, pool: pool.address, issuer: pool.issuer }), /refused/);
  row('recovery CLI verification', 'a prepared transaction that is not the one propose_rebind for the named person and wallet is refused before signing');
}
await recoverVia(w2);
st = await status(w2.address);
assert.equal(st.next, 'pending');
assert.equal(st.person?.pendingWallet, w2.address);
assert.ok(st.person!.pendingWalletAt >= (await clockTs()) + Number(pool.recoveryDelaySeconds) - 120, 'finalise after the pool delay');
await rebind(w2, 409); // not yet
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
row('lost keys: verify again + recover', 'signed request recorded (202), withdrawn, recorded again; operator CLI: list + approve <person> <wallet> --force (too young without it; issuer signature from the service, recovery signature from the CLI after verifying the transaction)', `after the ${pool.recoveryDelaySeconds}s delay: finalize_rebind by the new wallet (${f2.sig.slice(0, 8)}..)`, `old wallet retired, new wallet linked to person ${m2!.person.slice(0, 6)}..`);

// a further recovery (to w8) is proposed and left pending: cranker-e2e finalises it once the delay has passed
// (w8's seed is kept so cranker-e2e can pay back a settled loan from the recovered wallet)
const w8Seed = crypto.getRandomValues(new Uint8Array(32));
const w8 = await createKeyPairSignerFromPrivateKeyBytes(w8Seed);
await setSol(w8.address, 1_000_000_000n);
const s8 = await start(w8);
assert.equal((await decide(s8.inquiryId, 'approved')).result, 'issued');
assert.equal((await status(w8.address)).next, 'recover');
// a second wallet of the same person asking at the same time is blocked while w8's request waits; the operator can reject one
const w9 = await generateKeyPairSigner();
const s9 = await start(w9);
assert.equal((await decide(s9.inquiryId, 'approved')).result, 'issued');
await rebind(w9, 202);
assert.equal((await status(w8.address)).next, 'blocked', 'one request at a time');
const w9Req = queue().find((q) => q.newWallet === w9.address)!;
assert.match(recoveryCli(['reject', w9Req.personId]), /rejected/);
assert.equal((await status(w8.address)).next, 'recover');
await recoverVia(w8);
assert.equal((await status(w8.address)).next, 'pending');
assert.equal((await status(w9.address)).next, 'blocked', 'one recovery at a time');
await rebind(w9, 409);
row('second recovery proposed (left pending for the cranker)', 'w9 asked first and was rejected by the operator', 'w8 approved and pending', 'w9 same person: blocked while another move is pending');

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

// ---------- a permanent bar: passes frozen (not revoked), the person cannot come back on a new wallet; a lift thaws them ----------
// A second person (different ID) joins and is then barred; the first person stays eligible for cranker-e2e.
const other = { ...MOCK_FIELDS_TX, idNumber: `TX-${runId}-2` };
const w6 = await generateKeyPairSigner();
await setSol(w6.address, 1_000_000_000n);
const s6 = await start(w6);
assert.equal((await decide(s6.inquiryId, 'approved', other)).result, 'issued');
await finish(w6, 'join', 'register');
await api('/api/identity/ban', { method: 'POST', body: JSON.stringify({ wallet: w6.address }) }, 401);
const ban = await api<{ banned: boolean; permanent: boolean; frozen: string[] }>('/api/identity/ban', { method: 'POST', headers: { 'x-identity-admin-key': adminKey }, body: JSON.stringify({ wallet: w6.address }) });
assert.equal(ban.banned, true);
assert.equal(ban.permanent, true, 'no `until` means for good');
assert.ok(ban.frozen.includes(w6.address));
const tokenState = async (w: Address) => Buffer.from((await rpc.getAccountInfo(await gatewayTokenAddress(w, pool.gatekeeperNetwork), { encoding: 'base64' }).send()).value!.data[0], 'base64')[99]; // version, parent tag, owner, identity tag, network, gatekeeper, then state
assert.equal(await tokenState(w6.address), 1, 'gateway token frozen (0 active, 1 frozen, 2 revoked)');
assert.equal((await status(w6.address)).pass?.state, 'frozen');
const w5 = await generateKeyPairSigner();
const s5 = await start(w5);
assert.equal((await decide(s5.inquiryId, 'approved', other)).result, 'ineligible');
assert.equal((await status(w5.address)).reason, 'This person can no longer use Good Faith.');
// the bar is lifted (lift_bar, or a pay-back): the pass thaws and works again
const thaw = await api<{ banned: boolean; unfrozen: string[] }>('/api/identity/ban', { method: 'POST', headers: { 'x-identity-admin-key': adminKey }, body: JSON.stringify({ wallet: w6.address, until: '0' }) });
assert.equal(thaw.banned, false);
assert.ok(thaw.unfrozen.includes(w6.address));
assert.equal(await tokenState(w6.address), 0, 'gateway token active again');
assert.equal((await status(w6.address)).pass?.state, 'active');
row('permanent bar, then lifted', 'without the admin key: 401', `pass of ${w6.address.slice(0, 6)}.. frozen on chain (state=1)`, 'same person, new wallet: ineligible', 'lift: pass thawed (state=0)');
// a temporary bar (what the cranker mirrors after a settlement) keeps the passes: the chain refuses loans meanwhile,
// and the person can still recover a wallet and collect what they are owed; a past `until` lifts it
const w7 = await generateKeyPairSigner();
await setSol(w7.address, 1_000_000_000n);
const s7 = await start(w7);
assert.equal((await decide(s7.inquiryId, 'approved', { ...MOCK_FIELDS_TX, idNumber: `TX-${runId}-3` })).result, 'issued');
const until = Math.floor(Date.now() / 1000) + 30 * 86_400;
const temp = await api<{ banned: boolean; permanent: boolean; until: number; frozen: string[]; unfrozen: string[] }>('/api/identity/ban', { method: 'POST', headers: { 'x-identity-admin-key': adminKey }, body: JSON.stringify({ wallet: w7.address, until: String(until) }) });
assert.deepEqual(temp, { banned: true, until, permanent: false, frozen: [], unfrozen: [] });
assert.equal(Buffer.from((await rpc.getAccountInfo(await gatewayTokenAddress(w7.address, pool.gatekeeperNetwork), { encoding: 'base64' }).send()).value!.data[0], 'base64')[99], 0, 'pass kept');
assert.equal((await status(w7.address)).status, 'issued');
const lifted = await api<{ banned: boolean }>('/api/identity/ban', { method: 'POST', headers: { 'x-identity-admin-key': adminKey }, body: JSON.stringify({ wallet: w7.address, until: '0' }) });
assert.equal(lifted.banned, false);
row('temporary bar', `until +30 days: recorded, no pass frozen`, 'until 0: lifted');
// hand the still-eligible member to cranker-e2e (test keys only)
fs.writeFileSync(path.join(here, 'identity-e2e-result.json'), JSON.stringify({ member: w2.address, memberSecret: [...w2Seed, ...getAddressEncoder().encode(w2.address)], pendingWallet: w8.address, newWalletSecret: [...w8Seed, ...getAddressEncoder().encode(w8.address)] }));

console.log('\n' + ['step', 'detail...'].join(' | ')); for (const r of rows) console.log(r.join(' | '));
console.log('\nIDENTITY E2E PASS');
