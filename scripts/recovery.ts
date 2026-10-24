// The operator's recovery CLI: the only place the pool's recovery authority key lives. A member who lost their wallet
// verifies from a new one; the web service records the request and shows it here. The operator checks it (the
// notice reached the member's contact, the old wallet has not objected, the story adds up), then approves: the
// service returns `propose_rebind` signed by the issuer and built for this key as fee payer; this CLI adds the
// recovery signature, sends it, and reports back so the member is told about the veto window. On chain the old
// wallet can still veto for the pool's recovery delay; the cranker finalises afterwards.
//
//   npm run recovery -- list [--json]
//   npm run recovery -- approve <personId>
//   npm run recovery -- reject <personId>
//
// env: IDENTITY_URL (or APP_URL, default http://127.0.0.1:3000), IDENTITY_ADMIN_KEY, RECOVERY_KEYPAIR (JSON keypair file,
// default ~/.config/solana/id.json), RPC_URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeyPairSignerFromBytes, getBase64Encoder, getTransactionDecoder, partiallySignTransaction } from '@solana/kit';
import { rpc, RPC_URL } from './lib.ts';

process.env.NEXT_PUBLIC_RPC_URL = RPC_URL;
process.env.NEXT_PUBLIC_KORA_URL = '';
const tx = await import('../app/src/lib/tx.ts');
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
        const state = !r.onChain ? 'NO MEMBERSHIP ON CHAIN' : r.pendingWallet === r.newWallet ? `proposed, finalises after ${when(r.pendingWalletAt)}` : r.pendingWallet ? `another move pending to ${r.pendingWallet}` : 'waiting for approval';
        out(`${r.personId}  ${r.newWallet}  requested ${when(r.requestedAt)}  from ${r.currentWallet ?? '-'}  ${state}${r.barredUntil ? `  (barred until ${when(r.barredUntil)})` : ''}${r.hasContact ? '' : '  (no contact on file)'}`);
      }
      return;
    }
    case 'approve': {
      const personId = rest[0];
      if (!personId || !/^[0-9a-f]{64}$/.test(personId)) throw new Error('usage: approve <personId> (64 hex characters, from list)');
      const keyPath = process.env.RECOVERY_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json');
      const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));
      const prepared = await api<PreparedTx>(`/api/identity/recoveries/${personId}`, { method: 'POST', body: JSON.stringify({ feePayer: signer.address }) });
      if (prepared.kind !== 'propose' || prepared.feePayer !== signer.address) throw new Error(`unexpected transaction (${prepared.kind} for ${prepared.feePayer})`);
      const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
      const signed = await partiallySignTransaction([signer.keyPair], decoded);
      const sig = await tx.submit(rpc as never, signed, false);
      await api(`/api/identity/recoveries/${personId}`, { method: 'POST', body: JSON.stringify({ proposed: sig }) });
      out(`proposed on chain: ${sig}`);
      out('the old wallet can veto during the pool\'s recovery delay; the cranker finalises afterwards');
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
