"use client";

import { useState } from "react";
import Link from "next/link";
import { address, type Address } from "@solana/kit";
import { RequireWallet } from "@/components/connect-button";
import { VerifyAndJoin } from "@/components/verify-join";
import { Button, Card, Field, GhostButton, Notice, PageTitle, Stat, TxStatus } from "@/components/ui";
import { useApp, useMember, usePool, useRequest, useVaultBalance } from "@/lib/hooks";
import { cancelRequestIx, fetchMember, requestLoanIx, type LoanRequest, type Pool } from "@/lib/program";
import { sendInstructions } from "@/lib/tx";
import { buildCosignLink } from "@/lib/cosign-link";
import { escrowFor } from "@/lib/escrow";
import { formatUsdc, parseAmount, shortAddress } from "@/lib/format";
import { gatewayTokenAddress } from "@/lib/civic-addr";
import { GATEKEEPER_NETWORK, TOKEN_DECIMALS } from "@/lib/config";
import { useRun } from "@/lib/use-run";

export default function BorrowPage() {
  return (
    <>
      <PageTitle
        title="Borrow"
        sub="You pay back exactly what you borrow. No interest. No fees. A friend co-signs and puts a small part in escrow."
      />
      <RequireWallet>
        {(w) => (
          <div className="space-y-6">
            <VerifyAndJoin wallet={w} />
            <Request wallet={w} />
          </div>
        )}
      </RequireWallet>
    </>
  );
}

function Request({ wallet }: { wallet: Address }) {
  const pool = usePool();
  const member = useMember(wallet);
  const vault = useVaultBalance(pool.data?.vault);
  if (!pool.data || !member.data) return null;
  if (member.data.ineligible) return <Notice tone="warn">Your membership is on hold, so you can&apos;t borrow right now.</Notice>;
  if (member.data.activeLoan)
    return (
      <Notice tone="info">
        You already have an open loan. <Link className="underline" href="/repay">Go to Repay</Link>.
      </Notice>
    );
  return <RequestSection wallet={wallet} pool={pool.data} available={vault.data ?? 0n} />;
}

function RequestSection({ wallet, pool, available }: { wallet: Address; pool: Pool; available: bigint }) {
  const req = useRequest(wallet);
  if (req.data) return <PendingRequest wallet={wallet} pool={pool} request={req.data} onChange={() => req.mutate()} />;
  return <RequestForm wallet={wallet} pool={pool} available={available} onCreated={() => req.mutate()} />;
}

function PendingRequest({ wallet, pool, request, onChange }: { wallet: Address; pool: Pool; request: LoanRequest; onChange: () => void }) {
  const { rpc, signer } = useApp();
  const { run, busy, error, result } = useRun();
  const [copied, setCopied] = useState(false);
  const link = buildCosignLink(window.location.origin, { pool: pool.address, borrower: wallet });
  return (
    <Card title="Your loan request is waiting for your co-signer">
      <div className="space-y-3">
        <p className="text-sm text-stone-700">
          {formatUsdc(request.amount)} for {request.termDays} days. You pay back exactly {formatUsdc(request.amount)}. No interest. No fees.
        </p>
        <p className="text-sm text-stone-600">
          Co-signer: <span className="font-mono">{shortAddress(request.cosigner)}</span>. Send them this link. It doesn&apos;t expire.
        </p>
        <textarea readOnly value={link} className="h-20 w-full rounded-xl border border-stone-300 p-2 font-mono text-xs" />
        <div className="flex gap-2">
          <GhostButton
            onClick={async () => {
              await navigator.clipboard.writeText(link);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </GhostButton>
          <GhostButton
            disabled={busy || !signer}
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
            {busy ? "Cancelling..." : "Cancel request"}
          </GhostButton>
        </div>
        <TxStatus error={error} sig={result} />
      </div>
    </Card>
  );
}

function RequestForm({ wallet, pool, available, onCreated }: { wallet: Address; pool: Pool; available: bigint; onCreated: () => void }) {
  const { rpc, signer } = useApp();
  const [amt, setAmt] = useState("");
  const [days, setDays] = useState("30");
  const [co, setCo] = useState("");
  const { run, busy, error } = useRun();

  const maxAmount = pool.maxLoan < available ? pool.maxLoan : available;
  const amount = parseAmount(amt, TOKEN_DECIMALS);
  const termDays = Number(days);
  let cosigner: Address | null = null;
  try {
    cosigner = co ? address(co.trim()) : null;
  } catch {
    cosigner = null;
  }
  const amountOk = !!amount && amount > 0n && amount <= maxAmount;
  const termOk = Number.isInteger(termDays) && termDays > 0 && termDays <= pool.maxTermDays;
  const escrow = amountOk ? escrowFor(amount!, pool.cosignerEscrowBps) : null;
  const ready = amountOk && termOk && !!cosigner && cosigner !== wallet && !!signer;

  return (
    <Card title="3. Ask for a loan">
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat label="You can borrow up to" value={formatUsdc(maxAmount)} sub={`Fund has ${formatUsdc(available)} available`} />
        <Stat label="Longest term" value={`${pool.maxTermDays} days`} />
      </div>
      <div className="space-y-3">
        <Field label="Amount" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" />
        {amt && !amountOk && <p className="text-xs text-red-700">Enter an amount up to {formatUsdc(maxAmount)}.</p>}
        <Field label={`Term in days (1 to ${pool.maxTermDays})`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
        <Field
          label="Co-signer's wallet address"
          value={co}
          onChange={(e) => setCo(e.target.value)}
          hint="Someone you trust who is also verified and a member. They'll hold part of the loan in escrow."
        />
        {co && cosigner === wallet && <p className="text-xs text-red-700">You can&apos;t co-sign your own loan.</p>}
        {amountOk && termOk && (
          <Notice tone="info">
            You&apos;ll receive {formatUsdc(amount!)} and pay back exactly {formatUsdc(amount!)}. No interest. No fees. Your co-signer
            escrows {formatUsdc(escrow!)} and gets it back when you finish repaying.
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <Button
          disabled={!ready || busy}
          onClick={() =>
            run(async () => {
              const network = pool.gatekeeperNetwork ?? GATEKEEPER_NETWORK;
              const cm = await fetchMember(rpc, pool.address, cosigner!);
              if (!cm) throw new Error("Your co-signer needs to verify and join first. Send them to /join.");
              const sig = await sendInstructions(rpc, signer!, async (feePayer) => [
                await requestLoanIx({
                  payer: feePayer,
                  borrower: wallet,
                  pool,
                  borrowerGatewayToken: gatewayTokenAddress(wallet, network),
                  amount: amount!,
                  termDays,
                  cosigner: cosigner!,
                }),
              ]);
              onCreated();
              return sig;
            })
          }
        >
          {busy ? "Sending..." : "Request loan"}
        </Button>
      </div>
    </Card>
  );
}
