/**
 * Issues and revokes gateway tokens on the fund's own gatekeeper network. Server only: this is the one place
 * that still uses @solana/web3.js v1, because @civic/solana-gateway-ts speaks it.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, type Signer } from "@solana/web3.js";
import {
  addGatekeeper,
  findGatewayToken,
  freeze,
  gatekeeperExists,
  getGatekeeperAccountAddress,
  getGatewayTokenAddressForOwnerAndGatekeeperNetwork,
  issue,
  revoke,
  State,
  unfreeze,
  updateExpiry,
} from "@civic/solana-gateway-ts";
import { address, type Address } from "@solana/kit";

export type PassView = { address: Address; state: "active" | "frozen" | "revoked"; expiresAt: number | null };

export interface TokenIssuer {
  readonly network: Address;
  /** Issues a token for `owner`, valid until `expireSec` (a revoked one cannot come back). Returns the token address. */
  issue(owner: Address, expireSec: number): Promise<Address>;
  /** Permanent: the token can never be re-issued. Not used for bars (those freeze); kept for compromised wallets. */
  revoke(owner: Address): Promise<void>;
  /** A bar for good: the pass stops working until `unfreeze`. No-op without a token or when already frozen. */
  freeze(owner: Address): Promise<void>;
  unfreeze(owner: Address): Promise<void>;
  /** Moves the expiry of an existing token (issuing one when the wallet has none yet). */
  renew(owner: Address, expireSec: number): Promise<Address>;
  /** The token address when `owner` holds an active token. */
  active(owner: Address): Promise<Address | null>;
  /** The token as it is, whatever its state; null when the wallet never had one. */
  pass(owner: Address): Promise<PassView | null>;
}

type SendConn = Pick<Connection, "getLatestBlockhash" | "sendRawTransaction" | "confirmTransaction">;

/**
 * Signs and sends `tx` with a blockhash fetched for this attempt, and confirms it against that blockhash's expiry.
 * web3.js's own sendAndConfirmTransaction reuses a cached blockhash for about 30 seconds, which a cluster whose
 * blockhashes moved on (a restarted RPC node; a local fork after time travel) rejects at preflight ("Blockhash not
 * found"). That rejection means the transaction was never sent, so only it is retried, with a fresh blockhash, up to
 * `tries` times; anything else (a program error, an expiry while confirming) is thrown as is, so nothing lands twice.
 */
export async function sendFresh(conn: SendConn, tx: Transaction, signer: Signer, tries = 3): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = signer.publicKey;
    tx.signatures = [];
    tx.sign(signer);
    try {
      const signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
      const r = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (r.value.err) throw new Error(`transaction failed: ${JSON.stringify(r.value.err)}`);
      return signature;
    } catch (e) {
      const unsent = /blockhash not found/i.test(e instanceof Error ? e.message : String(e));
      if (!unsent || attempt >= tries) throw e;
    }
  }
}

/** A 64-byte secret key as a JSON array (the `solana-keygen` file format). */
export function secretFromEnv(name: string, value: string | undefined): Uint8Array {
  if (!value?.trim()) throw new Error(`${name} is not set.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON array of 64 numbers.`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) {
    throw new Error(`${name} must be a JSON array of 64 numbers.`);
  }
  return Uint8Array.from(parsed as number[]);
}

export class Gatekeeper implements TokenIssuer {
  readonly network: Address;
  private readonly conn: Connection;
  private readonly key: Keypair;
  private readonly net: PublicKey;
  private readonly account: PublicKey;

  constructor(opts: { rpcUrl: string; network: Address; secret: Uint8Array }) {
    this.conn = new Connection(opts.rpcUrl, "confirmed");
    this.key = Keypair.fromSecretKey(opts.secret);
    this.network = opts.network;
    this.net = new PublicKey(opts.network);
    this.account = getGatekeeperAccountAddress(this.key.publicKey, this.net);
  }

  get authority(): Address {
    return address(this.key.publicKey.toBase58());
  }

  private async send(tx: Transaction, label: string): Promise<void> {
    try {
      await sendFresh(this.conn, tx, this.key);
    } catch (e) {
      throw new Error(`gatekeeper ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async issue(owner: Address, expireSec: number): Promise<Address> {
    const ownerKey = new PublicKey(owner);
    const token = getGatewayTokenAddressForOwnerAndGatekeeperNetwork(ownerKey, this.net);
    const existing = await findGatewayToken(this.conn, ownerKey, this.net, true);
    if (existing && existing.isValid()) return address(token.toBase58());
    if (existing) throw new Error("This wallet's pass was revoked and cannot be re-issued.");
    await this.send(
      new Transaction().add(issue(token, this.key.publicKey, this.account, ownerKey, this.key.publicKey, this.net, undefined, expireSec)),
      "issue",
    );
    return address(token.toBase58());
  }

  async revoke(owner: Address): Promise<void> {
    const ownerKey = new PublicKey(owner);
    const existing = await findGatewayToken(this.conn, ownerKey, this.net, false);
    if (!existing) return;
    await this.send(new Transaction().add(revoke(existing.publicKey, this.key.publicKey, this.account)), "revoke");
  }

  async freeze(owner: Address): Promise<void> {
    const t = await findGatewayToken(this.conn, new PublicKey(owner), this.net, false);
    if (!t || t.state !== State.ACTIVE) return;
    await this.send(new Transaction().add(freeze(t.publicKey, this.key.publicKey, this.account)), "freeze");
  }

  async unfreeze(owner: Address): Promise<void> {
    const t = await findGatewayToken(this.conn, new PublicKey(owner), this.net, false);
    if (!t || t.state !== State.FROZEN) return;
    await this.send(new Transaction().add(unfreeze(t.publicKey, this.key.publicKey, this.account)), "unfreeze");
  }

  async renew(owner: Address, expireSec: number): Promise<Address> {
    const t = await findGatewayToken(this.conn, new PublicKey(owner), this.net, false);
    if (!t) return this.issue(owner, expireSec);
    if (t.state === State.REVOKED) throw new Error("This wallet's pass was revoked and cannot be renewed.");
    await this.send(new Transaction().add(updateExpiry(t.publicKey, this.key.publicKey, this.account, expireSec)), "update expiry");
    return address(t.publicKey.toBase58());
  }

  async active(owner: Address): Promise<Address | null> {
    const t = await findGatewayToken(this.conn, new PublicKey(owner), this.net, false);
    return t && t.isValid() ? address(t.publicKey.toBase58()) : null;
  }

  async pass(owner: Address): Promise<PassView | null> {
    const t = await findGatewayToken(this.conn, new PublicKey(owner), this.net, false);
    if (!t) return null;
    return {
      address: address(t.publicKey.toBase58()),
      state: t.state === State.ACTIVE ? "active" : t.state === State.FROZEN ? "frozen" : "revoked",
      expiresAt: t.expiryTime ?? null,
    };
  }
}

/** A fresh keypair (for a new gatekeeper network) or the address of an existing secret. */
export function keypairFor(secret?: Uint8Array): { secret: Uint8Array; address: Address } {
  const kp = secret ? Keypair.fromSecretKey(secret) : Keypair.generate();
  return { secret: kp.secretKey, address: address(kp.publicKey.toBase58()) };
}

/**
 * One-time setup per cluster: the network keypair signs to add the gatekeeper authority to the network.
 * Idempotent. Pays with the gatekeeper key.
 */
export async function ensureGatekeeper(opts: {
  rpcUrl: string;
  networkSecret: Uint8Array;
  gatekeeperSecret: Uint8Array;
}): Promise<{ network: Address; gatekeeper: Address; added: boolean }> {
  const conn = new Connection(opts.rpcUrl, "confirmed");
  const network = Keypair.fromSecretKey(opts.networkSecret);
  const gk = Keypair.fromSecretKey(opts.gatekeeperSecret);
  const out = { network: address(network.publicKey.toBase58()), gatekeeper: address(gk.publicKey.toBase58()), added: false };
  if (await gatekeeperExists(conn, gk.publicKey, network.publicKey)) return out;
  const account = getGatekeeperAccountAddress(gk.publicKey, network.publicKey);
  const tx = new Transaction().add(addGatekeeper(gk.publicKey, account, gk.publicKey, network.publicKey));
  await sendAndConfirmTransaction(conn, tx, [gk, network], { commitment: "confirmed" });
  return { ...out, added: true };
}
