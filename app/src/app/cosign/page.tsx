"use client";

import { useState } from "react";
import Link from "next/link";
import { address, createNoopSigner, type Address } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { RequireWallet } from "@/components/connect-button";
import { Button, Card, GhostButton, Notice, PageTitle, Stat, TxStatus } from "@/components/ui";
import { useApp, useMember, usePendingForCosigner, usePool, useRequest } from "@/lib/hooks";
import { parseCosignLink } from "@/lib/cosign-link";
import { cancelRequestIx, cosignLoanIx, type LoanRequest, type Pool } from "@/lib/program";
import { sendInstructions } from "@/lib/tx";
import { gatewayTokenAddress } from "@/lib/civic-addr";
import { GATEKEEPER_NETWORK } from "@/lib/config";
import { escrowFor } from "@/lib/escrow";
import { formatUsdc, shortAddress } from "@/lib/format";
import { useRun } from "@/lib/use-run";

export default function CosignPage() {
  // Read on the client only; this page is rendered after a wallet connects.
  return (
    <>
      <PageTitle title="Co-sign a loan" sub="You're helping someone you know borrow with no interest and no fees." />
      <RequireWallet>{(w) => <Cosign wallet={w} />}</RequireWallet>
    </>
  );
}

function Cosign({ wallet }: { wallet: Address }) {
  const ref = parseCosignLink(window.location.search);
  const pending = usePendingForCosigner(wallet);
  const pool = usePool();
  const [picked, setPicked] = useState<Address | null>(ref ? address(ref.borrower) : null);

  return (
    <div className="space-y-6">
      {picked && pool.data && <Review wallet={wallet} pool={pool.data} borrower={picked} />}
      {!picked && window.location.search && <Notice tone="error">This link isn&apos;t valid. Ask the borrower for a new one.</Notice>}
      <Card title="Requests waiting for you">
        {pending.isLoading && <p className="text-sm text-stone-500">Looking...</p>}
        {pending.data?.length === 0 && <p className="text-sm text-stone-600">Nothing waiting right now.</p>}
        <ul className="space-y-2">
          {pending.data?.map((r) => (
            <li key={r.address} className="flex items-center justify-between text-sm">
              <span>
                {formatUsdc(r.amount)} for {r.termDays} days from <span className="font-mono">{shortAddress(r.borrower)}</span>
              </span>
              <GhostButton onClick={() => setPicked(r.borrower)}>Review</GhostButton>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Review({ wallet, pool, borrower }: { wallet: Address; pool: Pool; borrower: Address }) {
  const req = useRequest(borrower);
  if (req.isLoading) return <p className="text-stone-600">Loading request...</p>;
  if (!req.data) return <Notice tone="warn">No open request found for this link. It may have been co-signed or cancelled.</Notice>;
  return <Terms wallet={wallet} pool={pool} request={req.data} onChange={() => req.mutate()} />;
}

function Terms({ wallet, pool, request, onChange }: { wallet: Address; pool: Pool; request: LoanRequest; onChange: () => void }) {
  const { rpc, signer } = useApp();
  const member = useMember(wallet);
  const { run, busy, error, result } = useRun();
  const escrow = escrowFor(request.amount, pool.cosignerEscrowBps);
  const isCosigner = wallet === request.cosigner;
  const isBorrower = wallet === request.borrower;
  const network = pool.gatekeeperNetwork ?? GATEKEEPER_NETWORK;

  return (
    <div className="space-y-5">
      <Card title="Loan terms">
        <div className="mb-4 grid grid-cols-2 gap-3">
          <Stat label="Loan amount" value={formatUsdc(request.amount)} sub="Borrower pays back exactly this" />
          <Stat label="Term" value={`${request.termDays} days`} />
          <Stat label="Interest and fees" value="$0.00" />
          <Stat label="Your escrow" value={formatUsdc(escrow)} sub="Taken from your wallet when you co-sign" />
        </div>
        <p className="text-sm text-stone-600">
          Borrower: <span className="font-mono">{shortAddress(request.borrower)}</span>
        </p>
      </Card>

      <Notice tone="warn">
        <strong>What you&apos;re agreeing to.</strong> {formatUsdc(escrow)} leaves your wallet and is held in escrow. You get all of it back
        when the loan is fully repaid. If the borrower does not repay on time, the escrow goes to the fund to cover what&apos;s missing (up to
        the escrow amount), and any leftover comes back to you.
      </Notice>

      {!isCosigner && !isBorrower && (
        <Notice tone="error">This request is for a different wallet ({shortAddress(request.cosigner)}). Switch to that wallet to continue.</Notice>
      )}
      {isCosigner && member.data === null && (
        <Notice tone="warn">
          You need to verify and join first. <Link className="underline" href="/join">Go to Join</Link>, then come back.
        </Notice>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!isCosigner || !member.data || !signer || busy || !!result}
          onClick={() =>
            run(async () => {
              const sig = await sendInstructions(rpc, signer!, async (feePayer) => {
                const { ix, borrowerToken } = await cosignLoanIx({
                  payer: feePayer,
                  pool,
                  request,
                  borrowerGatewayToken: gatewayTokenAddress(request.borrower, network),
                  cosignerGatewayToken: gatewayTokenAddress(request.cosigner, network),
                  expectedAmount: request.amount,
                  expectedTermDays: request.termDays,
                  maxEscrow: escrow,
                });
                return [
                  getCreateAssociatedTokenIdempotentInstruction({
                    payer: createNoopSigner(feePayer),
                    ata: borrowerToken,
                    owner: request.borrower,
                    mint: pool.mint,
                  }),
                  ix,
                ];
              });
              onChange();
              return sig;
            })
          }
        >
          {busy ? "Working..." : `Co-sign and put ${formatUsdc(escrow)} in escrow`}
        </Button>
        {(isCosigner || isBorrower) && (
          <GhostButton
            disabled={busy || !signer || !!result}
            onClick={() =>
              run(async () => {
                const sig = await sendInstructions(rpc, signer!, async () => [
                  cancelRequestIx({ canceller: wallet, pool: pool.address, request }),
                ]);
                onChange();
                return sig;
              })
            }
          >
            {isCosigner ? "Decline" : "Cancel request"}
          </GhostButton>
        )}
      </div>
      <TxStatus error={error} sig={result} />
    </div>
  );
}
