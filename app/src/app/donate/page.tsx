"use client";

import { useState } from "react";
import { RequireWallet } from "@/components/connect-button";
import { Button, Card, Field, Notice, PageTitle, TxStatus } from "@/components/ui";
import { useApp, useBalances, usePool } from "@/lib/hooks";
import { donateIx } from "@/lib/program";
import { sendInstructions } from "@/lib/tx";
import { formatUsdc, parseAmount } from "@/lib/format";
import { TOKEN_DECIMALS, TOKEN_SYMBOL } from "@/lib/config";
import { useRun } from "@/lib/use-run";
import type { Address } from "@solana/kit";

export default function DonatePage() {
  return (
    <>
      <PageTitle title="Donate" sub="Your gift helps fund loans for people in Texas who need a hand." />
      <RequireWallet>{(w) => <DonateForm wallet={w} />}</RequireWallet>
    </>
  );
}

function DonateForm({ wallet }: { wallet: Address }) {
  const { rpc, signer } = useApp();
  const pool = usePool();
  const balances = useBalances(wallet);
  const [amt, setAmt] = useState("");
  const [agree, setAgree] = useState(false);
  const { run, busy, error, result } = useRun();
  const amount = parseAmount(amt, TOKEN_DECIMALS);
  const enough = !amount || !balances.data || balances.data.usdc >= amount;

  return (
    <Card>
      <div className="space-y-4">
        <Notice tone="warn">
          <strong>Donations are gifts.</strong> Once you donate, the money belongs to the fund. It can&apos;t be withdrawn or refunded, by
          you or by us. It&apos;s only used to make loans.
        </Notice>
        <Field label={`Amount (${TOKEN_SYMBOL})`} inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" />
        {balances.data && <p className="text-xs text-stone-500">You have {formatUsdc(balances.data.usdc)}.</p>}
        {!enough && <p className="text-xs text-red-700">Your wallet doesn&apos;t have enough for that.</p>}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I understand this is a gift and I can&apos;t get it back.</span>
        </label>
        <Button
          disabled={!agree || !amount || amount <= 0n || !enough || !pool.data || !signer || busy}
          onClick={() =>
            run(async () => sendInstructions(rpc, signer!, async () => [await donateIx({ donor: wallet, pool: pool.data!, amount: amount! })]))
          }
        >
          {busy ? "Donating..." : "Donate"}
        </Button>
        <TxStatus error={error} sig={result} />
      </div>
    </Card>
  );
}
