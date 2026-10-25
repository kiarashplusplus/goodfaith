"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AuthState, ClientState, KeyFormat, useTurnkey } from "@turnkey/react-wallet-kit";
import { useApp, useMounted } from "@/lib/hooks";
import { shortAddress } from "@/lib/format";
import { copyLabel, useCopy } from "@/lib/clipboard";
import { Button } from "./ui";

const signIn = (handleLogin: ReturnType<typeof useTurnkey>["handleLogin"]) => handleLogin({ title: "Sign in to Good Faith" });

/** The account menu: the member's address, copy it, export the wallet key (for the no-website CLI), sign out. */
function AccountMenu({ wallet }: { wallet: string }) {
  const { logout, handleExportWalletAccount } = useTurnkey();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { state, copy } = useCopy();
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);

  // Close the menu on Escape or a click outside it.
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

  const item = "block w-full rounded-lg p-2 text-left hover:bg-stone-100 focus:bg-stone-100 focus:outline-none";
  return (
    <div className="relative" ref={wrap}>
      <button
        className="rounded-lg bg-stone-100 px-2 py-1 font-mono text-sm hover:bg-stone-200"
        aria-label={`Your wallet ${wallet}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {shortAddress(wallet)}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Your account"
          className="absolute right-0 z-10 mt-2 w-72 rounded-xl border border-stone-200 bg-white p-2 text-sm shadow-lg"
        >
          <p className="break-all p-2 font-mono text-xs text-stone-600">{wallet}</p>
          <button role="menuitem" className={item} onClick={() => copy(wallet)}>
            {copyLabel(state, "Copy my address")}
          </button>
          <button
            role="menuitem"
            className={item}
            onClick={async () => {
              setError(null);
              try {
                await handleExportWalletAccount({ address: wallet, keyFormat: KeyFormat.Solana });
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Export my wallet key
            <span className="block text-xs text-stone-500">Only for the command-line tool. Anyone with this key controls your wallet.</span>
          </button>
          <button
            role="menuitem"
            className={item}
            onClick={() => {
              setOpen(false);
              void logout();
            }}
          >
            Sign out
          </button>
          {error && (
            <p role="alert" className="p-2 text-xs text-red-700">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function ConnectButton() {
  const mounted = useMounted();
  const { clientState, authState, handleLogin } = useTurnkey();
  const { wallet } = useApp();
  // Turnkey restores the session in the browser, so the button renders after mount.
  if (!mounted || clientState === undefined || clientState === ClientState.Loading)
    return <span className="text-sm text-stone-500">Loading...</span>;
  if (clientState === ClientState.Error) return <span className="text-sm text-red-700">Sign-in is unavailable right now.</span>;
  if (authState !== AuthState.Authenticated) return <Button onClick={() => signIn(handleLogin)}>Sign in</Button>;
  if (!wallet) return <span className="text-sm text-stone-500">Setting up your wallet...</span>;
  return <AccountMenu wallet={wallet} />;
}

/** Shows children only when the member is signed in and their wallet is ready. */
export function RequireWallet({ children }: { children: (wallet: NonNullable<ReturnType<typeof useApp>["wallet"]>) => React.ReactNode }) {
  const { wallet, signedIn } = useApp();
  const { handleLogin, clientState } = useTurnkey();
  if (signedIn && !wallet)
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-stone-600">Setting up your wallet...</div>
    );
  if (!wallet) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-stone-600">
        <p>Sign in with a passkey or your email to continue.</p>
        <p className="mt-1 text-sm">A wallet is made for you: no app to install, no recovery phrase, no SOL needed.</p>
        <Button className="mt-4" disabled={clientState !== ClientState.Ready} onClick={() => signIn(handleLogin)}>
          Sign in
        </Button>
      </div>
    );
  }
  return <>{children(wallet)}</>;
}
