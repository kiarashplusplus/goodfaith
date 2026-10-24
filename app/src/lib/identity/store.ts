/**
 * What the identity service remembers. Two tables: one row per wallet that started a check, one row per person.
 * A person is an opaque random id; the keyed credential fingerprint that found them is kept beside it (never on
 * chain). Backed by Node's built-in SQLite in production and by memory in tests.
 */
export type WalletStatus =
  | "pending" // inquiry created, waiting for the provider
  | "review" // provider wants a human look
  | "declined" // provider declined
  | "ineligible" // approved but not eligible (not Texas, under 18, banned person)
  | "issued" // gateway token issued; may join (or recover a membership)
  | "error"; // provider approved but we could not finish; retry by starting again

export type WalletRecord = {
  wallet: string;
  inquiryId: string;
  /** Hosted flow for a pending inquiry. */
  url?: string;
  status: WalletStatus;
  /** The person the approved check resolved to (hex of the 32-byte on-chain id). */
  personId?: string;
  reason?: string;
  tokenAddress?: string;
  createdAt: number;
  updatedAt: number;
};

export type PersonRecord = {
  /** Opaque 32-byte id (hex) seeded into the on-chain Person account. */
  personId: string;
  /** Keyed fingerprint of the ID fields that found this person; the only link back to a credential. */
  credentialHash: string;
  /** Wallet the person first verified with (the chain is the source of truth for the bound wallet). */
  wallet: string;
  bannedAt?: number;
  createdAt: number;
};

export interface IdentityStore {
  getWallet(wallet: string): WalletRecord | null;
  getByInquiry(inquiryId: string): WalletRecord | null;
  putWallet(rec: WalletRecord): void;
  getPerson(personId: string): PersonRecord | null;
  getPersonByCredential(credentialHash: string): PersonRecord | null;
  putPerson(rec: PersonRecord): void;
  /** Every wallet whose check resolved to this person. */
  walletsOf(personId: string): string[];
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
  getPerson(id: string) {
    return this.persons.get(id) ?? null;
  }
  getPersonByCredential(h: string) {
    for (const p of this.persons.values()) if (p.credentialHash === h) return p;
    return null;
  }
  putPerson(p: PersonRecord) {
    this.persons.set(p.personId, { ...p });
  }
  walletsOf(id: string) {
    return [...this.wallets.values()].filter((w) => w.personId === id).map((w) => w.wallet);
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
        wallet text primary key, inquiry_id text not null, url text, status text not null, person_id text, reason text,
        token_address text, created_at integer not null, updated_at integer not null
      );
      create index if not exists wallets_inquiry on wallets(inquiry_id);
      create index if not exists wallets_person on wallets(person_id);
      create table if not exists persons (
        person_id text primary key, credential_hash text not null unique, wallet text not null, banned_at integer, created_at integer not null
      );
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
      personId: (r.person_id as string | null) ?? undefined,
      reason: (r.reason as string | null) ?? undefined,
      tokenAddress: (r.token_address as string | null) ?? undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
  private toPerson(r: Row | undefined): PersonRecord | null {
    if (!r) return null;
    return {
      personId: r.person_id as string,
      credentialHash: r.credential_hash as string,
      wallet: r.wallet as string,
      bannedAt: r.banned_at == null ? undefined : Number(r.banned_at),
      createdAt: Number(r.created_at),
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
        `insert into wallets (wallet, inquiry_id, url, status, person_id, reason, token_address, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(wallet) do update set inquiry_id = excluded.inquiry_id, url = excluded.url, status = excluded.status,
           person_id = excluded.person_id, reason = excluded.reason, token_address = excluded.token_address, updated_at = excluded.updated_at`,
      )
      .run(
        r.wallet,
        r.inquiryId,
        r.url ?? null,
        r.status,
        r.personId ?? null,
        r.reason ?? null,
        r.tokenAddress ?? null,
        r.createdAt,
        r.updatedAt,
      );
  }
  getPerson(id: string) {
    return this.toPerson(this.db.prepare("select * from persons where person_id = ?").get(id) as Row | undefined);
  }
  getPersonByCredential(h: string) {
    return this.toPerson(this.db.prepare("select * from persons where credential_hash = ?").get(h) as Row | undefined);
  }
  putPerson(p: PersonRecord) {
    this.db
      .prepare(
        `insert into persons (person_id, credential_hash, wallet, banned_at, created_at) values (?, ?, ?, ?, ?)
         on conflict(person_id) do update set credential_hash = excluded.credential_hash, wallet = excluded.wallet, banned_at = excluded.banned_at`,
      )
      .run(p.personId, p.credentialHash, p.wallet, p.bannedAt ?? null, p.createdAt);
  }
  walletsOf(id: string) {
    return (this.db.prepare("select wallet from wallets where person_id = ? order by updated_at").all(id) as Row[]).map(
      (r) => r.wallet as string,
    );
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
