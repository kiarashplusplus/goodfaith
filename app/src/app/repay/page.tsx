"use client";

import { useState } from "react";
import { RequireWallet } from "@/components/connect-button";
import { LoanList } from "@/components/loan-list";
import type { Address } from "@solana/kit";
import { Button, Card, Field, GhostButton, Notice, PageTitle, Stat, TxStatus } from "@/components/ui";
import { useApp, useBalances, useLoans, useNow, usePool } from "@/lib/hooks";
import {
  cosignerClaim,
  fetchLoanById,
  fundClaim,
  owedAfterSettlement,
  repayIx,
  restituteIx,
  settleIx,
  type Loan,
  type Pool,
} from "@/lib/program";
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
        sub="You pay back exactly what you borrowed. No interest. No fees. Anyone can chip in toward a loan, including friends and family. After the deadline the loan is settled first; paying back what is owed then restores your standing."
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

const bar = (seconds: bigint) => (seconds === 9223372036854775807n ? "for good" : `for ${Number(seconds / 86_400n)} days`);

function PayForm({ wallet, pool, loan, onPaid }: { wallet: Address; pool: Pool; loan: Loan; onPaid: () => void }) {
  const { rpc, signer } = useApp();
  const balances = useBalances(wallet);
  const now = useNow();
  const [amt, setAmt] = useState("");
  const { run, busy, error, result, reset } = useRun();
  const timing = loanTiming(loan, now);
  // Three ways to pay: a repayment while the loan is open and on time; "settle and pay back" once the deadline has
  // passed (the same settlement the cranker would do, plus the restitution, in one transaction); a restitution on a
  // loan somebody already settled.
  const mode: "repay" | "settle" | "restitute" | "closed" =
    loan.status === "Active" ? (timing.state === "defaultable" ? "settle" : "repay") : loan.status === "Defaulted" ? "restitute" : "closed";
  const owed = mode === "restitute" ? owedAfterSettlement(loan) : loan.principal - loan.repaid;
  const amount = parseAmount(amt, TOKEN_DECIMALS);
  const enough = !amount || !balances.data || balances.data.usdc >= amount;
  const amountError =
    amt && (!amount || amount <= 0n)
      ? "Enter an amount greater than zero."
      : amount && amount > owed
        ? `That's more than what's owed (${formatUsdc(owed)}).`
        : !enough
          ? "Your wallet doesn't have enough for that."
          : null;
  const ok = mode !== "closed" && !!amount && amount > 0n && amount <= owed && enough && !!signer;
  const toFund = mode === "restitute" ? fundClaim(loan) : owed > loan.escrowed ? owed - loan.escrowed : 0n;
  const toCosignerClaim = mode === "restitute" ? cosignerClaim(loan) : owed - toFund;

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
      {mode === "closed" ? (
        <Notice tone="info">
          This loan is {loan.status === "Restituted" ? "settled and paid back in full" : "repaid in full"}. Nothing more can be paid on it.
        </Notice>
      ) : (
        <>
          {timing.state === "overdue" && (
            <Notice tone="warn">{timing.label} Repay before then to protect the co-signer&apos;s escrow.</Notice>
          )}
          {mode === "settle" && (
            <Notice tone="error">
              The grace period has passed, so a repayment is no longer accepted. Paying now settles the loan and pays back what is owed in
              one step: the escrow covers {formatUsdc(owed < loan.escrowed ? owed : loan.escrowed)} and is reimbursed to the co-signer from
              your payment{toFund > 0n ? `, after the fund's ${formatUsdc(toFund)} shortfall` : ""}. The outcome is the same whoever settles
              first. You are barred {bar(loan.defaultBanSeconds)} by the settlement; once everything is paid back, by you or anyone for you,
              that{" "}
              {loan.lateBanSeconds > 0n ? `shortens to ${Number(loan.lateBanSeconds / 86_400n)} days from the day it is paid` : "lifts"}.
            </Notice>
          )}
          {mode === "restitute" && (
            <Notice tone="warn">
              This loan was settled on {new Date(Number(loan.closedAt) * 1000).toLocaleDateString()}. {formatUsdc(owed)} is still owed:{" "}
              {toFund > 0n ? `${formatUsdc(toFund)} to the fund first` : ""}
              {toFund > 0n && toCosignerClaim > 0n ? ", then " : ""}
              {toCosignerClaim > 0n ? `${formatUsdc(toCosignerClaim)} back to the co-signer whose escrow was used` : ""}. The
              co-signer&apos;s bar lifts as soon as the fund is whole. Once everything is paid back, whoever pays, the borrower&apos;s bar{" "}
              {loan.lateBanSeconds > 0n ? `shortens to ${Number(loan.lateBanSeconds / 86_400n)} days from that day` : "is lifted"}
              {loan.fundForgivenAt > 0n ? " (not here: the fund forgave its claim, which is not the same as being paid back)" : ""}.
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
                const ixs =
                  mode === "repay"
                    ? [await repayIx({ payer: wallet, pool, loan, amount: amount! })]
                    : mode === "settle"
                      ? [await settleIx({ caller: wallet, pool, loan }), await restituteIx({ payer: wallet, pool, loan, amount: amount! })]
                      : [await restituteIx({ payer: wallet, pool, loan, amount: amount! })];
                const sig = await sendInstructions(rpc, signer!, ixs);
                setAmt("");
                balances.mutate();
                onPaid();
                return sig;
              })
            }
          >
            {busy ? "Paying..." : mode === "settle" ? "Settle and pay back" : mode === "restitute" ? "Pay back" : "Pay"}
          </Button>
          <TxStatus error={error} sig={result} label={amount && amount === owed ? "Paid in full." : "Payment made."} />
        </>
      )}
    </div>
  );
}
