"use client";

import { useState } from "react";
import { RequireWallet } from "@/components/connect-button";
import { Button, Card, Field, GhostButton, Notice, PageTitle, Stat, TxStatus } from "@/components/ui";
import { useApp, useBalances, useLoans, usePool } from "@/lib/hooks";
import { fetchLoanById, repayIx, type Loan } from "@/lib/program";
import { sendInstructions } from "@/lib/tx";
import { formatUsdc, parseAmount, shortAddress } from "@/lib/format";
import { TOKEN_DECIMALS } from "@/lib/config";
import { useRun } from "@/lib/use-run";
import useSWR from "swr";
import type { Address } from "@solana/kit";

export default function RepayPage() {
  return (
    <>
      <PageTitle
        title="Repay"
        sub="You pay back exactly what you borrowed. No interest. No fees. Anyone can chip in toward a loan, including friends and family."
      />
      <RequireWallet>{(w) => <Repay wallet={w} />}</RequireWallet>
    </>
  );
}

function Repay({ wallet }: { wallet: Address }) {
  const { rpc } = useApp();
  const pool = usePool();
  const mine = useLoans(wallet);
  // Rendered only after a wallet connects (client side), so reading the URL here is safe.
  const [idText, setIdText] = useState(() => new URLSearchParams(window.location.search).get("loan") ?? "");

  const id = /^\d+$/.test(idText) ? BigInt(idText) : null;
  const loan = useSWR(
    pool.data && id !== null ? ["loan-by-id", pool.data.address, id.toString()] : null,
    () => fetchLoanById(rpc, pool.data!.address, id!),
    { refreshInterval: 10_000 },
  );

  const active = (mine.data ?? []).filter((l) => l.status === "Active");

  return (
    <div className="space-y-6">
      {active.length > 0 && (
        <Card title="Your open loans">
          <ul className="space-y-2">
            {active.map((l) => (
              <li key={l.address} className="flex items-center justify-between text-sm">
                <span>
                  Loan #{l.id.toString()} — {l.borrower === wallet ? "you borrowed" : "you co-signed"} {formatUsdc(l.principal)}, {formatUsdc(l.principal - l.repaid)} left
                </span>
                <GhostButton onClick={() => setIdText(l.id.toString())}>Pay</GhostButton>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Pay toward a loan">
        <Field label="Loan number" inputMode="numeric" value={idText} onChange={(e) => setIdText(e.target.value)} placeholder="e.g. 3" />
        <div className="mt-4">
          {loan.isLoading && <p className="text-sm text-stone-500">Looking up the loan...</p>}
          {id !== null && loan.data === null && <Notice tone="warn">No loan with that number.</Notice>}
          {loan.data && pool.data && <PayForm wallet={wallet} loan={loan.data} onPaid={() => { loan.mutate(); mine.mutate(); }} />}
        </div>
      </Card>
    </div>
  );
}

function PayForm({ wallet, loan, onPaid }: { wallet: Address; loan: Loan; onPaid: () => void }) {
  const { rpc, signer } = useApp();
  const pool = usePool();
  const balances = useBalances(wallet);
  const [amt, setAmt] = useState("");
  const { run, busy, error, result } = useRun();
  const owed = loan.principal - loan.repaid;
  const amount = parseAmount(amt, TOKEN_DECIMALS);
  const ok = loan.status === "Active" && !!amount && amount > 0n && amount <= owed && !!signer;
  const enough = !amount || !balances.data || balances.data.usdc >= amount;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Borrowed" value={formatUsdc(loan.principal)} />
        <Stat label="Paid so far" value={formatUsdc(loan.repaid)} />
        <Stat label="Still owed" value={formatUsdc(owed)} />
      </div>
      <p className="text-xs text-stone-500">
        Borrower {shortAddress(loan.borrower)} · Status: {loan.status} · Due {new Date(Number(loan.dueAt) * 1000).toLocaleDateString()} (
        {loan.graceDays} days of grace after that)
      </p>
      {loan.status !== "Active" ? (
        <Notice tone="info">This loan is {loan.status.toLowerCase()}.</Notice>
      ) : (
        <>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label="Amount" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" />
            </div>
            <GhostButton onClick={() => setAmt((Number(owed) / 10 ** TOKEN_DECIMALS).toFixed(TOKEN_DECIMALS).replace(/\.?0+$/, ""))}>Pay all</GhostButton>
          </div>
          {amount && amount > owed && <p className="text-xs text-red-700">That&apos;s more than what&apos;s owed ({formatUsdc(owed)}).</p>}
          {!enough && <p className="text-xs text-red-700">Your wallet doesn&apos;t have enough for that.</p>}
          <Button
            disabled={!ok || !enough || busy}
            onClick={() =>
              run(async () => {
                const sig = await sendInstructions(rpc, signer!, async () => [
                  await repayIx({ payer: wallet, pool: pool.data!, loan, amount: amount! }),
                ]);
                onPaid();
                return sig;
              })
            }
          >
            {busy ? "Paying..." : "Pay"}
          </Button>
          <TxStatus error={error} sig={result} />
        </>
      )}
    </div>
  );
}
