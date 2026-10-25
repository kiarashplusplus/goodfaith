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
import { MemoryNotifier } from "./notify";
import { MemoryStore, PERMANENT_UNTIL } from "./store";
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
  frozen = new Set<string>();
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
  async freeze(owner: Address) {
    if (this.issued.has(owner)) this.frozen.add(owner);
  }
  async unfreeze(owner: Address) {
    this.frozen.delete(owner);
  }
  async renew(owner: Address, expireSec: number) {
    if (this.fail) throw new Error("rpc down");
    this.issued.set(owner, expireSec);
    return owner;
  }
  async active(owner: Address) {
    return this.issued.has(owner) && !this.frozen.has(owner) ? (owner as Address) : null;
  }
  async pass(owner: Address) {
    const exp = this.issued.get(owner);
    if (exp === undefined) return null;
    return { address: owner, state: this.frozen.has(owner) ? ("frozen" as const) : ("active" as const), expiresAt: exp };
  }
}

const rpc = {
  getLatestBlockhash: () => ({
    send: async () => ({ value: { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n } }),
  }),
} as unknown as ConstructorParameters<typeof IdentityService>[0]["rpc"];

let provider: MockProvider, store: MemoryStore, gk: FakeGatekeeper, issuer: KeyPairSigner, recovery: KeyPairSigner, svc: IdentityService;
let notes: MemoryNotifier;
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
    rpc,
    keyring: keyring(),
    notifier: notes,
    now,
    feePayer: async () => null,
    recoveryMinAgeSec: 0,
    ...over,
  });

beforeEach(async () => {
  clock = 1_760_000_000_000;
  provider = new MockProvider("s");
  store = new MemoryStore();
  gk = new FakeGatekeeper();
  notes = new MemoryNotifier();
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
    // anyone may ask for a wallet's status, so the check's one-time link is only in the wallet's own (signed) view
    const pub = await svc.status(w1);
    expect(pub).toMatchObject({ status: "pending", next: "wait", detailsHidden: true });
    expect(pub.url).toBeUndefined();
    expect(await svc.status(w1, { details: true })).toMatchObject({ status: "pending", url: a.url });
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
    // the reason says a person's age or state: not in the public view, only in the wallet's own
    for (const w of [w1, w2]) {
      const pub = await svc.status(w);
      expect(pub).toMatchObject({ status: "ineligible", next: "blocked", detailsHidden: true });
      expect(pub.reason).toBeUndefined();
    }
    expect((await svc.status(w2, { details: true })).reason).toBe("You must be 18 or older.");
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

  it("refuses a permanently banned person on any wallet, freezing every pass they hold until the bar is lifted", async () => {
    await approve(w1);
    await approve(w2); // the same person verified from a second wallet earlier
    const id = (await store.getWallet(w1))!.personId!;
    expect(await svc.ban(id)).toEqual({ banned: true, until: PERMANENT_UNTIL, permanent: true, frozen: [w1, w2], unfrozen: [] });
    expect([...gk.frozen]).toEqual([w1, w2]);
    expect(gk.revoked).toEqual([]);
    // the wallets keep their records: the bar is the person's, and reversible
    expect(await store.getWallet(w1)).toMatchObject({ status: "issued" });
    expect((await svc.status(w1)).pass).toEqual({ expiresAt: expect.any(Number), state: "frozen" });
    expect(notes.sent.map((e) => e.kind)).toEqual(["barred"]);
    const w3 = (await generateKeyPairSigner()).address;
    expect(await approve(w3)).toBe("ineligible"); // same ID fields, new wallet
    expect(await store.getWallet(w3)).toMatchObject({ reason: "This person can no longer use Good Faith." });
    // again: nothing new to freeze, no second notice
    expect(await svc.ban(id)).toEqual({ banned: true, until: PERMANENT_UNTIL, permanent: true, frozen: [], unfrozen: [] });
    expect(notes.sent).toHaveLength(1);
    // the chain relaxes the bar (a pay-back) or lifts it: the passes thaw
    const until = Math.floor(now() / 1000) + 86_400;
    expect(await svc.ban(id, until)).toEqual({ banned: true, until, permanent: false, frozen: [], unfrozen: [w1, w2] });
    expect(gk.frozen.size).toBe(0);
    expect(await svc.ban(id, 0)).toEqual({ banned: false, until: null, permanent: false, frozen: [], unfrozen: [] });
    expect(notes.sent.map((e) => e.kind)).toEqual(["barred", "barred", "bar_lifted"]);
    expect(await svc.ban("00".repeat(32))).toEqual({ banned: false, until: null, permanent: false, frozen: [], unfrozen: [] });
  });

  it("records a temporary bar without freezing anything, tells the member, and lifts it on request", async () => {
    await svc.start(w1, "member@example.test");
    const { inquiryId } = (await store.getWallet(w1))!;
    expect(await svc.handleWebhook(new Headers(provider.sign()), provider.decide(inquiryId, "approved"))).toBe("issued");
    const id = (await store.getWallet(w1))!.personId!;
    expect(await store.getPerson(id)).toMatchObject({ contact: "member@example.test" });
    const until = Math.floor(now() / 1000) + 86_400;
    expect(await svc.ban(id, until)).toEqual({ banned: true, until, permanent: false, frozen: [], unfrozen: [] });
    expect(await svc.ban(id, until)).toEqual({ banned: true, until, permanent: false, frozen: [], unfrozen: [] }); // idempotent, one notice
    expect(gk.frozen.size).toBe(0);
    expect(await store.getWallet(w1)).toMatchObject({ status: "issued" });
    expect(await store.getPerson(id)).toMatchObject({ bannedUntil: until });
    expect(notes.sent).toHaveLength(1);
    expect(notes.sent[0]).toMatchObject({ kind: "barred", personId: id, contact: "member@example.test", data: { until } });
    // the person may still verify a new wallet (to recover and to collect what they are owed)
    expect(await approve(w2)).toBe("issued");
    // the bar ends by itself...
    clock += 2 * 86_400_000;
    expect(await approve((await generateKeyPairSigner()).address)).toBe("issued");
    // ...or is lifted (the authority's lift_bar, mirrored by the admin CLI)
    expect(await svc.ban(id, 0)).toEqual({ banned: false, until: null, permanent: false, frozen: [], unfrozen: [] });
    expect((await store.getPerson(id))!.bannedUntil).toBeUndefined();
    expect(notes.sent.at(-1)).toMatchObject({ kind: "bar_lifted", contact: "member@example.test" });
  });

  it("reconciles the chain's bars: sets the listed ones, lifts the rest, closes finished recoveries, retries notices", async () => {
    await approve(w1);
    const id = (await store.getWallet(w1))!.personId!;
    const [pda] = await findPersonPda(POOL, fromHex(id));
    chain.persons.set(pda, { wallet: w1 });
    const w3 = (await generateKeyPairSigner()).address;
    await approve(w3, { ...MOCK_FIELDS_TX, idNumber: "someone-else" });
    const id3 = (await store.getWallet(w3))!.personId!;
    const until = Math.floor(now() / 1000) + 86_400;
    // the cranker reports one bar; a stale stored bar on another person is lifted
    await svc.ban(id3, until);
    expect(await svc.reconcile([{ personId: id, until }])).toEqual({ barred: 1, lifted: 1, recoveriesClosed: [], noticesRetried: 0 });
    expect((await store.getPerson(id))!.bannedUntil).toBe(until);
    expect((await store.getPerson(id3))!.bannedUntil).toBeUndefined();
    // a recovery whose notice failed is retried; once proposed and finalised on chain it is closed
    notes.fail = true;
    await svc.setContact(w1, "m@example.test");
    expect(await approve(w2)).toBe("issued");
    expect((await svc.prepareRebind(w2)).kind).toBe("review");
    expect(await store.getRecovery(id)).toMatchObject({ delivery: "failed" });
    notes.fail = false;
    expect(await svc.reconcile([{ personId: id, until }])).toMatchObject({ noticesRetried: 1 });
    expect(await store.getRecovery(id)).toMatchObject({ delivery: "sent" });
    await expect(svc.prepareProposal(id, w2, recovery.address)).resolves.toMatchObject({ kind: "propose" });
    await svc.recoveryProposed(id, "sig1");
    chain.persons.set(pda, { wallet: w1, pendingWallet: w2, pendingWalletAt: nowSec() + 10n });
    expect((await svc.reconcile([])).recoveriesClosed).toEqual([]);
    chain.persons.set(pda, { wallet: w2 });
    expect((await svc.reconcile([])).recoveriesClosed).toEqual([{ personId: id, as: "finalized" }]);
    expect(await store.getRecovery(id)).toBeNull();
    expect(await store.getRecoveryHistory(id)).toMatchObject({ closedAs: "finalized", signature: "sig1" });
  });

  it("changes the contact only from the person's current wallet, and tells the previous contact", async () => {
    await svc.start(w1, "first@example.test");
    const { inquiryId } = (await store.getWallet(w1))!;
    expect(await svc.handleWebhook(new Headers(provider.sign()), provider.decide(inquiryId, "approved"))).toBe("issued");
    const id = (await store.getWallet(w1))!.personId!;
    const [pda] = await findPersonPda(POOL, fromHex(id));
    chain.persons.set(pda, { wallet: w1 });
    // a second wallet verifying with a contact of its own does not replace the member's
    await svc.start(w2, "thief@example.test");
    const second = (await store.getWallet(w2))!;
    expect(await svc.handleWebhook(new Headers(provider.sign()), provider.decide(second.inquiryId, "approved"))).toBe("issued");
    expect((await store.getPerson(id))!.contact).toBe("first@example.test");
    await expect(svc.setContact(w2, "thief@example.test")).rejects.toMatchObject({ status: 403 });
    expect(await svc.setContact(w1, "second@example.test")).toEqual({ changed: true });
    expect(await svc.setContact(w1, "second@example.test")).toEqual({ changed: false });
    expect(notes.sent.at(-1)).toMatchObject({
      kind: "contact_changed",
      contact: "first@example.test",
      data: { to: "second@example.test" },
    });
    // the recovery notice goes to the contact on file and to the requester's own, if different
    expect((await svc.prepareRebind(w2)).kind).toBe("review");
    const sent = notes.sent.filter((e) => e.kind === "recovery_requested").map((e) => e.contact);
    expect(sent.sort()).toEqual(["second@example.test", "thief@example.test"]);
  });

  it("clears the previous email from the records of the person's older wallets when it is removed", async () => {
    await svc.start(w1, "first@example.test");
    const { inquiryId } = (await store.getWallet(w1))!;
    expect(await svc.handleWebhook(new Headers(provider.sign()), provider.decide(inquiryId, "approved"))).toBe("issued");
    const id = (await store.getWallet(w1))!.personId!;
    // the membership has moved to w2 (same person, same document); w1's record still holds the email
    await svc.start(w2);
    const second = (await store.getWallet(w2))!;
    expect(await svc.handleWebhook(new Headers(provider.sign()), provider.decide(second.inquiryId, "approved"))).toBe("issued");
    const [pda] = await findPersonPda(POOL, fromHex(id));
    chain.persons.set(pda, { wallet: w2 });
    expect((await store.getWallet(w1))!.contact).toBe("first@example.test");
    expect(await svc.setContact(w2, undefined)).toEqual({ changed: true });
    expect((await store.getPerson(id))!.contact).toBeUndefined();
    expect((await store.getWallet(w1))!.contact).toBeUndefined();
    expect((await store.getWallet(w2))!.contact).toBeUndefined();
  });

  it("renews a pass for a member in good standing, not for a barred one", async () => {
    await approve(w1);
    const id = (await store.getWallet(w1))!.personId!;
    const [pda] = await findPersonPda(POOL, fromHex(id));
    chain.persons.set(pda, { wallet: w1 });
    chain.members.set(w1, { person: pda, retired: false });
    const issuedUntil = gk.issued.get(w1)!;
    expect((await svc.status(w1)).next).toBe("done");
    clock += 340 * 86_400_000; // 25 days before expiry: within the renewal window
    expect(await svc.status(w1)).toMatchObject({ next: "renew", pass: { expiresAt: issuedUntil, state: "active" } });
    const r = await svc.renew(w1);
    expect(r.expiresAt).toBe(Math.floor(now() / 1000) + 365 * 86_400);
    expect(gk.issued.get(w1)).toBe(r.expiresAt);
    expect((await svc.status(w1)).next).toBe("done");
    expect(notes.sent.at(-1)).toMatchObject({ kind: "pass_renewed", wallet: w1 });
    chain.persons.set(pda, { wallet: w1, ineligibleUntil: nowSec() + 100n });
    await expect(svc.renew(w1)).rejects.toMatchObject({ status: 403 });
    await expect(svc.renew(w2)).rejects.toMatchObject({ status: 409 });
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

  it("join is refused once the person is on chain; recovery is requested, proposed by the operator, then finalised", async () => {
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
      person: { onChain: true, currentWallet: w1, isThisWallet: false, pendingWallet: null, requestedAt: null, barredUntil: 0 },
    });
    expect(await svc.prepareRebind(w2)).toEqual({ kind: "review", requestedAt: Math.floor(now() / 1000) });
    expect(notes.sent.map((e) => e.kind)).toEqual(["recovery_requested"]);
    expect(notes.sent[0]).toMatchObject({ personId: id, wallet: w2, data: { currentWallet: w1 } });
    expect(await svc.status(w2)).toMatchObject({ next: "review", person: { requestedAt: Math.floor(now() / 1000) } });
    expect(await svc.prepareRebind(w2)).toEqual({ kind: "review", requestedAt: Math.floor(now() / 1000) }); // same request
    await expect(svc.prepareRebind(w1)).rejects.toThrow(/already linked/);
    const w3 = (await generateKeyPairSigner()).address;
    expect(await approve(w3)).toBe("issued");
    expect(await svc.status(w3)).toMatchObject({ next: "blocked" });
    await expect(svc.prepareRebind(w3)).rejects.toThrow(/already requested/);

    // the operator's queue and the issuer-signed proposal built for the recovery key (the CLI signs and sends it)
    expect(await svc.listRecoveries()).toEqual([
      {
        personId: id,
        newWallet: w2,
        inquiryId: expect.any(String),
        requestedAt: Math.floor(now() / 1000),
        hasContact: false,
        delivery: null,
        proposedAt: 0,
        onChain: true,
        currentWallet: w1,
        pendingWallet: null,
        pendingWalletAt: 0,
        barredUntil: 0,
      },
    ]);
    await expect(svc.prepareProposal(id, w2, w1)).rejects.toMatchObject({ status: 400 });
    await expect(svc.prepareProposal(id, w3, recovery.address)).rejects.toMatchObject({ status: 409 }); // not the recorded wallet
    await expect(svc.prepareProposal("00".repeat(32), w2, recovery.address)).rejects.toMatchObject({ status: 404 });
    // the member gets the minimum age to see the notice, unless the operator overrides
    const strict = make({ recoveryMinAgeSec: 3600 });
    await expect(strict.prepareProposal(id, w2, recovery.address)).rejects.toMatchObject({ status: 409 });
    expect((await strict.prepareProposal(id, w2, recovery.address, { force: true })).kind).toBe("propose");
    const p = await svc.prepareProposal(id, w2, recovery.address);
    expect(p).toMatchObject({ sponsored: false, feePayer: recovery.address, kind: "propose" });
    const t = decode(p.transaction);
    expect(Object.keys(t.signatures).sort()).toEqual([recovery.address, issuer.address].sort());
    expect(t.signatures[issuer.address]).not.toBeNull();
    expect(t.signatures[recovery.address]).toBeNull(); // the CLI adds it
    expect(await svc.recoveryProposed(id, "sig111")).toEqual({ notified: true });
    expect(notes.sent.at(-1)).toMatchObject({ kind: "recovery_proposed", wallet: w2, data: { signature: "sig111" } });
    expect(await store.getRecovery(id)).toMatchObject({ signature: "sig111", proposedAt: now() });
    expect((await svc.listRecoveries())[0]).toMatchObject({ proposedAt: Math.floor(now() / 1000) });
    // never twice; and the requester can no longer withdraw it (the old wallet vetoes on chain instead)
    await expect(svc.prepareProposal(id, w2, recovery.address)).rejects.toMatchObject({ status: 409 });
    await expect(svc.cancelRecovery(w2)).rejects.toMatchObject({ status: 409 });

    // the chain records the proposal: the new wallet waits out the delay, a third wallet is blocked
    chain.persons.set(pda, { wallet: w1, pendingWallet: w2, pendingWalletAt: nowSec() + 3n * 86_400n });
    expect(await svc.status(w2)).toMatchObject({ next: "pending", person: { pendingWallet: w2 } });
    await expect(svc.prepareRebind(w2)).rejects.toThrow(/pending until/);
    await expect(svc.prepareRebind(w3)).rejects.toThrow(/already pending/);
    await expect(svc.prepareProposal(id, w2, recovery.address)).rejects.toMatchObject({ status: 409 });

    // delay over: finalize, paid by the new wallet itself (no issuer signature needed)
    chain.persons.set(pda, { wallet: w1, pendingWallet: w2, pendingWalletAt: nowSec() - 1n });
    expect((await svc.status(w2)).next).toBe("finalize");
    const f = tx(await svc.prepareRebind(w2));
    expect(f).toMatchObject({ sponsored: false, feePayer: w2, kind: "finalize" });
    expect(Object.keys(decode(f.transaction).signatures)).toEqual([w2]);
    expect(await store.getRecovery(id)).toBeNull();
    expect(await store.getRecoveryHistory(id)).toMatchObject({ closedAs: "finalized" });

    // after the chain moves, the old wallet shows as replaced
    chain.persons.set(pda, { wallet: w2 });
    chain.members.set(w1, { person: pda, retired: true });
    chain.members.set(w2, { person: pda, retired: false });
    expect(await svc.status(w1)).toMatchObject({ next: "blocked", member: { retired: true } });
    expect((await svc.status(w2)).next).toBe("done");
  });

  it("a request can be withdrawn by the wallet or rejected by the operator; a permanent ban drops it", async () => {
    await approve(w1);
    const id = (await store.getWallet(w1))!.personId!;
    const [pda] = await findPersonPda(POOL, fromHex(id));
    chain.persons.set(pda, { wallet: w1 });
    await approve(w2);
    expect((await svc.prepareRebind(w2)).kind).toBe("review");
    expect(await svc.cancelRecovery(w2)).toBe(true);
    expect(await svc.cancelRecovery(w2)).toBe(false);
    expect((await svc.status(w2)).next).toBe("recover");
    const w3 = (await generateKeyPairSigner()).address;
    await approve(w3);
    expect((await svc.prepareRebind(w3)).kind).toBe("review");
    expect((await svc.status(w2)).next).toBe("blocked");
    expect(await svc.rejectRecovery(id)).toBe(true);
    expect(await svc.rejectRecovery(id)).toBe(false);
    expect(notes.sent.at(-1)).toMatchObject({ kind: "recovery_rejected", wallet: w3 });
    expect(await store.getRecoveryHistory(id)).toMatchObject({ closedAs: "rejected" });
    expect((await svc.status(w2)).next).toBe("recover");
    expect((await svc.prepareRebind(w3)).kind).toBe("review");
    await svc.ban(id);
    expect(await store.getRecovery(id)).toBeNull();
    expect(await store.getRecoveryHistory(id)).toMatchObject({ closedAs: "barred" });
  });

  it("a barred person may still recover (the bar follows them); a permanently banned one is refused", async () => {
    await approve(w1);
    const id = (await store.getWallet(w1))!.personId!;
    const [pda] = await findPersonPda(POOL, fromHex(id));
    const until = nowSec() + 30n * 86_400n;
    chain.persons.set(pda, { wallet: w1, ineligibleUntil: until });
    await svc.ban(id, Number(until));
    expect(await approve(w2)).toBe("issued");
    expect(await svc.status(w2)).toMatchObject({ next: "recover", person: { ineligible: true, barredUntil: Number(until) } });
    expect((await svc.prepareRebind(w2)).kind).toBe("review");
    expect((await svc.listRecoveries())[0]).toMatchObject({ barredUntil: Number(until) });
    expect((await svc.prepareProposal(id, w2, recovery.address)).kind).toBe("propose");
    chain.persons.set(pda, { wallet: w1, ineligibleUntil: PERMANENT });
    await svc.ban(id);
    const w3 = (await generateKeyPairSigner()).address;
    expect(await approve(w3)).toBe("ineligible");
    chain.pool = { ...chain.pool!, recoveryAuthority: w1 };
    await expect(svc.prepareProposal(id, w2, recovery.address)).rejects.toMatchObject({ status: 404 }); // the ban dropped the request
  });

  it("refuses to sign when the pool names another issuer", async () => {
    await approve(w1);
    chain.pool = { ...chain.pool!, issuer: w2 };
    await expect(svc.prepareJoin(w1)).rejects.toThrow(IdentityError);
    await expect(svc.prepareJoin(w1)).rejects.toMatchObject({ status: 500 });
    await store.putRecovery({ personId: (await store.getWallet(w1))!.personId!, newWallet: w2, openedAt: now() });
    await approve(w2);
    await expect(svc.prepareProposal((await store.getWallet(w1))!.personId!, w2, recovery.address)).rejects.toMatchObject({ status: 500 });
  });
});
