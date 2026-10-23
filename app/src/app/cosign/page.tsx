"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { createNoopSigner, type Address } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { RequireWallet } from "@/components/connect-button";
import { Button, Card, GhostButton, Notice, PageTitle, Stat, TxStatus } from "@/components/ui";
import { useApp, useBalances, useMember, usePendingForCosigner, usePool, useRequest, useSponsor } from "@/lib/hooks";
import { parseCosignLink } from "@/lib/cosign-link";
import { cancelRequestIx, cosignLoanIx, fetchMember, type LoanRequest, type Pool } from "@/lib/program";
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
  const parsed = useMemo(() => parseCosignLink(window.location.search), []);
  const pending = usePendingForCosigner(wallet);
  const pool = usePool();
  const [picked, setPicked] = useState<Address | null>(parsed.ok ? parsed.ref.borrower : null);
  const wrongPool = parsed.ok && !!pool.data && parsed.ref.pool !== pool.data.address;

  return (
    <div className="space-y-6">
      {!parsed.ok && parsed.reason === "invalid" && (
        <Notice tone="error">This link isn&apos;t valid. Ask the borrower for a new one.</Notice>
      )}
      {wrongPool && <Notice tone="error">This link is for a different fund than this app uses, so it can&apos;t be used here.</Notice>}
      {picked && pool.data && !wrongPool && <Review wallet={wallet} pool={pool.data} borrower={picked} />}
      <Card title="Requests waiting for you">
        {pending.isLoading && <p className="text-sm text-stone-500">Looking...</p>}
        {pending.error && <Notice tone="warn">Couldn&apos;t load requests right now.</Notice>}
        {pending.data?.length === 0 && <p className="text-sm text-stone-600">Nothing waiting right now.</p>}
        <ul className="space-y-2">
          {pending.data?.map((r) => (
            <li key={r.address} className="flex flex-wrap items-center justify-between gap-2 text-sm">
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

type Outcome = { sig: string; what: "cosigned" | "declined" };

function Review({ wallet, pool, borrower }: { wallet: Address; pool: Pool; borrower: Address }) {
  const req = useRequest(borrower);
  // Kept here so the success message survives the request account closing.
  const [done, setDone] = useState<Outcome | null>(null);
  if (done && !req.data)
    return (
      <TxStatus
        error={null}
        sig={done.sig}
        label={
          done.what === "cosigned"
            ? "The loan is open. The borrower has the money, and your escrow is held until it's repaid."
            : "The request was declined."
        }
      />
    );
  if (req.isLoading) return <p className="text-stone-600">Loading request...</p>;
  if (!req.data) return <Notice tone="warn">No open request found for this link. It may have been co-signed or cancelled.</Notice>;
  return (
    <Terms
      wallet={wallet}
      pool={pool}
      request={req.data}
      onDone={(o) => {
        setDone(o);
        req.mutate();
      }}
    />
  );
}

function Terms({ wallet, pool, request, onDone }: { wallet: Address; pool: Pool; request: LoanRequest; onDone: (o: Outcome) => void }) {
  const { rpc, signer } = useApp();
  const member = useMember(wallet);
  const balances = useBalances(wallet);
  const { run, busy, error, result } = useRun();
  const sponsor = useSponsor();
  const escrow = escrowFor(request.amount, pool.cosignerEscrowBps);
  const isCosigner = wallet === request.cosigner;
  const isBorrower = wallet === request.borrower;
  const network = pool.gatekeeperNetwork ?? GATEKEEPER_NETWORK;
  const onHold = !!member.data?.ineligible;
  const atLimit = !!member.data && member.data.activeGuarantees >= pool.maxGuaranteesPerMember;
  const short = !!balances.data && balances.data.usdc < escrow;
  const canCosign = isCosigner && !!member.data && !onHold && !atLimit && !short && !!signer && !busy && !result;

  return (
    <div className="space-y-5">
      <Card title="Loan terms">
        <div className="mb-4 grid grid-cols-2 gap-3">
          <Stat label="Loan amount" value={formatUsdc(request.amount)} sub="Borrower pays back exactly this" />
          <Stat label="Term" value={`${request.termDays} days`} sub={`plus ${pool.graceDays} days of grace`} />
          <Stat label="Interest and fees" value="$0.00" />
          <Stat label="Your escrow" value={formatUsdc(escrow)} sub="Taken from your wallet when you co-sign" />
        </div>
        <p className="text-sm text-stone-600">
          Borrower: <span className="font-mono">{shortAddress(request.borrower)}</span>
        </p>
      </Card>

      <Notice tone="warn">
        <strong>What you&apos;re agreeing to.</strong> {formatUsdc(escrow)} leaves your wallet and is held in escrow. You get all of it back
        when the loan is fully repaid. If the borrower does not repay on time, the escrow goes to the fund to cover what&apos;s missing (up
        to the escrow amount), any leftover comes back to you, and both of you lose your membership.
      </Notice>

      {!isCosigner && !isBorrower && (
        <Notice tone="error">
          This request is for a different wallet ({shortAddress(request.cosigner)}). Switch to that wallet to continue.
        </Notice>
      )}
      {isCosigner && member.data === null && (
        <Notice tone="warn">
          You need to verify and join first.{" "}
          <Link className="underline" href="/join">
            Go to Join
          </Link>
          , then come back.
        </Notice>
      )}
      {isCosigner && onHold && <Notice tone="warn">Your membership is on hold, so you can&apos;t co-sign right now.</Notice>}
      {isCosigner && atLimit && (
        <Notice tone="warn">
          You&apos;re already backing as many loans as allowed ({pool.maxGuaranteesPerMember}). Wait for one to be repaid.
        </Notice>
      )}
      {isCosigner && short && (
        <Notice tone="warn">
          Your wallet has {formatUsdc(balances.data!.usdc)}, but the escrow is {formatUsdc(escrow)}. Add funds to co-sign.
        </Notice>
      )}

      {isCosigner && !sponsor.available && (
        <p className="text-xs text-stone-500">
          Fees aren&apos;t covered right now: about 0.004 to 0.006 SOL of rent is paid by you, mostly refunded when the loan closes.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!canCosign}
          onClick={() =>
            run(async () => {
              const sig = await sendInstructions(rpc, signer!, async (feePayer) => {
                const [b, c] = await Promise.all([
                  fetchMember(rpc, pool.address, request.borrower),
                  fetchMember(rpc, pool.address, request.cosigner),
                ]);
                if (!b || !c) throw new Error("The borrower or co-signer is no longer a member.");
                const { ix, borrowerToken } = await cosignLoanIx({
                  payer: feePayer,
                  pool,
                  request,
                  borrowerPerson: b.person,
                  cosignerPerson: c.person,
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
              onDone({ sig, what: "cosigned" });
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
                onDone({ sig, what: "declined" });
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
