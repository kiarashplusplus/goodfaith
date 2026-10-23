import { describe, expect, it } from "vitest";
import { formatAmount, formatSol, formatUsdc, parseAmount, shortAddress } from "./format";
import { escrowFor } from "./escrow";
import { buildCosignLink, parseCosignLink } from "./cosign-link";
import { solanaPayUrl } from "./solana-pay";

describe("amounts", () => {
  it("parses decimal strings to base units", () => {
    expect(parseAmount("1")).toBe(1_000_000n);
    expect(parseAmount("12.5")).toBe(12_500_000n);
    expect(parseAmount("0.000001")).toBe(1n);
    expect(parseAmount("1,000.25")).toBe(1_000_250_000n);
  });
  it("rejects bad input", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("1.0000001")).toBeNull();
    expect(parseAmount("-1")).toBeNull();
  });
  it("formats base units", () => {
    expect(formatAmount(0n)).toBe("0.00");
    expect(formatAmount(1_234_567_890n)).toBe("1,234.56789");
    expect(formatUsdc(2_500_000n)).toBe("$2.50");
    expect(formatAmount(-1_500_000n)).toBe("-1.50");
  });
});

describe("escrow", () => {
  it("rounds up", () => {
    expect(escrowFor(1_000_000n, 2500)).toBe(250_000n);
    expect(escrowFor(1n, 2500)).toBe(1n);
    expect(escrowFor(10_001n, 2500)).toBe(2_501n);
    expect(escrowFor(100n, 0)).toBe(0n);
    expect(escrowFor(100n, 10_000)).toBe(100n);
  });
  it("rejects out-of-range bps", () => {
    expect(() => escrowFor(100n, 10_001)).toThrow();
  });
});

describe("cosign link", () => {
  const ref = { pool: "11111111111111111111111111111111", borrower: "So11111111111111111111111111111111111111112" };
  it("round-trips", () => {
    const link = buildCosignLink("https://goodfaith.fi", ref);
    expect(link.startsWith("https://goodfaith.fi/cosign?")).toBe(true);
    expect(parseCosignLink(link.split("?")[1]!)).toEqual(ref);
    expect(parseCosignLink("?" + link.split("?")[1]!)).toEqual(ref);
  });
  it("rejects garbage", () => {
    expect(parseCosignLink("")).toBeNull();
    expect(parseCosignLink("pool=abc&borrower=def")).toBeNull();
    expect(parseCosignLink(`pool=${ref.pool}`)).toBeNull();
  });
});

describe("solana pay", () => {
  it("builds a url", () => {
    expect(solanaPayUrl({ recipient: "abc", amount: "5", splToken: "mint" })).toBe(
      "solana:abc?amount=5&spl-token=mint",
    );
    expect(solanaPayUrl({ recipient: "abc" })).toBe("solana:abc");
  });
});

describe("sol and addresses", () => {
  it("formats lamports to at most four decimals", () => {
    expect(formatSol(1_000_000_000n)).toBe("1");
    expect(formatSol(1_234_567_890n)).toBe("1.2345");
    expect(formatSol(5_000n)).toBe("0");
    expect(formatSol(0n)).toBe("0");
  });
  it("shortens long addresses only", () => {
    expect(shortAddress("2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve")).toBe("2agN...Hbve");
    expect(shortAddress("short")).toBe("short");
  });
});
