/**
 * Liveness and readiness in one answer, for load balancers, the compose healthcheck and the operator: the RPC, the
 * pinned pool, the fee sponsor and the identity service, plus configuration problems. Never includes a secret.
 * 200 when the server runs with a valid configuration (component failures are reported inside), 503 otherwise.
 */
import { createSolanaRpc } from "@solana/kit";
import { CONFIG_ERRORS, POOL_MINT, PROGRAM_ID, RPC_URL, CLUSTER } from "@/lib/config";
import { fetchCanonicalPool, findPoolPda, windingDown } from "@/lib/program";
import { readServerEnv } from "@/lib/server-env";
import { openStore } from "@/lib/identity/db";
import { BUDGET_ALERT_SHARE, LANES, budgetFromEnv, budgetKey, utcDay } from "@/lib/sponsor-policy";

export const dynamic = "force-dynamic";

const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

export async function GET(): Promise<Response> {
  const env = readServerEnv();
  const rpc = createSolanaRpc(RPC_URL);
  const out: Record<string, unknown> = {
    time: new Date().toISOString(),
    version: process.env.GOODFAITH_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    cluster: CLUSTER,
    program: PROGRAM_ID,
    config: { ok: CONFIG_ERRORS.length === 0, errors: CONFIG_ERRORS, problems: env.problems },
    sponsor: env.sponsor,
    identity: env.identity,
    ramps: env.ramps,
  };
  try {
    const slot = await timeout(rpc.getSlot({ commitment: "confirmed" }).send(), 5_000);
    out.rpc = { ok: true, slot: Number(slot) };
  } catch (e) {
    out.rpc = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if ((out.rpc as { ok: boolean }).ok) {
    try {
      const pool = await timeout(fetchCanonicalPool(rpc), 5_000);
      const [expected] = await findPoolPda(POOL_MINT);
      const now = BigInt(Math.floor(Date.now() / 1000));
      out.pool = pool
        ? {
            ok: true,
            address: pool.address,
            paused: pool.paused,
            windingDown: windingDown(pool, now),
            frozen: pool.authority === null,
            activeLoans: Number(pool.activeLoans),
            outstandingPrincipal: pool.outstandingPrincipal.toString(),
            // Lifetime lending against its budget, and the recognised loss: open exposure is not the whole story.
            totalLent: pool.totalLent.toString(),
            maxTotalLent: pool.maxTotalLent.toString(),
            totalLost: pool.totalLost.toString(),
            totalForgiven: pool.totalForgiven.toString(),
            pendingClaims: pool.pendingClaims.toString(),
            recoveriesPending: pool.recoveriesPending.toString(),
            vaultClaims: pool.vaultClaims.toString(),
            scheduledChange: pool.pendingParams ? Number(pool.paramsEffectiveAt) : null,
          }
        : { ok: false, address: expected, error: "pool account not found" };
    } catch (e) {
      out.pool = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (env.sponsor.upstream) {
    try {
      const res = await fetch(new URL("/liveness", process.env.KORA_URL!.trim()), {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      out.sponsor = { ...env.sponsor, ok: res.ok };
    } catch {
      out.sponsor = { ...env.sponsor, ok: false };
    }
  }
  if (env.sponsor.upstream) {
    try {
      const store = openStore();
      const day = utcDay(Date.now());
      const caps = budgetFromEnv(process.env);
      const lanes: Record<string, unknown> = {};
      for (const lane of LANES) {
        const used = (await store.getSponsorBudget(budgetKey(day, lane)))?.txs ?? 0;
        lanes[lane] = { used, cap: caps[lane].dailyTxs, alert: used >= caps[lane].dailyTxs * BUDGET_ALERT_SHARE };
      }
      out.sponsorBudget = { day, lanes };
    } catch (e) {
      out.sponsorBudget = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  const ok = CONFIG_ERRORS.length === 0 && env.problems.length === 0 && (out.rpc as { ok: boolean }).ok;
  out.ok = ok;
  return Response.json(out, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
