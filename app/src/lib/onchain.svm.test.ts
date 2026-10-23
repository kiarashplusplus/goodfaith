/**
 * The app's own instruction builders and reads, driven end to end against the compiled program in LiteSVM.
 * Transactions go through tx.ts exactly as the pages send them (build → simulate → sign → submit → confirm).
 * Run with `npm run test:svm` after `anchor build --arch v2`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { address, createNoopSigner, getBase64EncodedWireTransaction, signTransaction, type Address, type KeyPairSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import type { LiteSVM } from "litesvm";
import { getAcceptAuthorityInstruction, getInitializePoolInstructionAsync, getProposeAuthorityInstruction } from "@/generated";
import { POOL_MINT, PROGRAM_ID } from "./config";
import { escrowFor } from "./escrow";
import { loanTiming, SECONDS_PER_DAY } from "./loan-status";
import {
  cancelRequestIx,
  cosignLoanIx,
  donateIx,
  fetchCanonicalPool,
  fetchLoanById,
  fetchLoansFor,
  fetchMember,
  fetchPool,
  fetchRecentLoans,
  fetchRequest,
  fetchRequestsForCosigner,
  findAta,
  findEscrowPda,
  findPoolPda,
  findRequestPda,
  friendlyError,
  markDefaultIx,
  registerMemberIx,
  repayIx,
  requestLoanIx,
  type Loan,
  type Pool,
} from "./program";
import { buildTransaction, sendInstructions } from "./tx";
import { gatewayTokenAddress } from "./civic-addr";
import { actor, admin, NETWORK, newSvm, plantAta, plantMint, setTime, T0, tokenAmount } from "./svm/fixtures";
import { svmRpc, type SvmRpc } from "./svm/rpc";

const USDC = 1_000_000n;
const MINT_B = address("BiJ1fzcq8BcDQrdUDGNaGK9Jq7oxEmXb9iBFJyKMEdw8");
const PARAMS = {
  gatekeeperNetwork: NETWORK,
  maxLoan: 1000n * USDC,
  maxTermDays: 90,
  graceDays: 7,
  maxGuaranteesPerMember: 2,
  cosignerEscrowBps: 2500,
};
const gw = (w: Address) => gatewayTokenAddress(w, NETWORK);

let svm: LiteSVM;
let rpc: SvmRpc;
let adm: KeyPairSigner,
  donor: KeyPairSigner,
  borrower: KeyPairSigner,
  cosigner: KeyPairSigner,
  third: KeyPairSigner,
  borrower2: KeyPairSigner,
  stranger: KeyPairSigner;
let poolA: Pool, poolB: Pool;
let loanA0: Loan, loanA1: Loan, loanB0: Loan;

/** Runs `p`, expects it to fail with the given program error code, and returns the user-facing copy. */
async function expectCode(p: Promise<unknown>, code: number): Promise<string> {
  try {
    await p;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    expect(msg, "error should carry the program code").toMatch(new RegExp(`"Custom":${code}\\b|0x${code.toString(16)}\\b`));
    return friendlyError(e);
  }
  throw new Error(`expected failure with code ${code}`);
}

/** Multi-signer send (payer ≠ wallet), the shape a sponsored Kora transaction has. */
async function sendSigned(feePayer: KeyPairSigner, signers: KeyPairSigner[], ixs: Parameters<typeof buildTransaction>[2]) {
  const tx = await buildTransaction(rpc, feePayer.address, ixs);
  const signed = await signTransaction(
    [feePayer, ...signers].map((s) => s.keyPair),
    tx,
  );
  return rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
}

const ataCreate = (payer: Address, ata: Address, owner: Address, mint: Address) =>
  getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer), ata, owner, mint });

beforeAll(async () => {
  svm = newSvm();
  rpc = svmRpc(svm);
  plantMint(svm, POOL_MINT);
  plantMint(svm, MINT_B);
  adm = await admin();
  svm.airdrop(adm.address, 10_000_000_000n as never);
  donor = await actor(svm, { usdc: 5000n * USDC, mint: POOL_MINT, gateway: false });
  await plantAta(svm, donor.address, MINT_B, 5000n * USDC);
  borrower = await actor(svm); // no ATA on purpose: the co-sign prefix creates it
  cosigner = await actor(svm, { usdc: 500n * USDC, mint: POOL_MINT });
  await plantAta(svm, cosigner.address, MINT_B, 500n * USDC);
  third = await actor(svm, { usdc: 200n * USDC, mint: POOL_MINT });
  borrower2 = await actor(svm);
  stranger = await actor(svm, { gateway: false });
});

describe("pool", () => {
  it("initialises both pools and the app pins the canonical one", async () => {
    for (const mint of [POOL_MINT, MINT_B]) {
      const ix = await getInitializePoolInstructionAsync({ payer: adm, mint, params: PARAMS }, { programAddress: PROGRAM_ID });
      await sendInstructions(rpc, adm, [ix]);
    }
    const a = await fetchCanonicalPool(rpc);
    expect(a).not.toBeNull();
    poolA = a!;
    expect(poolA.authority).toBe(adm.address);
    expect(poolA.gatekeeperNetwork).toBe(NETWORK);
    expect(poolA.loanCount).toBe(0n);
    const [pb] = await findPoolPda(MINT_B);
    poolB = (await fetchPool(rpc, pb))!;
    expect(poolB.mint).toBe(MINT_B);
  });

  it("takes donations through the real send path and maps a zero amount", async () => {
    await sendInstructions(rpc, donor, [await donateIx({ donor: donor.address, pool: poolA, amount: 1000n * USDC })]);
    await sendInstructions(rpc, donor, [await donateIx({ donor: donor.address, pool: poolB, amount: 1000n * USDC })]);
    expect(tokenAmount(svm, poolA.vault)).toBe(1000n * USDC);
    poolA = (await fetchCanonicalPool(rpc))!;
    expect(poolA.totalDonated).toBe(1000n * USDC);
    // simulate path (JSON error shape)
    expect(await expectCode(sendInstructions(rpc, donor, [await donateIx({ donor: donor.address, pool: poolA, amount: 0n })]), 6000)).toBe(
      "Enter an amount greater than zero.",
    );
    // send path without preflight simulation (hex error shape)
    expect(await expectCode(sendSigned(donor, [], [await donateIx({ donor: donor.address, pool: poolA, amount: 0n })]), 6000)).toBe(
      "Enter an amount greater than zero.",
    );
  });
});

describe("authority handover", () => {
  it("is two-step and the app notices the pending key, then refuses a pool it no longer recognises", async () => {
    const next = await actor(svm, { gateway: false });
    const propose = (authority: KeyPairSigner, newAuthority: Address) =>
      getProposeAuthorityInstruction({ authority, pool: poolA.address, newAuthority }, { programAddress: PROGRAM_ID });
    expect(await expectCode(sendInstructions(rpc, next, [propose(next, next.address)]), 6012)).toBe("You're not allowed to do that.");
    await sendInstructions(rpc, adm, [propose(adm, next.address)]);
    poolA = (await fetchCanonicalPool(rpc))!;
    expect(poolA.pendingAuthority).toBe(next.address);
    expect(poolA.authority).toBe(adm.address);

    await sendInstructions(rpc, next, [
      getAcceptAuthorityInstruction({ newAuthority: next, pool: poolA.address }, { programAddress: PROGRAM_ID }),
    ]);
    const fresh = (await fetchPool(rpc, poolA.address))!;
    expect(fresh).toMatchObject({ authority: next.address, pendingAuthority: null });
    // The pinned NEXT_PUBLIC_POOL_AUTHORITY is now stale, so the app refuses the pool until the config is updated.
    await expect(fetchCanonicalPool(rpc)).rejects.toThrow(/different authority/);

    // Hand it back so the rest of the suite keeps using the pinned admin.
    await sendInstructions(rpc, next, [propose(next, adm.address)]);
    await sendInstructions(rpc, adm, [
      getAcceptAuthorityInstruction({ newAuthority: adm, pool: poolA.address }, { programAddress: PROGRAM_ID }),
    ]);
    poolA = (await fetchCanonicalPool(rpc))!;
    expect(poolA).toMatchObject({ authority: adm.address, pendingAuthority: null });
  });
});

describe("membership", () => {
  it("registers members, including one whose rent a sponsor pays", async () => {
    const reg = (w: KeyPairSigner, pool: Pool, payer = w.address) =>
      registerMemberIx({ wallet: w.address, payer, pool, gatewayToken: gw(w.address) });
    await sendInstructions(rpc, borrower, [await reg(borrower, poolA)]);
    await sendInstructions(rpc, cosigner, [await reg(cosigner, poolA)]);
    await sendSigned(adm, [borrower2], [await reg(borrower2, poolA, adm.address)]);
    await sendInstructions(rpc, borrower, [await reg(borrower, poolB)]);
    await sendInstructions(rpc, cosigner, [await reg(cosigner, poolB)]);
    const m = await fetchMember(rpc, poolA.address, borrower2.address);
    expect(m).toMatchObject({ wallet: borrower2.address, activeLoan: null, activeGuarantees: 0, ineligible: false });
    expect(await fetchMember(rpc, poolA.address, stranger.address)).toBeNull();
  });

  it("rejects someone else's gateway token", async () => {
    const copy = await expectCode(
      sendInstructions(rpc, stranger, [
        await registerMemberIx({ wallet: stranger.address, payer: stranger.address, pool: poolA, gatewayToken: gw(borrower.address) }),
      ]),
      6007,
    );
    expect(copy).toBe("A valid Civic Pass is needed (it may have expired).");
  });
});

describe("request and co-sign", () => {
  const request = (b: KeyPairSigner, pool: Pool, amount: bigint, termDays: number) =>
    requestLoanIx({
      payer: b.address,
      borrower: b.address,
      pool,
      borrowerGatewayToken: gw(b.address),
      amount,
      termDays,
      cosigner: cosigner.address,
    });

  it("lists only this pool's requests for the co-signer", async () => {
    await sendInstructions(rpc, borrower, [await request(borrower, poolA, 100n * USDC, 7)]);
    await sendInstructions(rpc, borrower, [await request(borrower, poolB, 100n * USDC, 30)]);
    const forA = await fetchRequestsForCosigner(rpc, poolA.address, cosigner.address);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.address).toBe((await findRequestPda(poolA.address, borrower.address))[0]);
    expect(forA[0]).toMatchObject({ borrower: borrower.address, cosigner: cosigner.address, amount: 100n * USDC, termDays: 7 });
    expect(await fetchRequestsForCosigner(rpc, poolB.address, cosigner.address)).toHaveLength(1);
    expect(await fetchRequestsForCosigner(rpc, poolA.address, stranger.address)).toHaveLength(0);
    expect(await fetchRequest(rpc, poolA.address, borrower.address)).toEqual(forA[0]);
  });

  async function cosign(stale: Pool, b: KeyPairSigner, over: Partial<{ expectedAmount: bigint; maxEscrow: bigint }> = {}) {
    // The loan PDA comes from pool.loanCount, so use a fresh pool like the page's polling does.
    const pool = (await fetchPool(rpc, stale.address))!;
    const req = (await fetchRequest(rpc, pool.address, b.address))!;
    const escrow = escrowFor(req.amount, pool.cosignerEscrowBps);
    return sendInstructions(rpc, cosigner, async (feePayer) => {
      const { ix, borrowerToken } = await cosignLoanIx({
        payer: feePayer,
        pool,
        request: req,
        borrowerGatewayToken: gw(req.borrower),
        cosignerGatewayToken: gw(req.cosigner),
        expectedAmount: over.expectedAmount ?? req.amount,
        expectedTermDays: req.termDays,
        maxEscrow: over.maxEscrow ?? escrow,
      });
      return [ataCreate(feePayer, borrowerToken, req.borrower, pool.mint), ix];
    });
  }

  it("binds the co-signer to the terms they saw", async () => {
    expect(await expectCode(cosign(poolA, borrower, { expectedAmount: 99n * USDC }), 6015)).toBe(
      "The request changed. Please review again.",
    );
    expect(await expectCode(cosign(poolA, borrower, { maxEscrow: 1n }), 6016)).toBe(
      "The escrow is higher than what you were shown. Please review again.",
    );
  });

  it("opens the loan, creating the borrower's token account on the way", async () => {
    const vaultBefore = tokenAmount(svm, poolA.vault);
    await cosign(poolA, borrower);
    loanA0 = (await fetchLoanById(rpc, poolA.address, 0n))!;
    expect(loanA0).toMatchObject({
      id: 0n,
      borrower: borrower.address,
      cosigner: cosigner.address,
      rentPayer: cosigner.address,
      principal: 100n * USDC,
      repaid: 0n,
      escrowed: 25n * USDC,
      graceDays: 7,
      status: "Active",
    });
    expect(loanA0.dueAt).toBe(T0 + 7n * SECONDS_PER_DAY);
    expect(tokenAmount(svm, await findAta(borrower.address, POOL_MINT))).toBe(100n * USDC);
    expect(tokenAmount(svm, await findAta(cosigner.address, POOL_MINT))).toBe(475n * USDC);
    expect(tokenAmount(svm, poolA.vault)).toBe(vaultBefore - 100n * USDC);
    expect(await fetchRequest(rpc, poolA.address, borrower.address)).toBeNull();
    expect((await fetchMember(rpc, poolA.address, borrower.address))!.activeLoan).toBe(loanA0.address);
    expect((await fetchMember(rpc, poolA.address, cosigner.address))!.activeGuarantees).toBe(1);
  });

  it("opens a second pool-A loan and a pool-B loan for the history tests", async () => {
    await sendInstructions(rpc, borrower2, [await request(borrower2, poolA, 100n * USDC, 7)]);
    await cosign(poolA, borrower2);
    await cosign(poolB, borrower);
    poolA = (await fetchCanonicalPool(rpc))!;
    poolB = (await fetchPool(rpc, poolB.address))!;
    expect(poolA.loanCount).toBe(2n);
    loanA1 = (await fetchLoanById(rpc, poolA.address, 1n))!;
    loanB0 = (await fetchLoanById(rpc, poolB.address, 0n))!;
    expect(loanA1.borrower).toBe(borrower2.address);
    expect(loanB0).toMatchObject({ id: 0n, borrower: borrower.address, principal: 100n * USDC });
    expect(loanB0.address).not.toBe(loanA0.address);
  });

  it("lists the pool's recent loans newest first, this pool only", async () => {
    expect((await fetchRecentLoans(rpc, poolA)).map((l) => l.id)).toEqual([1n, 0n]);
    expect((await fetchRecentLoans(rpc, poolA, 1)).map((l) => l.id)).toEqual([1n]);
    expect((await fetchRecentLoans(rpc, poolB)).map((l) => l.address)).toEqual([loanB0.address]);
  });

  it("finds a wallet's loans in this pool only, newest first", async () => {
    expect((await fetchLoansFor(rpc, poolA, borrower.address)).map((l) => l.address)).toEqual([loanA0.address]);
    expect((await fetchLoansFor(rpc, poolA, cosigner.address)).map((l) => l.id)).toEqual([1n, 0n]);
    expect((await fetchLoansFor(rpc, poolB, borrower.address)).map((l) => l.address)).toEqual([loanB0.address]);
    expect(await fetchLoansFor(rpc, poolA, stranger.address)).toEqual([]);
  });
});

describe("repay", () => {
  it("takes a partial payment from anyone and rejects over-payment", async () => {
    await sendInstructions(rpc, third, [await repayIx({ payer: third.address, pool: poolA, loan: loanA0, amount: 40n * USDC })]);
    loanA0 = (await fetchLoanById(rpc, poolA.address, 0n))!;
    expect(loanA0.repaid).toBe(40n * USDC);
    expect(tokenAmount(svm, await findAta(third.address, POOL_MINT))).toBe(160n * USDC);
    expect(
      await expectCode(
        sendInstructions(rpc, third, [await repayIx({ payer: third.address, pool: poolA, loan: loanA0, amount: 61n * USDC })]),
        6009,
      ),
    ).toBe("That is more than what is still owed.");
  });

  it("closes the loan on full repayment and returns the escrow and its rent", async () => {
    const cosignerSol = svm.getBalance(cosigner.address)!;
    await sendInstructions(rpc, borrower, [await repayIx({ payer: borrower.address, pool: poolA, loan: loanA0, amount: 60n * USDC })]);
    loanA0 = (await fetchLoanById(rpc, poolA.address, 0n))!;
    expect(loanA0).toMatchObject({ status: "Repaid", repaid: 100n * USDC });
    expect(tokenAmount(svm, await findAta(cosigner.address, POOL_MINT))).toBe(450n * USDC + 25n * USDC); // 500 - 25 (loan A1 escrow) - 25 + 25
    const [escrow] = await findEscrowPda(loanA0.address);
    expect(svm.getAccount(escrow).exists).toBe(false);
    expect(svm.getBalance(cosigner.address)!).toBeGreaterThan(cosignerSol); // escrow rent back to the rent payer
    expect((await fetchMember(rpc, poolA.address, borrower.address))!.activeLoan).toBeNull();
    expect((await fetchMember(rpc, poolA.address, cosigner.address))!.activeGuarantees).toBe(1); // loan A1 still open
    expect((await fetchCanonicalPool(rpc))!.totalRepaid).toBe(100n * USDC);
    // A closed loan has no escrow account, which Anchor checks before the status, so the error is AccountNotInitialized (3012).
    // The UI never offers Pay on a closed loan; this pins the behaviour.
    await expectCode(sendInstructions(rpc, third, [await repayIx({ payer: third.address, pool: poolA, loan: loanA0, amount: 1n })]), 3012);
  });
});

describe("cancel request", () => {
  const request = () =>
    requestLoanIx({
      payer: borrower.address,
      borrower: borrower.address,
      pool: poolA,
      borrowerGatewayToken: gw(borrower.address),
      amount: 10n * USDC,
      termDays: 5,
      cosigner: cosigner.address,
    });

  it("lets the borrower or the named co-signer cancel, nobody else", async () => {
    await sendInstructions(rpc, borrower, [await request()]);
    let req = (await fetchRequest(rpc, poolA.address, borrower.address))!;
    const rent = svm.getBalance(borrower.address)!;
    await sendInstructions(rpc, borrower, [cancelRequestIx({ canceller: borrower.address, pool: poolA.address, request: req })]);
    expect(await fetchRequest(rpc, poolA.address, borrower.address)).toBeNull();
    expect(svm.getBalance(borrower.address)!).toBeGreaterThan(rent - 10_000n); // rent back, minus the tx fee

    await sendInstructions(rpc, borrower, [await request()]);
    req = (await fetchRequest(rpc, poolA.address, borrower.address))!;
    expect(
      await expectCode(
        sendInstructions(rpc, stranger, [cancelRequestIx({ canceller: stranger.address, pool: poolA.address, request: req })]),
        6012,
      ),
    ).toBe("You're not allowed to do that.");
    await sendInstructions(rpc, cosigner, [cancelRequestIx({ canceller: cosigner.address, pool: poolA.address, request: req })]);
    expect(await fetchRequest(rpc, poolA.address, borrower.address)).toBeNull();
  });
});

describe("default", () => {
  const markDefault = (caller: KeyPairSigner, pool: Pool, loan: Loan) =>
    sendInstructions(rpc, caller, async (feePayer) => {
      const { ix, cosignerToken } = await markDefaultIx({ caller: caller.address, pool, loan });
      return [ataCreate(feePayer, cosignerToken, loan.cosigner, pool.mint), ix];
    });

  it("refuses before the grace period ends, then anyone can mark it", async () => {
    expect(await expectCode(markDefault(third, poolA, loanA1), 6011)).toBe("The grace period hasn't ended yet.");
    const deadline = loanA1.dueAt + BigInt(loanA1.graceDays) * SECONDS_PER_DAY;
    setTime(svm, deadline + 1n);
    const vault = tokenAmount(svm, poolA.vault);
    await markDefault(third, poolA, loanA1);
    loanA1 = (await fetchLoanById(rpc, poolA.address, 1n))!;
    expect(loanA1.status).toBe("Defaulted");
    expect(tokenAmount(svm, poolA.vault)).toBe(vault + 25n * USDC); // escrow fully absorbed
    const p = (await fetchCanonicalPool(rpc))!;
    expect(p.totalRecovered).toBe(25n * USDC);
    expect(p.totalLost).toBe(75n * USDC);
    expect((await fetchMember(rpc, poolA.address, borrower2.address))!.ineligible).toBe(true);
    expect(await fetchMember(rpc, poolA.address, cosigner.address)).toMatchObject({ ineligible: true, activeGuarantees: 0 });
    await expectCode(markDefault(third, poolA, loanA1), 3012); // escrow already closed; see the repay test
  });

  it("agrees with loanTiming at the exact boundary", async () => {
    const deadline = loanB0.dueAt + BigInt(loanB0.graceDays) * SECONDS_PER_DAY;
    setTime(svm, deadline);
    expect(loanTiming(loanB0, deadline).state).toBe("overdue");
    await expectCode(markDefault(stranger, poolB, loanB0), 6011);
    setTime(svm, deadline + 1n);
    expect(loanTiming(loanB0, deadline + 1n).state).toBe("defaultable");
    await markDefault(stranger, poolB, loanB0);
    expect((await fetchLoanById(rpc, poolB.address, 0n))!.status).toBe("Defaulted");
    expect(loanTiming((await fetchLoanById(rpc, poolB.address, 0n))!, deadline + 1n).state).toBe("defaulted");
  });
});
