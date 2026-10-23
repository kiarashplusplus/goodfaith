import { describe, expect, it } from "vitest";
import { BASE, evaluate, lossPerDefault } from "./economics";

describe("economic model", () => {
  it("reproduces the reviewer's example: $100k fund, 10% default, 25% escrow, nothing repaid → $7,500 per cycle", () => {
    const r = evaluate({ ...BASE, fund: 100_000, utilisation: 1, defaultRate: 0.1, escrowRate: 0.25, repaidBeforeDefault: 0 });
    expect(r.lossPerCycle).toBeCloseTo(7_500, 6);
    expect(r.collusionPayoff).toBe(225);
  });
  it("escrow equal to the unpaid share makes a default free; more escrow never goes negative", () => {
    expect(lossPerDefault(300, 0.25, 0.75)).toBe(0);
    expect(lossPerDefault(300, 1, 0)).toBe(0);
    expect(lossPerDefault(300, 0.25, 0)).toBe(225);
    expect(evaluate({ ...BASE, repaidBeforeDefault: 0.4 }).breakEvenEscrowRate).toBeCloseTo(0.6);
  });
  it("scales with utilisation and cycle length, and adds operating costs to the donations needed", () => {
    const base = evaluate(BASE);
    expect(evaluate({ ...BASE, utilisation: 0.4 }).lossPerYear).toBeCloseTo(base.lossPerYear / 2);
    expect(evaluate({ ...BASE, cycleDays: 60 }).lossPerYear).toBeCloseTo(base.lossPerYear * 2);
    expect(base.donationsNeededPerYear).toBeCloseTo(base.lossPerYear + base.operatingPerYear);
    expect(base.operatingPerYear).toBeCloseTo(2.5 * 600 + 0.6 * base.loansPerYear + 1_800 + 10_000);
    expect(evaluate({ ...BASE, defaultRate: 0 }).yearsToDepletion).toBe(Infinity);
    expect(() => evaluate({ ...BASE, fund: 0 })).toThrow();
  });
});
