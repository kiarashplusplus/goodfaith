import { createHmac } from "node:crypto";
import type { VerifiedFields } from "./provider";

/**
 * The credential fingerprint: a keyed hash of the ID fields that stay the same across wallets and renewals, so the
 * same human resolves to the same person on a later check. Keyed with a server secret so it cannot be brute-forced
 * from the store, domain-separated so the same secret can never double as another HMAC, and versioned so the
 * secret can be rotated: a person found under an old key is re-linked under the current one on their next check.
 * Never includes the name, address or selfie, and never reaches the chain (the on-chain person id is random).
 */
export function normaliseFields(f: VerifiedFields): { idNumber: string; issuingState: string; birthdate: string } {
  return {
    idNumber: f.idNumber.toUpperCase().replace(/[^A-Z0-9]/g, ""),
    issuingState: f.issuingState
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .slice(0, 2),
    birthdate: f.birthdate.replace(/[^0-9]/g, ""),
  };
}

export const HASH_DOMAIN = "goodfaith/person/v1";

export function personHash(secret: string, fields: VerifiedFields): Uint8Array {
  if (!secret) throw new Error("PERSON_HASH_SECRET is not set.");
  const n = normaliseFields(fields);
  if (!n.idNumber || n.issuingState.length !== 2 || n.birthdate.length !== 8) throw new Error("Verified fields are incomplete.");
  return new Uint8Array(createHmac("sha256", secret).update(`${HASH_DOMAIN}|${n.issuingState}|${n.idNumber}|${n.birthdate}`).digest());
}

export type HashKey = { version: number; secret: string };

/**
 * The current key and the previous ones still recognised. `PERSON_HASH_SECRETS` lists them newest first as
 * `version:secret` pairs separated by commas; `PERSON_HASH_SECRET` alone is version 1.
 */
export class HashKeyring {
  readonly keys: readonly HashKey[];
  constructor(keys: readonly HashKey[]) {
    if (!keys.length) throw new Error("PERSON_HASH_SECRET is not set.");
    const versions = new Set<number>();
    for (const k of keys) {
      if (!Number.isInteger(k.version) || k.version < 1) throw new Error("Hash key versions are positive integers.");
      if (!k.secret)
        throw new Error(k.version === 1 && keys.length === 1 ? "PERSON_HASH_SECRET is not set." : `Hash key v${k.version} has no secret.`);
      if (versions.has(k.version)) throw new Error(`Hash key v${k.version} is listed twice.`);
      versions.add(k.version);
    }
    this.keys = [...keys].sort((a, b) => b.version - a.version);
  }

  static fromEnv(secrets: string | undefined, single: string | undefined): HashKeyring {
    const list = secrets?.trim();
    if (list) {
      return new HashKeyring(
        list.split(",").map((entry) => {
          const m = /^\s*v?(\d+)\s*:\s*(.+?)\s*$/.exec(entry);
          if (!m) throw new Error('PERSON_HASH_SECRETS entries look like "2:secret" (newest first).');
          return { version: Number(m[1]), secret: m[2]! };
        }),
      );
    }
    return new HashKeyring([{ version: 1, secret: single?.trim() ?? "" }]);
  }

  get current(): HashKey {
    return this.keys[0]!;
  }

  /** The fingerprint under the current key. */
  fingerprint(fields: VerifiedFields): { hash: string; version: number } {
    return { hash: toHex(personHash(this.current.secret, fields)), version: this.current.version };
  }

  /** Fingerprints under every key, newest first: the lookup set for a returning person. */
  fingerprints(fields: VerifiedFields): { hash: string; version: number }[] {
    return this.keys.map((k) => ({ hash: toHex(personHash(k.secret, fields)), version: k.version }));
  }
}

export const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

/** Whole years between a YYYY-MM-DD birthdate and `now`. */
export function ageAt(birthdate: string, now = new Date()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!m) return 0;
  const y = Number(m[1]),
    mo = Number(m[2]),
    d = Number(m[3]);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age--;
  return age;
}
