import { describe, expect, it } from "vitest";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from "@solana/kit";
import {
  getCloseAccountInstruction,
  getCreateAssociatedTokenIdempotentInstruction,
  getCreateAssociatedTokenInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import { checkCaps, COMPUTE_BUDGET_PROGRAM, inspectTransaction, limitsFromEnv, utcDay } from "./sponsor-policy";

const PROGRAM = address("BM71D4Kdnq3Mtc2cqDuMBLyYguFihDqsjk9btdTWtoRd");
const payer = address("78DWc8FZ3iVru1z1jDy9wdPsTHqhGYiQRhtyVU6u9RHU");
const wallet = address("5MhvzaqhN3tqQ2F4tqYwu7MWFoMFzTXFibKvDC3wGqSU");
const other = address("uniqobk8oGh4XBLMqM68K8M2zNu3CdYX7q5go7whQiv");
const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ataW = address("Cm8TDDJ7KqqB2oxgsHGcB5iBjdorjrzPrw3dLpEtHR9u");
const ataO = address("BiJ1fzcq8BcDQrdUDGNaGK9Jq7oxEmXb9iBFJyKMEdw8");
const pool = address("gatem74V238djXdzWnJf94Wo1DcnuGkfijbf3AuBhfs");

const gf = (accounts: Address[], signer: Address = wallet): Instruction => ({
  programAddress: PROGRAM,
  accounts: [{ address: signer, role: AccountRole.READONLY_SIGNER }, ...accounts.map((a) => ({ address: a, role: AccountRole.WRITABLE }))],
  data: new Uint8Array([1, 2, 3]),
});
const budget: Instruction = { programAddress: COMPUTE_BUDGET_PROGRAM, data: new Uint8Array([2, 0, 0, 0, 0]) };
const memo: Instruction = {
  programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
  accounts: [{ address: wallet, role: AccountRole.READONLY_SIGNER }],
  data: new Uint8Array([104, 105]),
};
const create = (ata: Address, owner: Address, p: Address = payer) =>
  getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(p), ata, owner, mint });

function wire(ixs: Instruction[], feePayer: Address = payer): string {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}
const inspect = (ixs: Instruction[], feePayer?: Address) => inspectTransaction(wire(ixs, feePayer), { payer, programId: PROGRAM });

describe("inspectTransaction", () => {
  it("accepts Good Faith instructions, attributed to the first signer after the sponsor", () => {
    expect(inspect([gf([pool])])).toEqual({ ok: true, wallet, atas: [], goodFaithInstructions: 1 });
    expect(inspect([budget, gf([pool]), gf([pool, ataW])])).toMatchObject({ ok: true, goodFaithInstructions: 2 });
    // registrations and recovery proposals carry the issuer's (and the recovery authority's) signature as well
    const registration: Instruction = {
      programAddress: PROGRAM,
      accounts: [
        { address: wallet, role: AccountRole.WRITABLE_SIGNER },
        { address: other, role: AccountRole.READONLY_SIGNER },
        { address: pool, role: AccountRole.WRITABLE },
      ],
      data: new Uint8Array([9]),
    };
    expect(inspect([registration])).toMatchObject({ ok: true, wallet });
  });
  it("accepts a token account created for a Good Faith instruction or for the wallet itself", () => {
    // the co-sign prefix: the borrower's account, used by the cosign instruction that follows
    expect(inspect([create(ataO, other), gf([pool, ataO])])).toEqual({
      ok: true,
      wallet,
      atas: [{ ata: ataO, owner: other }],
      goodFaithInstructions: 1,
    });
    // the wallet's own account, with a transfer into it
    expect(
      inspect([
        create(ataW, wallet),
        getTransferCheckedInstruction({
          source: ataO,
          mint,
          destination: ataW,
          authority: createNoopSigner(wallet),
          amount: 1n,
          decimals: 6,
        }),
      ]),
    ).toMatchObject({ ok: true, atas: [{ ata: ataW, owner: wallet }] });
    // the non-idempotent variant counts the same (the wallet still has to sign something)
    expect(
      inspect([getCreateAssociatedTokenInstruction({ payer: createNoopSigner(payer), ata: ataW, owner: wallet, mint }), gf([pool])]),
    ).toMatchObject({ ok: true, atas: [{ ata: ataW, owner: wallet }] });
  });
  it("refuses a token account for a stranger on its own (rent farming)", () => {
    expect(inspect([create(ataO, other)])).toMatchObject({ ok: false, reason: /someone else/ });
    expect(inspect([create(ataO, other), gf([pool])])).toMatchObject({ ok: false, reason: /someone else/ });
    expect(inspect([create(ataO, other, wallet), gf([pool, ataO])])).toMatchObject({ ok: false, reason: /paid by the sponsor/ });
  });
  it("accepts the wallet's own token transfers and closes, nothing signed by someone else", () => {
    const transfer = getTransferInstruction({ source: ataW, destination: ataO, authority: createNoopSigner(wallet), amount: 5n });
    const close = getCloseAccountInstruction({ account: ataW, destination: wallet, owner: createNoopSigner(wallet) });
    expect(inspect([transfer])).toMatchObject({ ok: true, wallet });
    expect(inspect([close])).toMatchObject({ ok: true });
    const foreign = getTransferInstruction({ source: ataO, destination: ataW, authority: createNoopSigner(other), amount: 5n });
    expect(inspect([foreign, gf([pool])])).toMatchObject({ ok: false, reason: /signed by the wallet/ });
    expect(inspect([foreign, transfer])).toMatchObject({ ok: false, reason: /signed by the wallet|Extra signers/ });
    expect(inspect([getCloseAccountInstruction({ account: ataO, destination: other, owner: other })])).toMatchObject({
      ok: false,
      reason: /signed by the wallet/,
    });
  });
  it("refuses other programs, the wrong fee payer, extra signers, lookup tables and empty transactions", () => {
    expect(inspect([memo])).toMatchObject({ ok: false, reason: /not sponsored/ });
    expect(inspect([getTransferSolInstruction({ source: createNoopSigner(wallet), destination: other, amount: 1n })])).toMatchObject({
      ok: false,
      reason: /not sponsored/,
    });
    expect(inspect([gf([pool])], wallet)).toMatchObject({ ok: false, reason: /fee payer/ });
    expect(inspect([budget])).toMatchObject({ ok: false, reason: /wallet's signature/ }); // nobody but the payer signs
    expect(inspect([create(ataW, wallet)])).toMatchObject({ ok: false, reason: /wallet's signature/ });
    expect(inspect([budget, memo])).toMatchObject({ ok: false, reason: /not sponsored/ });
    expect(inspectTransaction("not base64!", { payer, programId: PROGRAM })).toMatchObject({ ok: false, reason: /decoded/ });
  });
});

describe("caps", () => {
  const limits = { dailyTxs: 2, totalAtas: 1 };
  const t0 = Date.UTC(2026, 9, 24, 12);
  const next = (r: ReturnType<typeof checkCaps>) => {
    if (!r.ok) throw new Error(r.reason);
    return r.next;
  };
  it("counts per UTC day and token accounts for ever", () => {
    const a = checkCaps(null, 0, limits, t0);
    expect(a).toEqual({ ok: true, next: { day: "2026-10-24", dayTxs: 1, atasTotal: 0 } });
    const b = checkCaps(next(a), 1, limits, t0 + 1000);
    expect(b).toEqual({ ok: true, next: { day: "2026-10-24", dayTxs: 2, atasTotal: 1 } });
    expect(checkCaps(next(b), 0, limits, t0 + 2000)).toMatchObject({ ok: false, reason: /today's/ });
    const c = checkCaps(next(b), 0, limits, t0 + 86_400_000);
    expect(c).toEqual({ ok: true, next: { day: "2026-10-25", dayTxs: 1, atasTotal: 1 } });
    expect(checkCaps(next(c), 1, limits, t0 + 86_400_000)).toMatchObject({ ok: false, reason: /token accounts/ });
    expect(utcDay(t0)).toBe("2026-10-24");
  });
  it("reads limits from the environment with defaults", () => {
    expect(limitsFromEnv({})).toEqual({ dailyTxs: 40, totalAtas: 12 });
    expect(limitsFromEnv({ SPONSOR_DAILY_TX_PER_WALLET: "5", SPONSOR_ATA_PER_WALLET: "2" })).toEqual({ dailyTxs: 5, totalAtas: 2 });
  });
});
