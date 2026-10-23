"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { address, type Address, type TransactionSigner } from "@solana/kit";
import { useClient } from "@solana/react";
import { useConnectedWallet } from "@solana/kit-plugin-wallet/react";
import type { AppClient } from "@/app/providers";
import { POOL_MINT } from "./config";
import { fetchLoan, fetchLoansFor, fetchMember, fetchCanonicalPool, findAta, fetchRequest, fetchRequestsForCosigner } from "./program";
import type { TxRpc } from "./tx";

const noopSubscribe = () => () => {};
/** False during SSR and the hydration render, true afterwards. Safe against hydration mismatches. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function useApp() {
  const client = useClient<AppClient>();
  const mounted = useMounted();
  // The wallet client is a module singleton whose state can already differ from the server render
  // when React hydrates, so wallet state is hidden until after mount.
  const liveConnected = useConnectedWallet(client);
  const connected = mounted ? liveConnected : null;
  const signer = (connected?.signer ?? null) as TransactionSigner | null;
  const wallet: Address | null = connected ? address(connected.account.address) : null;
  return { client, rpc: client.rpc as unknown as TxRpc & AppClient["rpc"], connected, signer, wallet };
}

const POLL = { refreshInterval: 10_000, revalidateOnFocus: true };

export function usePool() {
  const { rpc } = useApp();
  return useSWR(["pool", POOL_MINT], () => fetchCanonicalPool(rpc), POLL);
}

export function useVaultBalance(vault: Address | undefined) {
  const { rpc } = useApp();
  return useSWR(
    vault ? ["vault", vault] : null,
    async () => {
      const r = await rpc.getTokenAccountBalance(vault!, { commitment: "confirmed" }).send();
      return BigInt(r.value.amount);
    },
    POLL,
  );
}

export function useMember(wallet: Address | null) {
  const pool = usePool();
  const { rpc } = useApp();
  return useSWR(
    wallet && pool.data ? ["member", wallet, pool.data.address] : null,
    () => fetchMember(rpc, pool.data!.address, wallet!),
    POLL,
  );
}

export function useBalances(wallet: Address | null) {
  const { rpc } = useApp();
  return useSWR(
    wallet ? ["balances", wallet] : null,
    async () => {
      const sol = (await rpc.getBalance(wallet!, { commitment: "confirmed" }).send()).value;
      let usdc = 0n;
      try {
        const ata = await findAta(wallet!, POOL_MINT);
        usdc = BigInt((await rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send()).value.amount);
      } catch {
        // no token account yet: balance is zero
      }
      return { sol: BigInt(sol), usdc };
    },
    POLL,
  );
}

export function useLoans(wallet: Address | null) {
  const pool = usePool();
  const { rpc } = useApp();
  return useSWR(
    wallet && pool.data ? ["loans", wallet, pool.data.loanCount.toString()] : null,
    () => fetchLoansFor(rpc, pool.data!, wallet!),
    POLL,
  );
}

export function useLoan(loan: Address | null) {
  const { rpc } = useApp();
  return useSWR(loan ? ["loan", loan] : null, () => fetchLoan(rpc, loan!), POLL);
}

export function useRequest(borrower: Address | null) {
  const pool = usePool();
  const { rpc } = useApp();
  return useSWR(
    borrower && pool.data ? ["request", pool.data.address, borrower] : null,
    () => fetchRequest(rpc, pool.data!.address, borrower!),
    POLL,
  );
}

export function usePendingForCosigner(wallet: Address | null) {
  const pool = usePool();
  const { rpc } = useApp();
  return useSWR(
    wallet && pool.data ? ["pending", pool.data.address, wallet] : null,
    () => fetchRequestsForCosigner(rpc, pool.data!.address, wallet!),
    POLL,
  );
}

/** Current unix time in seconds, refreshed every `everyMs`. Starts at 0 on the server render. */
export function useNow(everyMs = 30_000): bigint {
  const [now, setNow] = useState(0n);
  useEffect(() => {
    const tick = () => setNow(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
