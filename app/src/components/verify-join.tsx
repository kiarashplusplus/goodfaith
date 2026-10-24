"use client";

import { useState } from "react";
import useSWR from "swr";
import type { Address } from "@solana/kit";
import { Button, Card, GhostButton, Notice, TxStatus } from "./ui";
import { useApp, useMember, usePool, useSponsor } from "@/lib/hooks";
import { fetchIdentityStatus, prepareJoin, prepareRebind, startIdentityCheck, type StatusView } from "@/lib/identity-client";
import { friendlyError } from "@/lib/program";
import { sendPrepared } from "@/lib/tx";
import { useRun } from "@/lib/use-run";

/**
 * Step 1: a one-time identity check with the fund's verification service (government ID, Texas, 18+).
 * Step 2: join. The service co-signs the on-chain registration as the fund's issuer: one verified person,
 * one wallet. A person who lost their keys verifies again and asks to move their membership to the new wallet;
 * the move completes after the fund's recovery delay unless the old wallet objects.
 */
export function VerifyAndJoin({ wallet }: { wallet: Address }) {
  const { rpc, signer, client } = useApp();
  const pool = usePool();
  const member = useMember(wallet);
  const sponsor = useSponsor();
  const { run, busy, error, result } = useRun();
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const status = useSWR(["identity-status", wallet], () => fetchIdentityStatus(wallet), {
    refreshInterval: (d?: StatusView) => (d?.next === "wait" ? 4_000 : 20_000),
    revalidateOnFocus: true,
  });
  const walletClient = (client as unknown as { wallet?: { signMessage?: (m: Uint8Array) => Promise<Uint8Array> } }).wallet;

  if (!pool.data) return <Notice tone="info">{pool.isLoading ? "Loading the fund..." : "The fund isn't set up yet."}</Notice>;
  if (status.error) return <Notice tone="warn">{friendlyError(status.error)}</Notice>;
  const s = status.data;
  if (!s) return <p className="text-sm text-stone-500">Checking your membership...</p>;

  const refresh = () => Promise.all([status.mutate(), member.mutate()]);
  const start = async () => {
    setStartError(null);
    setStarting(true);
    try {
      const { url } = await startIdentityCheck(signer!, walletClient);
      window.open(url, "_blank", "noopener");
      await status.mutate();
    } catch (e) {
      setStartError(friendlyError(e));
    } finally {
      setStarting(false);
    }
  };
  const finish = (prepare: (w: Address) => ReturnType<typeof prepareJoin>) =>
    run(async () => {
      const prepared = await prepare(wallet);
      const sig = await sendPrepared(rpc, signer!, prepared);
      await refresh();
      return sig;
    });

  const verified = s.status === "issued";
  return (
    <div className="space-y-4">
      <Card title="1. Verify who you are">
        <p className="mb-3 text-sm text-stone-600">
          A one-time check of your government ID with our verification partner: Texas residents, 18 or older. Good Faith keeps only a keyed
          fingerprint of your ID so one person can hold one membership. Your documents are never stored here or on the blockchain.
        </p>
        {verified && <Notice tone="ok">Verified. Your pass is linked to this wallet.</Notice>}
        {s.status === "pending" && (
          <Notice tone="info">
            Your check is open.{" "}
            {s.url && (
              <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">
                Continue the check
              </a>
            )}{" "}
            This page updates by itself when it is done.
          </Notice>
        )}
        {s.status === "review" && <Notice tone="info">{s.reason ?? "Your check is being reviewed."}</Notice>}
        {(s.status === "declined" || s.status === "ineligible") && (
          <Notice tone="warn">{s.reason ?? "The identity check was not approved."}</Notice>
        )}
        {s.status === "error" && <Notice tone="error">{s.reason ?? "Something went wrong. Please try again."}</Notice>}
        {(s.status === "none" || s.status === "error" || s.status === "declined") && s.next !== "done" && (
          <div className="mt-3">
            <Button disabled={!signer || starting} onClick={start}>
              {starting ? "Opening..." : s.status === "none" ? "Verify my identity" : "Try again"}
            </Button>
          </div>
        )}
        {startError && (
          <div className="mt-3">
            <Notice tone="error">{startError}</Notice>
          </div>
        )}
      </Card>

      <Card title="2. Join the fund">
        {s.next === "done" ? (
          <Notice tone="ok">You&apos;re a member.{member.data?.ineligible && " Your membership is currently on hold."}</Notice>
        ) : s.next === "blocked" && (s.member?.retired || s.person?.pendingWallet) ? (
          <Notice tone="warn">{s.reason}</Notice>
        ) : s.next === "pending" ? (
          <Notice tone="info">{s.reason}</Notice>
        ) : s.next === "join" || s.next === "recover" || s.next === "finalize" ? (
          <>
            <p className="mb-3 text-sm text-stone-600">
              {s.next === "join"
                ? "This links your wallet to your verified membership. "
                : s.next === "recover"
                  ? "You already have a membership on another wallet. This asks to move it here. The move takes effect after a waiting period during which your old wallet can object; the old wallet then stops working for Good Faith. "
                  : "The waiting period is over. This completes the move of your membership to this wallet. "}
              {s.next !== "finalize" && sponsor.available
                ? "No cost to you."
                : "It creates small accounts; about 0.003 SOL of rent is paid by you."}
            </p>
            {s.next === "join" ? (
              <Button disabled={!signer || busy} onClick={() => finish(prepareJoin)}>
                {busy ? "Joining..." : "Join"}
              </Button>
            ) : (
              <GhostButton disabled={!signer || busy} onClick={() => finish(prepareRebind)}>
                {busy ? "Sending..." : s.next === "recover" ? "Move my membership to this wallet" : "Complete the move"}
              </GhostButton>
            )}
            <div className="mt-3">
              <TxStatus
                error={error}
                sig={result}
                label={
                  s.next === "join"
                    ? "Welcome. You can borrow or co-sign now."
                    : s.next === "recover"
                      ? "The move is proposed. Come back once the waiting period has passed."
                      : "Your membership now lives on this wallet."
                }
              />
            </div>
          </>
        ) : (
          <p className="text-sm text-stone-600">Finish step 1 first.</p>
        )}
      </Card>
    </div>
  );
}
