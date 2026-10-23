import {
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  type Rpc,
  type Transaction,
  type TransactionSigner,
  type GetLatestBlockhashApi,
  type SendTransactionApi,
  type SimulateTransactionApi,
  type GetSignatureStatusesApi,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  isTransactionSendingSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature,
} from "@solana/kit";
import { kora, getKoraPayer } from "./kora";

export type TxRpc = Rpc<
  GetLatestBlockhashApi &
    SendTransactionApi &
    SimulateTransactionApi &
    GetSignatureStatusesApi
>;

/** Who pays network fees: Kora when configured and reachable, otherwise the user. */
export async function resolveFeePayer(user: Address): Promise<{ feePayer: Address; sponsored: boolean }> {
  const k = await getKoraPayer();
  return k ? { feePayer: k, sponsored: true } : { feePayer: user, sponsored: false };
}

// Version 0 on purpose: the sponsor and multi-party flows must work with every wallet today.
export async function buildTransaction(rpc: TxRpc, feePayer: Address, instructions: Instruction[]) {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return compileTransaction(msg);
}

export const toBase64 = (tx: Transaction): Base64EncodedWireTransaction => getBase64EncodedWireTransaction(tx);

export function fromBase64(b64: string): Transaction {
  const bytes = getBase64Encoder().encode(b64);
  return getTransactionDecoder().decode(bytes);
}

/** Dry-run without signatures; throws with program logs on failure. */
export async function simulate(rpc: TxRpc, tx: Transaction): Promise<void> {
  const res = await rpc
    .simulateTransaction(toBase64(tx), {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    })
    .send();
  if (res.value.err) {
    const err = JSON.stringify(res.value.err, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
    const logs = (res.value.logs ?? []).slice(-4).join(" | ");
    throw new Error(`Simulation failed: ${err} ${logs}`);
  }
}

/** Ask the wallet to sign. Returns the transaction with the wallet's signature added. */
export async function signWith(signer: TransactionSigner, tx: Transaction): Promise<Transaction> {
  if (isTransactionModifyingSigner(signer)) {
    const [signed] = await signer.modifyAndSignTransactions([tx as never]);
    return signed as Transaction;
  }
  if (isTransactionPartialSigner(signer)) {
    const [sigs] = await signer.signTransactions([tx as never]);
    return { ...tx, signatures: { ...tx.signatures, ...sigs } };
  }
  throw new Error("This wallet can't sign here. Try Phantom or Solflare.");
}

async function confirm(rpc: TxRpc, sig: string, timeoutMs = 60_000): Promise<void> {
  const s = toSignature(sig);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { value } = await rpc.getSignatureStatuses([s]).send();
    const st = value[0];
    if (st?.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("Timed out waiting for confirmation. Check the explorer before retrying.");
}

/** Submit a fully user-signed tx: through Kora (which adds the fee-payer signature) or straight to RPC. */
export async function submit(rpc: TxRpc, tx: Transaction, sponsored: boolean): Promise<string> {
  const b64 = toBase64(tx);
  let sig: string;
  if (sponsored && kora) {
    const r = await kora.signAndSendTransaction({ transaction: b64 });
    sig = r.signature;
  } else {
    sig = await rpc
      .sendTransaction(b64, { encoding: "base64", preflightCommitment: "confirmed" })
      .send();
  }
  await confirm(rpc, sig);
  return sig;
}

/**
 * One-wallet flow: build, simulate, sign, send, confirm.
 * Fees go to Kora when available; otherwise the wallet pays.
 */
export async function sendInstructions(
  rpc: TxRpc,
  wallet: TransactionSigner,
  instructions: Instruction[] | ((feePayer: Address) => Promise<Instruction[]>),
): Promise<string> {
  const { feePayer, sponsored } = await resolveFeePayer(wallet.address);
  const ixs = typeof instructions === "function" ? await instructions(feePayer) : instructions;
  const tx = await buildTransaction(rpc, feePayer, ixs);
  await simulate(rpc, tx);
  if (!sponsored && !isTransactionModifyingSigner(wallet) && !isTransactionPartialSigner(wallet) && isTransactionSendingSigner(wallet)) {
    const [sigBytes] = await wallet.signAndSendTransactions([tx as never]);
    const sig = getBase58Decoder().decode(sigBytes as Uint8Array);
    await confirm(rpc, sig);
    return sig;
  }
  const signed = await signWith(wallet, tx);
  return submit(rpc, signed, sponsored);
}
