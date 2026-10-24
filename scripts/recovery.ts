// The operator's recovery CLI: the only place the pool's recovery authority key lives. A member who lost their wallet
// verifies from a new one; the web service records the request and shows it here. The operator checks it (the
// notice reached the member's contact, the request has aged, the old wallet has not objected, the story adds up),
// then approves, naming the wallet they checked: the service returns `propose_rebind` signed by the issuer and built
// for this key as fee payer; this CLI decodes it and refuses anything but that one instruction for that person and
// wallet, signed by nobody but the issuer and this key; then it adds the recovery signature, sends it, and reports
// back so the member is told about the veto window. On chain the old wallet can still veto for the pool's recovery
// delay; the cranker finalises afterwards.
//
//   npm run recovery -- list [--json]
//   npm run recovery -- approve <personId> <newWallet> [--force]   (--force: a request younger than the minimum age, or whose notice failed)
//   npm run recovery -- reject <personId>
//
// env: IDENTITY_URL (or APP_URL, default http://127.0.0.1:3000), IDENTITY_ADMIN_KEY, RECOVERY_KEYPAIR (JSON keypair file,
// required: no default path is shared with other keys), RPC_URL.
import fs from 'node:fs';
import path from 'node:path';
import {
  address, createKeyPairSignerFromBytes, decompileTransactionMessage, getBase64Encoder, getCompiledTransactionMessageDecoder,
  getTransactionDecoder, partiallySignTransaction, type Address,
} from '@solana/kit';
import { fetchPool, gf, rpc, RPC_URL } from './lib.ts';

process.env.NEXT_PUBLIC_RPC_URL = RPC_URL;
process.env.NEXT_PUBLIC_KORA_URL = '';
const tx = await import('../app/src/lib/tx.ts');
const cfg = await import('../app/src/lib/config.ts');
type RecoveryView = import('../app/src/lib/identity/service.ts').RecoveryView;
type PreparedTx = import('../app/src/lib/identity/service.ts').PreparedTx;

const APP = (process.env.IDENTITY_URL ?? process.env.APP_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const KEY = process.env.IDENTITY_ADMIN_KEY ?? '';
const when = (s: number) => (s === 0 ? '-' : s >= Number.MAX_SAFE_INTEGER ? 'for good' : new Date(s * 1000).toISOString());

async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  if (!KEY) throw new Error('IDENTITY_ADMIN_KEY is not set');
  const res = await fetch(`${APP}${route}`, { ...init, headers: { 'content-type': 'application/json', 'x-identity-admin-key': KEY, ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status} ${body.error ?? ''}`.trim());
  return body;
}

export type ProposalExpectation = { person: Address; newWallet: Address; recoveryAuthority: Address; pool: Address; issuer: Address };

/**
 * What a prepared proposal must be before this key signs it: one transaction with exactly one instruction, the Good
 * Faith `propose_rebind` for this person and this new wallet on this pool, with the issuer and this key as the only
 * signers and this key as fee payer. Returns the lines to show the operator; throws on anything else.
 */
export function verifyProposal(transactionB64: string, expect: ProposalExpectation): string[] {
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transactionB64));
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  if ('addressTableLookups' in compiled && compiled.addressTableLookups?.length) throw new Error('refused: the transaction uses address lookup tables');
  const signers = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
  if (signers[0] !== expect.recoveryAuthority) throw new Error(`refused: the fee payer is ${signers[0]}, not this key`);
  const allowed = new Set<string>([expect.recoveryAuthority, expect.issuer]);
  for (const s of signers) if (!allowed.has(s)) throw new Error(`refused: unexpected signer ${s}`);
  const { instructions } = decompileTransactionMessage(compiled);
  if (instructions.length !== 1) throw new Error(`refused: ${instructions.length} instructions; a proposal is exactly one`);
  const ix = instructions[0]!;
  if (ix.programAddress !== gf.GOODFAITH_PROGRAM_ADDRESS) throw new Error(`refused: instruction for program ${ix.programAddress}`);
  const data = new Uint8Array(ix.data ?? []);
  const disc = gf.PROPOSE_REBIND_DISCRIMINATOR;
  if (data.length !== disc.length || !disc.every((b, i) => data[i] === b)) throw new Error('refused: the instruction is not propose_rebind');
  const parsed = gf.parseProposeRebindInstruction(ix as never);
  const a = parsed.accounts;
  const checks: [string, Address, Address][] = [
    ['pool', a.pool.address, expect.pool],
    ['person account', a.person.address, expect.person],
    ['new wallet', a.newWallet.address, expect.newWallet],
    ['issuer', a.issuer.address, expect.issuer],
    ['recovery authority', a.recoveryAuthority.address, expect.recoveryAuthority],
  ];
  for (const [what, got, want] of checks) if (got !== want) throw new Error(`refused: ${what} is ${got}, expected ${want}`);
  return [
    `program          ${ix.programAddress}`,
    `instruction      propose_rebind`,
    `person account   ${a.person.address}`,
    `new wallet       ${a.newWallet.address}`,
    `pass (gateway)   ${a.gatewayToken.address}`,
    `signers          ${signers.join(', ')}`,
  ];
}

export async function run(argv: string[], out: (line: string) => void = console.log): Promise<void> {
  const [cmd = 'list', ...rest] = argv;
  switch (cmd) {
    case 'list': {
      const { recoveries } = await api<{ recoveries: RecoveryView[] }>('/api/identity/recoveries');
      if (rest.includes('--json')) {
        out(JSON.stringify(recoveries));
        return;
      }
      if (!recoveries.length) out('no recovery requests waiting');
      for (const r of recoveries) {
        const state = !r.onChain ? 'NO MEMBERSHIP ON CHAIN' : r.pendingWallet === r.newWallet ? `proposed, finalises after ${when(r.pendingWalletAt)}` : r.pendingWallet ? `another move pending to ${r.pendingWallet}` : r.proposedAt ? `proposed ${when(r.proposedAt)}` : 'waiting for approval';
        const notice = r.delivery === 'sent' ? 'notice sent' : r.delivery === 'failed' ? 'NOTICE FAILED' : r.hasContact ? 'no notice yet' : 'no contact on file';
        out(`${r.personId}  ${r.newWallet}  requested ${when(r.requestedAt)}  from ${r.currentWallet ?? '-'}  ${state}  (${notice})${r.barredUntil ? `  (barred until ${when(r.barredUntil)})` : ''}`);
      }
      return;
    }
    case 'approve': {
      const personId = rest[0];
      const newWalletRaw = rest[1];
      if (!personId || !/^[0-9a-f]{64}$/.test(personId) || !newWalletRaw || newWalletRaw.startsWith('--'))
        throw new Error('usage: approve <personId> <newWallet> [--force]   (both from list; name the wallet you checked)');
      const newWallet = address(newWalletRaw);
      const force = rest.includes('--force');
      const keyPath = process.env.RECOVERY_KEYPAIR;
      if (!keyPath) throw new Error('RECOVERY_KEYPAIR must be set: the recovery key has a file of its own, never a shared default');
      const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));
      const [poolAddr] = await gf.findPoolPda({ mint: cfg.POOL_MINT });
      const pool = await fetchPool(poolAddr);
      if (pool.recoveryAuthority !== signer.address) throw new Error(`this key (${signer.address}) is not the pool's recovery authority (${pool.recoveryAuthority})`);
      const prepared = await api<PreparedTx>(`/api/identity/recoveries/${personId}`, { method: 'POST', body: JSON.stringify({ feePayer: signer.address, newWallet, force }) });
      if (prepared.kind !== 'propose' || prepared.feePayer !== signer.address) throw new Error(`unexpected transaction (${prepared.kind} for ${prepared.feePayer})`);
      const [person] = await gf.findPersonPda({ pool: poolAddr, personId: Buffer.from(personId, 'hex') });
      const lines = verifyProposal(prepared.transaction, { person, newWallet, recoveryAuthority: signer.address, pool: poolAddr, issuer: pool.issuer });
      for (const l of lines) out(`  ${l}`);
      const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
      const signed = await partiallySignTransaction([signer.keyPair], decoded);
      const sig = await tx.submit(rpc as never, signed, false);
      await api(`/api/identity/recoveries/${personId}`, { method: 'POST', body: JSON.stringify({ proposed: sig }) });
      out(`proposed on chain: ${sig}`);
      out("the old wallet can veto during the pool's recovery delay; the cranker finalises afterwards");
      return;
    }
    case 'reject': {
      const personId = rest[0];
      if (!personId || !/^[0-9a-f]{64}$/.test(personId)) throw new Error('usage: reject <personId>');
      const r = await api<{ rejected: boolean }>(`/api/identity/recoveries/${personId}`, { method: 'DELETE' });
      out(r.rejected ? 'request rejected; the member was told' : 'no such request');
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}"; see the header of scripts/recovery.ts`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  run(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
