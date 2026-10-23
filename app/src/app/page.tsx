"use client";

import { useState } from "react";
import useSWR from "swr";
import { QRCodeSVG } from "qrcode.react";
import { address, type Address } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { createNoopSigner } from "@solana/kit";
import { RequireWallet } from "@/components/connect-button";
import { Button, Card, Field, GhostButton, Notice, PageTitle, Stat, TxStatus } from "@/components/ui";
import { useApp, useBalances } from "@/lib/hooks";
import { explorerAddress, explorerTx, POOL_MINT, TOKEN_DECIMALS, TOKEN_SYMBOL } from "@/lib/config";
import { formatAmount, formatSol, formatUsdc, parseAmount, shortAddress } from "@/lib/format";
import { findAta } from "@/lib/program";
import { sendInstructions } from "@/lib/tx";
import { solanaPayUrl } from "@/lib/solana-pay";
import { copyLabel, useCopy } from "@/lib/clipboard";
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
        <Send wallet={wallet} balance={data?.usdc} onDone={() => mutate()} />
        <Receive wallet={wallet} />
      </div>
      <History wallet={wallet} />
    </div>
  );
}

function Send({ wallet, balance, onDone }: { wallet: Address; balance: bigint | undefined; onDone: () => void }) {
  const { rpc, signer } = useApp();
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const { run, busy, error, result, reset } = useRun();

  let dest: Address | null = null;
  try {
    dest = to ? address(to.trim()) : null;
  } catch {
    dest = null;
  }
  const amount = parseAmount(amt, TOKEN_DECIMALS);
  const toError = to && !dest ? "That doesn't look like a wallet address." : dest === wallet ? "That's your own address." : null;
  const amountError =
    amt && (!amount || amount <= 0n)
      ? "Enter an amount greater than zero."
      : amount && balance !== undefined && amount > balance
        ? `You have ${formatUsdc(balance)}.`
        : null;
  const ok = !!dest && !toError && !!amount && amount > 0n && !amountError && !!signer;

  return (
    <Card title={`Send ${TOKEN_SYMBOL}`}>
      <div className="space-y-3">
        <Field
          label="To (wallet address)"
          value={to}
          onChange={(e) => {
            if (error || result) reset();
            setTo(e.target.value);
          }}
          placeholder="Wallet address"
          error={toError}
        />
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
              setAmt("");
              onDone();
              return sig;
            })
          }
        >
          {busy ? "Sending..." : "Send"}
        </Button>
        <TxStatus error={error} sig={result} label="Sent." />
      </div>
    </Card>
  );
}

function Receive({ wallet }: { wallet: Address }) {
  const [amt, setAmt] = useState("");
  const copy = useCopy();
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
          <QRCodeSVG value={url} size={176} title="QR code for your wallet address" />
        </div>
        <p className="break-all text-center font-mono text-xs text-stone-600">{wallet}</p>
        <GhostButton onClick={() => copy.copy(wallet)}>{copyLabel(copy.state, "Copy address")}</GhostButton>
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
  const { data, isLoading, error } = useSWR(
    ["history", wallet],
    async (): Promise<Row[]> => {
      const ata = await findAta(wallet, POOL_MINT);
      const sigs = await rpc.getSignaturesForAddress(ata, { limit: 10, commitment: "confirmed" }).send();
      return Promise.all(
        sigs.map(async (s) => {
          let delta = 0n;
          try {
            const tx = await rpc
              .getTransaction(s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" })
              .send();
            const sum = (arr?: readonly { mint: string; owner?: string; uiTokenAmount: { amount: string } }[]) =>
              (arr ?? [])
                .filter((b) => b.mint === POOL_MINT && b.owner === wallet)
                .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
            delta = sum(tx?.meta?.postTokenBalances as never) - sum(tx?.meta?.preTokenBalances as never);
          } catch {
            // leave delta at zero if the transaction can't be read
          }
          return { sig: s.signature, time: s.blockTime ? Number(s.blockTime) : null, delta, failed: !!s.err };
        }),
      );
    },
    { refreshInterval: 20_000 },
  );

  return (
    <Card title="Recent activity">
      {isLoading && <p className="text-sm text-stone-500">Loading...</p>}
      {error && <Notice tone="warn">Couldn&apos;t load recent activity. Use the explorer link below.</Notice>}
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
