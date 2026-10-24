"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "@solana/kit";
import { Button, Card, GhostButton, Notice } from "@/components/ui";
import { useApp, useBalances } from "@/lib/hooks";
import { CLUSTER, explorerTx, POOL_MINT, TOKEN_DECIMALS, TOKEN_SYMBOL } from "@/lib/config";
import {
  checkCashOut,
  planCashOut,
  RAMPS_ORIGIN,
  RAMPS_SDK_PATH,
  type CreateRamps,
  type OnChainTransaction,
  type RampsInstance,
  type RampsSession,
} from "@/lib/moneygram";
import { sendInstructions } from "@/lib/tx";

let sdk: Promise<CreateRamps> | null = null;

/** A cash-out carries MoneyGram's reference, which the fee sponsor won't pay for: the wallet pays a fee of about 0.000005 SOL. */
const CASH_OUT_FEE_SOL = 100_000n;

/** Loads MoneyGram's widget SDK from the widget origin once. */
function loadSdk(): Promise<CreateRamps> {
  if (window.RampsSDK) return Promise.resolve(window.RampsSDK.createRamps);
  sdk ??= new Promise<CreateRamps>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `${RAMPS_ORIGIN}${RAMPS_SDK_PATH}`;
    s.async = true;
    s.onload = () => (window.RampsSDK ? resolve(window.RampsSDK.createRamps) : reject(new Error("MoneyGram's widget didn't load.")));
    s.onerror = () => {
      sdk = null;
      reject(new Error("Couldn't reach MoneyGram. Try again in a minute."));
    };
    document.head.appendChild(s);
  });
  return sdk;
}

type Outcome = { tone: "ok" | "warn"; text: string; sig?: string };

/** Cash out to, or cash in from, a MoneyGram counter. Shown only when the widget origin is configured. */
export function CashCard({ wallet, onDone }: { wallet: Address; onDone: () => void }) {
  const { rpc, signer } = useApp();
  const balances = useBalances(wallet);
  const noSol = balances.data !== undefined && balances.data.sol < CASH_OUT_FEE_SOL;
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<RampsInstance | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const lastSig = useRef<string | undefined>(undefined);

  const close = useCallback(() => {
    widget.current?.destroy();
    widget.current = null;
    setOpen(false);
  }, []);
  useEffect(() => () => widget.current?.destroy(), []);

  if (!RAMPS_ORIGIN) return null;

  async function sendCashOut(tx: OnChainTransaction): Promise<string> {
    const check = checkCashOut(tx, { wallet, mint: POOL_MINT, decimals: TOKEN_DECIMALS, cluster: CLUSTER });
    if (!check.ok) throw new Error(check.reason);
    // The fee sponsor refuses memos, so a transfer carrying MoneyGram's reference is paid by the wallet.
    const plan = await planCashOut(rpc, wallet, POOL_MINT, TOKEN_DECIMALS, check.cashOut);
    const sig = await sendInstructions(rpc, signer!, plan.instructions, { sponsor: plan.sponsor });
    lastSig.current = sig;
    onDone();
    return sig;
  }

  async function start(mode: "off-ramp" | "on-ramp") {
    if (!container.current || (mode === "off-ramp" && !signer)) return;
    setBusy(true);
    setOutcome(null);
    lastSig.current = undefined;
    try {
      const createRamps = await loadSdk();
      const res = await fetch("/api/moneygram/session", { method: "POST" });
      const session = (await res.json()) as RampsSession & { error?: string };
      if (!res.ok) throw new Error(session.error ?? `MoneyGram session failed (HTTP ${res.status}).`);
      const url = new URL(session.widgetUrl);
      url.searchParams.set("mode", mode);
      widget.current = createRamps({
        container: container.current,
        sessionToken: session.sessionToken,
        widgetUrl: url.toString(),
        theme: "light",
        wallet: { address: wallet, chain: "solana", asset: "USDC", walletType: "non-custodial", displayName: "Good Faith" },
        // Good Faith serves Texas only: start the widget there.
        transaction: { type: mode, asset: "USDC", destinationCountry: "US", destinationCurrency: "USD", destinationSubdivision: "TX" },
        // Cash-in never asks the app to sign: MoneyGram sends USDC to the wallet after the counter takes the cash.
        onSignTransaction: mode === "off-ramp" ? sendCashOut : undefined,
        onComplete: (record) => {
          const code = record.referenceNumber ? ` Reference number: ${record.referenceNumber}.` : "";
          setOutcome({
            tone: "ok",
            text:
              mode === "off-ramp"
                ? `Cash-out started. Take the reference number and a photo ID to a MoneyGram location.${code}`
                : `Cash-in started. Take the reference number and the cash to a MoneyGram location.${code}`,
            sig: lastSig.current,
          });
          onDone();
        },
        onError: (e) => setOutcome({ tone: "warn", text: e.reason, sig: lastSig.current }),
        onClose: close,
      });
      widget.current.open();
      setOpen(true);
    } catch (e) {
      setOutcome({ tone: "warn", text: e instanceof Error ? e.message : "Couldn't open MoneyGram." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Cash at MoneyGram">
      <div className="space-y-3">
        <p className="text-sm text-stone-600">
          Turn {TOKEN_SYMBOL} into cash, or cash into {TOKEN_SYMBOL}, at a MoneyGram counter. MoneyGram checks your ID and shows its fee and
          rate before you commit; Good Faith adds nothing.
        </p>
        <div className="flex gap-2">
          <Button disabled={busy || !signer} onClick={() => start("off-ramp")}>
            {busy ? "Opening..." : "Cash out"}
          </Button>
          <GhostButton disabled={busy} onClick={() => start("on-ramp")}>
            Cash in
          </GhostButton>
        </div>
        {noSol && (
          <Notice tone="info">
            A cash-out pays its own network fee (well under 0.001 SOL), because it carries MoneyGram&apos;s reference. This wallet has no
            SOL yet; cash-in works without it.
          </Notice>
        )}
        {outcome && (
          <Notice tone={outcome.tone}>
            {outcome.text}
            {outcome.sig && (
              <>
                {" "}
                <a className="underline" href={explorerTx(outcome.sig)} target="_blank" rel="noreferrer">
                  Transfer
                </a>
              </>
            )}
          </Notice>
        )}
      </div>
      <div className={open ? "fixed inset-0 z-50 flex flex-col bg-white" : "hidden"}>
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <span className="text-sm font-semibold">MoneyGram</span>
          <GhostButton onClick={close}>Close</GhostButton>
        </div>
        <div ref={container} className="flex-1" />
      </div>
    </Card>
  );
}
