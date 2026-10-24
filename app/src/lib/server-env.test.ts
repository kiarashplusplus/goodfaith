import { describe, expect, it } from "vitest";
import { readServerEnv } from "./server-env";

describe("server environment", () => {
  it("describes a complete production-like setup without problems", () => {
    const e = readServerEnv({
      NEXT_PUBLIC_KORA_URL: "/api/sponsor",
      KORA_URL: "http://kora:8080",
      KORA_HMAC_SECRET: "s",
      KORA_API_KEY: "k",
      IDENTITY_PROVIDER: "persona",
      PERSONA_API_KEY: "a",
      PERSONA_TEMPLATE_ID: "t",
      PERSONA_WEBHOOK_SECRET: "w",
      ISSUER_SECRET: "[1]",
      GATEKEEPER_SECRET: "[1]",
      PERSON_HASH_SECRETS: "1:x",
      IDENTITY_ADMIN_KEY: "adm",
      IDENTITY_DB_URL: "postgres://x",
      NOTIFY_WEBHOOK_URL: "https://relay.example/notify",
    });
    expect(e).toEqual({
      sponsor: { enabled: true, proxied: true, upstream: true, auth: "hmac+key" },
      identity: { configured: true, provider: "persona", notifier: "webhook", store: "postgres" },
      ramps: { configured: false, origin: null, sandbox: false },
      problems: [],
    });
    expect(readServerEnv({ RECOVERY_SECRET: "[1]" }).problems).toEqual([
      "RECOVERY_SECRET is set on the web service: the recovery key belongs to the operator's recovery CLI (scripts/recovery.ts), not the app.",
    ]);
  });
  it("flags secrets exposed as NEXT_PUBLIC_, a proxy without upstream, missing auth and provider settings", () => {
    const e = readServerEnv({
      NEXT_PUBLIC_KORA_URL: "/api/sponsor",
      NEXT_PUBLIC_KORA_HMAC_SECRET: "leak",
      IDENTITY_PROVIDER: "persona",
      ISSUER_SECRET: "[1]",
      GATEKEEPER_SECRET: "[1]",
      PERSON_HASH_SECRET: "x",
      IDENTITY_DB_PATH: "memory",
      NEXT_PUBLIC_CLUSTER: "mainnet-beta",
    });
    expect(e.problems).toEqual([
      "NEXT_PUBLIC_KORA_URL points at the proxy but KORA_URL (the upstream Kora) is not set.",
      "NEXT_PUBLIC_KORA_HMAC_SECRET is set: that value would be shipped to browsers. Use KORA_HMAC_SECRET.",
      "IDENTITY_PROVIDER=persona needs PERSONA_API_KEY, PERSONA_TEMPLATE_ID and PERSONA_WEBHOOK_SECRET.",
      "IDENTITY_ADMIN_KEY is not set: the cranker cannot revoke passes.",
      "IDENTITY_DB_PATH=memory loses every record on restart; not for mainnet.",
    ]);
    expect(e.identity).toMatchObject({ configured: true, notifier: "console", store: "memory" });
    expect(readServerEnv({ KORA_URL: "http://k" }).problems).toContain(
      "Kora is reachable without KORA_API_KEY or KORA_HMAC_SECRET; the upstream must not be exposed without auth.",
    );
    expect(readServerEnv({ IDENTITY_PROVIDER: "mock", NEXT_PUBLIC_CLUSTER: "mainnet-beta" }).problems).toContain(
      "The mock identity provider must not run against mainnet.",
    );
    expect(readServerEnv({ IDENTITY_PROVIDER: "other" }).identity.provider).toBe("unknown");
  });
  it("reports nothing configured as such", () => {
    expect(readServerEnv({})).toEqual({
      sponsor: { enabled: false, proxied: false, upstream: false, auth: "none" },
      identity: { configured: false, provider: "none", notifier: "console", store: "sqlite" },
      ramps: { configured: false, origin: null, sandbox: false },
      problems: [],
    });
  });

  it("reports MoneyGram cash access and keeps its secret server-side", () => {
    const origin = "https://playground.xramps.moneygram.com";
    expect(readServerEnv({ NEXT_PUBLIC_RAMPS_ORIGIN: `${origin}/`, MONEYGRAM_SK: "ramps_sk_sbox_x" })).toMatchObject({
      ramps: { configured: true, origin, sandbox: true },
      problems: [],
    });
    expect(readServerEnv({ NEXT_PUBLIC_RAMPS_ORIGIN: origin }).problems).toEqual([
      "NEXT_PUBLIC_RAMPS_ORIGIN is set but MONEYGRAM_SK is not: the cash card cannot open.",
    ]);
    expect(readServerEnv({ NEXT_PUBLIC_MONEYGRAM_SK: "leak" }).problems).toContain(
      "NEXT_PUBLIC_MONEYGRAM_SK is set: that value would be shipped to browsers. Use MONEYGRAM_SK.",
    );
    expect(
      readServerEnv({ NEXT_PUBLIC_RAMPS_ORIGIN: origin, MONEYGRAM_SK: "ramps_sk_sbox_x", NEXT_PUBLIC_CLUSTER: "mainnet-beta" }).problems,
    ).toContain("MONEYGRAM_SK is a sandbox key; mainnet needs MoneyGram production credentials.");
  });
});
