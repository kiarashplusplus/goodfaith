/**
 * The one identity service per server process, built from the environment:
 *   IDENTITY_PROVIDER=persona|mock, PERSONA_API_KEY, PERSONA_TEMPLATE_ID, PERSONA_WEBHOOK_SECRET (persona),
 *   MOCK_WEBHOOK_SECRET (mock), PERSON_HASH_SECRETS ("2:new,1:old", newest first) or PERSON_HASH_SECRET (version 1),
 *   ISSUER_SECRET, GATEKEEPER_SECRET (both JSON keypair arrays), IDENTITY_DB_PATH (default ./identity.sqlite;
 *   "memory" for throwaway), IDENTITY_ADMIN_KEY (operator routes: ban, recoveries), NOTIFY_WEBHOOK_URL (where
 *   member notices go; the server log without it), RECOVERY_MIN_AGE_SECONDS (how long a recovery request must have
 *   been open before the operator may propose it; default one day). The recovery key never lives here: the operator's
 *   recovery CLI (scripts/recovery.ts) holds it and signs proposals the service prepared.
 */
import { createKeyPairSignerFromBytes, createSolanaRpc, type Address } from "@solana/kit";
import { GATEKEEPER_NETWORK, RPC_URL } from "../config";
import { serverKoraPayer } from "../kora-server";
import { Gatekeeper, secretFromEnv } from "./gatekeeper";
import { MockProvider } from "./mock";
import { PersonaProvider } from "./persona";
import type { IdentityProvider } from "./provider";
import { IdentityService } from "./service";
import { openStore } from "./db";
import { HashKeyring } from "./person-hash";
import { notifierFromEnv } from "./notify";
import type { IdentityStore } from "./store";

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
  const store = openStore();
  const issuer = await createKeyPairSignerFromBytes(secretFromEnv("ISSUER_SECRET", process.env.ISSUER_SECRET));
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
    rpc: createSolanaRpc(RPC_URL),
    keyring: HashKeyring.fromEnv(process.env.PERSON_HASH_SECRETS, process.env.PERSON_HASH_SECRET),
    notifier: notifierFromEnv(process.env),
    feePayer: serverKoraPayer,
    recoveryMinAgeSec: process.env.RECOVERY_MIN_AGE_SECONDS?.trim() ? Number(process.env.RECOVERY_MIN_AGE_SECONDS) : undefined,
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
