"use client";

import { useState } from "react";
import { createNoopSigner, type Address } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { Button, GhostButton, Notice, TxStatus } from "./ui";
import { useApp, useNow } from "@/lib/hooks";
import { claimEscrowIx, cosignerWalletOf, markDefaultIx, type Loan, type Pool } from "@/lib/program";
import { loanTiming } from "@/lib/loan-status";
import { CHIP } from "./status-chip";
import { formatUsdc } from "@/lib/format";
import { sendInstructions } from "@/lib/tx";
import { useRun } from "@/lib/use-run";

const date = (unixSec: bigint) => new Date(Number(unixSec) * 1000).toLocaleDateString();

function sortLoans(loans: Loan[]): Loan[] {
  return [...loans].sort((a, b) => {
    const aa = a.status === "Active" ? 0 : 1;
    const bb = b.status === "Active" ? 0 : 1;
    if (aa !== bb) return aa - bb;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/** Every loan a wallet borrowed or co-signed, active first, with where each one stands in time. */
export function LoanList({
  wallet,
  pool,
  loans,
  onPay,
  onChanged,
}: {
  wallet: Address;
  pool: Pool;
  loans: Loan[];
  onPay: (loan: Loan) => void;
  onChanged: () => void;
}) {
  const now = useNow();
  return (
    <ul className="divide-y divide-stone-100">
      {sortLoans(loans).map((l) => (
        <LoanRow key={l.address} wallet={wallet} pool={pool} loan={l} now={now} onPay={onPay} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function LoanRow({
  wallet,
  pool,
  loan,
  now,
  onPay,
  onChanged,
}: {
  wallet: Address;
  pool: Pool;
  loan: Loan;
  now: bigint;
  onPay: (loan: Loan) => void;
  onChanged: () => void;
}) {
  const { rpc, signer } = useApp();
  const { run, busy, error, result } = useRun();
  const [confirming, setConfirming] = useState(false);
  const t = loanTiming(loan, now);
  const chip = CHIP[t.state];
  const role = loan.borrower === wallet ? "you borrowed" : "you co-signed";
  const owed = loan.principal - loan.repaid;

  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">Loan #{loan.id.toString()}</span> · {role} {formatUsdc(loan.principal)}
          {loan.status === "Active" && <>, {formatUsdc(owed)} left</>}
          <div className="text-xs text-stone-500">
            Opened {date(loan.openedAt)} · Due {date(loan.dueAt)}
            {t.label && ` · ${t.label}`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${chip.className}`}>{chip.text}</span>
          {loan.status === "Active" && <GhostButton onClick={() => onPay(loan)}>Pay</GhostButton>}
          {loan.status !== "Active" && loan.refundPending > 0n && !result && (
            <GhostButton
              disabled={busy || !signer}
              onClick={() =>
                run(async () => {
                  // The deposit waits in escrow until someone claims it for the co-signer's current wallet.
                  const sig = await sendInstructions(rpc, signer!, async (feePayer) => {
                    const cosignerWallet = await cosignerWalletOf(rpc, loan);
                    const { ix, cosignerToken } = await claimEscrowIx({ claimer: wallet, pool, loan, cosignerWallet });
                    return [
                      getCreateAssociatedTokenIdempotentInstruction({
                        payer: createNoopSigner(feePayer),
                        ata: cosignerToken,
                        owner: cosignerWallet,
                        mint: pool.mint,
                      }),
                      ix,
                    ];
                  });
                  onChanged();
                  return sig;
                })
              }
            >
              {busy ? "Working..." : `Release ${formatUsdc(loan.refundPending)} escrow`}
            </GhostButton>
          )}
          {t.state === "defaultable" && !result && (
            <GhostButton onClick={() => setConfirming((c) => !c)} aria-expanded={confirming}>
              Mark as defaulted
            </GhostButton>
          )}
        </div>
      </div>
      {confirming && !result && (
        <div className="mt-3">
          <Notice tone="warn">
            <strong>This is final.</strong> The co-signer&apos;s escrow ({formatUsdc(loan.escrowed)}) goes to the fund to cover what is
            still owed ({formatUsdc(owed)}). Anything left over waits for the co-signer to collect. The borrower is barred for the
            fund&apos;s default period; the co-signer only if the escrow did not cover everything owed. Anyone can do this once the grace
            period has passed.
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={busy || !signer}
                onClick={() =>
                  run(async () => {
                    const sig = await sendInstructions(rpc, signer!, [await markDefaultIx({ caller: wallet, pool, loan })]);
                    onChanged();
                    return sig;
                  })
                }
              >
                {busy ? "Working..." : "Confirm default"}
              </Button>
              <GhostButton disabled={busy} onClick={() => setConfirming(false)}>
                Keep waiting
              </GhostButton>
            </div>
          </Notice>
        </div>
      )}
      <div className="mt-2">
        <TxStatus error={error} sig={result} label="Done." />
      </div>
    </li>
  );
}
