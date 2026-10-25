import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { getGatekeeperAccountAddress, getGatewayTokenAddressForOwnerAndGatekeeperNetwork } from "@civic/solana-gateway-ts";
import { address, generateKeyPairSigner, getBase64Decoder, signBytes, type Address } from "@solana/kit";
import { gatekeeperAccountAddress, gatewayTokenAddress } from "../gateway";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { sendFresh } from "./gatekeeper";
import { ageAt, HASH_DOMAIN, HashKeyring, normaliseFields, personHash, toHex } from "./person-hash";
import { DEFAULT_FIELD_KEYS, PersonaProvider, parsePersonaSignature, personaDigest } from "./persona";
import { MemoryStore, openSqlite, type IdentityStore } from "./store";
import { PgStore } from "./pg-store";
import { MockProvider, MOCK_FIELDS_TX } from "./mock";
import { proofMessage, verifyProof } from "./wallet-proof";

const W1 = address("5MhvzaqhN3tqQ2F4tqYwu7MWFoMFzTXFibKvDC3wGqSU");
const NET = address("uniqobk8oGh4XBLMqM68K8M2zNu3CdYX7q5go7whQiv");

describe("gateway addresses (kit) match the Civic library", () => {
  it("token and gatekeeper PDAs", async () => {
    expect(await gatewayTokenAddress(W1, NET)).toBe(
      getGatewayTokenAddressForOwnerAndGatekeeperNetwork(new PublicKey(W1), new PublicKey(NET)).toBase58(),
    );
    expect(await gatewayTokenAddress(W1, NET, 3)).toBe(
      getGatewayTokenAddressForOwnerAndGatekeeperNetwork(new PublicKey(W1), new PublicKey(NET), 3).toBase58(),
    );
    expect(await gatekeeperAccountAddress(W1, NET)).toBe(getGatekeeperAccountAddress(new PublicKey(W1), new PublicKey(NET)).toBase58());
  });
});

describe("person hash", () => {
  it("is stable across formatting, keyed by the secret, and never includes the name", () => {
    const a = personHash("s", { idNumber: "tx-1234 5678", issuingState: "tx", birthdate: "1990-05-04" });
    const b = personHash("s", { idNumber: "TX12345678", issuingState: " tx ", birthdate: "1990/05/04", idClass: "pp" });
    expect(toHex(a)).toBe(toHex(b));
    expect(toHex(personHash("other", { idNumber: "TX12345678", issuingState: "TX", birthdate: "1990-05-04" }))).not.toBe(toHex(a));
    expect(normaliseFields({ idNumber: "a-1", issuingState: "ca", birthdate: "2000-01-02" })).toEqual({
      idNumber: "A1",
      issuingState: "CA",
      birthdate: "20000102",
    });
    expect(() => personHash("", MOCK_FIELDS_TX)).toThrow(/PERSON_HASH_SECRET/);
    expect(() => personHash("s", { idNumber: "", issuingState: "TX", birthdate: "1990-05-04" })).toThrow(/incomplete/);
  });
  it("computes age at a date", () => {
    expect(ageAt("2008-06-15", new Date("2026-06-14T00:00:00Z"))).toBe(17);
    expect(ageAt("2008-06-15", new Date("2026-06-15T00:00:00Z"))).toBe(18);
    expect(ageAt("garbage")).toBe(0);
  });
});

describe("Persona provider", () => {
  const secret = "whsec_test";
  const cfg = { apiKey: "k", templateId: "itmpl_x", webhookSecret: secret };
  const body = JSON.stringify({
    data: {
      type: "event",
      id: "evt_1",
      attributes: { name: "inquiry.approved", payload: { data: { type: "inquiry", id: "inq_1", attributes: { "reference-id": W1 } } } },
    },
  });
  it("verifies t.body signatures with a time window and constant-time compare", () => {
    const p = new PersonaProvider(cfg);
    const t = 1_760_000_000;
    const good = new Headers({ "persona-signature": `t=${t},v1=${personaDigest(secret, t, body)}` });
    expect(p.verifyWebhook(good, body, t + 10)).toBe(true);
    expect(p.verifyWebhook(good, body, t + 301)).toBe(false);
    expect(p.verifyWebhook(good, body + " ", t)).toBe(false);
    expect(p.verifyWebhook(new Headers({ "persona-signature": `t=${t},v1=deadbeef` }), body, t)).toBe(false);
    expect(p.verifyWebhook(new Headers(), body, t)).toBe(false);
    // several v1 values (secret rotation): any match is enough
    const two = new Headers({ "persona-signature": `t=${t},v1=00,v1=${personaDigest(secret, t, body)}` });
    expect(p.verifyWebhook(two, body, t)).toBe(true);
    expect(parsePersonaSignature("t=5,v1=ab")).toEqual({ t: 5, v1: ["ab"] });
    expect(parsePersonaSignature("v1=ab")).toBeNull();
  });
  it("parses events and reads verified fields with configurable keys", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/v1/inquiries")) {
        return new Response(
          JSON.stringify({ data: { id: "inq_9" }, meta: { "one-time-link": "https://inquiry.withpersona.com/verify?x=1" } }),
          { status: 201 },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            id: "inq_1",
            attributes: {
              status: "approved",
              fields: {
                [DEFAULT_FIELD_KEYS.idNumber]: { value: "12345678" },
                [DEFAULT_FIELD_KEYS.issuingState]: { value: "TX" },
                birthdate: { value: "1990-05-04" },
                "name-first": { value: "Pat" },
              },
            },
          },
        }),
      );
    };
    const p = new PersonaProvider({ ...cfg, fetch: fakeFetch });
    expect(p.parseEvent(body)).toEqual({ eventId: "evt_1", inquiryId: "inq_1", referenceId: W1, outcome: "approved" });
    expect(
      p.parseEvent(JSON.stringify({ data: { id: "evt_2", attributes: { name: "account.created", payload: { data: { id: "act_1" } } } } })),
    ).toBeNull();
    expect(p.parseEvent("nope")).toBeNull();
    const created = await p.createInquiry(W1);
    expect(created).toEqual({ inquiryId: "inq_9", url: "https://inquiry.withpersona.com/verify?x=1" });
    const sent = JSON.parse(String(calls[0]!.init!.body)) as {
      data: { attributes: Record<string, string> };
      meta: Record<string, boolean>;
    };
    expect(sent.data.attributes["inquiry-template-id"]).toBe("itmpl_x");
    expect(sent.data.attributes["reference-id"]).toBe(W1);
    expect(sent.meta["auto-create-one-time-link"]).toBe(true);
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(await p.fetchVerified("inq_1")).toEqual({
      idNumber: "12345678",
      issuingState: "TX",
      birthdate: "1990-05-04",
      idClass: undefined,
    });
  });
});

describe("stores", () => {
  // Postgres runs only where TEST_PG_URL points at a database (CI starts one); the same assertions on all backends.
  const stores: [string, () => IdentityStore][] = [
    ["memory", () => new MemoryStore()],
    ["sqlite", () => openSqlite(":memory:")],
    ...(process.env.TEST_PG_URL
      ? ([["postgres", () => PgStore.fromUrl(process.env.TEST_PG_URL!)]] as [string, () => IdentityStore][])
      : []),
  ];
  for (const [name, make] of stores) {
    it(`${name}: wallets, persons, credentials, recoveries, sponsorship and event ids`, async () => {
      const s = make();
      expect(await s.getWallet(W1)).toBeNull();
      await s.putWallet({ wallet: W1, inquiryId: "inq_1", url: "https://x", status: "pending", createdAt: 1, updatedAt: 1 });
      expect(await s.getWallet(W1)).toMatchObject({ inquiryId: "inq_1", status: "pending", url: "https://x" });
      expect((await s.getByInquiry("inq_1"))?.wallet).toBe(W1);
      await s.putWallet({
        wallet: W1,
        inquiryId: "inq_1",
        status: "issued",
        personId: "ab",
        tokenAddress: NET,
        createdAt: 1,
        updatedAt: 2,
      });
      expect(await s.getWallet(W1)).toMatchObject({ status: "issued", personId: "ab", tokenAddress: NET });
      expect((await s.getWallet(W1))!.url).toBeUndefined();
      expect((await s.getWallet(W1))!.linkTo).toBeUndefined();
      await s.putWallet({ ...(await s.getWallet(W1))!, linkTo: "ab" });
      expect((await s.getWallet(W1))!.linkTo).toBe("ab");
      expect(await s.getPerson("ab")).toBeNull();
      await s.putPerson({ personId: "ab", wallet: W1, createdAt: 3 });
      expect(await s.getPerson("ab")).toEqual({ personId: "ab", wallet: W1, createdAt: 3 });
      await s.putPerson({ personId: "ab", wallet: W1, bannedAt: 4, bannedUntil: 1_800_000_000, contact: "m@example.com", createdAt: 3 });
      expect(await s.getPerson("ab")).toEqual({
        personId: "ab",
        wallet: W1,
        bannedAt: 4,
        bannedUntil: 1_800_000_000,
        contact: "m@example.com",
        createdAt: 3,
      });
      await s.putPerson({ ...(await s.getPerson("ab"))!, bannedUntil: undefined });
      expect((await s.getPerson("ab"))!.bannedUntil).toBeUndefined();
      await s.putWallet({ ...(await s.getWallet(W1))!, contact: "m@example.com" });
      expect((await s.getWallet(W1))!.contact).toBe("m@example.com");
      expect(await s.walletsOf("ab")).toEqual([W1]);
      expect(await s.walletsOf("zz")).toEqual([]);
      expect(await s.getCredential("cd")).toBeNull();
      await s.putCredential({ hash: "cd", keyVersion: 1, personId: "ab", linkedAt: 5, via: "verify" });
      await s.putCredential({ hash: "ef", keyVersion: 2, personId: "ab", linkedAt: 6, via: "rotate" });
      expect(await s.getCredential("cd")).toEqual({ hash: "cd", keyVersion: 1, personId: "ab", linkedAt: 5, via: "verify" });
      expect((await s.credentialsOf("ab")).map((c) => c.hash)).toEqual(["cd", "ef"]);
      expect(await s.credentialsOf("zz")).toEqual([]);
      expect(await s.listBarredPersons()).toEqual([]);
      await s.putPerson({ ...(await s.getPerson("ab"))!, bannedUntil: 5 });
      expect((await s.listBarredPersons()).map((p) => p.personId)).toEqual(["ab"]);
      expect(await s.getRecovery("ab")).toBeNull();
      await s.putRecovery({ personId: "ab", newWallet: NET, openedAt: 7 });
      await s.putRecovery({ personId: "zz", newWallet: W1, openedAt: 6 });
      expect(await s.getRecovery("ab")).toEqual({ personId: "ab", newWallet: NET, openedAt: 7 });
      expect((await s.listRecoveries()).map((r) => r.personId)).toEqual(["zz", "ab"]);
      await s.putRecovery({ ...(await s.getRecovery("ab"))!, notifiedAt: 8, delivery: "failed", proposedAt: 9, signature: "sig" });
      expect(await s.getRecovery("ab")).toEqual({
        personId: "ab",
        newWallet: NET,
        openedAt: 7,
        notifiedAt: 8,
        delivery: "failed",
        proposedAt: 9,
        signature: "sig",
      });
      await s.closeRecovery("ab", "finalized", 10);
      await s.closeRecovery("zz", "withdrawn", 11);
      expect(await s.getRecovery("ab")).toBeNull();
      expect(await s.getRecoveryHistory("ab")).toMatchObject({ closedAs: "finalized", closedAt: 10, signature: "sig" });
      expect(await s.listRecoveries()).toEqual([]);
      await s.putRecovery({ personId: "ab", newWallet: W1, openedAt: 12 });
      expect(await s.getRecovery("ab")).toEqual({ personId: "ab", newWallet: W1, openedAt: 12 });
      await s.closeRecovery("ab", "rejected", 13);
      expect(await s.getSponsorUsage(W1)).toBeNull();
      await s.putSponsorUsage({ wallet: W1, day: "2026-10-24", dayTxs: 3, atasTotal: 1 });
      await s.putSponsorUsage({ wallet: W1, day: "2026-10-25", dayTxs: 1, atasTotal: 2 });
      expect(await s.getSponsorUsage(W1)).toEqual({ wallet: W1, day: "2026-10-25", dayTxs: 1, atasTotal: 2 });
      // atomic reservations: the caps hold under concurrent requests, a day rolls the daily count over, a release gives back
      const caps = { dailyTxs: 3, totalAtas: 3 };
      await s.putSponsorUsage({ wallet: W1, day: "2026-10-25", dayTxs: 0, atasTotal: 2 });
      const burst = await Promise.all(Array.from({ length: 6 }, () => s.reserveSponsorUsage(W1, "2026-10-25", 0, caps)));
      expect(burst.filter((u) => u !== null)).toHaveLength(3);
      expect(await s.getSponsorUsage(W1)).toMatchObject({ dayTxs: 3, atasTotal: 2 });
      expect(await s.reserveSponsorUsage(W1, "2026-10-26", 2, caps)).toBeNull(); // two more accounts would be four
      expect(await s.reserveSponsorUsage(W1, "2026-10-26", 1, caps)).toEqual({ wallet: W1, day: "2026-10-26", dayTxs: 1, atasTotal: 3 });
      await s.releaseSponsorUsage(W1, "2026-10-26", 1);
      expect(await s.getSponsorUsage(W1)).toEqual({ wallet: W1, day: "2026-10-26", dayTxs: 0, atasTotal: 2 });
      expect(await s.reserveSponsorUsage(NET, "2026-10-26", 0, caps)).toEqual({ wallet: NET, day: "2026-10-26", dayTxs: 1, atasTotal: 0 });
      const budget = { dailyTxs: 2, dailyNewWallets: 1 };
      expect(await s.getSponsorBudget("2026-10-26")).toBeNull();
      const bb = await Promise.all([true, true, false, false].map((n) => s.reserveSponsorBudget("2026-10-26", n, budget)));
      expect(bb.filter(Boolean)).toHaveLength(2);
      expect(await s.getSponsorBudget("2026-10-26")).toMatchObject({ txs: 2 });
      await s.releaseSponsorBudget("2026-10-26", true);
      expect(await s.getSponsorBudget("2026-10-26")).toEqual({ day: "2026-10-26", txs: 1, newWallets: 0 });
      expect(await s.reserveSponsorBudget("2026-10-27", false, budget)).toBe(true);
      expect(await s.firstTime("e1")).toBe(true);
      expect(await s.firstTime("e1")).toBe(false);
      await s.close();
    });
  }
});

describe("hash keyring", () => {
  it("parses the versioned list newest first, or a single secret as version 1", () => {
    const k = HashKeyring.fromEnv("1:old, v2:new", undefined);
    expect(k.keys.map((x) => x.version)).toEqual([2, 1]);
    expect(k.current).toEqual({ version: 2, secret: "new" });
    expect(HashKeyring.fromEnv(undefined, "only").keys).toEqual([{ version: 1, secret: "only" }]);
    expect(() => HashKeyring.fromEnv("nope", undefined)).toThrow(/newest first/);
    expect(() => HashKeyring.fromEnv("1:a,1:b", undefined)).toThrow(/twice/);
    expect(() => HashKeyring.fromEnv(undefined, "")).toThrow(/PERSON_HASH_SECRET/);
  });
  it("fingerprints under every key and keeps the domain separation", () => {
    const k = HashKeyring.fromEnv("2:new,1:old", undefined);
    const prints = k.fingerprints(MOCK_FIELDS_TX);
    expect(prints.map((p) => p.version)).toEqual([2, 1]);
    expect(prints[0]!.hash).toBe(toHex(personHash("new", MOCK_FIELDS_TX)));
    expect(prints[1]!.hash).toBe(toHex(personHash("old", MOCK_FIELDS_TX)));
    expect(k.fingerprint(MOCK_FIELDS_TX)).toEqual(prints[0]);
    expect(HASH_DOMAIN).toBe("goodfaith/person/v1");
  });
});

describe("wallet proof", () => {
  it("accepts a fresh signature from the wallet and nothing else", async () => {
    const kp = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const now = 1_760_000_000;
    const msg = proofMessage(kp.address, now);
    const sig = getBase64Decoder().decode(await signBytes(kp.keyPair.privateKey, new TextEncoder().encode(msg)));
    expect(await verifyProof(kp.address, msg, sig, now + 5)).toBe(true);
    expect(await verifyProof(kp.address, msg, sig, now + 400)).toBe(false);
    expect(await verifyProof(other.address, msg, sig, now)).toBe(false);
    expect(await verifyProof(kp.address, msg.replace("check", "cheque"), sig, now)).toBe(false);
    expect(await verifyProof(kp.address, msg, "AAAA", now)).toBe(false);
    const forged = getBase64Decoder().decode(await signBytes(other.keyPair.privateKey, new TextEncoder().encode(msg)));
    expect(await verifyProof(kp.address, msg, forged, now)).toBe(false);
    // purposes do not cross: a status proof cannot start a check, an identity proof does not read details
    const statusMsg = proofMessage(kp.address, now, "status");
    const statusSig = getBase64Decoder().decode(await signBytes(kp.keyPair.privateKey, new TextEncoder().encode(statusMsg)));
    expect(await verifyProof(kp.address, statusMsg, statusSig, now, "status")).toBe(true);
    expect(await verifyProof(kp.address, statusMsg, statusSig, now)).toBe(false);
    expect(await verifyProof(kp.address, msg, sig, now, "status")).toBe(false);
  });
});

describe("mock provider", () => {
  it("creates, decides and signs", async () => {
    const m = new MockProvider("s");
    const { inquiryId, url } = await m.createInquiry(W1);
    expect(url).toContain(inquiryId);
    expect(await m.fetchVerified(inquiryId)).toBeNull();
    const ev = m.decide(inquiryId, "approved");
    expect(m.parseEvent(ev)).toMatchObject({ inquiryId, referenceId: W1, outcome: "approved" });
    expect(m.verifyWebhook(new Headers(m.sign()))).toBe(true);
    expect(m.verifyWebhook(new Headers({ "x-mock-signature": "nope" }))).toBe(false);
    expect(await m.fetchVerified(inquiryId)).toEqual(MOCK_FIELDS_TX);
    expect(() => m.decide("mock-99", "declined")).toThrow(/unknown/);
    const w2 = address("BiJ1fzcq8BcDQrdUDGNaGK9Jq7oxEmXb9iBFJyKMEdw8") as Address;
    expect(m.referenceOf((await m.createInquiry(w2)).inquiryId)).toBe(w2);
  });
});

describe("gatekeeper sends", () => {
  const key = Keypair.generate();
  const tx = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: key.publicKey, lamports: 1 }));
  // A fake connection: a new blockhash per call; `sendRawTransaction` fails with the queued errors first.
  const conn = (failures: string[]) => {
    const used: string[] = [];
    let n = 0;
    return {
      used,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 + n++ }),
      sendRawTransaction: async (raw: Buffer | Uint8Array) => {
        used.push(Transaction.from(raw).recentBlockhash!);
        const f = failures.shift();
        if (f) throw new Error(f);
        return "sig";
      },
      confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
    };
  };

  it("retries a transaction the cluster never took (stale blockhash) with a fresh blockhash", async () => {
    const c = conn(["Simulation failed. Message: Transaction simulation failed: Blockhash not found."]);
    expect(await sendFresh(c as never, tx(), key)).toBe("sig");
    expect(c.used).toHaveLength(2);
    expect(c.used[0]).not.toBe(c.used[1]);
  });

  it("does not retry anything else, and gives up after the last try", async () => {
    const program = conn(["Transaction simulation failed: custom program error: 0x1"]);
    await expect(sendFresh(program as never, tx(), key)).rejects.toThrow(/custom program error/);
    expect(program.used).toHaveLength(1);
    const stale = conn(["Blockhash not found", "Blockhash not found", "Blockhash not found"]);
    await expect(sendFresh(stale as never, tx(), key)).rejects.toThrow(/Blockhash not found/);
    expect(stale.used).toHaveLength(3);
  });
});
