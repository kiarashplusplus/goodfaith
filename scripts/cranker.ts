// The operator's scheduled job. Everything it does is permissionless on chain; it only makes outcomes timely and
// deterministic: marks loans past due + grace as defaulted, applies settings whose timelock has elapsed, sweeps the
// vault to the successor once a wind-down is in effect and no loan is open, and tells the identity service which
// people lost their eligibility so their passes are revoked. Pays its own fees (CRANKER_KEYPAIR, default
// ~/.config/solana/id.json) or lets Kora pay when KORA_URL is set. `--once` for CI and cron; `--interval <sec>` loops.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeyPairSignerFromBytes, createNoopSigner, type Address } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { clockTs, rpc, RPC_URL } from './lib.ts';

process.env.NEXT_PUBLIC_RPC_URL = RPC_URL;
process.env.NEXT_PUBLIC_KORA_URL = process.env.KORA_URL ?? '';
const prog = await import('../app/src/lib/program.ts');
const tx = await import('../app/src/lib/tx.ts');
const cfg = await import('../app/src/lib/config.ts');
const { loanTiming } = await import('../app/src/lib/loan-status.ts');

type Rpc = Parameters<typeof tx.sendInstructions>[0] & Parameters<typeof prog.fetchPool>[0] & Parameters<typeof prog.fetchRecentLoans>[0];
const txRpc = rpc as unknown as Rpc;

export type Report = {
  now: number;
  applied: boolean;
  defaults: { loanId: string; sig: string; borrowerBarred: boolean; cosignerBarred: boolean }[];
  bans: { personHash: string; banned: boolean; revoked: string[]; note?: string }[];
  swept: { amount: string; sig: string } | null;
  errors: string[];
};

const keyPath = process.env.CRANKER_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json');
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));

async function ban(personHash: string): Promise<Report['bans'][number]> {
  const url = process.env.IDENTITY_URL ?? process.env.APP_URL;
  const key = process.env.IDENTITY_ADMIN_KEY;
  if (!url || !key) return { personHash, banned: false, revoked: [], note: 'IDENTITY_URL/APP_URL and IDENTITY_ADMIN_KEY not set; pass not revoked' };
  const res = await fetch(`${url}/api/identity/ban`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-identity-admin-key': key }, body: JSON.stringify({ personHash }) });
  const body = (await res.json().catch(() => ({}))) as { banned?: boolean; revoked?: string[]; error?: string };
  if (!res.ok && res.status !== 404) return { personHash, banned: false, revoked: [], note: `HTTP ${res.status} ${body.error ?? ''}` };
  return { personHash, banned: !!body.banned, revoked: body.revoked ?? [], note: body.error };
}

export async function runOnce(): Promise<Report> {
  const report: Report = { now: 0, applied: false, defaults: [], bans: [], swept: null, errors: [] };
  const now = await clockTs();
  report.now = now;
  // The pool for the configured mint (NEXT_PUBLIC_POOL_MINT); the operator pins it the same way the app does.
  const [poolAddr] = await prog.findPoolPda(cfg.POOL_MINT);
  const reload = async () => {
    const p = await prog.fetchPool(txRpc, poolAddr);
    if (!p) throw new Error(`pool ${poolAddr} not found`);
    return p;
  };
  let pool = await reload();

  // 1. settings whose delay has passed
  if (pool.pendingParams && BigInt(now) >= pool.paramsEffectiveAt) {
    try {
      await tx.sendInstructions(txRpc, signer, [prog.applyParamsIx(pool)]);
      report.applied = true;
      pool = await reload();
    } catch (e) {
      report.errors.push(`apply_params: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. loans past due + grace
  const loans = (await prog.fetchRecentLoans(txRpc, pool, 10_000)).filter((l) => loanTiming(l, BigInt(now)).state === 'defaultable');
  const barred = new Map<string, Address>(); // person hash -> person account
  for (const loan of loans) {
    try {
      const cosignerWallet = await prog.cosignerWalletOf(txRpc, loan);
      const sig = await tx.sendInstructions(txRpc, signer, async (feePayer) => {
        const { ix, cosignerToken } = await prog.markDefaultIx({ caller: signer.address, pool: pool!, loan, cosignerWallet });
        return [getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(feePayer), ata: cosignerToken, owner: cosignerWallet, mint: pool!.mint }), ix];
      });
      const [b, c] = await Promise.all([prog.fetchPerson(txRpc, loan.borrowerPerson), prog.fetchPerson(txRpc, loan.cosignerPerson)]);
      for (const p of [b, c]) if (p?.ineligible) barred.set(p.personHash, p.address);
      report.defaults.push({ loanId: loan.id.toString(), sig, borrowerBarred: !!b?.ineligible, cosignerBarred: !!c?.ineligible });
    } catch (e) {
      report.errors.push(`mark_default #${loan.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const hash of barred.keys()) {
    try {
      report.bans.push(await ban(hash));
    } catch (e) {
      report.errors.push(`ban ${hash.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. wind-down sweep
  pool = await reload();
  if (prog.windingDown(pool, BigInt(now)) && pool.activeLoans === 0n && pool.successor) {
    try {
      const balance = BigInt((await rpc.getTokenAccountBalance(pool.vault, { commitment: 'confirmed' }).send()).value.amount);
      if (balance > 0n) {
        const sig = await tx.sendInstructions(txRpc, signer, [prog.sweepToSuccessorIx(pool)]);
        report.swept = { amount: balance.toString(), sig };
      }
    } catch (e) {
      report.errors.push(`sweep: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

function print(r: Report) {
  const rows = [
    ['clock', new Date(r.now * 1000).toISOString()],
    ['apply_params', r.applied ? 'applied' : 'nothing due'],
    ['defaults', r.defaults.length ? r.defaults.map((d) => `#${d.loanId} (${d.borrowerBarred ? 'borrower barred' : ''}${d.cosignerBarred ? ', co-signer barred' : ''}) ${d.sig.slice(0, 8)}..`).join('; ') : 'none due'],
    ['bans', r.bans.length ? r.bans.map((b) => `${b.personHash.slice(0, 8)}.. ${b.banned ? `revoked ${b.revoked.length}` : `skipped: ${b.note ?? 'no record'}`}`).join('; ') : 'none'],
    ['sweep', r.swept ? `${r.swept.amount} base units -> successor ${r.swept.sig.slice(0, 8)}..` : 'not applicable'],
    ['errors', r.errors.length ? r.errors.join('; ') : 'none'],
  ];
  for (const [k, v] of rows) console.log(`${k.padEnd(13)} ${v}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const once = process.argv.includes('--once');
  const idx = process.argv.indexOf('--interval');
  const interval = idx >= 0 ? Number(process.argv[idx + 1]) : 300;
  do {
    const r = await runOnce();
    print(r);
    if (once) process.exit(r.errors.length ? 1 : 0);
    await new Promise((res) => setTimeout(res, interval * 1000));
  } while (true);
}
