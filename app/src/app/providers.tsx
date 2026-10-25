"use client";

import React, { useEffect, useRef } from "react";
import { createClient } from "@solana/kit";
import { solanaRpcConnection } from "@solana/kit-plugin-rpc";
import { ClientProvider } from "@solana/react";
import { AuthState, TurnkeyProvider, useTurnkey, type CustomWallet, type TurnkeyProviderConfig } from "@turnkey/react-wallet-kit";
import "@turnkey/react-wallet-kit/styles.css";
import { RPC_URL, TURNKEY } from "@/lib/config";
import { solanaAccountOf } from "@/lib/turnkey-signer";

// One RPC client for the whole app. The member's wallet is a Turnkey sign-in wallet (lib/hooks.ts `useApp`);
// transactions are built by src/lib/tx.ts.
export const client = createClient().use(solanaRpcConnection({ rpcUrl: RPC_URL }));

export type AppClient = Awaited<typeof client>;

// The member's Solana account, made when they sign up (Turnkey's default Solana path).
const SOLANA_WALLET = {
  walletName: "Good Faith",
  walletAccounts: [
    { curve: "CURVE_ED25519", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/501'/0'/0'", addressFormat: "ADDRESS_FORMAT_SOLANA" },
  ],
} satisfies CustomWallet;

// Sign-in is a code sent to the member's email, the only method enabled in the Turnkey dashboard (no passkeys, wallet
// apps or social logins), so every member has an email. Sign-up creates the member's Solana account straight away.
const turnkeyConfig: TurnkeyProviderConfig = {
  organizationId: TURNKEY.organizationId,
  authProxyConfigId: TURNKEY.authProxyConfigId,
  auth: {
    autoRefreshSession: true,
    createSuborgParams: {
      emailOtpAuth: { customWallet: SOLANA_WALLET },
    },
  },
  ui: {
    authModal: {
      methods: {
        passkeyAuthEnabled: false,
        emailOtpAuthEnabled: true,
        smsOtpAuthEnabled: false,
        walletAuthEnabled: false,
        googleOauthEnabled: false,
        appleOauthEnabled: false,
        xOauthEnabled: false,
        discordOauthEnabled: false,
        facebookOauthEnabled: false,
      },
      methodOrder: ["email"],
    },
    borderRadius: 12,
    colors: { light: { primary: "#065f46" }, dark: { primary: "#6ee7b7" } },
  },
};

/** A member signed in without a Solana account (e.g. one made before sign-up created it) gets one, once. */
function WalletSetup() {
  const { authState, wallets, createWallet, refreshWallets } = useTurnkey();
  const started = useRef(false);
  const missing = authState === AuthState.Authenticated && !solanaAccountOf(wallets);
  useEffect(() => {
    if (!missing || started.current) return;
    started.current = true;
    // Wallets load just after sign-in: look again before creating one.
    void refreshWallets()
      .then((ws) =>
        solanaAccountOf(ws)
          ? ws
          : createWallet({ walletName: SOLANA_WALLET.walletName, accounts: SOLANA_WALLET.walletAccounts }).then(() => refreshWallets()),
      )
      .catch(() => (started.current = false));
  }, [missing, createWallet, refreshWallets]);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TurnkeyProvider config={turnkeyConfig}>
      <WalletSetup />
      <ClientProvider client={client}>{children}</ClientProvider>
    </TurnkeyProvider>
  );
}
