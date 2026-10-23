/** Browser (and e2e) side of the identity routes. */
import {
  createSignableMessage,
  getBase64Decoder,
  isMessageModifyingSigner,
  isMessagePartialSigner,
  type Address,
  type TransactionSigner,
} from "@solana/kit";
import type { StatusView, PreparedTx } from "./identity/service";
import { proofMessage } from "./identity/wallet-proof";

export type { StatusView, PreparedTx };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Identity service returned HTTP ${res.status}.`);
  return body;
}

export const fetchIdentityStatus = (wallet: Address) => call<StatusView>(`/api/identity/status?wallet=${wallet}`);
export const prepareJoin = (wallet: Address) =>
  call<PreparedTx>("/api/identity/join", { method: "POST", body: JSON.stringify({ wallet }) });
export const prepareRebind = (wallet: Address) =>
  call<PreparedTx>("/api/identity/rebind", { method: "POST", body: JSON.stringify({ wallet }) });

type MessageCapable = { signMessage?: (message: Uint8Array) => Promise<Uint8Array> };

/** Signs `text` with the wallet: through the kit signer when it can sign messages, else through the wallet client. */
export async function signText(signer: TransactionSigner, walletClient: MessageCapable | undefined, text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  if (isMessagePartialSigner(signer)) {
    const [sigs] = await signer.signMessages([createSignableMessage(bytes)]);
    const sig = sigs?.[signer.address];
    if (sig) return new Uint8Array(sig);
  } else if (isMessageModifyingSigner(signer)) {
    const [m] = await signer.modifyAndSignMessages([createSignableMessage(bytes)]);
    const sig = m?.signatures[signer.address];
    if (sig) return new Uint8Array(sig);
  }
  if (walletClient?.signMessage) return new Uint8Array(await walletClient.signMessage(bytes));
  throw new Error("This wallet can't sign a message. Try Phantom or Solflare.");
}

/** Starts the identity check: the wallet signs a dated message proving control, the server opens the inquiry. */
export async function startIdentityCheck(
  signer: TransactionSigner,
  walletClient: MessageCapable | undefined,
): Promise<{ inquiryId: string; url: string }> {
  const message = proofMessage(signer.address, Math.floor(Date.now() / 1000));
  const signature = getBase64Decoder().decode(await signText(signer, walletClient, message));
  return call("/api/identity/start", { method: "POST", body: JSON.stringify({ wallet: signer.address, message, signature }) });
}
