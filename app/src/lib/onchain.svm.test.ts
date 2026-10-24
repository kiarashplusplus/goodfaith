/**
 * The app's own instruction builders and reads, driven end to end against the compiled program in LiteSVM.
 * Transactions go through tx.ts exactly as the pages send them (build → simulate → sign → submit → confirm).
 * Run with `npm run test:svm` after `anchor build --arch v2`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { address, createNoopSigner, getBase64EncodedWireTransaction, signTransaction, type Address, type KeyPairSigner } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import type { LiteSVM } from "litesvm";
import {
  getAcceptAuthorityInstruction,
  getAnnounceWindDownInstruction,
  getInitializePoolInstructionAsync,
  getProposeAuthorityInstruction,
  getScheduleParamsInstruction,
} from "@/generated";
import { POOL_MINT, PROGRAM_ID } from "./config";
import { escrowFor } from "./escrow";
import { loanTiming, SECONDS_PER_DAY } from "./loan-status";
import {
  cancelRequestIx,
  claimEscrowIx,
  closeExpiredRequestIx,
  cosignLoanIx,
  cosignerWalletOf,
  donateIx,
  fetchCanonicalPool,
  fetchLoanById,
  fetchLoansFor,
  fetchMember,
  waiveReimbursementIx,
  forgiveFundClaimIx,
  fundClaim,
  cosignerClaim,
  owedAfterSettlement,
  fetchPerson,
  fetchPool,
  fetchRecentLoans,
  fetchRequest,
  fetchRequestsForCosigner,
  findAta,
  findEscrowPda,
  findPoolPda,
  findRequestPda,
  finalizeRebindIx,
  friendlyError,
  settleIx,
  collectRecoveryIx,
  restituteIx,
  pauseLendingIx,
  PERMANENT,
  proposeRebindIx,
  registerMemberIx,
  repayIx,
  requestLoanIx,
  resumeLendingIx,
  sweepToSuccessorIx,
  vetoRebindIx,
  windingDown,
  type Loan,
  type Pool,
} from "./program";
import { buildTransaction, sendInstructions } from "./tx";
import { gatewayTokenAddress } from "./gateway";
import { actor, admin, issuer, NETWORK, newSvm, personIdOf, plantAta, plantMint, setTime, T0, tokenAmount } from "./svm/fixtures";
import { svmRpc, type SvmRpc } from "./svm/rpc";

const USDC = 1_000_000n;
const MINT_B = address("BiJ1fzcq8BcDQrdUDGNaGK9Jq7oxEmXb9iBFJyKMEdw8");
let PARAMS: Parameters<typeof getScheduleParamsInstruction>[0]["params"];
const gw = (w: Address) => gatewayTokenAddress(w, NETWORK);

let svm: LiteSVM;
let rpc: SvmRpc;
let adm: KeyPairSigner,
  iss: KeyPairSigner,
  rec: KeyPairSigner,
  pauser: KeyPairSigner,
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
  iss = await issuer();
  rec = await actor(svm, { gateway: false });
  pauser = await actor(svm, { gateway: false });
  svm.airdrop(adm.address, 10_000_000_000n as never);
  PARAMS = {
    gatekeeperNetwork: NETWORK,
    maxLoan: 1000n * USDC,
    maxTermDays: 90,
    graceDays: 7,
    maxGuaranteesPerMember: 2,
    cosignerEscrowBps: 2500,
    issuer: iss.address,
    timelockSeconds: 0n,
    recoveryAuthority: rec.address,
    pauseAuthority: pauser.address,
    recoveryDelaySeconds: 3n * SECONDS_PER_DAY,
    successorAuthority: adm.address,
    requestTtlSeconds: 7n * SECONDS_PER_DAY,
    firstLoanCap: 1000n * USDC,
    loanCapStep: 100n * USDC,
    cooldownSeconds: 0n,
    maxExposurePerPerson: 10_000n * USDC,
    disbursementWindowSeconds: SECONDS_PER_DAY,
    disbursementCapPerWindow: 0n,
    defaultBanSeconds: PERMANENT,
    lateBanSeconds: 0n,
    cosignerBanSeconds: PERMANENT,
    seasoningSeconds: 0n,
    capStepIntervalSeconds: 0n,
    maxOutstandingPrincipal: 0n,
    maxTotalLent: 0n,
  };
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
    expect(poolA).toMatchObject({
      issuer: iss.address,
      timelockSeconds: 0n,
      pendingParams: null,
      windDownAt: null,
      successor: null,
      activeLoans: 0n,
      recoveryAuthority: rec.address,
      pauseAuthority: pauser.address,
      paused: false,
      pendingClaims: 0n,
      outstandingPrincipal: 0n,
      recoveriesPending: 0n,
      vaultClaims: 0n,
      recoveryDelaySeconds: 3n * SECONDS_PER_DAY,
      defaultBanSeconds: PERMANENT,
    });
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

/** Registration the way the identity service prepares it: wallet + fee payer + issuer signatures. */
const reg = async (w: KeyPairSigner, pool: Pool, payer = w.address, issuerKey: Address = iss.address) =>
  registerMemberIx({
    wallet: w.address,
    payer,
    issuer: issuerKey,
    pool,
    gatewayToken: await gw(w.address),
    personId: personIdOf(w.address),
  });

describe("membership", () => {
  it("registers members with the issuer's signature, including one whose rent a sponsor pays", async () => {
    await sendSigned(borrower, [iss], [await reg(borrower, poolA)]);
    await sendSigned(cosigner, [iss], [await reg(cosigner, poolA)]);
    await sendSigned(adm, [borrower2, iss], [await reg(borrower2, poolA, adm.address)]);
    await sendSigned(borrower, [iss], [await reg(borrower, poolB)]);
    await sendSigned(cosigner, [iss], [await reg(cosigner, poolB)]);
    const m = await fetchMember(rpc, poolA.address, borrower2.address);
    expect(m).toMatchObject({ wallet: borrower2.address, retired: false, activeLoan: null, activeGuarantees: 0, ineligible: false });
    expect(await fetchPerson(rpc, m!.person)).toMatchObject({
      wallet: borrower2.address,
      ineligibleUntil: 0n,
      completedLoans: 0,
      pendingWallet: null,
      personId: Buffer.from(personIdOf(borrower2.address)).toString("hex"),
    });
    expect(await fetchMember(rpc, poolA.address, stranger.address)).toBeNull();
  });

  it("refuses a registration the issuer did not sign", async () => {
    const copy = await expectCode(sendSigned(third, [adm], [await reg(third, poolA, third.address, adm.address)]), 6012);
    expect(copy).toBe("You're not allowed to do that.");
  });

  it("rejects someone else's gateway token", async () => {
    const copy = await expectCode(
      sendSigned(
        stranger,
        [iss],
        [
          await registerMemberIx({
            wallet: stranger.address,
            payer: stranger.address,
            issuer: iss.address,
            pool: poolA,
            gatewayToken: await gw(borrower.address),
            personId: personIdOf(stranger.address),
          }),
        ],
      ),
      6007,
    );
    expect(copy).toBe("A valid verification pass is needed (it may have expired).");
  });
});

const personOf = async (pool: Pool, w: Address) => (await fetchMember(rpc, pool.address, w))!.person;

describe("request and co-sign", () => {
  const request = async (b: KeyPairSigner, pool: Pool, amount: bigint, termDays: number) =>
    requestLoanIx({
      payer: b.address,
      borrower: b.address,
      borrowerPerson: await personOf(pool, b.address),
      pool,
      borrowerGatewayToken: await gw(b.address),
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
        borrowerPerson: await personOf(pool, req.borrower),
        cosignerPerson: await personOf(pool, req.cosigner),
        borrowerGatewayToken: await gw(req.borrower),
        cosignerGatewayToken: await gw(req.cosigner),
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
      borrowerPerson: await personOf(poolA, borrower.address),
      cosignerPerson: await personOf(poolA, cosigner.address),
      rentPayer: cosigner.address,
      principal: 100n * USDC,
      repaid: 0n,
      escrowed: 25n * USDC,
      graceDays: 7,
      status: "Active",
      closedAt: 0n,
      refundPending: 0n,
      shortfall: 0n,
      defaultBanSeconds: PERMANENT,
      lateBanSeconds: 0n,
      cosignerBanSeconds: PERMANENT,
    });
    expect(loanA0.dueAt).toBe(T0 + 7n * SECONDS_PER_DAY);
    expect(tokenAmount(svm, await findAta(borrower.address, POOL_MINT))).toBe(100n * USDC);
    expect(tokenAmount(svm, await findAta(cosigner.address, POOL_MINT))).toBe(475n * USDC);
    expect(tokenAmount(svm, poolA.vault)).toBe(vaultBefore - 100n * USDC);
    expect(await fetchRequest(rpc, poolA.address, borrower.address)).toBeNull();
    expect((await fetchMember(rpc, poolA.address, borrower.address))!.activeLoan).toBe(loanA0.address);
    expect((await fetchMember(rpc, poolA.address, cosigner.address))!.activeGuarantees).toBe(1);
    expect((await fetchCanonicalPool(rpc))!.activeLoans).toBe(1n);
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

  it("closes the loan on full repayment; the escrow waits in the loan until it is claimed", async () => {
    await sendInstructions(rpc, borrower, [await repayIx({ payer: borrower.address, pool: poolA, loan: loanA0, amount: 60n * USDC })]);
    loanA0 = (await fetchLoanById(rpc, poolA.address, 0n))!;
    expect(loanA0).toMatchObject({ status: "Repaid", repaid: 100n * USDC, refundPending: 25n * USDC });
    expect(loanA0.closedAt).toBe(svm.getClock().unixTimestamp);
    expect(tokenAmount(svm, await findAta(cosigner.address, POOL_MINT))).toBe(450n * USDC); // 500 - 25 (loan A1 escrow) - 25
    const [escrow] = await findEscrowPda(loanA0.address);
    expect(tokenAmount(svm, escrow)).toBe(25n * USDC);
    expect(await fetchMember(rpc, poolA.address, borrower.address)).toMatchObject({ activeLoan: null, completedLoans: 1 });
    expect((await fetchMember(rpc, poolA.address, cosigner.address))!.activeGuarantees).toBe(1); // loan A1 still open
    poolA = (await fetchCanonicalPool(rpc))!;
    expect(poolA).toMatchObject({ totalRepaid: 100n * USDC, pendingClaims: 25n * USDC, activeLoans: 1n });
  });

  it("lets anyone release the escrow to the co-signer's wallet, once", async () => {
    const cosignerSol = svm.getBalance(cosigner.address)!;
    const claim = (claimer: KeyPairSigner) =>
      sendInstructions(rpc, claimer, async (feePayer) => {
        const cosignerWallet = await cosignerWalletOf(rpc, loanA0);
        const { ix, cosignerToken } = await claimEscrowIx({ claimer: claimer.address, pool: poolA, loan: loanA0, cosignerWallet });
        return [ataCreate(feePayer, cosignerToken, cosignerWallet, poolA.mint), ix];
      });
    await claim(third);
    expect(tokenAmount(svm, await findAta(cosigner.address, POOL_MINT))).toBe(475n * USDC);
    const [escrow] = await findEscrowPda(loanA0.address);
    expect(svm.getAccount(escrow).exists).toBe(false);
    expect(svm.getBalance(cosigner.address)!).toBeGreaterThan(cosignerSol); // escrow rent back to the rent payer
    loanA0 = (await fetchLoanById(rpc, poolA.address, 0n))!;
    expect(loanA0.refundPending).toBe(0n);
    expect((await fetchCanonicalPool(rpc))!.pendingClaims).toBe(0n);
    // Nothing is pending any more, so the builder leaves the closed escrow out and the program says so.
    expect(await expectCode(claim(stranger), 6036)).toBe("Nothing to claim on this loan.");
    // Same for a repayment on the closed loan; the UI never offers Pay on one, this pins the behaviour.
    await expectCode(sendInstructions(rpc, third, [await repayIx({ payer: third.address, pool: poolA, loan: loanA0, amount: 1n })]), 3012);
    // An open loan has nothing to claim.
    expect(
      await expectCode(
        sendInstructions(rpc, third, async () => {
          const { ix } = await claimEscrowIx({ claimer: third.address, pool: poolA, loan: loanA1, cosignerWallet: cosigner.address });
          return [ix];
        }),
        6010,
      ),
    ).toBe("This loan is no longer active.");
  });
});

describe("cancel request", () => {
  const request = async () =>
    requestLoanIx({
      payer: borrower.address,
      borrower: borrower.address,
      borrowerPerson: await personOf(poolA, borrower.address),
      pool: poolA,
      borrowerGatewayToken: await gw(borrower.address),
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

describe("settlement", () => {
  const settle = async (caller: KeyPairSigner, pool: Pool, loan: Loan) =>
    sendInstructions(rpc, caller, [await settleIx({ caller: caller.address, pool, loan })]);
  const collect = async (caller: KeyPairSigner, pool: Pool, loan: Loan) =>
    sendInstructions(rpc, caller, [await collectRecoveryIx({ collector: caller.address, pool, loan })]);

  it("refuses before the grace period ends, then anyone settles; the recovery is collected separately", async () => {
    expect(await expectCode(settle(third, poolA, loanA1), 6011)).toBe("The grace period hasn't ended yet.");
    const deadline = loanA1.dueAt + BigInt(loanA1.graceDays) * SECONDS_PER_DAY;
    setTime(svm, deadline + 1n);
    // Repaying after the deadline is refused, whole or in part.
    expect(
      await expectCode(
        sendInstructions(rpc, third, [await repayIx({ payer: third.address, pool: poolA, loan: loanA1, amount: 1n * USDC })]),
        6039,
      ),
    ).toBe("The deadline has passed. The loan is settled first, then what is owed can be paid back.");
    const vault = tokenAmount(svm, poolA.vault);
    await settle(third, poolA, loanA1);
    loanA1 = (await fetchLoanById(rpc, poolA.address, 1n))!;
    expect(loanA1).toMatchObject({
      status: "Defaulted",
      shortfall: 100n * USDC,
      recovered: 25n * USDC,
      recoveryPending: 25n * USDC,
      refundPending: 0n,
      restituted: 0n,
      borrowerBarUntil: PERMANENT,
      cosignerBarUntil: PERMANENT,
    });
    expect(tokenAmount(svm, poolA.vault)).toBe(vault); // settlement moves nothing
    const [escrow] = await findEscrowPda(loanA1.address);
    expect(tokenAmount(svm, escrow)).toBe(25n * USDC);
    let p = (await fetchCanonicalPool(rpc))!;
    expect(p).toMatchObject({
      totalRecovered: 0n,
      recoveriesPending: 25n * USDC,
      totalLost: 75n * USDC,
      activeLoans: 0n,
      outstandingPrincipal: 0n,
    });
    expect(await fetchMember(rpc, poolA.address, borrower2.address)).toMatchObject({ ineligible: true, ineligibleUntil: PERMANENT });
    // 75 was lost, so the co-signer is barred too (a fully covered default would leave them in good standing).
    expect(await fetchMember(rpc, poolA.address, cosigner.address)).toMatchObject({
      ineligible: true,
      ineligibleUntil: PERMANENT,
      activeGuarantees: 0,
    });
    expect(await expectCode(settle(third, poolA, loanA1), 6010)).toBe("This loan is no longer active.");
    // Anyone moves the recovery into the vault; the escrow closes because nothing else waits in it.
    await collect(stranger, poolA, loanA1);
    expect(tokenAmount(svm, poolA.vault)).toBe(vault + 25n * USDC);
    expect(svm.getAccount(escrow).exists).toBe(false);
    p = (await fetchCanonicalPool(rpc))!;
    expect(p).toMatchObject({ totalRecovered: 25n * USDC, recoveriesPending: 0n });
    loanA1 = (await fetchLoanById(rpc, poolA.address, 1n))!;
    expect(loanA1.recoveryPending).toBe(0n);
    await expectCode(collect(stranger, poolA, loanA1), 3012); // the escrow account is gone
  });

  it("restitution pays the fund back first, then the co-signer; a full pay-back relaxes the borrower's bar", async () => {
    const restitute = async (payer: KeyPairSigner, amount: bigint) =>
      sendInstructions(rpc, payer, [await restituteIx({ payer: payer.address, pool: poolA, loan: loanA1, amount })]);
    expect(await expectCode(restitute(third, 101n * USDC), 6009)).toBe("That is more than what is still owed.");
    const vault = tokenAmount(svm, poolA.vault);
    // 75 is the fund's loss: the first 75 go there.
    await restitute(third, 75n * USDC);
    loanA1 = (await fetchLoanById(rpc, poolA.address, 1n))!;
    expect(loanA1).toMatchObject({ status: "Defaulted", restituted: 75n * USDC, reimbursementPending: 0n });
    let p = (await fetchCanonicalPool(rpc))!;
    expect(p).toMatchObject({ totalLost: 0n, totalRestituted: 75n * USDC, vaultClaims: 0n });
    expect(tokenAmount(svm, poolA.vault)).toBe(vault + 75n * USDC);
    // The fund is whole, so the co-signer's bar lifts now, whoever paid; the borrower's does not.
    expect(await fetchMember(rpc, poolA.address, cosigner.address)).toMatchObject({ ineligible: false, ineligibleUntil: 0n });
    expect(await fetchMember(rpc, poolA.address, borrower2.address)).toMatchObject({ ineligible: true, ineligibleUntil: PERMANENT });
    // The last 25 (whoever pays; here the borrower) reimburse the co-signer (claimable from the vault); the loan is
    // Restituted and the borrower's bar relaxes to the late bar counted from today.
    await restitute(borrower2, 25n * USDC);
    loanA1 = (await fetchLoanById(rpc, poolA.address, 1n))!;
    expect(loanA1).toMatchObject({ status: "Restituted", restituted: 100n * USDC, reimbursementPending: 25n * USDC, cosignerBarUntil: 0n });
    expect(loanTiming(loanA1, svm.getClock().unixTimestamp).state).toBe("restituted");
    p = (await fetchCanonicalPool(rpc))!;
    expect(p).toMatchObject({ totalRestituted: 100n * USDC, vaultClaims: 25n * USDC });
    // Zero late ban in PARAMS: the borrower is eligible again from today.
    expect(await fetchMember(rpc, poolA.address, borrower2.address)).toMatchObject({
      ineligible: false,
      ineligibleUntil: svm.getClock().unixTimestamp,
    });
    expect((await fetchPerson(rpc, (await fetchMember(rpc, poolA.address, borrower2.address))!.person))!.borrowerBarUntil).toBe(
      svm.getClock().unixTimestamp,
    );
    const cosignerUsdc = tokenAmount(svm, await findAta(cosigner.address, POOL_MINT));
    // The claim pays from the vault; no escrow account is involved any more.
    await sendInstructions(rpc, stranger, async () => {
      const { ix } = await claimEscrowIx({ claimer: stranger.address, pool: poolA, loan: loanA1, cosignerWallet: cosigner.address });
      return [ix];
    });
    expect(tokenAmount(svm, await findAta(cosigner.address, POOL_MINT))).toBe(cosignerUsdc + 25n * USDC);
    expect((await fetchCanonicalPool(rpc))!).toMatchObject({ vaultClaims: 0n, totalReimbursed: 25n * USDC });
    expect(await expectCode(restitute(third, 1n * USDC), 6043)).toBe("This loan hasn't been settled yet.");
  });

  it("agrees with loanTiming at the exact boundary", async () => {
    const deadline = loanB0.dueAt + BigInt(loanB0.graceDays) * SECONDS_PER_DAY;
    setTime(svm, deadline);
    expect(loanTiming(loanB0, deadline).state).toBe("overdue");
    await expectCode(settle(stranger, poolB, loanB0), 6011);
    setTime(svm, deadline + 1n);
    expect(loanTiming(loanB0, deadline + 1n).state).toBe("defaultable");
    await settle(stranger, poolB, loanB0);
    expect((await fetchLoanById(rpc, poolB.address, 0n))!.status).toBe("Defaulted");
    expect(loanTiming((await fetchLoanById(rpc, poolB.address, 0n))!, deadline + 1n).state).toBe("defaulted");
  });

  it("the co-signer waives only their own claim; the fund's claim is forgiven only by the administrator", async () => {
    loanB0 = (await fetchLoanById(rpc, poolB.address, 0n))!;
    const fundOwed = fundClaim(loanB0);
    expect(cosignerClaim(loanB0)).toBeGreaterThan(0n);
    const waive = (who: KeyPairSigner) =>
      sendInstructions(rpc, who, [waiveReimbursementIx({ cosigner: who.address, pool: poolB, loan: loanB0 })]);
    expect(await expectCode(waive(stranger), 6012)).toBe("You're not allowed to do that.");
    const lostBefore = (await fetchPool(rpc, poolB.address))!.totalLost;
    await waive(cosigner);
    loanB0 = (await fetchLoanById(rpc, poolB.address, 0n))!;
    expect(loanB0.cosignerWaivedAt).toBe(svm.getClock().unixTimestamp);
    expect(cosignerClaim(loanB0)).toBe(0n);
    expect(await expectCode(waive(cosigner), 6048)).toBe("There is nothing left for you to waive on this loan.");
    if (fundOwed > 0n) {
      // The fund's claim is untouched by the waiver; only the administrator can forgive it, with a reason.
      expect(loanB0.status).toBe("Defaulted");
      expect(owedAfterSettlement(loanB0)).toBe(fundOwed);
      const forgive = (who: KeyPairSigner) =>
        sendInstructions(rpc, who, [
          forgiveFundClaimIx({ authority: who.address, pool: poolB, loan: loanB0, reason: new Uint8Array(32).fill(3) }),
        ]);
      expect(await expectCode(forgive(cosigner), 6012)).toBe("You're not allowed to do that.");
      await forgive(adm);
      loanB0 = (await fetchLoanById(rpc, poolB.address, 0n))!;
      expect((await fetchPool(rpc, poolB.address))!.totalForgiven).toBe(fundOwed);
    }
    expect(loanB0.status).toBe("Restituted");
    expect(owedAfterSettlement(loanB0)).toBe(0n);
    // The recognised loss stays, and no bar moves.
    expect((await fetchPool(rpc, poolB.address))!.totalLost).toBe(lostBefore);
    expect(await fetchMember(rpc, poolB.address, borrower.address)).toMatchObject({ ineligible: true });
    expect(await fetchMember(rpc, poolB.address, cosigner.address)).toMatchObject({ ineligible: true });
    expect(await expectCode(waive(cosigner), 6043)).toBe("This loan hasn't been settled yet.");
  });
});

describe("pause and request expiry", () => {
  const request = async (b: KeyPairSigner, c: KeyPairSigner, amount = 10n * USDC) =>
    requestLoanIx({
      payer: b.address,
      borrower: b.address,
      borrowerPerson: await personOf(poolA, b.address),
      pool: poolA,
      borrowerGatewayToken: await gw(b.address),
      amount,
      termDays: 5,
      cosigner: c.address,
    });

  it("the pause authority stops new lending at once and only the authority resumes it", async () => {
    // The co-signer was barred by loan A1's default; `third` joins and stands in as the named co-signer.
    await sendSigned(third, [iss], [await reg(third, poolA)]);
    expect(await expectCode(sendInstructions(rpc, stranger, [pauseLendingIx({ signer: stranger.address, pool: poolA })]), 6012)).toBe(
      "You're not allowed to do that.",
    );
    await sendInstructions(rpc, pauser, [pauseLendingIx({ signer: pauser.address, pool: poolA })]);
    poolA = (await fetchCanonicalPool(rpc))!;
    expect(poolA.paused).toBe(true);
    expect(await expectCode(sendInstructions(rpc, borrower, [await request(borrower, third)]), 6026)).toBe(
      "New loans are paused right now. Repayments still work.",
    );
    await expectCode(sendInstructions(rpc, pauser, [resumeLendingIx({ authority: pauser.address, pool: poolA })]), 6012);
    await sendInstructions(rpc, adm, [resumeLendingIx({ authority: adm.address, pool: poolA })]);
    poolA = (await fetchCanonicalPool(rpc))!;
    expect(poolA.paused).toBe(false);
  });

  it("requests expire after the pool's TTL and anyone may close them, rent back to the borrower", async () => {
    await sendInstructions(rpc, borrower, [await request(borrower, third)]);
    const req = (await fetchRequest(rpc, poolA.address, borrower.address))!;
    const now = svm.getClock().unixTimestamp;
    expect(req.expiresAt).toBe(now + poolA.requestTtlSeconds);
    expect(
      await expectCode(
        sendInstructions(rpc, stranger, [closeExpiredRequestIx({ closer: stranger.address, pool: poolA.address, request: req })]),
        6028,
      ),
    ).toBe("This request hasn't expired yet.");
    setTime(svm, req.expiresAt + 1n);
    const rent = svm.getBalance(borrower.address)!;
    await sendInstructions(rpc, stranger, [closeExpiredRequestIx({ closer: stranger.address, pool: poolA.address, request: req })]);
    expect(await fetchRequest(rpc, poolA.address, borrower.address)).toBeNull();
    expect(svm.getBalance(borrower.address)!).toBeGreaterThan(rent);
  });
});

describe("wallet replacement", () => {
  let b3: KeyPairSigner, c3: KeyPairSigner, newWallet: KeyPairSigner;

  async function openOnB(b: KeyPairSigner, c: KeyPairSigner, amount: bigint) {
    await sendInstructions(rpc, b, [
      await requestLoanIx({
        payer: b.address,
        borrower: b.address,
        borrowerPerson: await personOf(poolB, b.address),
        pool: poolB,
        borrowerGatewayToken: await gw(b.address),
        amount,
        termDays: 10,
        cosigner: c.address,
      }),
    ]);
    const pool = (await fetchPool(rpc, poolB.address))!;
    const req = (await fetchRequest(rpc, pool.address, b.address))!;
    await sendInstructions(rpc, c, async (feePayer) => {
      const { ix, borrowerToken } = await cosignLoanIx({
        payer: feePayer,
        pool,
        request: req,
        borrowerPerson: await personOf(pool, req.borrower),
        cosignerPerson: await personOf(pool, req.cosigner),
        borrowerGatewayToken: await gw(req.borrower),
        cosignerGatewayToken: await gw(req.cosigner),
        expectedAmount: req.amount,
        expectedTermDays: req.termDays,
        maxEscrow: escrowFor(req.amount, pool.cosignerEscrowBps),
      });
      return [ataCreate(feePayer, borrowerToken, req.borrower, pool.mint), ix];
    });
    return (await fetchLoanById(rpc, pool.address, pool.loanCount))!;
  }

  it("moves the person, their history and the escrow refund to the new wallet", async () => {
    // Fresh people on pool B (its first borrower and co-signer were barred by loan B0's default).
    b3 = await actor(svm);
    c3 = await actor(svm, { usdc: 500n * USDC, mint: MINT_B });
    newWallet = await actor(svm);
    await sendSigned(b3, [iss], [await reg(b3, poolB)]);
    await sendSigned(c3, [iss], [await reg(c3, poolB)]);
    const loan = await openOnB(b3, c3, 40n * USDC);
    const person = (await fetchPerson(rpc, loan.cosignerPerson))!;
    expect(person.wallet).toBe(c3.address);

    // Step one: the issuer and the recovery authority sign; neither the old wallet (lost keys) nor the new one takes
    // part, so the recovery key can live with an operator rather than in the web service.
    const propose = async () =>
      proposeRebindIx({
        newWallet: newWallet.address,
        issuer: iss.address,
        recoveryAuthority: rec.address,
        pool: poolB,
        person,
        gatewayToken: await gw(newWallet.address),
      });
    await sendSigned(adm, [iss, rec], [await propose()]);
    let p = (await fetchPerson(rpc, person.address))!;
    expect(p).toMatchObject({ wallet: c3.address, pendingWallet: newWallet.address });
    expect(p.pendingWalletAt).toBe(svm.getClock().unixTimestamp + 3n * SECONDS_PER_DAY);
    expect(await fetchMember(rpc, poolB.address, newWallet.address)).toBeNull();
    // The old wallet still has its keys after all and objects; the proposal is dropped.
    await expectCode(sendInstructions(rpc, stranger, [vetoRebindIx({ signer: stranger.address, pool: poolB, person: p })]), 6012);
    await sendInstructions(rpc, c3, [vetoRebindIx({ signer: c3.address, pool: poolB, person: p })]);
    p = (await fetchPerson(rpc, person.address))!;
    expect(p.pendingWallet).toBeNull();
    expect(await expectCode(sendInstructions(rpc, c3, [vetoRebindIx({ signer: c3.address, pool: poolB, person: p })]), 6034)).toBe(
      "No wallet recovery is in progress.",
    );
    // Proposed again; nothing moves until the delay has passed, then anyone finalises.
    await sendSigned(adm, [iss, rec], [await propose()]);
    p = (await fetchPerson(rpc, person.address))!;
    expect(await expectCode(sendSigned(adm, [iss, rec], [await propose()]), 6033)).toBe("A wallet recovery is already in progress.");
    expect(
      await expectCode(
        sendInstructions(rpc, stranger, [await finalizeRebindIx({ payer: stranger.address, pool: poolB, person: p })]),
        6035,
      ),
    ).toBe("The recovery waiting period hasn't passed yet.");
    setTime(svm, p.pendingWalletAt);
    await sendInstructions(rpc, stranger, [await finalizeRebindIx({ payer: stranger.address, pool: poolB, person: p })]);
    expect(await fetchPerson(rpc, person.address)).toMatchObject({ wallet: newWallet.address, pendingWallet: null });
    expect(await fetchMember(rpc, poolB.address, c3.address)).toMatchObject({ retired: true, person: person.address });
    expect(await fetchMember(rpc, poolB.address, newWallet.address)).toMatchObject({
      retired: false,
      person: person.address,
      activeGuarantees: 1,
    });
    expect(await cosignerWalletOf(rpc, loan)).toBe(newWallet.address);
    // Loan history follows the person, whichever wallet asks.
    expect((await fetchLoansFor(rpc, poolB, newWallet.address)).map((l) => l.id)).toEqual([loan.id]);
    expect((await fetchLoansFor(rpc, poolB, c3.address)).map((l) => l.id)).toEqual([loan.id]);

    // Repayment leaves the escrow in the loan; the claim goes to the new wallet's token account (created by the claimer's prefix).
    await sendInstructions(rpc, donor, [await repayIx({ payer: donor.address, pool: poolB, loan, amount: 40n * USDC })]);
    const cosignerWallet = await cosignerWalletOf(rpc, loan);
    expect(cosignerWallet).toBe(newWallet.address);
    await sendInstructions(rpc, donor, async (feePayer) => {
      const { ix, cosignerToken } = await claimEscrowIx({ claimer: donor.address, pool: poolB, loan, cosignerWallet });
      return [ataCreate(feePayer, cosignerToken, cosignerWallet, MINT_B), ix];
    });
    expect(tokenAmount(svm, await findAta(newWallet.address, MINT_B))).toBe(10n * USDC);
    expect(tokenAmount(svm, await findAta(c3.address, MINT_B))).toBe(490n * USDC);
    // The retired wallet can no longer co-sign.
    expect(
      await expectCode(
        sendInstructions(rpc, b3, [
          await requestLoanIx({
            payer: b3.address,
            borrower: b3.address,
            borrowerPerson: await personOf(poolB, b3.address),
            pool: poolB,
            borrowerGatewayToken: await gw(b3.address),
            amount: 1n * USDC,
            termDays: 1,
            cosigner: c3.address,
          }),
        ]),
        6019,
      ),
    ).toBe("This wallet was replaced and can't be used any more.");
  });

  it("winds pool B down: no new loans or donations, then anyone sweeps the balance to the successor", async () => {
    const open = await openOnB(b3, newWallet, 40n * USDC); // the new wallet co-signs with its refunded 10
    const successorOwner = await actor(svm, { gateway: false });
    const successor = await plantAta(svm, successorOwner.address, MINT_B, 0n);
    await sendInstructions(rpc, adm, [
      getAnnounceWindDownInstruction(
        { authority: adm, successorAuthority: adm, pool: poolB.address, successorVault: successor },
        { programAddress: PROGRAM_ID },
      ),
    ]);
    let pool = (await fetchPool(rpc, poolB.address))!;
    const now = svm.getClock().unixTimestamp;
    expect(pool.windDownAt).toBe(now); // pool B kept a zero timelock, so it is in effect at once
    expect(pool.successor).toBe(successor);
    expect(windingDown(pool, now)).toBe(true);
    const closed = "The fund is winding down, so it no longer takes new loans or donations.";
    expect(await expectCode(sendInstructions(rpc, donor, [await donateIx({ donor: donor.address, pool, amount: 1n * USDC })]), 6020)).toBe(
      closed,
    );
    expect(
      await expectCode(
        sendInstructions(rpc, c3, [
          await requestLoanIx({
            payer: newWallet.address,
            borrower: newWallet.address,
            borrowerPerson: await personOf(pool, newWallet.address),
            pool,
            borrowerGatewayToken: await gw(newWallet.address),
            amount: 1n * USDC,
            termDays: 1,
            cosigner: b3.address,
          }),
        ]),
        6020,
      ),
    ).toBe(closed);
    expect(await expectCode(sendInstructions(rpc, stranger, [sweepToSuccessorIx(pool)]), 6024)).toBe("Some loans are still open.");
    // Open loans run their course; once the last one closes, anyone can move the balance on. An unclaimed escrow
    // sits in its own account, so it never holds the sweep up and stays claimable afterwards.
    await sendInstructions(rpc, donor, [await repayIx({ payer: donor.address, pool, loan: open, amount: 40n * USDC })]);
    const balance = tokenAmount(svm, pool.vault);
    await sendInstructions(rpc, stranger, [sweepToSuccessorIx(pool)]);
    expect(tokenAmount(svm, pool.vault)).toBe(0n);
    expect(tokenAmount(svm, successor)).toBe(balance);
    pool = (await fetchPool(rpc, poolB.address))!;
    expect(pool).toMatchObject({ totalSwept: balance, activeLoans: 0n, pendingClaims: 10n * USDC });
    const settled = (await fetchLoanById(rpc, pool.address, open.id))!;
    await sendInstructions(rpc, stranger, async () => {
      const { ix } = await claimEscrowIx({ claimer: stranger.address, pool, loan: settled, cosignerWallet: newWallet.address });
      return [ix];
    });
    expect(tokenAmount(svm, await findAta(newWallet.address, MINT_B))).toBe(10n * USDC); // 10 refunded earlier - 10 escrowed + 10 back
    expect((await fetchPool(rpc, poolB.address))!.pendingClaims).toBe(0n);
  });
});
