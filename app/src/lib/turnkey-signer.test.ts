import { describe, expect, it } from "vitest";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  verifySignature,
  blockhash,
  createNoopSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { createTurnkeySigner, signRawWith, solanaAccountOf, type SignRaw } from "./turnkey-signer";
import { signText } from "./identity-client";
import { signWith } from "./tx";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

// A stand-in for Turnkey: signs the hex payload with a local ed25519 key, answering in Turnkey's r/s hex shape.
async function fakeTurnkey() {
  const keys = await generateKeyPair();
  const wallet = await getAddressFromPublicKey(keys.publicKey);
  const calls: Parameters<SignRaw>[0][] = [];
  const signRaw: SignRaw = async (req) => {
    calls.push(req);
    const sig = hex(await signBytes(keys.privateKey, unhex(req.payload)));
    return { r: sig.slice(0, 64), s: sig.slice(64) };
  };
  return { keys, wallet, signRaw, calls };
}

async function transferFrom(wallet: ReturnType<typeof address>) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(wallet, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getTransferSolInstruction({
            source: createNoopSigner(wallet),
            destination: address("2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve"),
            amount: 1n,
          }),
        ],
        m,
      ),
  );
  return compileTransaction(msg);
}

describe("createTurnkeySigner", () => {
  it("signs a transaction's message bytes as a raw ed25519 payload", async () => {
    const t = await fakeTurnkey();
    const signer = createTurnkeySigner(t.wallet, t.signRaw);
    const tx = await transferFrom(t.wallet);
    const signed = await signWith(signer, tx);
    const sig = signed.signatures[t.wallet]!;
    expect(sig).toHaveLength(64);
    expect(await verifySignature(t.keys.publicKey, sig, tx.messageBytes)).toBe(true);
    expect(t.calls[0]).toEqual({
      signWith: t.wallet,
      payload: hex(Uint8Array.from(tx.messageBytes)),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
    });
  });

  it("signs proof messages through signText", async () => {
    const t = await fakeTurnkey();
    const signer = createTurnkeySigner(t.wallet, t.signRaw);
    const text = "Good Faith identity check\nwallet: x";
    const sig = await signText(signer, undefined, text);
    expect(await verifySignature(t.keys.publicKey, sig as never, new TextEncoder().encode(text))).toBe(true);
  });

  it("accepts a 0x-prefixed signature", async () => {
    const t = await fakeTurnkey();
    const signer = createTurnkeySigner(t.wallet, async (req) => {
      const { r, s } = await t.signRaw(req);
      return { r: `0x${r}`, s };
    });
    await expect(signText(signer, undefined, "hello")).resolves.toHaveLength(64);
  });

  it("refuses a signature from another key", async () => {
    const t = await fakeTurnkey();
    const other = await fakeTurnkey();
    const signer = createTurnkeySigner(t.wallet, other.signRaw);
    await expect(signText(signer, undefined, "hello")).rejects.toThrow(/does not match this wallet/);
  });

  it("refuses a signature of the wrong length or encoding", async () => {
    const t = await fakeTurnkey();
    const short = createTurnkeySigner(t.wallet, async () => ({ r: "ab".repeat(32), s: "" }));
    await expect(signText(short, undefined, "hello")).rejects.toThrow(/32-byte signature/);
    const b58 = createTurnkeySigner(t.wallet, async () => ({ r: getBase58Decoder().decode(new Uint8Array(64).fill(200)), s: "" }));
    await expect(signText(b58, undefined, "hello")).rejects.toThrow(/not hex/);
  });
});

describe("signRawWith", () => {
  it("passes r and s through from a completed activity and refuses anything else", async () => {
    const req = {
      signWith: "w",
      payload: "00",
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
    } as const;
    const done = signRawWith({ signRawPayload: async () => ({ activity: { status: "ACTIVITY_STATUS_COMPLETED" }, r: "aa", s: "bb" }) });
    await expect(done(req)).resolves.toEqual({ r: "aa", s: "bb" });
    const pending = signRawWith({
      signRawPayload: async () => ({ activity: { status: "ACTIVITY_STATUS_CONSENSUS_NEEDED" }, r: "", s: "" }),
    });
    await expect(pending(req)).rejects.toThrow(/CONSENSUS_NEEDED/);
  });
});

describe("solanaAccountOf", () => {
  it("picks the first embedded Solana account and ignores connected wallets", () => {
    expect(
      solanaAccountOf([
        { source: "connected", accounts: [{ address: "ext", addressFormat: "ADDRESS_FORMAT_SOLANA" }] },
        { source: "embedded", accounts: [{ address: "0xeth", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }] },
        { source: "embedded", accounts: [{ address: "sol", addressFormat: "ADDRESS_FORMAT_SOLANA" }] },
      ]),
    ).toBe("sol");
    expect(solanaAccountOf([])).toBeNull();
  });
});
