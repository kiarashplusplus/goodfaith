import { describe, expect, it } from "vitest";
import { DEFAULT_POOL_MINT, DEFAULT_PROGRAM_ID, DEFAULT_RPC_URL, DEVNET_TURNKEY, parseConfig } from "./config";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const AUTH = "2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve";

describe("parseConfig", () => {
  it("uses defaults when nothing is set", () => {
    const c = parseConfig({});
    expect(c.errors).toEqual([]);
    expect(c.cluster).toBe("devnet");
    expect(c.rpcUrl).toBe(DEFAULT_RPC_URL);
    expect(c.poolMint).toBe(DEFAULT_POOL_MINT);
    expect(c.programId).toBe(DEFAULT_PROGRAM_ID);
    expect(c.gatekeeperNetwork).toBe("");
    expect(c.poolAuthority).toBe("");
    expect(c.turnkey).toEqual(DEVNET_TURNKEY);
  });

  it("accepts a full valid configuration", () => {
    const c = parseConfig({
      cluster: "mainnet-beta",
      rpcUrl: "https://rpc.example",
      koraUrl: "https://kora.example",
      poolMint: MINT,
      programId: DEFAULT_PROGRAM_ID,
      gatekeeperNetwork: AUTH,
      poolAddress: AUTH,
      poolAuthority: "none",
      turnkeyOrganizationId: "11111111-2222-3333-4444-555555555555",
      turnkeyAuthProxyConfigId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
    });
    expect(c.errors).toEqual([]);
    expect(c.turnkey.organizationId).toBe("11111111-2222-3333-4444-555555555555");
    expect(c.cluster).toBe("mainnet-beta");
    expect(c.koraUrl).toBe("https://kora.example");
    expect(c.poolAuthority).toBe("none");
    expect(parseConfig({ poolAuthority: AUTH }).poolAuthority).toBe(AUTH);
  });

  it("needs mainnet's own Turnkey IDs and refuses ones that are not UUIDs", () => {
    const main = parseConfig({ cluster: "mainnet-beta" });
    expect(main.turnkey).toEqual({ organizationId: "", authProxyConfigId: "" });
    expect(main.errors.map((e) => e.split(" ")[0])).toEqual([
      "NEXT_PUBLIC_TURNKEY_ORGANIZATION_ID",
      "NEXT_PUBLIC_TURNKEY_AUTH_PROXY_CONFIG_ID",
    ]);
    const bad = parseConfig({ turnkeyOrganizationId: "org-1" });
    expect(bad.turnkey.organizationId).toBe(DEVNET_TURNKEY.organizationId);
    expect(bad.errors[0]).toMatch(/not a Turnkey ID/);
  });

  it("records a bad cluster and falls back to devnet", () => {
    const c = parseConfig({ cluster: "testnet" });
    expect(c.cluster).toBe("devnet");
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]).toMatch(/NEXT_PUBLIC_CLUSTER/);
  });

  it("never throws on bad addresses and keeps the defaults", () => {
    const c = parseConfig({
      poolMint: "not-an-address",
      programId: "xyz",
      gatekeeperNetwork: "??",
      poolAddress: "0",
      poolAuthority: "frozen",
    });
    expect(c.poolMint).toBe(DEFAULT_POOL_MINT);
    expect(c.programId).toBe(DEFAULT_PROGRAM_ID);
    expect(c.gatekeeperNetwork).toBe("");
    expect(c.poolAddress).toBe("");
    expect(c.poolAuthority).toBe("");
    expect(c.errors.map((e) => e.split(" ")[0])).toEqual([
      "NEXT_PUBLIC_POOL_AUTHORITY",
      "NEXT_PUBLIC_POOL_MINT",
      "NEXT_PUBLIC_PROGRAM_ID",
      "NEXT_PUBLIC_GATEKEEPER_NETWORK",
      "NEXT_PUBLIC_POOL_ADDRESS",
    ]);
  });

  it("trims whitespace", () => {
    expect(parseConfig({ cluster: " devnet ", poolMint: ` ${MINT} ` }).errors).toEqual([]);
  });
});

describe("kora url", () => {
  it("accepts an absolute http(s) URL or an app path, rejects the rest", () => {
    expect(parseConfig({ koraUrl: "http://127.0.0.1:8080" })).toMatchObject({ koraUrl: "http://127.0.0.1:8080", errors: [] });
    expect(parseConfig({ koraUrl: "/api/sponsor" })).toMatchObject({ koraUrl: "/api/sponsor", errors: [] });
    expect(parseConfig({ koraUrl: "" })).toMatchObject({ koraUrl: "" });
    for (const bad of ["api/sponsor", "ftp://x", "kora"]) {
      const c = parseConfig({ koraUrl: bad });
      expect(c.koraUrl).toBe("");
      expect(c.errors[0]).toMatch(/NEXT_PUBLIC_KORA_URL/);
    }
  });
});
