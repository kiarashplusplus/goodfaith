// The operator's scheduled job. Everything it does is permissionless on chain; it only makes outcomes timely and
// deterministic: applies settings whose timelock has elapsed, marks loans past due + grace as defaulted, closes
// expired requests, releases escrow owed to co-signers of closed loans, finalises wallet recoveries whose delay has
// passed, sweeps the vault to the successor once a wind-down is in effect and no loan is open, and tells the identity
// service which people lost their eligibility so their passes are revoked. Pays its own fees (CRANKER_KEYPAIR, default
// ~/.config/solana/id.json) or lets Kora pay when KORA_URL is set. `--once` for CI and cron; `--interval <sec>` loops;
// `--dry-run` reports what is due without sending anything.
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
  dryRun: boolean;
  applied: boolean;
  defaults: { loanId: string; sig: string; borrowerBarred: boolean; cosignerBarred: boolean }[];
  expired: { borrower: string; sig: string }[];
  claims: { loanId: string; amount: string; to: string; sig: string; ataCreated: boolean }[];
  recoveries: { person: string; from: string; to: string; sig: string }[];
  bans: { personId: string; banned: boolean; revoked: string[]; note?: string }[];
  swept: { amount: string; sig: string } | null;
  errors: string[];
};

const keyPath = process.env.CRANKER_KEYPAIR ?? path.join(os.homedir(), '.config/solana/id.json');
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));

async function ban(personId: string): Promise<Report['bans'][number]> {
  const url = process.env.IDENTITY_URL ?? process.env.APP_URL;
  const key = process.env.IDENTITY_ADMIN_KEY;
  if (!url || !key) return { personId, banned: false, revoked: [], note: 'IDENTITY_URL/APP_URL and IDENTITY_ADMIN_KEY not set; pass not revoked' };
  const res = await fetch(`${url}/api/identity/ban`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-identity-admin-key': key }, body: JSON.stringify({ personId }) });
  const body = (await res.json().catch(() => ({}))) as { banned?: boolean; revoked?: string[]; error?: string };
  if (!res.ok && res.status !== 404) return { personId, banned: false, revoked: [], note: `HTTP ${res.status} ${body.error ?? ''}` };
  return { personId, banned: !!body.banned, revoked: body.revoked ?? [], note: body.error };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runOnce(opts: { dryRun?: boolean } = {}): Promise<Report> {
  const dryRun = !!opts.dryRun;
  const report: Report = { now: 0, dryRun, applied: false, defaults: [], expired: [], claims: [], recoveries: [], bans: [], swept: null, errors: [] };
  const now = await clockTs();
  report.now = now;
  const nowB = BigInt(now);
  const send = (ixs: Parameters<typeof tx.sendInstructions>[2]) => (dryRun ? Promise.resolve('dry-run') : tx.sendInstructions(txRpc, signer, ixs));
  // The pool for the configured mint (NEXT_PUBLIC_POOL_MINT); the operator pins it the same way the app does.
  const [poolAddr] = await prog.findPoolPda(cfg.POOL_MINT);
  const reload = async () => {
    const p = await prog.fetchPool(txRpc, poolAddr);
    if (!p) throw new Error(`pool ${poolAddr} not found`);
    return p;
  };
  let pool = await reload();

  // 1. settings whose delay has passed
  if (pool.pendingParams && nowB >= pool.paramsEffectiveAt) {
    try {
      await send([prog.applyParamsIx(pool)]);
      report.applied = true;
      if (!dryRun) pool = await reload();
    } catch (e) {
      report.errors.push(`apply_params: ${msg(e)}`);
    }
  }

  // 2. loans past due + grace; then the people the chain barred are reported to the identity service
  const all = await prog.fetchRecentLoans(txRpc, pool, 10_000);
  const barred = new Map<string, Address>(); // person id -> person account
  for (const loan of all.filter((l) => loanTiming(l, nowB).state === 'defaultable')) {
    try {
      const sig = await send([await prog.markDefaultIx({ caller: signer.address, pool, loan })]);
      const [b, c] = dryRun ? [null, null] : await Promise.all([prog.fetchPerson(txRpc, loan.borrowerPerson), prog.fetchPerson(txRpc, loan.cosignerPerson)]);
      const bBarred = !!b && !prog.eligibleAt(b, nowB), cBarred = !!c && !prog.eligibleAt(c, nowB);
      if (b && bBarred) barred.set(b.personId, b.address);
      if (c && cBarred) barred.set(c.personId, c.address);
      report.defaults.push({ loanId: loan.id.toString(), sig, borrowerBarred: bBarred, cosignerBarred: cBarred });
    } catch (e) {
      report.errors.push(`mark_default #${loan.id}: ${msg(e)}`);
    }
  }
  for (const id of barred.keys()) {
    try {
      report.bans.push(await ban(id));
    } catch (e) {
      report.errors.push(`ban ${id.slice(0, 8)}: ${msg(e)}`);
    }
  }

  // 3. escrow owed to co-signers of closed loans (the ones just defaulted included): to the person's current wallet
  const closed = (await prog.fetchRecentLoans(txRpc, pool, 10_000)).filter((l) => l.status !== 'Active' && l.refundPending > 0n);
  for (const loan of closed) {
    try {
      const to = await prog.cosignerWalletOf(txRpc, loan);
      const { ix, cosignerToken } = await prog.claimEscrowIx({ claimer: signer.address, pool, loan, cosignerWallet: to });
      const exists = (await rpc.getAccountInfo(cosignerToken, { encoding: 'base64' }).send()).value !== null;
      // A missing token account is created at the cranker's expense (about 0.002 SOL), so the refund never stalls.
      const sig = await send(async (feePayer) =>
        exists ? [ix] : [getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(feePayer), ata: cosignerToken, owner: to, mint: pool.mint }), ix],
      );
      report.claims.push({ loanId: loan.id.toString(), amount: loan.refundPending.toString(), to, sig, ataCreated: !exists });
    } catch (e) {
      report.errors.push(`claim_escrow #${loan.id}: ${msg(e)}`);
    }
  }

  // 4. expired requests: rent back to whoever paid it
  for (const r of (await prog.fetchRequests(txRpc, pool.address)).filter((r) => nowB > r.expiresAt)) {
    try {
      const sig = await send([prog.closeExpiredRequestIx({ closer: signer.address, pool: pool.address, request: r })]);
      report.expired.push({ borrower: r.borrower, sig });
    } catch (e) {
      report.errors.push(`close_expired_request ${r.borrower.slice(0, 8)}: ${msg(e)}`);
    }
  }

  // 5. wallet recoveries whose delay has passed and that nobody vetoed
  for (const p of (await prog.fetchPendingRecoveries(txRpc, pool.address)).filter((p) => nowB >= p.pendingWalletAt)) {
    try {
      const sig = await send([await prog.finalizeRebindIx({ payer: signer.address, pool, person: p })]);
      report.recoveries.push({ person: p.address, from: p.wallet, to: p.pendingWallet!, sig });
    } catch (e) {
      report.errors.push(`finalize_rebind ${p.address.slice(0, 8)}: ${msg(e)}`);
    }
  }

  // 6. wind-down sweep
  if (!dryRun) pool = await reload();
  if (prog.windingDown(pool, nowB) && pool.activeLoans === 0n && pool.successor) {
    try {
      const balance = BigInt((await rpc.getTokenAccountBalance(pool.vault, { commitment: 'confirmed' }).send()).value.amount);
      if (balance > 0n) {
        const sig = await send([prog.sweepToSuccessorIx(pool)]);
        report.swept = { amount: balance.toString(), sig };
      }
    } catch (e) {
      report.errors.push(`sweep: ${msg(e)}`);
    }
  }
  return report;
}

function print(r: Report) {
  const s = (sig: string) => (sig === 'dry-run' ? 'due' : `${sig.slice(0, 8)}..`);
  const rows = [
    ['clock', `${new Date(r.now * 1000).toISOString()}${r.dryRun ? ' (dry run: nothing sent)' : ''}`],
    ['apply_params', r.applied ? (r.dryRun ? 'due' : 'applied') : 'nothing due'],
    ['defaults', r.defaults.length ? r.defaults.map((d) => `#${d.loanId} (${d.borrowerBarred ? 'borrower barred' : ''}${d.cosignerBarred ? ', co-signer barred' : ''}) ${s(d.sig)}`).join('; ') : 'none due'],
    ['claims', r.claims.length ? r.claims.map((c) => `#${c.loanId} ${c.amount} -> ${c.to.slice(0, 6)}..${c.ataCreated ? ' (token account created)' : ''} ${s(c.sig)}`).join('; ') : 'none'],
    ['expired', r.expired.length ? r.expired.map((e) => `${e.borrower.slice(0, 6)}.. ${s(e.sig)}`).join('; ') : 'none'],
    ['recoveries', r.recoveries.length ? r.recoveries.map((x) => `${x.from.slice(0, 6)}.. -> ${x.to.slice(0, 6)}.. ${s(x.sig)}`).join('; ') : 'none due'],
    ['bans', r.bans.length ? r.bans.map((b) => `${b.personId.slice(0, 8)}.. ${b.banned ? `revoked ${b.revoked.length}` : `skipped: ${b.note ?? 'no record'}`}`).join('; ') : 'none'],
    ['sweep', r.swept ? `${r.swept.amount} base units -> successor ${s(r.swept.sig)}` : 'not applicable'],
    ['errors', r.errors.length ? r.errors.join('; ') : 'none'],
  ];
  for (const [k, v] of rows) console.log(`${k.padEnd(13)} ${v}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const once = process.argv.includes('--once');
  const dryRun = process.argv.includes('--dry-run');
  const idx = process.argv.indexOf('--interval');
  const interval = idx >= 0 ? Number(process.argv[idx + 1]) : 300;
  do {
    const r = await runOnce({ dryRun });
    print(r);
    if (once || dryRun) process.exit(r.errors.length ? 1 : 0);
    await new Promise((res) => setTimeout(res, interval * 1000));
  } while (true);
}
