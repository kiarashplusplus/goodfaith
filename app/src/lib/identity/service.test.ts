/**
 * The identity service against a mock provider, a memory store, a fake gatekeeper and a fake chain:
 * the registry logic and the issuer-signed transactions, without LiteSVM. The on-chain half runs in the
 * SVM suite and the fork e2e.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  address,
  blockhash,
  generateKeyPairSigner,
  getTransactionDecoder,
  getBase64Encoder,
  type Address,
  type KeyPairSigner,
} from "@solana/kit";
import { IdentityService, IdentityError } from "./service";
import { MockProvider, MOCK_FIELDS_TX } from "./mock";
import { MemoryStore } from "./store";
import type { TokenIssuer } from "./gatekeeper";
import { fromHex, personHash, toHex } from "./person-hash";

// program.ts reads the canonical pool and member/person accounts; the fake chain answers for them.
const chain = vi.hoisted(() => ({
  pool: null as null | Record<string, unknown>,
  members: new Map<string, { person: string; retired: boolean }>(),
  persons: new Map<string, { wallet: string; ineligible: boolean }>(),
}));
vi.mock("../program", async () => {
  const real = await vi.importActual<typeof import("../program")>("../program");
  return {
    ...real,
    fetchCanonicalPool: async () => chain.pool,
    fetchMember: async (_rpc: unknown, _pool: Address, wallet: Address) => {
      const m = chain.members.get(wallet);
      if (!m) return null;
      const p = chain.persons.get(m.person)!;
      return {
        address: wallet,
        wallet,
        person: m.person,
        retired: m.retired,
        activeLoan: null,
        activeGuarantees: 0,
        ineligible: p.ineligible,
      };
    },
    fetchPerson: async (_rpc: unknown, a: Address) => {
      const p = chain.persons.get(a);
      return p ? { address: a, wallet: p.wallet, activeLoan: null, activeGuarantees: 0, ineligible: p.ineligible } : null;
    },
  };
});
import { findPersonPda } from "../program";

class FakeGatekeeper implements TokenIssuer {
  readonly network = address("uniqobk8oGh4XBLMqM68K8M2zNu3CdYX7q5go7whQiv");
  issued = new Map<string, number>();
  revoked: string[] = [];
  fail = false;
  async issue(owner: Address, expireSec: number) {
    if (this.fail) throw new Error("rpc down");
    this.issued.set(owner, expireSec);
    return address("GateTok111111111111111111111111111111111111".replace(/1+$/, "").padEnd(43, "1").slice(0, 43)) as Address;
  }
  async revoke(owner: Address) {
    this.revoked.push(owner);
    this.issued.delete(owner);
  }
  async active(owner: Address) {
    return this.issued.has(owner) ? (owner as Address) : null;
  }
}

const rpc = {
  getLatestBlockhash: () => ({
    send: async () => ({ value: { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n } }),
  }),
} as unknown as ConstructorParameters<typeof IdentityService>[0]["rpc"];

let provider: MockProvider, store: MemoryStore, gk: FakeGatekeeper, issuer: KeyPairSigner, svc: IdentityService;
let w1: Address, w2: Address;
const now = 1_760_000_000_000;
const POOL = address("Cm8TDDJ7KqqB2oxgsHGcB5iBjdorjrzPrw3dLpEtHR9u");

async function approve(wallet: Address, fields = MOCK_FIELDS_TX) {
  const { inquiryId } = await svc.start(wallet);
  return svc.handleWebhook(new Headers(provider.sign()), provider.decide(inquiryId, "approved", fields));
}

beforeEach(async () => {
  provider = new MockProvider("s");
  store = new MemoryStore();
  gk = new FakeGatekeeper();
  issuer = await generateKeyPairSigner();
  w1 = (await generateKeyPairSigner()).address;
  w2 = (await generateKeyPairSigner()).address;
  chain.members.clear();
  chain.persons.clear();
  chain.pool = {
    address: POOL,
    mint: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
    vault: POOL,
    gatekeeperNetwork: gk.network,
    issuer: issuer.address,
    loanCount: 0n,
  };
  svc = new IdentityService({
    provider,
    store,
    gatekeeper: gk,
    issuer,
    rpc,
    hashSecret: "hash-secret",
    now: () => now,
    feePayer: async () => null,
  });
});

describe("start", () => {
  it("opens one inquiry per wallet and resumes a pending one", async () => {
    const a = await svc.start(w1);
    expect(a.status).toBe("pending");
    expect(await svc.start(w1)).toEqual(a);
    expect(await svc.status(w1)).toMatchObject({ status: "pending", next: "wait", url: a.url });
  });
});

describe("webhook", () => {
  it("rejects bad signatures, ignores unknown and duplicate events", async () => {
    const { inquiryId } = await svc.start(w1);
    const ev = provider.decide(inquiryId, "approved");
    expect(await svc.handleWebhook(new Headers({ "x-mock-signature": "wrong" }), ev)).toBe("bad_signature");
    expect(await svc.handleWebhook(new Headers(provider.sign()), "not json")).toBe("ignored");
    expect(await svc.handleWebhook(new Headers(provider.sign()), ev)).toBe("issued");
    expect(await svc.handleWebhook(new Headers(provider.sign()), ev)).toBe("duplicate");
    const stray = JSON.stringify({ eventId: "e-x", inquiryId: "mock-77", outcome: "approved" });
    expect(await svc.handleWebhook(new Headers(provider.sign()), stray)).toBe("unknown_inquiry");
  });

  it("issues a pass for an approved Texas adult and records the person", async () => {
    expect(await approve(w1)).toBe("issued");
    const rec = store.getWallet(w1)!;
    expect(rec).toMatchObject({ status: "issued", personHash: toHex(personHash("hash-secret", MOCK_FIELDS_TX)) });
    expect(gk.issued.get(w1)).toBe(Math.floor(now / 1000) + 365 * 86_400);
    expect(store.getPerson(rec.personHash!)).toMatchObject({ wallet: w1 });
    expect(await svc.status(w1)).toMatchObject({ status: "issued", next: "join", person: { onChain: false, currentWallet: null } });
  });

  it("turns out-of-state, underage and declined checks away, and keeps a review pending", async () => {
    expect(await approve(w1, { ...MOCK_FIELDS_TX, issuingState: "CA" })).toBe("ineligible");
    expect(store.getWallet(w1)).toMatchObject({ reason: "Good Faith is for Texas residents only." });
    expect(gk.issued.size).toBe(0);
    expect(await approve(w2, { ...MOCK_FIELDS_TX, idNumber: "2", birthdate: "2010-01-01" })).toBe("ineligible");
    expect(store.getWallet(w2)).toMatchObject({ reason: "You must be 18 or older." });
    const w3 = (await generateKeyPairSigner()).address;
    const { inquiryId } = await svc.start(w3);
    expect(await svc.handleWebhook(new Headers(provider.sign()), provider.decide(inquiryId, "needs_review"))).toBe("review");
    await expect(svc.start(w3)).rejects.toThrow(/reviewed/);
    const w4 = (await generateKeyPairSigner()).address;
    const q = await svc.start(w4);
    expect(await svc.handleWebhook(new Headers(provider.sign()), provider.decide(q.inquiryId, "declined"))).toBe("declined");
    expect((await svc.status(w4)).next).toBe("blocked");
    // a declined wallet may try again
    expect((await svc.start(w4)).status).toBe("pending");
  });

  it("records an error when the pass cannot be issued, and the wallet can retry", async () => {
    gk.fail = true;
    expect(await approve(w1)).toBe("error");
    expect((await svc.status(w1)).next).toBe("verify");
    gk.fail = false;
    expect(await approve(w1)).toBe("issued");
  });

  it("refuses a banned person on any wallet", async () => {
    await approve(w1);
    const hash = store.getWallet(w1)!.personHash!;
    expect(await svc.ban(hash)).toEqual({ banned: true, revoked: [w1] });
    expect(gk.revoked).toEqual([w1]);
    expect(store.getWallet(w1)).toMatchObject({ status: "ineligible" });
    expect(await approve(w2)).toBe("ineligible"); // same ID fields, new wallet
    expect(store.getWallet(w2)).toMatchObject({ reason: "This person can no longer use Good Faith." });
    expect(await svc.ban("00".repeat(32))).toEqual({ banned: false, revoked: [] });
  });
});

describe("prepared transactions", () => {
  const decode = (b64: string) => getTransactionDecoder().decode(getBase64Encoder().encode(b64));

  it("join: issuer-signed register_member, wallet as fee payer when no sponsor", async () => {
    await expect(svc.prepareJoin(w1)).rejects.toMatchObject({ status: 409 });
    await approve(w1);
    const p = await svc.prepareJoin(w1);
    expect(p).toMatchObject({ feePayer: w1, sponsored: false, kind: "register" });
    const tx = decode(p.transaction);
    expect(Object.keys(tx.signatures)).toEqual(expect.arrayContaining([issuer.address, w1]));
    expect(tx.signatures[issuer.address]).not.toBeNull();
    expect(tx.signatures[w1]).toBeNull();
  });

  it("join is refused once the person is on chain; rebind takes over for a new wallet", async () => {
    await approve(w1);
    const hash = store.getWallet(w1)!.personHash!;
    const [pda] = await findPersonPda(POOL, fromHex(hash));
    chain.persons.set(pda, { wallet: w1, ineligible: false });
    chain.members.set(w1, { person: pda, retired: false });
    expect(await svc.status(w1)).toMatchObject({ next: "done", member: { retired: false } });
    await expect(svc.prepareJoin(w1)).rejects.toMatchObject({ status: 409 });
    // lost keys: verify again from w2 (same person) and move the membership
    expect(await approve(w2)).toBe("issued");
    expect(store.getWallet(w2)!.personHash).toBe(hash);
    expect(await svc.status(w2)).toMatchObject({ next: "rebind", person: { onChain: true, currentWallet: w1, isThisWallet: false } });
    const svcSponsored = new IdentityService({
      provider,
      store,
      gatekeeper: gk,
      issuer,
      rpc,
      hashSecret: "hash-secret",
      now: () => now,
      feePayer: async () => address("78DWc8FZ3iVru1z1jDy9wdPsTHqhGYiQRhtyVU6u9RHU"),
    });
    const p = await svcSponsored.prepareRebind(w2);
    expect(p).toMatchObject({ sponsored: true, feePayer: "78DWc8FZ3iVru1z1jDy9wdPsTHqhGYiQRhtyVU6u9RHU", kind: "rebind" });
    expect(Object.keys(decode(p.transaction).signatures)).toEqual(expect.arrayContaining([p.feePayer, w2, issuer.address]));
    await expect(svc.prepareRebind(w1)).rejects.toThrow(/already linked/);
    // after the chain moves, the old wallet shows as replaced
    chain.persons.set(pda, { wallet: w2, ineligible: false });
    chain.members.set(w1, { person: pda, retired: true });
    chain.members.set(w2, { person: pda, retired: false });
    expect(await svc.status(w1)).toMatchObject({ next: "blocked", member: { retired: true } });
    expect((await svc.status(w2)).next).toBe("done");
  });

  it("refuses to sign when the pool names another issuer", async () => {
    await approve(w1);
    chain.pool = { ...chain.pool!, issuer: w2 };
    await expect(svc.prepareJoin(w1)).rejects.toThrow(IdentityError);
    await expect(svc.prepareJoin(w1)).rejects.toMatchObject({ status: 500 });
  });
});
