"use client";

import { useState } from "react";
import useSWR from "swr";
import { QRCodeSVG } from "qrcode.react";
import { address, type Address } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { createNoopSigner } from "@solana/kit";
import { RequireWallet } from "@/components/connect-button";
import { Button, Card, Field, GhostButton, PageTitle, Stat, TxStatus } from "@/components/ui";
import { useApp, useBalances } from "@/lib/hooks";
import { explorerAddress, explorerTx, POOL_MINT, TOKEN_DECIMALS, TOKEN_SYMBOL } from "@/lib/config";
import { formatAmount, formatSol, formatUsdc, parseAmount, shortAddress } from "@/lib/format";
import { findAta } from "@/lib/program";
import { sendInstructions } from "@/lib/tx";
import { solanaPayUrl } from "@/lib/solana-pay";
import { useRun } from "@/lib/use-run";

export default function CheckingPage() {
  return (
    <>
      <PageTitle title="Checking" sub="Your money stays in your own wallet. Good Faith never holds it." />
      <RequireWallet>{(w) => <Account wallet={w} />}</RequireWallet>
    </>
  );
}

function Account({ wallet }: { wallet: Address }) {
  const { data, mutate } = useBalances(wallet);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <Stat label={TOKEN_SYMBOL} value={data ? formatUsdc(data.usdc) : "..."} />
        <Stat label="SOL" value={data ? formatSol(data.sol) : "..."} sub="Only needed if fees aren't covered" />
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Send wallet={wallet} onDone={() => mutate()} />
        <Receive wallet={wallet} />
      </div>
      <History wallet={wallet} />
    </div>
  );
}

function Send({ wallet, onDone }: { wallet: Address; onDone: () => void }) {
  const { rpc, signer } = useApp();
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const { run, busy, error, result } = useRun();

  let dest: Address | null = null;
  try {
    dest = to ? address(to.trim()) : null;
  } catch {
    dest = null;
  }
  const amount = parseAmount(amt, TOKEN_DECIMALS);
  const ok = !!dest && !!amount && amount > 0n && !!signer;

  return (
    <Card title={`Send ${TOKEN_SYMBOL}`}>
      <div className="space-y-3">
        <Field label="To (wallet address)" value={to} onChange={(e) => setTo(e.target.value)} placeholder="Wallet address" />
        {to && !dest && <p className="text-xs text-red-700">That doesn&apos;t look like a wallet address.</p>}
        <Field label="Amount" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00" />
        <Button
          disabled={!ok || busy}
          onClick={() =>
            run(async () => {
              const mint = POOL_MINT;
              const source = await findAta(wallet, mint);
              const destination = await findAta(dest!, mint);
              const sig = await sendInstructions(rpc, signer!, async (feePayer) => [
                getCreateAssociatedTokenIdempotentInstruction({
                  payer: createNoopSigner(feePayer),
                  ata: destination,
                  owner: dest!,
                  mint,
                }),
                getTransferCheckedInstruction({
                  source,
                  mint,
                  destination,
                  authority: createNoopSigner(wallet),
                  amount: amount!,
                  decimals: TOKEN_DECIMALS,
                }),
              ]);
              onDone();
              return sig;
            })
          }
        >
          {busy ? "Sending..." : "Send"}
        </Button>
        <TxStatus error={error} sig={result} />
      </div>
    </Card>
  );
}

function Receive({ wallet }: { wallet: Address }) {
  const [amt, setAmt] = useState("");
  const [copied, setCopied] = useState(false);
  const parsed = parseAmount(amt, TOKEN_DECIMALS);
  const url = solanaPayUrl({
    recipient: wallet,
    splToken: POOL_MINT,
    amount: parsed && parsed > 0n ? formatAmount(parsed, TOKEN_DECIMALS, { minFraction: 0 }) : undefined,
    label: "Good Faith",
  });
  return (
    <Card title={`Receive ${TOKEN_SYMBOL}`}>
      <div className="flex flex-col items-center gap-3">
        <div className="rounded-xl border border-stone-200 bg-white p-3">
          <QRCodeSVG value={url} size={176} />
        </div>
        <p className="break-all text-center font-mono text-xs text-stone-600">{wallet}</p>
        <GhostButton
          onClick={async () => {
            await navigator.clipboard.writeText(wallet);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy address"}
        </GhostButton>
        <div className="w-full">
          <Field label="Request a specific amount (optional)" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
        </div>
      </div>
    </Card>
  );
}

type Row = { sig: string; time: number | null; delta: bigint; failed: boolean };

function History({ wallet }: { wallet: Address }) {
  const { rpc } = useApp();
  const { data, isLoading } = useSWR(["history", wallet], async (): Promise<Row[]> => {
    const ata = await findAta(wallet, POOL_MINT);
    const sigs = await rpc.getSignaturesForAddress(ata, { limit: 10, commitment: "confirmed" }).send();
    return Promise.all(
      sigs.map(async (s) => {
        let delta = 0n;
        try {
          const tx = await rpc
            .getTransaction(s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" })
            .send();
          const sum = (arr?: readonly { mint: string; owner?: string; uiTokenAmount: { amount: string } }[]) =>
            (arr ?? []).filter((b) => b.mint === POOL_MINT && b.owner === wallet).reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
          delta = sum(tx?.meta?.postTokenBalances as never) - sum(tx?.meta?.preTokenBalances as never);
        } catch {
          // leave delta at zero if the transaction can't be read
        }
        return { sig: s.signature, time: s.blockTime ? Number(s.blockTime) : null, delta, failed: !!s.err };
      }),
    );
  }, { refreshInterval: 20_000 });

  return (
    <Card title="Recent activity">
      {isLoading && <p className="text-sm text-stone-500">Loading...</p>}
      {data && data.length === 0 && <p className="text-sm text-stone-600">No activity yet.</p>}
      <ul className="divide-y divide-stone-100">
        {data?.map((r) => (
          <li key={r.sig} className="flex items-center justify-between py-2 text-sm">
            <a className="text-stone-700 underline" href={explorerTx(r.sig)} target="_blank" rel="noreferrer">
              {r.time ? new Date(r.time * 1000).toLocaleString() : shortAddress(r.sig)}
            </a>
            <span className={r.failed ? "text-red-700" : r.delta >= 0n ? "text-emerald-700" : "text-stone-800"}>
              {r.failed ? "Failed" : `${r.delta >= 0n ? "+" : ""}${formatUsdc(r.delta)}`}
            </span>
          </li>
        ))}
      </ul>
      <a className="mt-2 inline-block text-xs text-stone-500 underline" href={explorerAddress(wallet)} target="_blank" rel="noreferrer">
        Full history
      </a>
    </Card>
  );
}
