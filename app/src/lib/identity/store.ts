/**
 * What the identity service remembers. Two tables: one row per wallet that started a check, one row per person
 * (keyed by the person hash). Backed by Node's built-in SQLite in production and by memory in tests.
 */
export type WalletStatus =
  | "pending" // inquiry created, waiting for the provider
  | "review" // provider wants a human look
  | "declined" // provider declined
  | "ineligible" // approved but not eligible (not Texas, under 18, banned person)
  | "issued" // gateway token issued; may join (or replace a wallet)
  | "error"; // provider approved but we could not finish; retry by starting again

export type WalletRecord = {
  wallet: string;
  inquiryId: string;
  /** Hosted flow for a pending inquiry. */
  url?: string;
  status: WalletStatus;
  personHash?: string;
  reason?: string;
  tokenAddress?: string;
  createdAt: number;
  updatedAt: number;
};

export type PersonRecord = {
  personHash: string;
  /** Wallet the person last verified with (the chain is the source of truth for the bound wallet). */
  wallet: string;
  bannedAt?: number;
  createdAt: number;
};

export interface IdentityStore {
  getWallet(wallet: string): WalletRecord | null;
  getByInquiry(inquiryId: string): WalletRecord | null;
  putWallet(rec: WalletRecord): void;
  getPerson(personHash: string): PersonRecord | null;
  putPerson(rec: PersonRecord): void;
  /** Records an event id; false when it was seen before. */
  firstTime(eventId: string): boolean;
  close(): void;
}

export class MemoryStore implements IdentityStore {
  private readonly wallets = new Map<string, WalletRecord>();
  private readonly persons = new Map<string, PersonRecord>();
  private readonly events = new Set<string>();
  getWallet(w: string) {
    return this.wallets.get(w) ?? null;
  }
  getByInquiry(id: string) {
    for (const r of this.wallets.values()) if (r.inquiryId === id) return r;
    return null;
  }
  putWallet(r: WalletRecord) {
    this.wallets.set(r.wallet, { ...r });
  }
  getPerson(h: string) {
    return this.persons.get(h) ?? null;
  }
  putPerson(p: PersonRecord) {
    this.persons.set(p.personHash, { ...p });
  }
  firstTime(e: string) {
    if (this.events.has(e)) return false;
    this.events.add(e);
    return true;
  }
  close() {}
}

type SqliteModule = typeof import("node:sqlite");
type Db = InstanceType<SqliteModule["DatabaseSync"]>;
type Row = Record<string, unknown>;

/** Node 22.13+ ships `node:sqlite`; it is loaded through getBuiltinModule so bundlers leave it alone. */
export function openSqlite(path: string): IdentityStore {
  const mod = (process.getBuiltinModule as ((id: string) => unknown) | undefined)?.("node:sqlite") as SqliteModule | undefined;
  if (!mod) throw new Error("node:sqlite is not available; use Node 22.13 or newer.");
  return new SqliteStore(new mod.DatabaseSync(path));
}

export class SqliteStore implements IdentityStore {
  constructor(private readonly db: Db) {
    db.exec(`
      create table if not exists wallets (
        wallet text primary key, inquiry_id text not null, url text, status text not null, person_hash text, reason text,
        token_address text, created_at integer not null, updated_at integer not null
      );
      create index if not exists wallets_inquiry on wallets(inquiry_id);
      create table if not exists persons (person_hash text primary key, wallet text not null, banned_at integer, created_at integer not null);
      create table if not exists events (event_id text primary key, seen_at integer not null);
    `);
  }
  private toWallet(r: Row | undefined): WalletRecord | null {
    if (!r) return null;
    return {
      wallet: r.wallet as string,
      inquiryId: r.inquiry_id as string,
      url: (r.url as string | null) ?? undefined,
      status: r.status as WalletStatus,
      personHash: (r.person_hash as string | null) ?? undefined,
      reason: (r.reason as string | null) ?? undefined,
      tokenAddress: (r.token_address as string | null) ?? undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
  getWallet(w: string) {
    return this.toWallet(this.db.prepare("select * from wallets where wallet = ?").get(w) as Row | undefined);
  }
  getByInquiry(id: string) {
    return this.toWallet(
      this.db.prepare("select * from wallets where inquiry_id = ? order by updated_at desc limit 1").get(id) as Row | undefined,
    );
  }
  putWallet(r: WalletRecord) {
    this.db
      .prepare(
        `insert into wallets (wallet, inquiry_id, url, status, person_hash, reason, token_address, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(wallet) do update set inquiry_id = excluded.inquiry_id, url = excluded.url, status = excluded.status,
           person_hash = excluded.person_hash, reason = excluded.reason, token_address = excluded.token_address, updated_at = excluded.updated_at`,
      )
      .run(
        r.wallet,
        r.inquiryId,
        r.url ?? null,
        r.status,
        r.personHash ?? null,
        r.reason ?? null,
        r.tokenAddress ?? null,
        r.createdAt,
        r.updatedAt,
      );
  }
  getPerson(h: string) {
    const r = this.db.prepare("select * from persons where person_hash = ?").get(h) as Row | undefined;
    if (!r) return null;
    return {
      personHash: r.person_hash as string,
      wallet: r.wallet as string,
      bannedAt: r.banned_at == null ? undefined : Number(r.banned_at),
      createdAt: Number(r.created_at),
    };
  }
  putPerson(p: PersonRecord) {
    this.db
      .prepare(
        `insert into persons (person_hash, wallet, banned_at, created_at) values (?, ?, ?, ?)
         on conflict(person_hash) do update set wallet = excluded.wallet, banned_at = excluded.banned_at`,
      )
      .run(p.personHash, p.wallet, p.bannedAt ?? null, p.createdAt);
  }
  firstTime(e: string) {
    try {
      this.db.prepare("insert into events (event_id, seen_at) values (?, ?)").run(e, Date.now());
      return true;
    } catch {
      return false;
    }
  }
  close() {
    this.db.close();
  }
}
