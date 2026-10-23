import { createHmac } from "node:crypto";
import type { VerifiedFields } from "./provider";

/**
 * One stable identifier per human, from the ID fields that stay the same across wallets and renewals, keyed
 * with a server secret so the hash cannot be brute-forced from the on-chain Person accounts.
 * Never includes the name, address or selfie.
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

export function personHash(secret: string, fields: VerifiedFields): Uint8Array {
  if (!secret) throw new Error("PERSON_HASH_SECRET is not set.");
  const n = normaliseFields(fields);
  if (!n.idNumber || n.issuingState.length !== 2 || n.birthdate.length !== 8) throw new Error("Verified fields are incomplete.");
  return new Uint8Array(createHmac("sha256", secret).update(`${n.issuingState}|${n.idNumber}|${n.birthdate}`).digest());
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
