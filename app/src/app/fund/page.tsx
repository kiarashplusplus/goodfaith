"use client";

import { Card, Notice, PageTitle, Stat } from "@/components/ui";
import { windingDown } from "@/lib/program";
import { useNow, usePool, useRecentLoans, useVaultBalance } from "@/lib/hooks";
import { loanTiming } from "@/lib/loan-status";
import { StatusChip } from "@/components/status-chip";
import { formatUsdc } from "@/lib/format";
import { explorerAddress } from "@/lib/config";

const ZERO = "11111111111111111111111111111111";
/** "7 days", "36 hours" or "20 minutes". */
function days(seconds: bigint): string {
  const s = Number(seconds);
  if (s >= 86_400 && s % 86_400 === 0) return `${s / 86_400} day${s === 86_400 ? "" : "s"}`;
  if (s >= 3_600) return `${Math.round(s / 3_600)} hours`;
  return `${Math.max(1, Math.round(s / 60))} minutes`;
}
/** A unix time relative to now, in words, with the date for reference. */
function when(ts: bigint, now: bigint): string {
  const date = new Date(Number(ts) * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  if (now === 0n) return `on ${date}`;
  const diff = Number(ts - now);
  if (diff <= 0) return `on ${date}`;
  return `in ${days(BigInt(diff))} (${date})`;
}

export default function FundPage() {
  const pool = usePool();
  const vault = useVaultBalance(pool.data?.vault);
  const recent = useRecentLoans(pool.data);
  const now = useNow();
  const p = pool.data;

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
            <Stat
              label="Out on loan"
              value={formatUsdc(p.outstandingPrincipal)}
              sub={p.maxOutstandingPrincipal > 0n ? `Limit ${formatUsdc(p.maxOutstandingPrincipal)}` : undefined}
            />
            <Stat label="Loans made" value={p.loanCount.toString()} />
            <Stat label="Donated" value={formatUsdc(p.totalDonated)} sub="Gifts, never withdrawn" />
            <Stat label="Lent in total" value={formatUsdc(p.totalLent)} />
            <Stat label="Paid back" value={formatUsdc(p.totalRepaid)} />
            <Stat label="Recovered from escrow" value={formatUsdc(p.totalRecovered)} />
            <Stat label="Not repaid" value={formatUsdc(p.totalLost)} sub="Lost on settled loans, not yet paid back" />
            <Stat label="Paid back after settlement" value={formatUsdc(p.totalRestituted)} />
            <Stat label="Owed to co-signers" value={formatUsdc(p.pendingClaims + p.vaultClaims)} sub="Waiting to be collected" />
          </div>
          <Card title="Rules">
            <ul className="list-disc space-y-1 pl-5 text-sm text-stone-700">
              <li>
                Up to {formatUsdc(p.maxLoan)} per loan, up to {p.maxTermDays} days, plus {p.graceDays} days of grace.
              </li>
              <li>Borrowers pay back exactly what they borrow. No interest. No fees.</li>
              <li>
                Repayment is open until {p.graceDays} days after the due date. After that the loan is settled: the escrow covers what is
                owed, the borrower is barred for {days(p.defaultBanSeconds)}, and paying everything back later shortens that to{" "}
                {p.lateBanSeconds > 0n ? days(p.lateBanSeconds) : "nothing"}.
              </li>
              {(p.seasoningSeconds > 0n || p.capStepIntervalSeconds > 0n) && (
                <li>
                  A repaid loan raises your limit by {formatUsdc(p.loanCapStep)} only if it ran at least {days(p.seasoningSeconds)}, and at
                  most once every {days(p.capStepIntervalSeconds)}.
                </li>
              )}
              <li>A co-signer escrows {(p.cosignerEscrowBps / 100).toString()}% of the loan and gets it back when it&apos;s repaid.</li>
              <li>
                A member can back up to {p.maxGuaranteesPerMember} {p.maxGuaranteesPerMember === 1 ? "loan" : "loans"} at a time as a
                co-signer.
              </li>
              <li>
                {p.authority === null
                  ? "These rules are frozen. Nobody can change them."
                  : p.timelockSeconds > 0n
                    ? `The administrator can change these rules only with ${days(p.timelockSeconds)} of public notice. Changes never affect loans that are already open.`
                    : "These rules can be changed by the fund's administrator without a notice period. Changes never affect loans that are already open."}
              </li>
              {p.pendingParams && (
                <li>
                  A rule change is announced and takes effect {when(p.paramsEffectiveAt, now)}: loans up to{" "}
                  {formatUsdc(p.pendingParams.maxLoan)}, {p.pendingParams.maxTermDays} days, {p.pendingParams.graceDays} days of grace,{" "}
                  {(p.pendingParams.cosignerEscrowBps / 100).toString()}% escrow, {p.pendingParams.maxGuaranteesPerMember} guarantees per
                  co-signer, {days(p.pendingParams.timelockSeconds)} of notice
                  {p.pendingParams.issuer !== p.issuer && ", and a new identity issuer"}.
                </li>
              )}
              {p.issuer === ZERO && <li>New memberships are paused: the identity issuer is suspended until a new one is announced.</li>}
              {p.windDownAt !== null && (
                <li className="font-medium">
                  {windingDown(p, now)
                    ? `The fund is winding down since ${when(p.windDownAt, now)}: no new loans or donations. Open loans run their course; once none is open, the balance moves to its successor.`
                    : `The fund will wind down ${when(p.windDownAt, now)}: after that, no new loans or donations. The administrator can still withdraw the announcement.`}
                  {p.totalSwept > 0n && ` ${formatUsdc(p.totalSwept)} has been moved to the successor.`}
                </li>
              )}
              {p.pendingAuthority && (
                <li>
                  A handover of the administrator role to <span className="font-mono">{p.pendingAuthority}</span> is pending until that key
                  accepts it.
                </li>
              )}
            </ul>
            <a
              className="mt-3 inline-block text-xs text-stone-500 underline"
              href={explorerAddress(p.address)}
              target="_blank"
              rel="noreferrer"
            >
              View fund account
            </a>
          </Card>
          <Card title="Recent loans">
            {recent.isLoading && <p className="text-sm text-stone-500">Loading...</p>}
            {recent.error && <Notice tone="warn">Couldn&apos;t load the loan list right now.</Notice>}
            {recent.data?.length === 0 && <p className="text-sm text-stone-600">No loans yet.</p>}
            {recent.data && recent.data.length > 0 && (
              <ul className="divide-y divide-stone-100 text-sm">
                {recent.data.map((l) => (
                  <li key={l.address} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <a className="font-medium underline" href={explorerAddress(l.address)} target="_blank" rel="noreferrer">
                        Loan #{l.id.toString()}
                      </a>{" "}
                      · {formatUsdc(l.principal)}
                      {l.status === "Active" && <>, {formatUsdc(l.principal - l.repaid)} left</>}
                      <span className="block text-xs text-stone-500">
                        Due {new Date(Number(l.dueAt) * 1000).toLocaleDateString()}
                        {loanTiming(l, now).label && ` · ${loanTiming(l, now).label}`}
                      </span>
                    </span>
                    <StatusChip state={loanTiming(l, now).state} />
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-stone-500">Wallet addresses are not shown here; every loan is public on the explorer.</p>
          </Card>
        </div>
      )}
    </>
  );
}
