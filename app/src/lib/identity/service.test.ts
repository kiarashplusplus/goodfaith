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
import { IdentityService, IdentityError, type PreparedTx } from "./service";
import { MockProvider, MOCK_FIELDS_TX } from "./mock";
import { MemoryStore } from "./store";
import type { TokenIssuer } from "./gatekeeper";
import { fromHex, HashKeyring, personHash, toHex } from "./person-hash";

type FakePerson = { wallet: string; ineligibleUntil?: bigint; pendingWallet?: string; pendingWalletAt?: bigint };

// program.ts reads the canonical pool and member/person accounts; the fake chain answers for them.
const chain = vi.hoisted(() => ({
  pool: null as null | Record<string, unknown>,
  members: new Map<string, { person: string; retired: boolean }>(),
  persons: new Map<string, FakePerson>(),
}));
vi.mock("../program", async () => {
  const real = await vi.importActual<typeof import("../program")>("../program");
  const person = (a: string, p: FakePerson) => ({
    address: a,
    personId: "00".repeat(32),
    wallet: p.wallet,
    activeLoan: null,
    activeGuarantees: 0,
    activeGuaranteeAmount: 0n,
    completedLoans: 0,
    ineligibleUntil: p.ineligibleUntil ?? 0n,
    restrictedUntil: 0n,
    pendingWallet: p.pendingWallet ?? null,
    pendingWalletAt: p.pendingWalletAt ?? 0n,
  });
  return {
    ...real,
    fetchCanonicalPool: async () => chain.pool,
    fetchMember: async (_rpc: unknown, _pool: Address, wallet: Address) => {
      const m = chain.members.get(wallet);
      if (!m) return null;
      const p = person(m.person, chain.persons.get(m.person)!);
      return {
        address: wallet,
        wallet,
        person: m.person,
        retired: m.retired,
        activeLoan: null,
        activeGuarantees: 0,
        ineligibleUntil: p.ineligibleUntil,
        restrictedUntil: 0n,
        completedLoans: 0,
        ineligible: p.ineligibleUntil > 0n,
      };
    },
    fetchPerson: async (_rpc: unknown, a: Address) => {
      const p = chain.persons.get(a);
      return p ? person(a, p) : null;
    },
  };
});
import { findPersonPda, PERMANENT } from "../program";

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

let provider: MockProvider, store: MemoryStore, gk: FakeGatekeeper, issuer: KeyPairSigner, recovery: KeyPairSigner, svc: IdentityService;
let w1: Address, w2: Address;
let clock = 1_760_000_000_000;
const now = () => clock;
const nowSec = () => BigInt(Math.floor(clock / 1000));
const POOL = address("Cm8TDDJ7KqqB2oxgsHGcB5iBjdorjrzPrw3dLpEtHR9u");
const keyring = () => HashKeyring.fromEnv(undefined, "hash-secret");

async function approve(wallet: Address, fields = MOCK_FIELDS_TX) {
  const { inquiryId } = await svc.start(wallet);
  return svc.handleWebhook(new Headers(provider.sign()), provider.decide(inquiryId, "approved", fields));
}
const make = (over: Partial<ConstructorParameters<typeof IdentityService>[0]> = {}) =>
  new IdentityService({
    provider,
    store,
    gatekeeper: gk,
    issuer,
    recovery,
    rpc,
    keyring: keyring(),
    now,
    feePayer: async () => null,
    ...over,
  });

beforeEach(async () => {
  clock = 1_760_000_000_000;
  provider = new MockProvider("s");
  store = new MemoryStore();
  gk = new FakeGatekeeper();
  issuer = await generateKeyPairSigner();
  recovery = await generateKeyPairSigner();
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
    recoveryAuthority: recovery.address,
    loanCount: 0n,
  };
  svc = make();
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

  it("issues a pass for an approved Texas adult and records the person under an opaque id", async () => {
    expect(await approve(w1)).toBe("issued");
    const rec = (await store.getWallet(w1))!;
    expect(rec.status).toBe("issued");
    expect(rec.personId).toMatch(/^[0-9a-f]{64}$/);
    const hash = toHex(personHash("hash-secret", MOCK_FIELDS_TX));
    expect(rec.personId).not.toBe(hash); // nothing derived from the credential goes on chain
    expect(gk.issued.get(w1)).toBe(Math.floor(now() / 1000) + 365 * 86_400);
    expect(await store.getPerson(rec.personId!)).toMatchObject({ wallet: w1 });
    expect(await store.getCredential(hash)).toMatchObject({ personId: rec.personId, keyVersion: 1, via: "verify" });
    expect(await svc.status(w1)).toMatchObject({ status: "issued", next: "join", person: { onChain: false, currentWallet: null } });
    // the same credential from another wallet resolves to the same person
    expect(await approve(w2)).toBe("issued");
    expect((await store.getWallet(w2))!.personId).toBe(rec.personId);
  });

  it("turns out-of-state, underage and declined checks away, and keeps a review pending", async () => {
    expect(await approve(w1, { ...MOCK_FIELDS_TX, issuingState: "CA" })).toBe("ineligible");
    expect(await store.getWallet(w1)).toMatchObject({ reason: "Good Faith is for Texas residents only." });
    expect(gk.issued.size).toBe(0);
    expect(await approve(w2, { ...MOCK_FIELDS_TX, idNumber: "2", birthdate: "2010-01-01" })).toBe("ineligible");
    expect(await store.getWallet(w2)).toMatchObject({ reason: "You must be 18 or older." });
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

  it("refuses a wallet that verifies as a second person", async () => {
    await approve(w1);
    await store.putWallet({ ...(await store.getWallet(w1))!, status: "error" }); // pretend the pass failed, the person stuck
    expect(await approve(w1, { ...MOCK_FIELDS_TX, idNumber: "other-person" })).toBe("ineligible");
    expect(await store.getWallet(w1)).toMatchObject({ reason: "This wallet already belongs to another verified person." });
  });

  it("refuses a banned person on any wallet, revoking every wallet they verified with", async () => {
    await approve(w1);
    await approve(w2); // the same person verified from a second wallet earlier
    const id = (await store.getWallet(w1))!.personId!;
    expect(await svc.ban(id)).toEqual({ banned: true, revoked: [w1, w2] });
    expect(gk.revoked).toEqual([w1, w2]);
    expect(await store.getWallet(w1)).toMatchObject({ status: "ineligible" });
    expect(await store.getWallet(w2)).toMatchObject({ status: "ineligible" });
    const w3 = (await generateKeyPairSigner()).address;
    expect(await approve(w3)).toBe("ineligible"); // same ID fields, new wallet
    expect(await store.getWallet(w3)).toMatchObject({ reason: "This person can no longer use Good Faith." });
    expect(await svc.ban("00".repeat(32))).toEqual({ banned: false, revoked: [] });
  });
});

describe("credentials", () => {
  it("re-links a returning person under the current key after a rotation", async () => {
    await approve(w1);
    const id = (await store.getWallet(w1))!.personId!;
    const oldHash = toHex(personHash("hash-secret", MOCK_FIELDS_TX));
    const rotated = make({ keyring: HashKeyring.fromEnv("2:fresh-secret,1:hash-secret", undefined) });
    svc = rotated;
    expect(await approve(w2)).toBe("issued");
    expect((await store.getWallet(w2))!.personId).toBe(id);
    const newHash = toHex(personHash("fresh-secret", MOCK_FIELDS_TX));
    expect((await store.credentialsOf(id)).map((c) => [c.hash, c.keyVersion, c.via])).toEqual([
      [oldHash, 1, "verify"],
      [newHash, 2, "rotate"],
    ]);
    // once the old key is dropped the person is still found
    svc = make({ keyring: HashKeyring.fromEnv("2:fresh-secret", undefined) });
    const w3 = (await generateKeyPairSigner()).address;
    expect(await approve(w3)).toBe("issued");
    expect((await store.getWallet(w3))!.personId).toBe(id);
  });

  it("links a second document to the same person and refuses one that belongs to someone else", async () => {
    await expect(svc.startLink(w1)).rejects.toMatchObject({ status: 409 });
    await approve(w1);
    const id = (await store.getWallet(w1))!.personId!;
    const renewed = { ...MOCK_FIELDS_TX, idNumber: "renewed-1" };
    const l = await svc.startLink(w1);
    expect(await store.getWallet(w1)).toMatchObject({ status: "pending", linkTo: id, personId: id });
    expect(await svc.startLink(w1)).toEqual(l); // resumes
    expect(await svc.handleWebhook(new Headers(provider.sign()), provider.decide(l.inquiryId, "approved", renewed))).toBe("issued");
    expect(await store.getWallet(w1)).toMatchObject({ status: "issued", personId: id, linkTo: undefined });
    expect((await store.credentialsOf(id)).map((c) => c.via)).toEqual(["verify", "link"]);
    // the renewed document now resolves to the same person from any wallet
    expect(await approve(w2, renewed)).toBe("issued");
    expect((await store.getWallet(w2))!.personId).toBe(id);
    // someone else's document cannot be attached
    const w3 = (await generateKeyPairSigner()).address;
    await approve(w3, { ...MOCK_FIELDS_TX, idNumber: "someone-else" });
    const l2 = await svc.startLink(w1);
    expect(
      await svc.handleWebhook(
        new Headers(provider.sign()),
        provider.decide(l2.inquiryId, "approved", { ...MOCK_FIELDS_TX, idNumber: "someone-else" }),
      ),
    ).toBe("issued");
    expect(await store.getWallet(w1)).toMatchObject({ status: "issued", reason: "That document already belongs to another membership." });
    expect((await store.credentialsOf(id)).length).toBe(2);
    // a declined link leaves the pass in place
    const l3 = await svc.startLink(w1);
    expect(await svc.handleWebhook(new Headers(provider.sign()), provider.decide(l3.inquiryId, "declined"))).toBe("issued");
    expect(await store.getWallet(w1)).toMatchObject({ status: "issued", linkTo: undefined });
  });
});

describe("prepared transactions", () => {
  const decode = (b64: string) => getTransactionDecoder().decode(getBase64Encoder().encode(b64));
  const tx = (r: Awaited<ReturnType<IdentityService["prepareRebind"]>>): PreparedTx => {
    if (r.kind === "review") throw new Error("expected a transaction");
    return r;
  };

  it("join: issuer-signed register_member, wallet as fee payer when no sponsor", async () => {
    await expect(svc.prepareJoin(w1)).rejects.toMatchObject({ status: 409 });
    await approve(w1);
    const p = await svc.prepareJoin(w1);
    expect(p).toMatchObject({ feePayer: w1, sponsored: false, kind: "register" });
    const t = decode(p.transaction);
    expect(Object.keys(t.signatures)).toEqual(expect.arrayContaining([issuer.address, w1]));
    expect(t.signatures[issuer.address]).not.toBeNull();
    expect(t.signatures[w1]).toBeNull();
  });

  it("join is refused once the person is on chain; recovery proposes, then finalises after the delay", async () => {
    await approve(w1);
    const id = (await store.getWallet(w1))!.personId!;
    const [pda] = await findPersonPda(POOL, fromHex(id));
    chain.persons.set(pda, { wallet: w1 });
    chain.members.set(w1, { person: pda, retired: false });
    expect(await svc.status(w1)).toMatchObject({ next: "done", member: { retired: false } });
    await expect(svc.prepareJoin(w1)).rejects.toMatchObject({ status: 409 });
    // lost keys: verify again from w2 (same person) and ask to move the membership
    expect(await approve(w2)).toBe("issued");
    expect((await store.getWallet(w2))!.personId).toBe(id);
    expect(await svc.status(w2)).toMatchObject({
      next: "recover",
      person: { onChain: true, currentWallet: w1, isThisWallet: false, pendingWallet: null, reviewUntil: null },
    });
    const sponsor = address("78DWc8FZ3iVru1z1jDy9wdPsTHqhGYiQRhtyVU6u9RHU");
    const svcSponsored = make({ feePayer: async () => sponsor });
    const p = tx(await svcSponsored.prepareRebind(w2));
    expect(p).toMatchObject({ sponsored: true, feePayer: sponsor, kind: "propose" });
    const t = decode(p.transaction);
    expect(Object.keys(t.signatures)).toEqual(expect.arrayContaining([sponsor, w2, issuer.address, recovery.address]));
    expect(t.signatures[issuer.address]).not.toBeNull();
    expect(t.signatures[recovery.address]).not.toBeNull();
    expect(t.signatures[w2]).toBeNull();
    await expect(svc.prepareRebind(w1)).rejects.toThrow(/already linked/);

    // the chain records the proposal: the new wallet waits out the delay, a third wallet is blocked
    chain.persons.set(pda, { wallet: w1, pendingWallet: w2, pendingWalletAt: nowSec() + 3n * 86_400n });
    expect(await svc.status(w2)).toMatchObject({ next: "pending", person: { pendingWallet: w2 } });
    await expect(svc.prepareRebind(w2)).rejects.toThrow(/pending until/);
    const w3 = (await generateKeyPairSigner()).address;
    expect(await approve(w3)).toBe("issued");
    expect(await svc.status(w3)).toMatchObject({ next: "blocked" });
    await expect(svc.prepareRebind(w3)).rejects.toThrow(/already pending/);

    // delay over: finalize, paid by the new wallet itself (no issuer signature needed)
    chain.persons.set(pda, { wallet: w1, pendingWallet: w2, pendingWalletAt: nowSec() - 1n });
    expect((await svc.status(w2)).next).toBe("finalize");
    const f = tx(await svcSponsored.prepareRebind(w2));
    expect(f).toMatchObject({ sponsored: false, feePayer: w2, kind: "finalize" });
    expect(Object.keys(decode(f.transaction).signatures)).toEqual([w2]);
    expect(await store.getRecovery(id)).toBeNull();

    // after the chain moves, the old wallet shows as replaced
    chain.persons.set(pda, { wallet: w2 });
    chain.members.set(w1, { person: pda, retired: true });
    chain.members.set(w2, { person: pda, retired: false });
    expect(await svc.status(w1)).toMatchObject({ next: "blocked", member: { retired: true } });
    expect((await svc.status(w2)).next).toBe("done");
  });

  it("holds a recovery request for the review period, one request per person, and lets the wallet withdraw it", async () => {
    svc = make({ recoveryReviewSec: 3_600 });
    await approve(w1);
    const id = (await store.getWallet(w1))!.personId!;
    const [pda] = await findPersonPda(POOL, fromHex(id));
    chain.persons.set(pda, { wallet: w1 });
    await approve(w2);
    const r = await svc.prepareRebind(w2);
    expect(r).toEqual({ kind: "review", readyAt: Math.floor(now() / 1000) + 3_600 });
    expect(await svc.status(w2)).toMatchObject({ next: "review", person: { reviewUntil: Math.floor(now() / 1000) + 3_600 } });
    const w3 = (await generateKeyPairSigner()).address;
    await approve(w3);
    expect((await svc.status(w3)).next).toBe("blocked");
    await expect(svc.prepareRebind(w3)).rejects.toThrow(/already requested/);
    clock += 1_800_000;
    expect(await svc.prepareRebind(w2)).toEqual(r); // same request, same deadline
    clock += 1_800_000;
    expect((await svc.status(w2)).next).toBe("recover");
    expect(tx(await svc.prepareRebind(w2)).kind).toBe("propose");
    expect(await svc.cancelRecovery(w2)).toBe(true);
    expect(await svc.cancelRecovery(w2)).toBe(false);
    expect((await svc.status(w3)).next).toBe("recover");
    // a ban drops the request too
    await svc.prepareRebind(w3);
    await svc.ban(id);
    expect(await store.getRecovery(id)).toBeNull();
  });

  it("refuses recovery for a barred person and without a recovery key", async () => {
    await approve(w1);
    const id = (await store.getWallet(w1))!.personId!;
    const [pda] = await findPersonPda(POOL, fromHex(id));
    chain.persons.set(pda, { wallet: w1, ineligibleUntil: PERMANENT });
    await approve(w2);
    expect(await svc.status(w2)).toMatchObject({ next: "recover", person: { ineligible: true } });
    await expect(svc.prepareRebind(w2)).rejects.toMatchObject({ status: 403 });
    chain.persons.set(pda, { wallet: w1 });
    const noRecovery = make({ recovery: undefined });
    await expect(noRecovery.prepareRebind(w2)).rejects.toMatchObject({ status: 503 });
    chain.pool = { ...chain.pool!, recoveryAuthority: w1 };
    await expect(svc.prepareRebind(w2)).rejects.toMatchObject({ status: 500 });
  });

  it("refuses to sign when the pool names another issuer", async () => {
    await approve(w1);
    chain.pool = { ...chain.pool!, issuer: w2 };
    await expect(svc.prepareJoin(w1)).rejects.toThrow(IdentityError);
    await expect(svc.prepareJoin(w1)).rejects.toMatchObject({ status: 500 });
  });
});
