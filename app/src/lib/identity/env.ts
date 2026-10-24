/**
 * The one identity service per server process, built from the environment:
 *   IDENTITY_PROVIDER=persona|mock, PERSONA_API_KEY, PERSONA_TEMPLATE_ID, PERSONA_WEBHOOK_SECRET (persona),
 *   MOCK_WEBHOOK_SECRET (mock), PERSON_HASH_SECRET, ISSUER_SECRET, GATEKEEPER_SECRET (both JSON keypair arrays),
 *   IDENTITY_DB_PATH (default ./identity.sqlite; ":memory:" for throwaway), IDENTITY_ADMIN_KEY (ban route),
 *   RECOVERY_SECRET (optional JSON keypair: the pool's recovery authority, enables wallet recovery proposals).
 */
import { createKeyPairSignerFromBytes, createSolanaRpc, type Address } from "@solana/kit";
import { GATEKEEPER_NETWORK, RPC_URL } from "../config";
import { serverKoraPayer } from "../kora-server";
import { Gatekeeper, secretFromEnv } from "./gatekeeper";
import { MockProvider } from "./mock";
import { PersonaProvider } from "./persona";
import type { IdentityProvider } from "./provider";
import { IdentityService } from "./service";
import { MemoryStore, openSqlite, type IdentityStore } from "./store";

type Bundle = { service: IdentityService; provider: IdentityProvider; store: IdentityStore };
const g = globalThis as unknown as { __goodfaithIdentity?: Promise<Bundle> };

function providerFromEnv(): IdentityProvider {
  const kind = process.env.IDENTITY_PROVIDER?.trim() || "persona";
  if (kind === "mock") return new MockProvider(process.env.MOCK_WEBHOOK_SECRET?.trim() || "mock-secret");
  if (kind !== "persona") throw new Error(`IDENTITY_PROVIDER must be "persona" or "mock" (got "${kind}").`);
  return new PersonaProvider({
    apiKey: process.env.PERSONA_API_KEY?.trim() ?? "",
    templateId: process.env.PERSONA_TEMPLATE_ID?.trim() ?? "",
    webhookSecret: process.env.PERSONA_WEBHOOK_SECRET?.trim() ?? "",
  });
}

async function build(): Promise<Bundle> {
  const provider = providerFromEnv();
  const dbPath = process.env.IDENTITY_DB_PATH?.trim() || "./identity.sqlite";
  const store = dbPath === "memory" ? new MemoryStore() : openSqlite(dbPath);
  const issuer = await createKeyPairSignerFromBytes(secretFromEnv("ISSUER_SECRET", process.env.ISSUER_SECRET));
  const recovery = process.env.RECOVERY_SECRET?.trim()
    ? await createKeyPairSignerFromBytes(secretFromEnv("RECOVERY_SECRET", process.env.RECOVERY_SECRET))
    : undefined;
  const network = (GATEKEEPER_NETWORK || "") as Address;
  if (!network) throw new Error("NEXT_PUBLIC_GATEKEEPER_NETWORK is required for the identity service.");
  const gatekeeper = new Gatekeeper({
    rpcUrl: RPC_URL,
    network,
    secret: secretFromEnv("GATEKEEPER_SECRET", process.env.GATEKEEPER_SECRET),
  });
  const service = new IdentityService({
    provider,
    store,
    gatekeeper,
    issuer,
    recovery,
    rpc: createSolanaRpc(RPC_URL),
    hashSecret: process.env.PERSON_HASH_SECRET?.trim() ?? "",
    feePayer: serverKoraPayer,
  });
  return { service, provider, store };
}

/** Lazily built; a bad configuration surfaces as a clear error on the first identity request, not at boot. */
export function identity(): Promise<Bundle> {
  if (!g.__goodfaithIdentity) {
    g.__goodfaithIdentity = build().catch((e) => {
      g.__goodfaithIdentity = undefined;
      throw e;
    });
  }
  return g.__goodfaithIdentity;
}
