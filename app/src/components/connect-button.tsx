"use client";

import { useState } from "react";
import { useConnect, useDisconnect, useWallets, WalletReadyGate } from "@solana/kit-plugin-wallet/react";
import { useApp, useMounted } from "@/lib/hooks";
import { shortAddress } from "@/lib/format";
import { Button, GhostButton } from "./ui";

function Inner() {
  const { client, wallet } = useApp();
  const wallets = useWallets(client);
  const { dispatch: connect, isRunning } = useConnect(client);
  const { dispatch: disconnect } = useDisconnect(client);
  const [open, setOpen] = useState(false);

  if (wallet) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-stone-100 px-2 py-1 font-mono text-sm">{shortAddress(wallet)}</span>
        <GhostButton onClick={() => disconnect()}>Disconnect</GhostButton>
      </div>
    );
  }
  return (
    <div className="relative">
      <Button onClick={() => setOpen((o) => !o)} disabled={isRunning}>
        {isRunning ? "Connecting..." : "Connect wallet"}
      </Button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 w-64 rounded-xl border border-stone-200 bg-white p-2 shadow-lg">
          {wallets.length === 0 && (
            <p className="p-2 text-sm text-stone-600">
              No wallet found. Install Phantom or Solflare, then reload.
            </p>
          )}
          {wallets.map((w) => (
            <button
              key={w.name}
              className="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-stone-100"
              onClick={() => {
                connect(w);
                setOpen(false);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={w.icon} alt="" width={24} height={24} />
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConnectButton() {
  const { client } = useApp();
  const mounted = useMounted();
  const fallback = <span className="text-sm text-stone-500">Loading wallets...</span>;
  // Wallet readiness is client-only state (it may already be "ready" at hydration), so render the gate after mount.
  if (!mounted) return fallback;
  return (
    <WalletReadyGate client={client} fallback={fallback}>
      <Inner />
    </WalletReadyGate>
  );
}

/** Shows children only when a wallet is connected. */
export function RequireWallet({ children }: { children: (wallet: NonNullable<ReturnType<typeof useApp>["wallet"]>) => React.ReactNode }) {
  const { wallet } = useApp();
  if (!wallet) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-stone-600">
        Connect your wallet to continue.
      </div>
    );
  }
  return <>{children(wallet)}</>;
}
