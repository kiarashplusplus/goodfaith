/** Accounts planted straight into LiteSVM: mints, token accounts, Civic gateway tokens, clock. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  lamports,
  none,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { AccountState, getMintEncoder, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { LiteSVM } from "litesvm";
import { gatewayTokenAddress } from "../civic-addr";
import { GATEKEEPER_NETWORK, PROGRAM_ID } from "../config";
import { findAta } from "../program";
import { TEST_ADMIN_SECRET, TEST_ISSUER_SECRET } from "./admin";

export const T0 = 1_700_000_000n;
export const GATEWAY_PROGRAM = address("gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs");
export const NETWORK = address(GATEKEEPER_NETWORK);

const root = (p: string) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
const civic = JSON.parse(readFileSync(root("scripts/civic-token.json"), "utf8")) as { lamports: number; data: string };
const civicBytes = Uint8Array.from(Buffer.from(civic.data, "hex"));

export function newSvm(): LiteSVM {
  const so = root("target/deploy/goodfaith.so");
  if (!existsSync(so)) throw new Error(`${so} not found. Run \`anchor build --arch v2\` at the repo root first.`);
  const svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM_ID, so);
  setTime(svm, T0);
  return svm;
}

export function setTime(svm: LiteSVM, unixSec: bigint) {
  const clock = svm.getClock();
  clock.unixTimestamp = unixSec;
  svm.setClock(clock);
}

function plant(svm: LiteSVM, addr: Address, owner: Address, data: Uint8Array, lam: bigint) {
  svm.setAccount({ address: addr, programAddress: owner, data, executable: false, lamports: lamports(lam), space: BigInt(data.length) });
}

export function plantMint(svm: LiteSVM, mint: Address) {
  const data = getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: none() });
  plant(svm, mint, TOKEN_PROGRAM_ADDRESS, new Uint8Array(data), 1_461_600n);
}

/** Associated token account for `owner` holding `amount` base units. */
export async function plantAta(svm: LiteSVM, owner: Address, mint: Address, amount: bigint): Promise<Address> {
  const ata = await findAta(owner, mint);
  const data = getTokenEncoder().encode({
    mint,
    owner,
    amount,
    delegate: none(),
    state: AccountState.Initialized,
    isNative: none(),
    delegatedAmount: 0n,
    closeAuthority: none(),
  });
  plant(svm, ata, TOKEN_PROGRAM_ADDRESS, new Uint8Array(data), 2_039_280n);
  return ata;
}

/** Token balance of an account, 0 when it doesn't exist. */
export function tokenAmount(svm: LiteSVM, account: Address): bigint {
  const acc = svm.getAccount(account);
  if (!acc.exists) return 0n;
  return new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength).getBigUint64(64, true);
}

/**
 * A Civic gateway token for `wallet`: the real devnet token bytes with the owner patched
 * (version 1 + parent tag 1 → owner at offset 2), planted where the app expects it.
 */
export function plantGatewayToken(svm: LiteSVM, wallet: Address, at?: Address): Address {
  const addr = at ?? gatewayTokenAddress(wallet, NETWORK);
  const bytes = new Uint8Array(civicBytes);
  bytes.set(new Uint8Array(getAddressEncoder().encode(wallet)), 2);
  plant(svm, addr, GATEWAY_PROGRAM, bytes, BigInt(civic.lamports));
  return addr;
}

export async function admin(): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(Uint8Array.from(TEST_ADMIN_SECRET));
}

/** The identity issuer that co-signs registrations in the suite. */
export async function issuer(): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(Uint8Array.from(TEST_ISSUER_SECRET));
}

const hashes = new Map<Address, Uint8Array>();
/** A stable 32-byte person hash per wallet for the suite (the issuer service derives real ones from verified ID fields). */
export function personHashOf(wallet: Address): Uint8Array {
  let h = hashes.get(wallet);
  if (!h) {
    h = crypto.getRandomValues(new Uint8Array(32));
    hashes.set(wallet, h);
  }
  return h;
}

/** A funded wallet with a gateway token; the pool-mint ATA is planted only when `usdc` is given. */
export async function actor(svm: LiteSVM, opts: { usdc?: bigint; mint?: Address; gateway?: boolean } = {}): Promise<KeyPairSigner> {
  const kp = await generateKeyPairSigner();
  svm.airdrop(kp.address, lamports(10_000_000_000n));
  if (opts.gateway !== false) plantGatewayToken(svm, kp.address);
  if (opts.usdc !== undefined && opts.mint) await plantAta(svm, kp.address, opts.mint, opts.usdc);
  return kp;
}
