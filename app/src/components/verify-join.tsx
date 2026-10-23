"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Button, Card, Notice, TxStatus } from "./ui";
import { GATEKEEPER_NETWORK } from "@/lib/config";
import { useApp, useMember, usePool, useSponsor } from "@/lib/hooks";
import { friendlyError, registerMemberIx } from "@/lib/program";
import { sendInstructions } from "@/lib/tx";
import { useRun } from "@/lib/use-run";
import type { Address } from "@solana/kit";

const CivicGate = dynamic(() => import("./civic-gate"), {
  ssr: false,
  loading: () => <p className="text-sm text-stone-500">Loading verification...</p>,
});

/** Step 1: Civic Pass. Step 2: join (register member). */
export function VerifyAndJoin({ wallet }: { wallet: Address }) {
  const { rpc, signer } = useApp();
  const pool = usePool();
  const member = useMember(wallet);
  const { run, busy, error, result } = useRun();
  const sponsor = useSponsor();
  const [civicError, setCivicError] = useState<string | null>(null);
  const network = pool.data?.gatekeeperNetwork ?? GATEKEEPER_NETWORK;

  if (!network) {
    return <Notice tone="warn">The verification network isn&apos;t configured yet. Check back soon.</Notice>;
  }
  if (!pool.data) {
    return <Notice tone="info">{pool.isLoading ? "Loading the fund..." : "The fund isn't set up yet."}</Notice>;
  }

  return (
    <CivicGate network={network}>
      {(civic) => {
        return (
          <div className="space-y-4">
            <Card title="1. Verify you live in Texas">
              <p className="mb-3 text-sm text-stone-600">
                Civic checks your ID once. Good Faith only learns that you passed. Your documents are never stored here.
              </p>
              <p className="mb-3 text-sm font-medium">{civic.statusLabel}</p>
              {!civic.active && (
                <Button
                  onClick={() => {
                    setCivicError(null);
                    civic.request().catch((e: unknown) => setCivicError(friendlyError(e)));
                  }}
                >
                  Verify with Civic
                </Button>
              )}
              {civicError && (
                <div className="mt-3">
                  <Notice tone="error">{civicError}</Notice>
                </div>
              )}
            </Card>
            <Card title="2. Join the fund as a member">
              {member.data ? (
                <Notice tone="ok">You&apos;re a member.{member.data.ineligible && " Your membership is currently on hold."}</Notice>
              ) : (
                <>
                  <p className="mb-3 text-sm text-stone-600">
                    This links your wallet to your pass.{" "}
                    {sponsor.available ? "No cost to you." : "It creates a small account; about 0.0015 SOL of rent is paid by you."}
                  </p>
                  <Button
                    disabled={!civic.active || !civic.gatewayToken || !signer || busy}
                    onClick={() =>
                      run(async () => {
                        const sig = await sendInstructions(rpc, signer!, async (feePayer) => [
                          await registerMemberIx({ payer: feePayer, wallet, pool: pool.data!, gatewayToken: civic.gatewayToken! }),
                        ]);
                        await member.mutate();
                        return sig;
                      })
                    }
                  >
                    {busy ? "Joining..." : "Join"}
                  </Button>
                  <div className="mt-3">
                    <TxStatus error={error} sig={result} />
                  </div>
                </>
              )}
            </Card>
          </div>
        );
      }}
    </CivicGate>
  );
}
