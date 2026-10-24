"use client";

import { useState } from "react";
import { createNoopSigner, type Address } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { Button, GhostButton, Notice, TxStatus } from "./ui";
import { useApp, useNow } from "@/lib/hooks";
import {
  claimEscrowIx,
  collectRecoveryIx,
  cosignerWalletOf,
  waiveReimbursementIx,
  fundClaim,
  cosignerClaim,
  owedAfterSettlement,
  owedToCosigner,
  settleIx,
  type Loan,
  type Pool,
} from "@/lib/program";
import { loanTiming } from "@/lib/loan-status";
import { CHIP } from "./status-chip";
import { formatUsdc } from "@/lib/format";
import { sendInstructions } from "@/lib/tx";
import { useRun } from "@/lib/use-run";

const date = (unixSec: bigint) => new Date(Number(unixSec) * 1000).toLocaleDateString();
/** "90 days" or "for good". */
const bar = (seconds: bigint) =>
  seconds === 9223372036854775807n ? "for good" : seconds === 0n ? "not at all" : `for ${Number(seconds / 86_400n)} days`;

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
  const [confirming, setConfirming] = useState<false | "settle" | "waive">(false);
  const t = loanTiming(loan, now);
  const iAmCosigner = loan.cosigner === wallet;
  const chip = CHIP[t.state];
  const role = loan.borrower === wallet ? "you borrowed" : "you co-signed";
  const owed = loan.principal - loan.repaid;
  const settled = loan.status === "Defaulted" || loan.status === "Restituted";
  const toCosigner = owedToCosigner(loan);
  const stillOwed = loan.status === "Defaulted" ? owedAfterSettlement(loan) : 0n;

  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">Loan #{loan.id.toString()}</span> · {role} {formatUsdc(loan.principal)}
          {loan.status === "Active" && <>, {formatUsdc(owed)} left</>}
          {loan.status === "Defaulted" && <>, {formatUsdc(stillOwed)} still owed</>}
          <div className="text-xs text-stone-500">
            Opened {date(loan.openedAt)} · Due {date(loan.dueAt)}
            {t.label && ` · ${t.label}`}
          </div>
          {settled && (
            <div className="text-xs text-stone-500">
              {loan.recovered > 0n && <>Escrow covered {formatUsdc(loan.recovered)}. </>}
              {fundClaim(loan) > 0n && <>The fund is owed {formatUsdc(fundClaim(loan))}. </>}
              {cosignerClaim(loan) > 0n && <>The co-signer is owed {formatUsdc(cosignerClaim(loan))} back. </>}
              {loan.recoveryPending > 0n && <>{formatUsdc(loan.recoveryPending)} waits in escrow for the fund. </>}
              {toCosigner > 0n && <>{formatUsdc(toCosigner)} waits for the co-signer. </>}
              {loan.cosignerWaivedAt > 0n && <>The co-signer waived their claim on {date(loan.cosignerWaivedAt)}. </>}
              {loan.fundForgivenAt > 0n && <>The fund forgave its claim on {date(loan.fundForgivenAt)}. </>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${chip.className}`}>{chip.text}</span>
          {(loan.status === "Active" || loan.status === "Defaulted") && (
            <GhostButton onClick={() => onPay(loan)}>{loan.status === "Defaulted" ? "Pay back" : "Pay"}</GhostButton>
          )}
          {loan.status !== "Active" && toCosigner > 0n && !result && (
            <GhostButton
              disabled={busy || !signer}
              onClick={() =>
                run(async () => {
                  // What is owed waits in escrow (and, after a restitution, in the vault) until someone claims it
                  // for the co-signer's current wallet.
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
              {busy ? "Working..." : `Release ${formatUsdc(toCosigner)} to the co-signer`}
            </GhostButton>
          )}
          {settled && loan.recoveryPending > 0n && !result && (
            <GhostButton
              disabled={busy || !signer}
              onClick={() =>
                run(async () => {
                  const sig = await sendInstructions(rpc, signer!, [await collectRecoveryIx({ collector: wallet, pool, loan })]);
                  onChanged();
                  return sig;
                })
              }
            >
              {busy ? "Working..." : `Move ${formatUsdc(loan.recoveryPending)} to the fund`}
            </GhostButton>
          )}
          {t.state === "defaultable" && !result && (
            <GhostButton onClick={() => setConfirming((c) => (c ? false : "settle"))} aria-expanded={confirming === "settle"}>
              Settle
            </GhostButton>
          )}
          {loan.status === "Defaulted" && iAmCosigner && cosignerClaim(loan) > 0n && !result && (
            <GhostButton onClick={() => setConfirming((c) => (c ? false : "waive"))} aria-expanded={confirming === "waive"}>
              Waive my claim
            </GhostButton>
          )}
        </div>
      </div>
      {confirming === "waive" && !result && (
        <div className="mt-3">
          <Notice tone="warn">
            <strong>Waiving gives up the {formatUsdc(cosignerClaim(loan))} the borrower would still pay back to you.</strong> It is your
            claim only: the fund&apos;s claim{fundClaim(loan) > 0n ? ` of ${formatUsdc(fundClaim(loan))}` : ""} stays owed, your bar (if
            any) still lifts only when the fund is paid back or at its end date, and you cannot undo the waiver.
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={busy || !signer}
                onClick={() =>
                  run(async () => {
                    const sig = await sendInstructions(rpc, signer!, [waiveReimbursementIx({ cosigner: wallet, pool, loan })]);
                    onChanged();
                    return sig;
                  })
                }
              >
                {busy ? "Working..." : "Waive my claim"}
              </Button>
              <GhostButton disabled={busy} onClick={() => setConfirming(false)}>
                Keep it owed
              </GhostButton>
            </div>
          </Notice>
        </div>
      )}
      {confirming === "settle" && !result && (
        <div className="mt-3">
          <Notice tone="warn">
            <strong>Settling records the outcome; it moves no money by itself.</strong> Of the co-signer&apos;s escrow (
            {formatUsdc(loan.escrowed)}), {formatUsdc(owed < loan.escrowed ? owed : loan.escrowed)} is set aside for the fund to cover what
            is owed ({formatUsdc(owed)}); the rest waits for the co-signer. The borrower is barred {bar(loan.defaultBanSeconds)}
            {owed > loan.escrowed ? `, the co-signer ${bar(loan.cosignerBanSeconds)} because the escrow does not cover everything` : ""}.
            Anyone can do this once the grace period has passed. Paying back what is owed afterwards reimburses the co-signer and lifts
            their bar once the fund is whole; the borrower&apos;s own pay-back{" "}
            {loan.lateBanSeconds > 0n
              ? `shortens their bar to ${Number(loan.lateBanSeconds / 86_400n)} days from that day`
              : "lifts their bar"}
            .
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={busy || !signer}
                onClick={() =>
                  run(async () => {
                    const sig = await sendInstructions(rpc, signer!, [await settleIx({ caller: wallet, pool, loan })]);
                    onChanged();
                    return sig;
                  })
                }
              >
                {busy ? "Working..." : "Confirm settlement"}
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
