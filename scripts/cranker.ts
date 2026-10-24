// The operator's scheduled job. Everything it does is permissionless on chain; it only makes outcomes timely and
// deterministic: applies settings whose timelock has elapsed, settles loans past due + grace, collects the escrow the
// fund is owed into the vault, releases what co-signers are owed (from escrows and the vault), closes expired
// requests, finalises wallet recoveries whose delay has passed, sweeps the vault to the successor once a wind-down is
// in effect and no loan is open, and reconciles the identity service with the chain: every person the chain bars,
// and until when (the service lifts the rest, closes finished recoveries and retries failed notices). Frozen escrows
// are reported as waiting, not as errors, and the vault part of a claim is paid around them. Pays its own fees
// (CRANKER_KEYPAIR, required: the cranker has a key of its own) or lets Kora pay when KORA_URL is set. `--once` for CI
// and cron (exit 1 only on new failures; waiting work is not a failure); `--interval <sec>` loops; `--dry-run` reports
// what is due without sending anything.
import fs from 'node:fs';
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
  /** Recoveries moved from escrows into the vault. */
  collected: { loanId: string; amount: string; sig: string }[];
  expired: { borrower: string; sig: string }[];
  claims: { loanId: string; amount: string; to: string; sig: string; ataCreated: boolean; vaultOnly: boolean }[];
  recoveries: { person: string; from: string; to: string; sig: string }[];
  /** What the identity service did with the chain's list of barred people; null when it is not configured. */
  reconcile: { persons: number; barred: number; lifted: number; recoveriesClosed: number; noticesRetried: number; note?: string } | null;
  swept: { amount: string; sig: string } | null;
  /** Work that cannot be done yet and will be retried: frozen escrows, claims during a pending wallet move. */
  waiting: string[];
  errors: string[];
};

const keyPath = process.env.CRANKER_KEYPAIR;
if (!keyPath) throw new Error('CRANKER_KEYPAIR must be set: the cranker signs with a key of its own, never a shared default');
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, 'utf8'))));

async function reconcile(barred: { personId: string; until: string }[]): Promise<NonNullable<Report['reconcile']>> {
  const url = process.env.IDENTITY_URL ?? process.env.APP_URL;
  const key = process.env.IDENTITY_ADMIN_KEY;
  const none = { persons: barred.length, barred: 0, lifted: 0, recoveriesClosed: 0, noticesRetried: 0 };
  if (!url || !key) return { ...none, note: 'IDENTITY_URL/APP_URL and IDENTITY_ADMIN_KEY not set; identity service not reconciled' };
  const res = await fetch(`${url}/api/identity/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-identity-admin-key': key }, body: JSON.stringify({ barred }) });
  const body = (await res.json().catch(() => ({}))) as { barred?: number; lifted?: number; recoveriesClosed?: unknown[]; noticesRetried?: number; error?: string };
  if (!res.ok) return { ...none, note: `HTTP ${res.status} ${body.error ?? ''}` };
  return { persons: barred.length, barred: body.barred ?? 0, lifted: body.lifted ?? 0, recoveriesClosed: body.recoveriesClosed?.length ?? 0, noticesRetried: body.noticesRetried ?? 0 };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runOnce(opts: { dryRun?: boolean } = {}): Promise<Report> {
  const dryRun = !!opts.dryRun;
  const report: Report = { now: 0, dryRun, applied: false, defaults: [], collected: [], expired: [], claims: [], recoveries: [], reconcile: null, swept: null, waiting: [], errors: [] };
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
  const loans = () => prog.fetchRecentLoans(txRpc, pool, 10_000);

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

  // 2. loans past due + grace are settled (the bars this sets reach the identity service in step 8)
  for (const loan of (await loans()).filter((l) => loanTiming(l, nowB).state === 'defaultable')) {
    try {
      const sig = await send([await prog.settleIx({ caller: signer.address, pool, loan })]);
      const [b, c] = dryRun ? [null, null] : await Promise.all([prog.fetchPerson(txRpc, loan.borrowerPerson), prog.fetchPerson(txRpc, loan.cosignerPerson)]);
      report.defaults.push({ loanId: loan.id.toString(), sig, borrowerBarred: !!b && !prog.eligibleAt(b, nowB), cosignerBarred: !!c && !prog.eligibleAt(c, nowB) });
    } catch (e) {
      report.errors.push(`settle #${loan.id}: ${msg(e)}`);
    }
  }

  // 3. what settled loans owe the fund: escrow into the vault. A frozen escrow waits; it is not an error.
  for (const loan of (await loans()).filter((l) => l.recoveryPending > 0n)) {
    try {
      if (await prog.escrowFrozen(txRpc, loan)) {
        report.waiting.push(`collect_recovery #${loan.id}: escrow frozen (${loan.recoveryPending} waits)`);
        continue;
      }
      const sig = await send([await prog.collectRecoveryIx({ collector: signer.address, pool, loan })]);
      report.collected.push({ loanId: loan.id.toString(), amount: loan.recoveryPending.toString(), sig });
    } catch (e) {
      report.errors.push(`collect_recovery #${loan.id}: ${msg(e)}`);
    }
  }

  // 4. what closed loans owe co-signers (escrow refunds and vault reimbursements): to the person's current wallet.
  //    Claims wait while a wallet move is pending (the program refuses them); a frozen escrow still lets the vault
  //    part out.
  for (const loan of (await loans()).filter((l) => l.status !== 'Active' && prog.owedToCosigner(l) > 0n)) {
    try {
      const person = await prog.fetchPerson(txRpc, loan.cosignerPerson);
      if (person?.pendingWallet) {
        report.waiting.push(`claim_escrow #${loan.id}: the co-signer's wallet move is pending until ${person.pendingWalletAt}`);
        continue;
      }
      const frozen = loan.refundPending > 0n && (await prog.escrowFrozen(txRpc, loan));
      if (frozen && loan.reimbursementPending === 0n) {
        report.waiting.push(`claim_escrow #${loan.id}: escrow frozen (${loan.refundPending} waits)`);
        continue;
      }
      const to = person?.wallet ?? loan.cosigner;
      const { ix, cosignerToken } = await prog.claimEscrowIx({ claimer: signer.address, pool, loan, cosignerWallet: to, ...(frozen ? { withEscrow: false } : {}) });
      const exists = (await rpc.getAccountInfo(cosignerToken, { encoding: 'base64' }).send()).value !== null;
      // A missing token account is created at the cranker's expense (about 0.002 SOL), so the refund never stalls.
      const sig = await send(async (feePayer) =>
        exists ? [ix] : [getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(feePayer), ata: cosignerToken, owner: to, mint: pool.mint }), ix],
      );
      const amount = frozen ? loan.reimbursementPending : prog.owedToCosigner(loan);
      report.claims.push({ loanId: loan.id.toString(), amount: amount.toString(), to, sig, ataCreated: !exists, vaultOnly: frozen });
      if (frozen) report.waiting.push(`claim_escrow #${loan.id}: escrow frozen (${loan.refundPending} waits; the vault part was paid)`);
    } catch (e) {
      report.errors.push(`claim_escrow #${loan.id}: ${msg(e)}`);
    }
  }

  // 5. expired requests: rent back to whoever paid it
  for (const r of (await prog.fetchRequests(txRpc, pool.address)).filter((r) => nowB > r.expiresAt)) {
    try {
      const sig = await send([prog.closeExpiredRequestIx({ closer: signer.address, pool: pool.address, request: r })]);
      report.expired.push({ borrower: r.borrower, sig });
    } catch (e) {
      report.errors.push(`close_expired_request ${r.borrower.slice(0, 8)}: ${msg(e)}`);
    }
  }

  // 6. wallet recoveries whose delay has passed and that nobody vetoed
  for (const p of (await prog.fetchPendingRecoveries(txRpc, pool.address)).filter((p) => nowB >= p.pendingWalletAt)) {
    try {
      const sig = await send([await prog.finalizeRebindIx({ payer: signer.address, pool, person: p })]);
      report.recoveries.push({ person: p.address, from: p.wallet, to: p.pendingWallet!, sig });
    } catch (e) {
      report.errors.push(`finalize_rebind ${p.address.slice(0, 8)}: ${msg(e)}`);
    }
  }

  // 7. wind-down sweep: everything in the vault except what co-signers are owed from it. Runs on every pass, so a
  // pay-back or collection that lands in the old vault after the first sweep is forwarded to the successor too.
  if (!dryRun) pool = await reload();
  if (prog.windingDown(pool, nowB) && pool.activeLoans === 0n && pool.successor) {
    try {
      const balance = BigInt((await rpc.getTokenAccountBalance(pool.vault, { commitment: 'confirmed' }).send()).value.amount) - pool.vaultClaims;
      if (balance > 0n) {
        const sig = await send([prog.sweepToSuccessorIx(pool)]);
        report.swept = { amount: balance.toString(), sig };
      }
    } catch (e) {
      report.errors.push(`sweep: ${msg(e)}`);
    }
  }

  // 8. the identity service follows the chain: everyone barred right now, with the end of their bar (whoever settled
  //    the loan, and whatever relaxed or lifted the bar since); the service lifts the rest and closes finished recoveries
  if (!dryRun) {
    try {
      const barred = (await prog.fetchBarredPersons(txRpc, pool.address))
        .filter((p) => !prog.eligibleAt(p, nowB))
        .map((p) => ({ personId: p.personId, until: p.ineligibleUntil.toString() }));
      report.reconcile = await reconcile(barred);
    } catch (e) {
      report.errors.push(`reconcile: ${msg(e)}`);
    }
  }
  return report;
}

function print(r: Report) {
  const s = (sig: string) => (sig === 'dry-run' ? 'due' : `${sig.slice(0, 8)}..`);
  const rows = [
    ['clock', `${new Date(r.now * 1000).toISOString()}${r.dryRun ? ' (dry run: nothing sent)' : ''}`],
    ['apply_params', r.applied ? (r.dryRun ? 'due' : 'applied') : 'nothing due'],
    ['settled', r.defaults.length ? r.defaults.map((d) => `#${d.loanId} (${d.borrowerBarred ? 'borrower barred' : ''}${d.cosignerBarred ? ', co-signer barred' : ''}) ${s(d.sig)}`).join('; ') : 'none due'],
    ['collected', r.collected.length ? r.collected.map((c) => `#${c.loanId} ${c.amount} -> vault ${s(c.sig)}`).join('; ') : 'none'],
    ['claims', r.claims.length ? r.claims.map((c) => `#${c.loanId} ${c.amount} -> ${c.to.slice(0, 6)}..${c.ataCreated ? ' (token account created)' : ''}${c.vaultOnly ? ' (vault part only)' : ''} ${s(c.sig)}`).join('; ') : 'none'],
    ['expired', r.expired.length ? r.expired.map((e) => `${e.borrower.slice(0, 6)}.. ${s(e.sig)}`).join('; ') : 'none'],
    ['recoveries', r.recoveries.length ? r.recoveries.map((x) => `${x.from.slice(0, 6)}.. -> ${x.to.slice(0, 6)}.. ${s(x.sig)}`).join('; ') : 'none due'],
    ['identity', r.reconcile ? `${r.reconcile.persons} barred on chain; service: ${r.reconcile.barred} set, ${r.reconcile.lifted} lifted, ${r.reconcile.recoveriesClosed} recoveries closed, ${r.reconcile.noticesRetried} notices retried${r.reconcile.note ? ` (${r.reconcile.note})` : ''}` : r.dryRun ? 'skipped (dry run)' : 'not reconciled'],
    ['sweep', r.swept ? `${r.swept.amount} base units -> successor ${s(r.swept.sig)}` : 'not applicable'],
    ['waiting', r.waiting.length ? r.waiting.join('; ') : 'none'],
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
