"use client";

import { Card, Notice } from "./ui";
import { useMember, usePool } from "@/lib/hooks";
import type { Address } from "@solana/kit";

/**
 * Membership status for the Borrow page. Joining now needs the fund's identity issuer to co-sign
 * (one verified person, one wallet), which the identity service provides; until it is connected,
 * this shows where the wallet stands.
 */
export function VerifyAndJoin({ wallet }: { wallet: Address }) {
  const pool = usePool();
  const member = useMember(wallet);

  if (!pool.data) {
    return <Notice tone="info">{pool.isLoading ? "Loading the fund..." : "The fund isn't set up yet."}</Notice>;
  }
  return (
    <Card title="Membership">
      {member.data ? (
        member.data.retired ? (
          <Notice tone="warn">This wallet was replaced. Use the wallet now linked to your membership.</Notice>
        ) : (
          <Notice tone="ok">You&apos;re a member.{member.data.ineligible && " Your membership is currently on hold."}</Notice>
        )
      ) : member.isLoading ? (
        <p className="text-sm text-stone-600">Checking your membership...</p>
      ) : (
        <Notice tone="info">
          This wallet isn&apos;t a member yet. Joining takes a one-time identity check with Good Faith&apos;s verification service, which is
          being connected. Check back soon.
        </Notice>
      )}
    </Card>
  );
}
