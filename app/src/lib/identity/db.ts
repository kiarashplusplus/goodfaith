/**
 * The one identity store per server process, from IDENTITY_DB_PATH (default ./identity.sqlite; "memory" for a
 * throwaway store). Shared by the identity service and the fee-sponsor proxy, which keeps its per-wallet counters
 * here, so the proxy works even where the identity service itself is not configured.
 */
import { MemoryStore, openSqlite, type IdentityStore } from "./store";

const g = globalThis as unknown as { __goodfaithStore?: IdentityStore };

export function openStore(): IdentityStore {
  if (!g.__goodfaithStore) {
    const dbPath = process.env.IDENTITY_DB_PATH?.trim() || "./identity.sqlite";
    g.__goodfaithStore = dbPath === "memory" ? new MemoryStore() : openSqlite(dbPath);
  }
  return g.__goodfaithStore;
}
