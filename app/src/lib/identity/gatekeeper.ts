/**
 * Issues and revokes gateway tokens on the fund's own gatekeeper network. Server only: this is the one place
 * that still uses @solana/web3.js v1, because @civic/solana-gateway-ts speaks it.
 */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  addGatekeeper,
  findGatewayToken,
  gatekeeperExists,
  getGatekeeperAccountAddress,
  getGatewayTokenAddressForOwnerAndGatekeeperNetwork,
  issue,
  revoke,
} from "@civic/solana-gateway-ts";
import { address, type Address } from "@solana/kit";

export interface TokenIssuer {
  readonly network: Address;
  /** Issues (or re-issues after a revoke) a token for `owner`, valid until `expireSec`. Returns the token address. */
  issue(owner: Address, expireSec: number): Promise<Address>;
  revoke(owner: Address): Promise<void>;
  /** The token address when `owner` holds an active token. */
  active(owner: Address): Promise<Address | null>;
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
      await sendAndConfirmTransaction(this.conn, tx, [this.key], { commitment: "confirmed" });
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

  async active(owner: Address): Promise<Address | null> {
    const t = await findGatewayToken(this.conn, new PublicKey(owner), this.net, false);
    return t && t.isValid() ? address(t.publicKey.toBase58()) : null;
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
