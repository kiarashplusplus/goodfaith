import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_METHODS,
  authHeaders,
  clientIp,
  hmacSignature,
  jsonRpcError,
  MAX_BODY_BYTES,
  parseRpcRequest,
  PROXY_ERROR,
  TokenBucket,
} from "./sponsor-proxy";

describe("parseRpcRequest", () => {
  it("accepts allowed methods and canonicalises the body", () => {
    const r = parseRpcRequest(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "signAndSendTransaction", params: { transaction: "AQID", signer_key: "k" } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.req.method).toBe("signAndSendTransaction");
    expect(r.req.body).toBe('{"jsonrpc":"2.0","id":7,"method":"signAndSendTransaction","params":{"transaction":"AQID","signer_key":"k"}}');
    expect(parseRpcRequest('{"jsonrpc":"2.0","id":"a","method":"getPayerSigner"}')).toMatchObject({ ok: true, req: { params: {} } });
    expect(parseRpcRequest('{"jsonrpc":"2.0","id":1,"method":"liveness","params":[]}')).toMatchObject({ ok: true });
  });
  it("rejects bad envelopes, unknown methods and extra params", () => {
    expect(parseRpcRequest("nope")).toMatchObject({ ok: false, code: PROXY_ERROR.INVALID_REQUEST, id: null });
    expect(parseRpcRequest("[1]")).toMatchObject({ ok: false, code: PROXY_ERROR.INVALID_REQUEST });
    expect(parseRpcRequest('{"jsonrpc":"1.0","id":1,"method":"liveness"}')).toMatchObject({
      ok: false,
      code: PROXY_ERROR.INVALID_REQUEST,
      id: 1,
    });
    expect(parseRpcRequest('{"jsonrpc":"2.0","id":1,"method":"getConfig"}')).toMatchObject({
      ok: false,
      code: PROXY_ERROR.METHOD_NOT_ALLOWED,
    });
    expect(parseRpcRequest('{"jsonrpc":"2.0","id":1,"method":"transferTransaction","params":{}}')).toMatchObject({
      ok: false,
      code: PROXY_ERROR.METHOD_NOT_ALLOWED,
    });
    expect(parseRpcRequest('{"jsonrpc":"2.0","id":1,"method":"getPayerSigner","params":{"x":1}}')).toMatchObject({
      ok: false,
      code: PROXY_ERROR.INVALID_REQUEST,
    });
    expect(parseRpcRequest('{"jsonrpc":"2.0","id":1,"method":"signAndSendTransaction","params":{}}')).toMatchObject({
      ok: false,
      code: PROXY_ERROR.INVALID_REQUEST,
    });
    expect(parseRpcRequest('{"jsonrpc":"2.0","id":1,"method":"__proto__"}')).toMatchObject({
      ok: false,
      code: PROXY_ERROR.METHOD_NOT_ALLOWED,
    });
  });
  it("has sane limits", () => {
    expect(MAX_BODY_BYTES).toBeGreaterThan(2000);
    expect(ALLOWED_METHODS.signAndSendTransaction.timeoutMs).toBeGreaterThan(ALLOWED_METHODS.getPayerSigner.timeoutMs);
    expect(jsonRpcError(3, -1, "m")).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -1, message: "m" } });
    expect(jsonRpcError(null, -1, "m", { a: 1 }).error).toEqual({ code: -1, message: "m", data: { a: 1 } });
  });
});

describe("auth headers", () => {
  it("matches Kora's HMAC scheme: hex(HMAC-SHA256(secret, timestamp + body))", () => {
    const expected = createHmac("sha256", "s3cret")
      .update("1700000000" + '{"a":1}')
      .digest("hex");
    expect(hmacSignature("s3cret", "1700000000", '{"a":1}')).toBe(expected);
    const h = authHeaders({ hmacSecret: "s3cret" }, '{"a":1}', 1_700_000_000_500);
    expect(h["x-timestamp"]).toBe("1700000000");
    expect(h["x-hmac-signature"]).toBe(expected);
    expect(h["x-api-key"]).toBeUndefined();
  });
  it("sends an api key alone, both, or nothing", () => {
    expect(authHeaders({ apiKey: "k" }, "{}")).toEqual({ "x-api-key": "k" });
    expect(Object.keys(authHeaders({ apiKey: "k", hmacSecret: "s" }, "{}")).sort()).toEqual([
      "x-api-key",
      "x-hmac-signature",
      "x-timestamp",
    ]);
    expect(authHeaders({}, "{}")).toEqual({});
  });
});

describe("clientIp", () => {
  it("prefers the first forwarded hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1", "x-real-ip": "9.9.9.9" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("TokenBucket", () => {
  it("allows a burst, then refills over time", () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: () => t });
    expect(b.take("a").ok).toBe(true);
    expect(b.take("a").ok).toBe(true);
    expect(b.take("a").ok).toBe(true);
    const denied = b.take("a");
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBe(1);
    expect(b.take("b").ok).toBe(true); // independent key
    t = 2_000;
    expect(b.take("a", 2).ok).toBe(true);
    expect(b.take("a").ok).toBe(false);
    t = 10_000;
    b.sweep();
    expect(b.size).toBe(0);
  });
});
