"use client";

import { useState } from "react";
import { RequireWallet } from "@/components/connect-button";
import { LoanList } from "@/components/loan-list";
import type { Address } from "@solana/kit";
import { Button, Card, Field, GhostButton, Notice, PageTitle, Stat, TxStatus } from "@/components/ui";
import { useApp, useBalances, useLoans, useNow, usePool } from "@/lib/hooks";
import { fetchLoanById, repayIx, type Loan, type Pool } from "@/lib/program";
import { loanTiming } from "@/lib/loan-status";
import { sendInstructions } from "@/lib/tx";
import { formatAmount, formatUsdc, parseAmount, shortAddress } from "@/lib/format";
import { TOKEN_DECIMALS } from "@/lib/config";
import { useRun } from "@/lib/use-run";
import useSWR from "swr";

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
  const refresh = () => {
    loan.mutate();
    mine.mutate();
  };

  return (
    <div className="space-y-6">
      <Card title="Your loans">
        {mine.isLoading && <p className="text-sm text-stone-500">Looking up your loans...</p>}
        {mine.error && <Notice tone="warn">Couldn&apos;t load your loans right now.</Notice>}
        {mine.data?.length === 0 && <p className="text-sm text-stone-600">No loans yet, as a borrower or a co-signer.</p>}
        {mine.data && mine.data.length > 0 && pool.data && (
          <LoanList wallet={wallet} pool={pool.data} loans={mine.data} onPay={(l) => setIdText(l.id.toString())} onChanged={refresh} />
        )}
      </Card>
      <Card title="Pay toward a loan">
        <Field
          label="Loan number"
          inputMode="numeric"
          value={idText}
          onChange={(e) => setIdText(e.target.value)}
          placeholder="e.g. 3"
          error={idText && id === null ? "Enter a whole number." : null}
        />
        <div className="mt-4">
          {loan.isLoading && <p className="text-sm text-stone-500">Looking up the loan...</p>}
          {id !== null && loan.data === null && <Notice tone="warn">No loan with that number.</Notice>}
          {loan.data && pool.data && <PayForm wallet={wallet} pool={pool.data} loan={loan.data} onPaid={refresh} />}
        </div>
      </Card>
    </div>
  );
}

function PayForm({ wallet, pool, loan, onPaid }: { wallet: Address; pool: Pool; loan: Loan; onPaid: () => void }) {
  const { rpc, signer } = useApp();
  const balances = useBalances(wallet);
  const now = useNow();
  const [amt, setAmt] = useState("");
  const { run, busy, error, result, reset } = useRun();
  const owed = loan.principal - loan.repaid;
  const amount = parseAmount(amt, TOKEN_DECIMALS);
  const timing = loanTiming(loan, now);
  const enough = !amount || !balances.data || balances.data.usdc >= amount;
  const amountError =
    amt && (!amount || amount <= 0n)
      ? "Enter an amount greater than zero."
      : amount && amount > owed
        ? `That's more than what's owed (${formatUsdc(owed)}).`
        : !enough
          ? "Your wallet doesn't have enough for that."
          : null;
  const ok = loan.status === "Active" && !!amount && amount > 0n && amount <= owed && enough && !!signer;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Borrowed" value={formatUsdc(loan.principal)} />
        <Stat label="Paid so far" value={formatUsdc(loan.repaid)} />
        <Stat label="Still owed" value={formatUsdc(owed)} />
      </div>
      <p className="text-xs text-stone-500">
        Borrower {shortAddress(loan.borrower)} · Co-signer {shortAddress(loan.cosigner)} · Due{" "}
        {new Date(Number(loan.dueAt) * 1000).toLocaleDateString()} ({loan.graceDays} days of grace after that)
        {timing.label && ` · ${timing.label}`}
      </p>
      {loan.status !== "Active" ? (
        <Notice tone="info">
          This loan is{" "}
          {loan.status === "Defaulted"
            ? "defaulted"
            : loan.status === "RepaidLate"
              ? "repaid in full, after the grace period"
              : "repaid in full"}
          . Nothing more can be paid on it.
        </Notice>
      ) : (
        <>
          {timing.state === "overdue" && (
            <Notice tone="warn">{timing.label} Repay before then to protect the co-signer&apos;s escrow.</Notice>
          )}
          {timing.state === "defaultable" && (
            <Notice tone="error">
              The grace period has passed. Repaying in full right now still closes the loan, unless someone marks it as defaulted first.
            </Notice>
          )}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field
                label="Amount"
                inputMode="decimal"
                value={amt}
                onChange={(e) => {
                  if (error || result) reset();
                  setAmt(e.target.value);
                }}
                placeholder="0.00"
                error={amountError}
              />
            </div>
            <GhostButton
              onClick={() => {
                if (error || result) reset();
                setAmt(formatAmount(owed, TOKEN_DECIMALS, { minFraction: 0 }));
              }}
            >
              Pay all
            </GhostButton>
          </div>
          <Button
            disabled={!ok || busy}
            onClick={() =>
              run(async () => {
                // Repayment touches nobody else's accounts; the co-signer's deposit is released separately.
                const sig = await sendInstructions(rpc, signer!, [await repayIx({ payer: wallet, pool, loan, amount: amount! })]);
                setAmt("");
                balances.mutate();
                onPaid();
                return sig;
              })
            }
          >
            {busy ? "Paying..." : "Pay"}
          </Button>
          <TxStatus error={error} sig={result} label={amount && amount === owed ? "Paid in full." : "Payment made."} />
        </>
      )}
    </div>
  );
}
