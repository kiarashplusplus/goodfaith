/**
 * Pure helpers for the fee-sponsor proxy (`app/api/sponsor`): request validation, Kora auth headers,
 * a per-client token bucket. No Next.js imports, so everything here is unit-testable.
 * Kora 2.0.5 auth: `x-api-key`, and/or `x-timestamp` (unix seconds) + `x-hmac-signature` =
 * hex(HMAC-SHA256(secret, timestamp + body)), accepted within 300 s.
 */
import { createHmac } from "node:crypto";

export const ALLOWED_METHODS = {
  liveness: { timeoutMs: 5_000, params: [] as readonly string[], cost: 1 },
  getPayerSigner: { timeoutMs: 5_000, params: [] as readonly string[], cost: 1 },
  signAndSendTransaction: { timeoutMs: 90_000, params: ["transaction", "signer_key", "sig_verify"] as readonly string[], cost: 3 },
} as const;
export type AllowedMethod = keyof typeof ALLOWED_METHODS;

/** A v0 transaction is at most 1232 bytes (about 1.7 KB in base64) plus the JSON-RPC envelope. */
export const MAX_BODY_BYTES = 8 * 1024;

export const PROXY_ERROR = {
  INVALID_REQUEST: -32600,
  METHOD_NOT_ALLOWED: -32601,
  UPSTREAM_UNREACHABLE: -32001,
  UPSTREAM_TIMEOUT: -32002,
  UPSTREAM_BAD_RESPONSE: -32003,
  NOT_CONFIGURED: -32004,
  RATE_LIMITED: -32005,
  UPSTREAM_AUTH: -32006,
  BODY_TOO_LARGE: -32007,
} as const;

export type RpcId = string | number | null;
export type ParsedRequest = { id: RpcId; method: AllowedMethod; params: Record<string, unknown>; body: string };
export type ParseResult = { ok: true; req: ParsedRequest } | { ok: false; id: RpcId; code: number; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates the JSON-RPC envelope and method, and re-serialises a canonical body so only known keys reach Kora. */
export function parseRpcRequest(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, id: null, code: PROXY_ERROR.INVALID_REQUEST, message: "Body is not valid JSON." };
  }
  if (!isRecord(parsed)) return { ok: false, id: null, code: PROXY_ERROR.INVALID_REQUEST, message: "Body must be a JSON-RPC object." };
  const idRaw = parsed.id;
  const id: RpcId = typeof idRaw === "string" || typeof idRaw === "number" ? idRaw : null;
  if (parsed.jsonrpc !== "2.0") return { ok: false, id, code: PROXY_ERROR.INVALID_REQUEST, message: 'jsonrpc must be "2.0".' };
  const method = parsed.method;
  if (typeof method !== "string" || !Object.hasOwn(ALLOWED_METHODS, method)) {
    return { ok: false, id, code: PROXY_ERROR.METHOD_NOT_ALLOWED, message: "Method not allowed through the sponsor proxy." };
  }
  const allowed = ALLOWED_METHODS[method as AllowedMethod].params;
  const paramsRaw = parsed.params ?? {};
  const params: Record<string, unknown> = {};
  if (Array.isArray(paramsRaw)) {
    if (paramsRaw.length) return { ok: false, id, code: PROXY_ERROR.INVALID_REQUEST, message: "params must be an object." };
  } else if (isRecord(paramsRaw)) {
    for (const [k, v] of Object.entries(paramsRaw)) {
      if (!allowed.includes(k)) return { ok: false, id, code: PROXY_ERROR.INVALID_REQUEST, message: `Unexpected parameter "${k}".` };
      if (v !== undefined) params[k] = v;
    }
  } else {
    return { ok: false, id, code: PROXY_ERROR.INVALID_REQUEST, message: "params must be an object." };
  }
  if (method === "signAndSendTransaction" && typeof params.transaction !== "string") {
    return { ok: false, id, code: PROXY_ERROR.INVALID_REQUEST, message: "transaction must be a base64 string." };
  }
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  return { ok: true, req: { id, method: method as AllowedMethod, params, body } };
}

export function jsonRpcError(id: RpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: data === undefined ? { code, message } : { code, message, data } };
}

export function hmacSignature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}${body}`).digest("hex");
}

/** Headers Kora expects, built from the exact body string that will be sent. */
export function authHeaders(env: { apiKey?: string; hmacSecret?: string }, body: string, nowMs = Date.now()): Record<string, string> {
  const h: Record<string, string> = {};
  if (env.apiKey) h["x-api-key"] = env.apiKey;
  if (env.hmacSecret) {
    const ts = String(Math.floor(nowMs / 1000));
    h["x-timestamp"] = ts;
    h["x-hmac-signature"] = hmacSignature(env.hmacSecret, ts, body);
  }
  return h;
}

/** First hop of x-forwarded-for, then x-real-ip, else "unknown". */
export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** Per-key token bucket. In-memory, so per server instance. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(opts: { capacity: number; refillPerSec: number; now?: () => number; maxKeys?: number }) {
    this.capacity = opts.capacity;
    this.refillPerSec = opts.refillPerSec;
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  take(key: string, cost = 1): { ok: boolean; retryAfterSec: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    const refilled = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.refillPerSec);
    if (refilled >= cost) {
      this.buckets.set(key, { tokens: refilled - cost, at: t });
      if (this.buckets.size > this.maxKeys) this.sweep();
      return { ok: true, retryAfterSec: 0 };
    }
    this.buckets.set(key, { tokens: refilled, at: t });
    return { ok: false, retryAfterSec: Math.ceil((cost - refilled) / this.refillPerSec) };
  }

  /** Drops keys that have fully refilled (idle clients). */
  sweep(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.at) / 1000) * this.refillPerSec >= this.capacity) this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
