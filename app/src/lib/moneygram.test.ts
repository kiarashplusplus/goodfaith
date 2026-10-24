import { describe, expect, it } from "vitest";
import { address, getBase64Decoder, type Address } from "@solana/kit";
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Cluster } from "./config";
import {
  checkCashOut,
  createRampsSession,
  memoInstruction,
  MEMO_PROGRAM,
  planCashOut,
  sessionEnv,
  type OnChainTransaction,
} from "./moneygram";
import { findAta } from "./program";

const wallet = address("5MhvzaqhN3tqQ2F4tqYwu7MWFoMFzTXFibKvDC3wGqSU");
const mgi = address("uniqobk8oGh4XBLMqM68K8M2zNu3CdYX7q5go7whQiv");
const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ctx: { wallet: typeof wallet; mint: typeof mint; decimals: number; cluster: Cluster } = {
  wallet,
  mint,
  decimals: 6,
  cluster: "devnet",
};
const base: OnChainTransaction = { chain: "solana", asset: "USDC", to: mgi, amount: "12.5", tokenAddress: mint, tokenDecimals: 6 };

describe("MoneyGram cash-out requests", () => {
  it("accepts the pool's USDC to MoneyGram's address, exactly", () => {
    expect(checkCashOut(base, ctx)).toEqual({ ok: true, cashOut: { to: mgi, amount: 12_500_000n, memo: null } });
    expect(checkCashOut({ ...base, amount: "0.000001", memo: " MG-123 ", tokenAddress: undefined, tokenDecimals: undefined }, ctx)).toEqual(
      {
        ok: true,
        cashOut: { to: mgi, amount: 1n, memo: "MG-123" },
      },
    );
  });

  it("accepts the request MoneyGram's sandbox actually sent", () => {
    // Captured from the playground widget on devnet, 2026-10-24: a token account as `to`, a UUID memo, "testnet".
    const sandbox: OnChainTransaction = {
      chain: "solana",
      to: "FYqcebvZeN5KdtARR7XvntpBx7XfvTsCCH8p8Cw4eHmZ",
      amount: "25",
      asset: "USDC",
      requiredNetwork: "testnet",
      memo: "43acb682-2798-4e57-b966-cc818c6a7628",
      tokenAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      tokenDecimals: 6,
    };
    expect(checkCashOut(sandbox, ctx)).toEqual({
      ok: true,
      cashOut: { to: "FYqcebvZeN5KdtARR7XvntpBx7XfvTsCCH8p8Cw4eHmZ", amount: 25_000_000n, memo: "43acb682-2798-4e57-b966-cc818c6a7628" },
    });
  });

  it("refuses anything that would send something else, somewhere else, or a rounded amount", () => {
    const reason = (tx: Partial<OnChainTransaction>, c = ctx) => {
      const r = checkCashOut({ ...base, ...tx }, c);
      return r.ok ? "accepted" : r.reason;
    };
    expect(reason({ chain: "stellar" })).toMatch(/not Solana/);
    expect(reason({ asset: "USDT" })).toMatch(/not USDC/);
    expect(reason({ tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })).toMatch(/different token/);
    expect(reason({ tokenDecimals: 9 })).toMatch(/decimals/);
    expect(reason({ requiredNetwork: "mainnet" })).toMatch(/expects mainnet/);
    expect(reason({ requiredNetwork: "testnet" }, { ...ctx, cluster: "mainnet-beta" })).toMatch(/test network/);
    expect(reason({ to: "not-an-address" })).toMatch(/isn't a Solana address/);
    expect(reason({ to: wallet })).toMatch(/your own wallet/);
    expect(reason({ amount: "1.0000001" })).toMatch(/can't send exactly/);
    expect(reason({ amount: "0" })).toMatch(/can't send exactly/);
    expect(reason({ amount: "-5" })).toMatch(/can't send exactly/);
    expect(reason({ amount: 5 as unknown as string })).toMatch(/can't send exactly/);
    expect(reason({ memo: "x".repeat(129) })).toMatch(/too long/);
  });

  it("builds a signer-less memo instruction", () => {
    const ix = memoInstruction("MG-123");
    expect(ix.programAddress).toBe(MEMO_PROGRAM);
    expect(ix.accounts).toEqual([]);
    expect(new TextDecoder().decode(ix.data as Uint8Array)).toBe("MG-123");
  });
});

describe("MoneyGram cash-out transfers", () => {
  const owner = address("HzcTrHjkEhjFTHEsC6Dsv8DXCh21WgujD4s5M15Sm94g");
  const tokenAccount = address("FYqcebvZeN5KdtARR7XvntpBx7XfvTsCCH8p8Cw4eHmZ");
  const b64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
  const token = (m: Address, state = AccountState.Initialized) =>
    b64(
      new Uint8Array(
        getTokenEncoder().encode({
          mint: m,
          owner,
          amount: 0n,
          delegate: null,
          state,
          isNative: null,
          delegatedAmount: 0n,
          closeAuthority: null,
        }),
      ),
    );
  // A fake RPC: `accounts` maps an address to [owner program, base64 data]; anything else does not exist.
  const rpcWith = (accounts: Record<string, [string, string]>) =>
    ({
      getAccountInfo: (a: Address) => ({
        send: async () => ({
          context: { slot: 1n },
          value: accounts[a]
            ? { owner: accounts[a][0], data: [accounts[a][1], "base64"], executable: false, lamports: 1n, space: 0n, rentEpoch: 0n }
            : null,
        }),
      }),
    }) as never;
  const payer = address("Kora111111111111111111111111111111111111111");
  const cash = { to: tokenAccount, amount: 25_000_000n, memo: "43acb682-2798-4e57-b966-cc818c6a7628" };

  it("pays a MoneyGram token account directly, with its reference, at the wallet's expense", async () => {
    const plan = await planCashOut(rpcWith({ [tokenAccount]: [TOKEN_PROGRAM_ADDRESS, token(mint)] }), wallet, mint, 6, cash);
    expect(plan.sponsor).toBe(false);
    const [transfer, memo, ...rest] = await plan.instructions(wallet);
    expect(rest).toEqual([]);
    expect(transfer.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(transfer.accounts!.map((a) => a.address)).toEqual([await findAta(wallet, mint), mint, tokenAccount, wallet]);
    expect(memo.programAddress).toBe(MEMO_PROGRAM);
    expect(new TextDecoder().decode(memo.data as Uint8Array)).toBe(cash.memo);
  });

  it("lets the sponsor pay when there is no reference and the account exists", async () => {
    const plan = await planCashOut(rpcWith({ [tokenAccount]: [TOKEN_PROGRAM_ADDRESS, token(mint)] }), wallet, mint, 6, {
      ...cash,
      memo: null,
    });
    expect(plan.sponsor).toBe(true);
    expect(await plan.instructions(payer)).toHaveLength(1);
  });

  it("sends to a wallet's associated account when MoneyGram names a wallet", async () => {
    const ata = await findAta(owner, mint);
    const plan = await planCashOut(rpcWith({ [ata]: [TOKEN_PROGRAM_ADDRESS, token(mint)] }), wallet, mint, 6, { ...cash, to: owner });
    const [transfer, memo] = await plan.instructions(wallet);
    expect(transfer.accounts![2].address).toBe(ata);
    expect(memo.programAddress).toBe(MEMO_PROGRAM);
    expect(plan.sponsor).toBe(false);
  });

  it("refuses a token account of another mint, a frozen one, and a program account", async () => {
    const usdcMainnet = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    await expect(
      planCashOut(rpcWith({ [tokenAccount]: [TOKEN_PROGRAM_ADDRESS, token(usdcMainnet)] }), wallet, mint, 6, cash),
    ).rejects.toThrow(/different token/);
    await expect(
      planCashOut(rpcWith({ [tokenAccount]: [TOKEN_PROGRAM_ADDRESS, token(mint, AccountState.Frozen)] }), wallet, mint, 6, cash),
    ).rejects.toThrow(/can't receive/);
    await expect(planCashOut(rpcWith({ [tokenAccount]: [MEMO_PROGRAM, ""] }), wallet, mint, 6, cash)).rejects.toThrow(/neither a wallet/);
  });
});

describe("MoneyGram widget sessions", () => {
  const origin = "https://playground.xramps.moneygram.com";
  const env = sessionEnv({ MONEYGRAM_SK: "ramps_sk_sbox_secret", NEXT_PUBLIC_RAMPS_ORIGIN: `${origin}/` });
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it("sends the secret only to MoneyGram and returns only the session fields", async () => {
    let sent: { url: string; init?: RequestInit } | null = null;
    const r = await createRampsSession(env, (async (url: string, init?: RequestInit) => {
      sent = { url, init };
      return new Response(
        JSON.stringify({ sessionToken: "tok", sessionId: "id", widgetUrl: `${origin}/sdk/widget.html?mode=off-ramp`, walletType: "x" }),
        { status: 201 },
      );
    }) as typeof fetch);
    expect(r).toEqual({
      ok: true,
      session: { sessionToken: "tok", sessionId: "id", widgetUrl: `${origin}/sdk/widget.html?mode=off-ramp` },
    });
    expect(sent!.url).toBe("https://playground.xramps.moneygram.com/api/v1/sessions");
    expect((sent!.init!.headers as Record<string, string>)["x-api-key"]).toBe("ramps_sk_sbox_secret");
    expect(JSON.stringify(r)).not.toContain("ramps_sk");
  });

  it("refuses when unconfigured, on upstream errors and on a widget off the configured origin", async () => {
    expect(await createRampsSession(sessionEnv({}))).toMatchObject({ ok: false, status: 503 });
    expect(await createRampsSession(env, reply(401, { error: "bad key" }) as typeof fetch)).toMatchObject({ ok: false, status: 502 });
    expect(await createRampsSession(env, reply(201, { sessionToken: "t" }) as typeof fetch)).toMatchObject({ ok: false, status: 502 });
    expect(
      await createRampsSession(env, reply(201, { sessionToken: "t", sessionId: "i", widgetUrl: "https://evil.example/w" }) as typeof fetch),
    ).toMatchObject({ ok: false, error: "MoneyGram's widget is not on the configured origin." });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await createRampsSession(env, down)).toMatchObject({ ok: false, status: 502 });
  });
});
