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
import { proofMessage, type ProofPurpose } from "./identity/wallet-proof";

export type { StatusView, PreparedTx };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Identity service returned HTTP ${res.status}.`);
  return body;
}

/** Anyone's view of a wallet: no check reason and no check link (`detailsHidden` says when there are some). */
export const fetchIdentityStatus = (wallet: Address) => call<StatusView>(`/api/identity/status?wallet=${wallet}`);
export const prepareJoin = (wallet: Address) =>
  call<PreparedTx>("/api/identity/join", { method: "POST", body: JSON.stringify({ wallet }) });

type MessageCapable = { signMessage?: (message: Uint8Array) => Promise<Uint8Array> };

/** The dated proof of control every wallet-acting route wants, signed now. */
async function proof(signer: TransactionSigner, walletClient: MessageCapable | undefined, purpose: ProofPurpose = "identity") {
  const message = proofMessage(signer.address, Math.floor(Date.now() / 1000), purpose);
  const signature = getBase64Decoder().decode(await signText(signer, walletClient, message));
  return { wallet: signer.address, message, signature };
}

/** The wallet's own view, with the check's reason and its link: the wallet signs a dated "status" message. */
export async function fetchIdentityDetails(signer: TransactionSigner, walletClient: MessageCapable | undefined): Promise<StatusView> {
  return call<StatusView>("/api/identity/status", { method: "POST", body: JSON.stringify(await proof(signer, walletClient, "status")) });
}

/**
 * Asks to move the membership to this wallet (recorded for the operator), or finalises a proposal whose delay has
 * passed. The wallet signs a dated message: nobody can open a recovery request in someone else's name.
 */
export async function prepareRebind(signer: TransactionSigner, walletClient: MessageCapable | undefined): Promise<PreparedTx> {
  return call<PreparedTx>("/api/identity/rebind", { method: "POST", body: JSON.stringify(await proof(signer, walletClient)) });
}
/** Withdraws this wallet's recovery request while the operator has not proposed it yet. */
export async function cancelRebind(signer: TransactionSigner, walletClient: MessageCapable | undefined): Promise<{ cancelled: boolean }> {
  return call("/api/identity/rebind", { method: "DELETE", body: JSON.stringify(await proof(signer, walletClient)) });
}
/** Renews the member's pass for another term. */
export async function renewPass(signer: TransactionSigner, walletClient: MessageCapable | undefined): Promise<{ expiresAt: number }> {
  return call("/api/identity/renew", { method: "POST", body: JSON.stringify(await proof(signer, walletClient)) });
}
/** Changes where notices about the membership go (an email: it can be changed, not removed). */
export async function setContact(
  signer: TransactionSigner,
  walletClient: MessageCapable | undefined,
  contact: string,
): Promise<{ changed: boolean }> {
  return call("/api/identity/contact", { method: "POST", body: JSON.stringify({ ...(await proof(signer, walletClient)), contact }) });
}

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
  throw new Error("This wallet can't sign a message. Sign in again and retry.");
}

/**
 * Starts the identity check: the wallet signs a dated message proving control, the server opens the inquiry.
 * `contact` is the email notices go to (the member's Turnkey sign-in email); the server requires one.
 */
export async function startIdentityCheck(
  signer: TransactionSigner,
  walletClient: MessageCapable | undefined,
  contact: string,
): Promise<{ inquiryId: string; url: string }> {
  const message = proofMessage(signer.address, Math.floor(Date.now() / 1000));
  const signature = getBase64Decoder().decode(await signText(signer, walletClient, message));
  return call("/api/identity/start", { method: "POST", body: JSON.stringify({ wallet: signer.address, message, signature, contact }) });
}
