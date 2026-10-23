"use client";

import { useEffect, useId, useRef, useState } from "react";
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
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);

  // Close the wallet menu on Escape or a click outside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (wallet) {
    return (
      <div className="flex items-center gap-2">
        <span className="rounded-lg bg-stone-100 px-2 py-1 font-mono text-sm" aria-label={`Connected wallet ${wallet}`}>
          {shortAddress(wallet)}
        </span>
        <GhostButton onClick={() => disconnect()}>Disconnect</GhostButton>
      </div>
    );
  }
  return (
    <div className="relative" ref={wrap}>
      <Button
        onClick={() => setOpen((o) => !o)}
        disabled={isRunning}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        {isRunning ? "Connecting..." : "Connect wallet"}
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Choose a wallet"
          className="absolute right-0 z-10 mt-2 w-64 rounded-xl border border-stone-200 bg-white p-2 shadow-lg"
        >
          {wallets.length === 0 && <p className="p-2 text-sm text-stone-600">No wallet found. Install Phantom or Solflare, then reload.</p>}
          {wallets.map((w) => (
            <button
              key={w.name}
              role="menuitem"
              className="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-stone-100 focus:bg-stone-100 focus:outline-none"
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
