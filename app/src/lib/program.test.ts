import { describe, expect, it } from "vitest";
import { address, getAddressEncoder, getProgramDerivedAddress, getU64Encoder, getUtf8Encoder } from "@solana/kit";
import * as gen from "@/generated/pdas";
import { findEscrowPda, findLoanPda, findMemberPda, findPoolPda, findRequestPda, findVaultPda, friendlyError } from "./program";
import { POOL_MINT, PROGRAM_ID } from "./config";

// Known addresses for the devnet USDC mint under the default program id (scripts/e2e-result.json).
const POOL = address("6WhSVqUVvjQ9ana2JAvx4gBKK2o1P7m2K6aCxeXWxCeA");
const VAULT = address("FUbBuu4hfSDpiK5po711MesY8KureDLQ4R1utvs1zFCj");
const A = address("2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve");
const B = address("uniqobk8oGh4XBLMqM68K8M2zNu3CdYX7q5go7whQiv");

describe("PDAs", () => {
  const cfg = { programAddress: PROGRAM_ID };
  it("pool and vault match the known devnet addresses", async () => {
    expect((await findPoolPda(POOL_MINT))[0]).toBe(POOL);
    expect((await findVaultPda(POOL))[0]).toBe(VAULT);
  });
  it("hand-derived PDAs match the generated client", async () => {
    expect(await findPoolPda(POOL_MINT)).toEqual(await gen.findPoolPda({ mint: POOL_MINT }, cfg));
    expect(await findVaultPda(POOL)).toEqual(await gen.findVaultPda({ pool: POOL }, cfg));
    expect(await findMemberPda(POOL, A)).toEqual(await gen.findMemberPda({ pool: POOL, wallet: A }, cfg));
    expect(await findRequestPda(POOL, A)).toEqual(await gen.findRequestPda({ pool: POOL, borrower: A }, cfg));
    expect(await findEscrowPda(B)).toEqual(await gen.findEscrowPda({ loan: B }, cfg));
  });
  it("loan PDA uses the little-endian u64 id", async () => {
    const expected = await getProgramDerivedAddress({
      programAddress: PROGRAM_ID,
      seeds: [getUtf8Encoder().encode("loan"), getAddressEncoder().encode(POOL), getU64Encoder().encode(7n)],
    });
    expect(await findLoanPda(POOL, 7n)).toEqual(expected);
    expect((await findLoanPda(POOL, 7n))[0]).not.toBe((await findLoanPda(POOL, 8n))[0]);
  });
});

describe("friendlyError", () => {
  it("maps program error codes from both error formats", () => {
    expect(friendlyError(new Error("custom program error: 0x1771"))).toBe("That is more than the loan limit.");
    expect(friendlyError(new Error('Simulation failed: {"InstructionError":[0,{"Custom":6011}]}'))).toBe(
      "The grace period hasn't ended yet.",
    );
    expect(friendlyError('Transaction failed: {"InstructionError":[1,{"Custom":6016}]}')).toBe(
      "The escrow is higher than what you were shown. Please review again.",
    );
  });
  it("does not call a failed cancel_request simulation 'cancelled'", () => {
    const msg =
      'Simulation failed: {"InstructionError":[0,{"Custom":6012}]} Program log: Instruction: CancelRequest | Program log: AnchorError ... Not authorized';
    expect(friendlyError(new Error(msg))).toBe("You're not allowed to do that.");
    const noCode = 'Simulation failed: {"InstructionError":[0,"InvalidAccountData"]} Program log: Instruction: CancelRequest';
    expect(friendlyError(new Error(noCode))).not.toBe("You cancelled the request.");
  });
  it("recognises a wallet rejection", () => {
    expect(friendlyError(new Error("User rejected the request."))).toBe("You cancelled the request.");
    expect(friendlyError(new Error("Transaction was rejected by user"))).toBe("You cancelled the request.");
  });
  it("keeps the generic fallbacks and truncates", () => {
    expect(friendlyError(new Error("Insufficient funds for rent"))).toBe("Not enough balance for this.");
    expect(friendlyError(new Error("Blockhash not found"))).toBe("That took too long. Please try again.");
    expect(friendlyError("x".repeat(300))).toHaveLength(203);
    expect(friendlyError(42)).toBe("42");
  });
});

describe("friendlyError for the fee sponsor", () => {
  it("maps proxy and Kora errors to plain copy", async () => {
    const { KoraError, KORA_CODES } = await import("./kora");
    expect(friendlyError(new KoraError(KORA_CODES.RATE_LIMITED, "x"))).toBe("Too many requests. Wait a moment and try again.");
    expect(friendlyError(new KoraError(KORA_CODES.TIMEOUT, "x"))).toBe("The fee sponsor didn't respond. Try again in a minute.");
    expect(friendlyError(new KoraError(KORA_CODES.AUTH, "x"))).toBe("The fee sponsor isn't set up correctly.");
    expect(
      friendlyError(new KoraError(-32602, "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr is not in the allowed programs list")),
    ).toBe("The fee sponsor doesn't cover this kind of transaction.");
    expect(friendlyError(new KoraError(-32602, "Transaction fee 7000000 lamports exceeds max allowed 5000000"))).toBe(
      "This transaction needs more SOL than the fee sponsor covers.",
    );
    expect(friendlyError(new KoraError(-32602, "Too many signatures: 4 > 3"))).toBe("Too many signers for the fee sponsor.");
    expect(friendlyError(new KoraError(-32000, "x".repeat(200)))).toBe(`The fee sponsor declined this: ${"x".repeat(120)}...`);
  });
});
