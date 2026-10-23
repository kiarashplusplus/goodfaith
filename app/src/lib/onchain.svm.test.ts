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
  cosignLoanIx,
  cosignerWalletOf,
  donateIx,
  fetchCanonicalPool,
  fetchLoanById,
  fetchLoansFor,
  fetchMember,
  fetchPerson,
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
  rebindWalletIx,
  registerMemberIx,
  repayIx,
  requestLoanIx,
  sweepToSuccessorIx,
  windingDown,
  type Loan,
  type Pool,
} from "./program";
import { buildTransaction, sendInstructions } from "./tx";
import { gatewayTokenAddress } from "./civic-addr";
import { actor, admin, issuer, NETWORK, newSvm, personHashOf, plantAta, plantMint, setTime, T0, tokenAmount } from "./svm/fixtures";
import { svmRpc, type SvmRpc } from "./svm/rpc";

const USDC = 1_000_000n;
const MINT_B = address("BiJ1fzcq8BcDQrdUDGNaGK9Jq7oxEmXb9iBFJyKMEdw8");
let PARAMS: Parameters<typeof getScheduleParamsInstruction>[0]["params"];
const gw = (w: Address) => gatewayTokenAddress(w, NETWORK);

let svm: LiteSVM;
let rpc: SvmRpc;
let adm: KeyPairSigner,
  iss: KeyPairSigner,
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
const reg = (w: KeyPairSigner, pool: Pool, payer = w.address, issuerKey: Address = iss.address) =>
  registerMemberIx({ wallet: w.address, payer, issuer: issuerKey, pool, gatewayToken: gw(w.address), personHash: personHashOf(w.address) });

describe("membership", () => {
  it("registers members with the issuer's signature, including one whose rent a sponsor pays", async () => {
    await sendSigned(borrower, [iss], [await reg(borrower, poolA)]);
    await sendSigned(cosigner, [iss], [await reg(cosigner, poolA)]);
    await sendSigned(adm, [borrower2, iss], [await reg(borrower2, poolA, adm.address)]);
    await sendSigned(borrower, [iss], [await reg(borrower, poolB)]);
    await sendSigned(cosigner, [iss], [await reg(cosigner, poolB)]);
    const m = await fetchMember(rpc, poolA.address, borrower2.address);
    expect(m).toMatchObject({ wallet: borrower2.address, retired: false, activeLoan: null, activeGuarantees: 0, ineligible: false });
    expect(await fetchPerson(rpc, m!.person)).toMatchObject({ wallet: borrower2.address, ineligible: false });
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
            gatewayToken: gw(borrower.address),
            personHash: personHashOf(stranger.address),
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
        borrowerPerson: await personOf(pool, req.borrower),
        cosignerPerson: await personOf(pool, req.cosigner),
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
      borrowerPerson: await personOf(poolA, borrower.address),
      cosignerPerson: await personOf(poolA, cosigner.address),
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
    await sendInstructions(rpc, third, [
      await repayIx({ payer: third.address, pool: poolA, loan: loanA0, amount: 40n * USDC, cosignerWallet: cosigner.address }),
    ]);
    loanA0 = (await fetchLoanById(rpc, poolA.address, 0n))!;
    expect(loanA0.repaid).toBe(40n * USDC);
    expect(tokenAmount(svm, await findAta(third.address, POOL_MINT))).toBe(160n * USDC);
    expect(
      await expectCode(
        sendInstructions(rpc, third, [
          await repayIx({ payer: third.address, pool: poolA, loan: loanA0, amount: 61n * USDC, cosignerWallet: cosigner.address }),
        ]),
        6009,
      ),
    ).toBe("That is more than what is still owed.");
  });

  it("closes the loan on full repayment and returns the escrow and its rent", async () => {
    const cosignerSol = svm.getBalance(cosigner.address)!;
    await sendInstructions(rpc, borrower, [
      await repayIx({
        payer: borrower.address,
        pool: poolA,
        loan: loanA0,
        amount: 60n * USDC,
        cosignerWallet: await cosignerWalletOf(rpc, loanA0),
      }),
    ]);
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
    await expectCode(
      sendInstructions(rpc, third, [
        await repayIx({ payer: third.address, pool: poolA, loan: loanA0, amount: 1n, cosignerWallet: cosigner.address }),
      ]),
      3012,
    );
  });
});

describe("cancel request", () => {
  const request = async () =>
    requestLoanIx({
      payer: borrower.address,
      borrower: borrower.address,
      borrowerPerson: await personOf(poolA, borrower.address),
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
      const cosignerWallet = await cosignerWalletOf(rpc, loan);
      const { ix, cosignerToken } = await markDefaultIx({ caller: caller.address, pool, loan, cosignerWallet });
      return [ataCreate(feePayer, cosignerToken, cosignerWallet, pool.mint), ix];
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
    // 75 was lost, so the co-signer is barred too (a fully covered default would leave them in good standing).
    expect(await fetchMember(rpc, poolA.address, cosigner.address)).toMatchObject({ ineligible: true, activeGuarantees: 0 });
    expect((await fetchCanonicalPool(rpc))!.activeLoans).toBe(0n);
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

describe("wallet replacement", () => {
  let b3: KeyPairSigner, c3: KeyPairSigner, newWallet: KeyPairSigner;

  async function openOnB(b: KeyPairSigner, c: KeyPairSigner, amount: bigint) {
    await sendInstructions(rpc, b, [
      await requestLoanIx({
        payer: b.address,
        borrower: b.address,
        borrowerPerson: await personOf(poolB, b.address),
        pool: poolB,
        borrowerGatewayToken: gw(b.address),
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
        borrowerGatewayToken: gw(req.borrower),
        cosignerGatewayToken: gw(req.cosigner),
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

    // The issuer and the new wallet sign; the old wallet does not take part (lost keys).
    const rebind = await rebindWalletIx({
      newWallet: newWallet.address,
      payer: adm.address,
      issuer: iss.address,
      pool: poolB,
      person,
      gatewayToken: gw(newWallet.address),
    });
    await sendSigned(adm, [newWallet, iss], [rebind]);
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

    // Repayment returns the escrow to the new wallet's token account (created by the payer's prefix).
    const cosignerWallet = await cosignerWalletOf(rpc, loan);
    await sendInstructions(rpc, donor, async (feePayer) => [
      ataCreate(feePayer, await findAta(cosignerWallet, MINT_B), cosignerWallet, MINT_B),
      await repayIx({ payer: donor.address, pool: poolB, loan, amount: 40n * USDC, cosignerWallet }),
    ]);
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
            borrowerGatewayToken: gw(b3.address),
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
      getAnnounceWindDownInstruction({ authority: adm, pool: poolB.address, successorVault: successor }, { programAddress: PROGRAM_ID }),
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
            borrowerGatewayToken: gw(newWallet.address),
            amount: 1n * USDC,
            termDays: 1,
            cosigner: b3.address,
          }),
        ]),
        6020,
      ),
    ).toBe(closed);
    expect(await expectCode(sendInstructions(rpc, stranger, [sweepToSuccessorIx(pool)]), 6024)).toBe("Some loans are still open.");
    // Open loans run their course; once the last one closes, anyone can move the balance on.
    await sendInstructions(rpc, donor, [
      await repayIx({ payer: donor.address, pool, loan: open, amount: 40n * USDC, cosignerWallet: await cosignerWalletOf(rpc, open) }),
    ]);
    const balance = tokenAmount(svm, pool.vault);
    await sendInstructions(rpc, stranger, [sweepToSuccessorIx(pool)]);
    expect(tokenAmount(svm, pool.vault)).toBe(0n);
    expect(tokenAmount(svm, successor)).toBe(balance);
    pool = (await fetchPool(rpc, poolB.address))!;
    expect(pool).toMatchObject({ totalSwept: balance, activeLoans: 0n });
  });
});
