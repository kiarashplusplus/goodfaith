/**
 * A JSON-RPC-shaped adapter over LiteSVM so the app's real code paths (tx.ts, program.ts, hooks' fetchers)
 * run unchanged in tests. Only the methods those modules call are implemented.
 */
import {
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  signature as toSignature,
  type Address,
  type GetAccountInfoApi,
  type GetProgramAccountsApi,
  type ReadonlyUint8Array,
  type Rpc,
} from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { fromBase64, type TxRpc } from "../tx";

export type SvmRpc = TxRpc & Rpc<GetAccountInfoApi & GetProgramAccountsApi>;

type Filter = { dataSize?: bigint; memcmp?: { offset: bigint; bytes: string; encoding?: string } };

const b64 = getBase64Decoder();
const b58 = getBase58Decoder();

/** JSON-RPC error shape for a failed transaction, e.g. {"InstructionError":[1,{"Custom":6011}]}. */
export function rpcError(failed: FailedTransactionMetadata): unknown {
  const e = failed.err() as { index?: number; err?: () => unknown; toString(): string };
  if (typeof e.index === "number" && typeof e.err === "function") {
    const inner = e.err() as { code?: number; toString(): string };
    const detail = typeof inner === "object" && inner !== null && typeof inner.code === "number" ? { Custom: inner.code } : String(inner);
    return { InstructionError: [e.index, detail] };
  }
  return String(e);
}

function encode(acc: { data: ReadonlyUint8Array; executable: boolean; lamports: bigint; programAddress: Address }) {
  return {
    data: [b64.decode(acc.data), "base64"] as const,
    executable: acc.executable,
    lamports: acc.lamports,
    owner: acc.programAddress,
    rentEpoch: 0n,
    space: BigInt(acc.data.length),
  };
}

function matches(data: ReadonlyUint8Array, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.dataSize !== undefined && BigInt(data.length) !== f.dataSize) return false;
    if (f.memcmp) {
      const want = getBase58Encoder().encode(f.memcmp.bytes);
      const off = Number(f.memcmp.offset);
      if (off + want.length > data.length) return false;
      for (let i = 0; i < want.length; i++) if (data[off + i] !== want[i]) return false;
    }
  }
  return true;
}

const call = <T>(fn: () => T) => ({ send: async () => fn() });

export function svmRpc(svm: LiteSVM): SvmRpc {
  const rpc = {
    getAccountInfo: (address: Address) =>
      call(() => {
        const acc = svm.getAccount(address);
        return { context: { slot: 0n }, value: acc.exists ? encode(acc) : null };
      }),
    getLatestBlockhash: () =>
      call(() => {
        // Fresh blockhash per transaction, so identical instructions are not rejected as already processed.
        svm.expireBlockhash();
        return { context: { slot: 0n }, value: { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 0n } };
      }),
    getProgramAccounts: (program: Address, cfg?: { filters?: Filter[] }) =>
      call(() =>
        svm
          .getProgramAccounts(program)
          .filter((acc) => matches(acc.data, cfg?.filters ?? []))
          .map((acc) => ({ pubkey: acc.address, account: encode(acc) })),
      ),
    simulateTransaction: (wire: string) =>
      call(() => {
        const tx = fromBase64(wire);
        svm.withSigverify(false);
        try {
          const res = svm.simulateTransaction(tx);
          if (res instanceof FailedTransactionMetadata) {
            return { context: { slot: 0n }, value: { err: rpcError(res), logs: res.meta().logs(), unitsConsumed: 0n } };
          }
          return { context: { slot: 0n }, value: { err: null, logs: res.meta().logs(), unitsConsumed: res.meta().computeUnitsConsumed() } };
        } finally {
          svm.withSigverify(true);
        }
      }),
    sendTransaction: (wire: string) =>
      call(() => {
        const res = svm.sendTransaction(fromBase64(wire));
        if (res instanceof FailedTransactionMetadata) {
          // Same wording a real RPC uses when preflight fails.
          const err = rpcError(res) as { InstructionError?: [number, { Custom?: number } | string] };
          const ie = err.InstructionError;
          const custom = ie && typeof ie[1] === "object" ? ie[1].Custom : undefined;
          const detail = custom !== undefined ? `custom program error: 0x${custom.toString(16)}` : JSON.stringify(err);
          throw new Error(`Transaction simulation failed: Error processing Instruction ${ie?.[0] ?? 0}: ${detail}`);
        }
        return b58.decode(res.signature());
      }),
    getSignatureStatuses: (sigs: string[]) =>
      call(() => ({
        context: { slot: 0n },
        value: sigs.map((s) => {
          const tx = svm.getTransaction(toSignature(s));
          if (!tx) return null;
          return {
            slot: 0n,
            confirmations: null,
            confirmationStatus: "confirmed" as const,
            err: tx instanceof FailedTransactionMetadata ? rpcError(tx) : null,
          };
        }),
      })),
  };
  return rpc as unknown as SvmRpc;
}
