"use client";

import { Card, Notice, PageTitle, Stat } from "@/components/ui";
import { usePool, useVaultBalance } from "@/lib/hooks";
import { formatUsdc } from "@/lib/format";
import { explorerAddress } from "@/lib/config";

export default function FundPage() {
  const pool = usePool();
  const vault = useVaultBalance(pool.data?.vault);
  const p = pool.data;
  const outstanding = p ? p.totalLent - p.totalRepaid - p.totalRecovered - p.totalLost : 0n;

  return (
    <>
      <PageTitle title="The fund" sub="Everything here is public on the blockchain." />
      {pool.isLoading && <p className="text-stone-600">Loading...</p>}
      {pool.error && <Notice tone="error">{pool.error instanceof Error ? pool.error.message : "The fund couldn't be loaded."}</Notice>}
      {!pool.isLoading && !pool.error && !p && <Notice tone="warn">The fund isn&apos;t set up on this network yet.</Notice>}
      {p && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat label="Available to lend" value={vault.data !== undefined ? formatUsdc(vault.data) : "..."} />
            <Stat label="Out on loan" value={formatUsdc(outstanding < 0n ? 0n : outstanding)} />
            <Stat label="Loans made" value={p.loanCount.toString()} />
            <Stat label="Donated" value={formatUsdc(p.totalDonated)} sub="Gifts, never withdrawn" />
            <Stat label="Lent in total" value={formatUsdc(p.totalLent)} />
            <Stat label="Paid back" value={formatUsdc(p.totalRepaid)} />
            <Stat label="Recovered from escrow" value={formatUsdc(p.totalRecovered)} />
            <Stat label="Not repaid" value={formatUsdc(p.totalLost)} />
          </div>
          <Card title="Rules">
            <ul className="list-disc space-y-1 pl-5 text-sm text-stone-700">
              <li>
                Up to {formatUsdc(p.maxLoan)} per loan, up to {p.maxTermDays} days, plus {p.graceDays} days of grace.
              </li>
              <li>Borrowers pay back exactly what they borrow. No interest. No fees.</li>
              <li>A co-signer escrows {(p.cosignerEscrowBps / 100).toString()}% of the loan and gets it back when it&apos;s repaid.</li>
              <li>
                A member can back up to {p.maxGuaranteesPerMember} {p.maxGuaranteesPerMember === 1 ? "loan" : "loans"} at a time as a
                co-signer.
              </li>
              <li>
                {p.authority === null
                  ? "These rules are frozen. Nobody can change them."
                  : "These rules can still be changed by the fund's administrator. Changes never affect loans that are already open."}
              </li>
            </ul>
            <a className="mt-3 inline-block text-xs text-stone-500 underline" href={explorerAddress(p.address)} target="_blank" rel="noreferrer">
              View fund account
            </a>
          </Card>
        </div>
      )}
    </>
  );
}
