"use client";

/**
 * Civic Pass (official @civic/solana-gateway-react). The package speaks web3.js v1 types,
 * so they stay inside this file; everything else in the app uses @solana/kit.
 * Load with next/dynamic({ ssr: false }).
 */
import { useMemo, type ReactNode } from "react";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { GatewayProvider, GatewayStatus, useGateway } from "@civic/solana-gateway-react";
import { getTransactionDecoder, getTransactionEncoder, address, type Address } from "@solana/kit";
import { CLUSTER, RPC_URL } from "@/lib/config";
import { useApp } from "@/lib/hooks";
import { signWith } from "@/lib/tx";

export type CivicState = {
  active: boolean;
  statusLabel: string;
  /** address of the wallet's Civic gateway token account, when a pass exists */
  gatewayToken: Address | null;
  request: () => Promise<void>;
};

const LABELS: Partial<Record<GatewayStatus, string>> = {
  [GatewayStatus.CHECKING]: "Checking for your Civic Pass...",
  [GatewayStatus.NOT_REQUESTED]: "You don't have a Civic Pass yet.",
  [GatewayStatus.COLLECTING_USER_INFORMATION]: "Verification in progress.",
  [GatewayStatus.IN_REVIEW]: "Your verification is being reviewed.",
  [GatewayStatus.REJECTED]: "Verification wasn't approved.",
  [GatewayStatus.REVOKED]: "Your Civic Pass was revoked.",
  [GatewayStatus.FROZEN]: "Your Civic Pass is on hold.",
  [GatewayStatus.ACTIVE]: "Verified.",
  [GatewayStatus.ERROR]: "Something went wrong checking your pass.",
  [GatewayStatus.LOCATION_NOT_SUPPORTED]: "Good Faith is for Texas residents only.",
  [GatewayStatus.VPN_NOT_SUPPORTED]: "Please turn off your VPN and try again.",
  [GatewayStatus.REFRESH_TOKEN_REQUIRED]: "Your pass needs to be renewed.",
};

function Bridge({ children }: { children: (s: CivicState) => ReactNode }) {
  const { gatewayStatus, gatewayToken, requestGatewayToken } = useGateway();
  const state: CivicState = {
    active: gatewayStatus === GatewayStatus.ACTIVE,
    statusLabel: LABELS[gatewayStatus] ?? "Waiting for your wallet...",
    gatewayToken: gatewayToken?.publicKey ? address(gatewayToken.publicKey.toBase58()) : null,
    request: async () => {
      await requestGatewayToken?.();
    },
  };
  return <>{children(state)}</>;
}

export default function CivicGate({
  network,
  children,
}: {
  network: string;
  children: (s: CivicState) => ReactNode;
}) {
  const { signer, wallet } = useApp();
  const connection = useMemo(() => new Connection(RPC_URL, "processed"), []);
  const adapter = useMemo(
    () => ({
      publicKey: wallet ? new PublicKey(wallet) : null,
      connected: !!wallet && !!signer,
      signTransaction: async (tx: Transaction) => {
        if (!signer) throw new Error("Connect your wallet first.");
        const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const kitTx = getTransactionDecoder().decode(bytes);
        const signed = await signWith(signer, kitTx);
        return Transaction.from(getTransactionEncoder().encode(signed) as Uint8Array);
      },
    }),
    [wallet, signer],
  );
  const net = useMemo(() => new PublicKey(network), [network]);

  return (
    <GatewayProvider connection={connection} cluster={CLUSTER} wallet={adapter} gatekeeperNetwork={net}>
      <Bridge>{children}</Bridge>
    </GatewayProvider>
  );
}
