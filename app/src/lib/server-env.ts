/**
 * One view of the server-side configuration: what is set, what is missing, and what is misconfigured. Values never
 * leave this module; callers get booleans, names and problem descriptions (`/api/health`, the operations docs).
 */
export type ServerEnv = {
  sponsor: { enabled: boolean; proxied: boolean; upstream: boolean; auth: "hmac+key" | "hmac" | "key" | "none" };
  identity: {
    configured: boolean;
    provider: "persona" | "mock" | "unknown" | "none";
    recovery: boolean;
    store: "memory" | "sqlite" | "postgres";
  };
  problems: string[];
};

const has = (v: string | undefined) => !!v?.trim();

export function readServerEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  const problems: string[] = [];
  const publicKora = env.NEXT_PUBLIC_KORA_URL?.trim() ?? "";
  const proxied = publicKora.startsWith("/");
  const upstream = has(env.KORA_URL);
  if (proxied && !upstream) problems.push("NEXT_PUBLIC_KORA_URL points at the proxy but KORA_URL (the upstream Kora) is not set.");
  for (const k of [
    "KORA_API_KEY",
    "KORA_HMAC_SECRET",
    "ISSUER_SECRET",
    "RECOVERY_SECRET",
    "GATEKEEPER_SECRET",
    "PERSON_HASH_SECRET",
    "PERSON_HASH_SECRETS",
    "IDENTITY_ADMIN_KEY",
    "IDENTITY_DB_URL",
  ]) {
    if (has(env[`NEXT_PUBLIC_${k}`])) problems.push(`NEXT_PUBLIC_${k} is set: that value would be shipped to browsers. Use ${k}.`);
  }
  const auth =
    has(env.KORA_HMAC_SECRET) && has(env.KORA_API_KEY)
      ? "hmac+key"
      : has(env.KORA_HMAC_SECRET)
        ? "hmac"
        : has(env.KORA_API_KEY)
          ? "key"
          : "none";
  if (upstream && auth === "none")
    problems.push("Kora is reachable without KORA_API_KEY or KORA_HMAC_SECRET; the upstream must not be exposed without auth.");

  const providerRaw = env.IDENTITY_PROVIDER?.trim() || (has(env.ISSUER_SECRET) ? "persona" : "");
  const provider: ServerEnv["identity"]["provider"] =
    providerRaw === "" ? "none" : providerRaw === "persona" || providerRaw === "mock" ? providerRaw : "unknown";
  const identityConfigured =
    has(env.ISSUER_SECRET) && has(env.GATEKEEPER_SECRET) && (has(env.PERSON_HASH_SECRET) || has(env.PERSON_HASH_SECRETS));
  if (provider === "unknown") problems.push(`IDENTITY_PROVIDER must be "persona" or "mock".`);
  if (
    provider === "persona" &&
    identityConfigured &&
    !(has(env.PERSONA_API_KEY) && has(env.PERSONA_TEMPLATE_ID) && has(env.PERSONA_WEBHOOK_SECRET))
  )
    problems.push("IDENTITY_PROVIDER=persona needs PERSONA_API_KEY, PERSONA_TEMPLATE_ID and PERSONA_WEBHOOK_SECRET.");
  if (provider === "mock" && env.NEXT_PUBLIC_CLUSTER?.trim() === "mainnet-beta")
    problems.push("The mock identity provider must not run against mainnet.");
  if (identityConfigured && !has(env.IDENTITY_ADMIN_KEY)) problems.push("IDENTITY_ADMIN_KEY is not set: the cranker cannot revoke passes.");
  const dbPath = env.IDENTITY_DB_PATH?.trim() || "./identity.sqlite";
  const store: ServerEnv["identity"]["store"] = has(env.IDENTITY_DB_URL) ? "postgres" : dbPath === "memory" ? "memory" : "sqlite";
  if (store === "memory" && env.NEXT_PUBLIC_CLUSTER?.trim() === "mainnet-beta")
    problems.push("IDENTITY_DB_PATH=memory loses every record on restart; not for mainnet.");

  return {
    sponsor: { enabled: publicKora !== "", proxied, upstream, auth },
    identity: { configured: identityConfigured, provider, recovery: has(env.RECOVERY_SECRET), store },
    problems,
  };
}
