/**
 * What the identity service remembers, and nothing more:
 *   wallets      one row per wallet that started a check (status, inquiry, the person it resolved to)
 *   persons      one row per person: an opaque random id (the only thing that reaches the chain)
 *   credentials  the keyed fingerprints that resolve to a person, each with the key version that made it
 *   recoveries   wallet-recovery requests waiting out the service-side review period
 *   sponsorship  per-wallet counters behind the fee-sponsor caps
 *   events       provider event ids already handled
 * Backed by Node's built-in SQLite in production, by memory in tests; Postgres follows the same interface.
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
  /** Set while a verified wallet re-checks to attach another credential to its person. */
  linkTo?: string;
  reason?: string;
  tokenAddress?: string;
  createdAt: number;
  updatedAt: number;
};

export type PersonRecord = {
  /** Opaque 32-byte id (hex) seeded into the on-chain Person account. */
  personId: string;
  /** Wallet the person first verified with (the chain is the source of truth for the bound wallet). */
  wallet: string;
  bannedAt?: number;
  createdAt: number;
};

export type CredentialRecord = {
  /** Keyed fingerprint (hex) of the ID fields; see person-hash.ts. */
  hash: string;
  keyVersion: number;
  personId: string;
  linkedAt: number;
  /** How it got attached: the person's first check, a later check under a rotated key, or an explicit link. */
  via: "verify" | "rotate" | "link";
};

export type RecoveryRecord = { personId: string; newWallet: string; openedAt: number };

export type SponsorUsage = { wallet: string; day: string; dayTxs: number; atasTotal: number };

export interface IdentityStore {
  getWallet(wallet: string): Promise<WalletRecord | null>;
  getByInquiry(inquiryId: string): Promise<WalletRecord | null>;
  putWallet(rec: WalletRecord): Promise<void>;
  getPerson(personId: string): Promise<PersonRecord | null>;
  putPerson(rec: PersonRecord): Promise<void>;
  /** Every wallet whose check resolved to this person. */
  walletsOf(personId: string): Promise<string[]>;
  getCredential(hash: string): Promise<CredentialRecord | null>;
  putCredential(rec: CredentialRecord): Promise<void>;
  credentialsOf(personId: string): Promise<CredentialRecord[]>;
  getRecovery(personId: string): Promise<RecoveryRecord | null>;
  putRecovery(rec: RecoveryRecord): Promise<void>;
  deleteRecovery(personId: string): Promise<void>;
  getSponsorUsage(wallet: string): Promise<SponsorUsage | null>;
  putSponsorUsage(rec: SponsorUsage): Promise<void>;
  /** Records an event id; false when it was seen before. */
  firstTime(eventId: string): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryStore implements IdentityStore {
  private readonly wallets = new Map<string, WalletRecord>();
  private readonly persons = new Map<string, PersonRecord>();
  private readonly credentials = new Map<string, CredentialRecord>();
  private readonly recoveries = new Map<string, RecoveryRecord>();
  private readonly usage = new Map<string, SponsorUsage>();
  private readonly events = new Set<string>();
  async getWallet(w: string) {
    return this.wallets.get(w) ?? null;
  }
  async getByInquiry(id: string) {
    for (const r of this.wallets.values()) if (r.inquiryId === id) return r;
    return null;
  }
  async putWallet(r: WalletRecord) {
    this.wallets.set(r.wallet, { ...r });
  }
  async getPerson(id: string) {
    return this.persons.get(id) ?? null;
  }
  async putPerson(p: PersonRecord) {
    this.persons.set(p.personId, { ...p });
  }
  async walletsOf(id: string) {
    return [...this.wallets.values()].filter((w) => w.personId === id).map((w) => w.wallet);
  }
  async getCredential(h: string) {
    return this.credentials.get(h) ?? null;
  }
  async putCredential(c: CredentialRecord) {
    this.credentials.set(c.hash, { ...c });
  }
  async credentialsOf(id: string) {
    return [...this.credentials.values()].filter((c) => c.personId === id).sort((a, b) => a.linkedAt - b.linkedAt);
  }
  async getRecovery(id: string) {
    return this.recoveries.get(id) ?? null;
  }
  async putRecovery(r: RecoveryRecord) {
    this.recoveries.set(r.personId, { ...r });
  }
  async deleteRecovery(id: string) {
    this.recoveries.delete(id);
  }
  async getSponsorUsage(w: string) {
    return this.usage.get(w) ?? null;
  }
  async putSponsorUsage(u: SponsorUsage) {
    this.usage.set(u.wallet, { ...u });
  }
  async firstTime(e: string) {
    if (this.events.has(e)) return false;
    this.events.add(e);
    return true;
  }
  async close() {}
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

export const SCHEMA_SQL = `
  create table if not exists wallets (
    wallet text primary key, inquiry_id text not null, url text, status text not null, person_id text, link_to text, reason text,
    token_address text, created_at integer not null, updated_at integer not null
  );
  create index if not exists wallets_inquiry on wallets(inquiry_id);
  create index if not exists wallets_person on wallets(person_id);
  create table if not exists persons (person_id text primary key, wallet text not null, banned_at integer, created_at integer not null);
  create table if not exists credentials (
    hash text primary key, key_version integer not null, person_id text not null, linked_at integer not null, via text not null
  );
  create index if not exists credentials_person on credentials(person_id);
  create table if not exists recoveries (person_id text primary key, new_wallet text not null, opened_at integer not null);
  create table if not exists sponsorship (wallet text primary key, day text not null, day_txs integer not null, atas_total integer not null);
  create table if not exists events (event_id text primary key, seen_at integer not null);
`;

export class SqliteStore implements IdentityStore {
  constructor(private readonly db: Db) {
    db.exec(SCHEMA_SQL);
  }
  private toWallet(r: Row | undefined): WalletRecord | null {
    if (!r) return null;
    return {
      wallet: r.wallet as string,
      inquiryId: r.inquiry_id as string,
      url: (r.url as string | null) ?? undefined,
      status: r.status as WalletStatus,
      personId: (r.person_id as string | null) ?? undefined,
      linkTo: (r.link_to as string | null) ?? undefined,
      reason: (r.reason as string | null) ?? undefined,
      tokenAddress: (r.token_address as string | null) ?? undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
  private toCredential(r: Row): CredentialRecord {
    return {
      hash: r.hash as string,
      keyVersion: Number(r.key_version),
      personId: r.person_id as string,
      linkedAt: Number(r.linked_at),
      via: r.via as CredentialRecord["via"],
    };
  }
  async getWallet(w: string) {
    return this.toWallet(this.db.prepare("select * from wallets where wallet = ?").get(w) as Row | undefined);
  }
  async getByInquiry(id: string) {
    return this.toWallet(
      this.db.prepare("select * from wallets where inquiry_id = ? order by updated_at desc limit 1").get(id) as Row | undefined,
    );
  }
  async putWallet(r: WalletRecord) {
    this.db
      .prepare(
        `insert into wallets (wallet, inquiry_id, url, status, person_id, link_to, reason, token_address, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(wallet) do update set inquiry_id = excluded.inquiry_id, url = excluded.url, status = excluded.status,
           person_id = excluded.person_id, link_to = excluded.link_to, reason = excluded.reason, token_address = excluded.token_address,
           updated_at = excluded.updated_at`,
      )
      .run(
        r.wallet,
        r.inquiryId,
        r.url ?? null,
        r.status,
        r.personId ?? null,
        r.linkTo ?? null,
        r.reason ?? null,
        r.tokenAddress ?? null,
        r.createdAt,
        r.updatedAt,
      );
  }
  async getPerson(id: string) {
    const r = this.db.prepare("select * from persons where person_id = ?").get(id) as Row | undefined;
    if (!r) return null;
    return {
      personId: r.person_id as string,
      wallet: r.wallet as string,
      bannedAt: r.banned_at == null ? undefined : Number(r.banned_at),
      createdAt: Number(r.created_at),
    };
  }
  async putPerson(p: PersonRecord) {
    this.db
      .prepare(
        `insert into persons (person_id, wallet, banned_at, created_at) values (?, ?, ?, ?)
         on conflict(person_id) do update set wallet = excluded.wallet, banned_at = excluded.banned_at`,
      )
      .run(p.personId, p.wallet, p.bannedAt ?? null, p.createdAt);
  }
  async walletsOf(id: string) {
    return (this.db.prepare("select wallet from wallets where person_id = ? order by updated_at").all(id) as Row[]).map(
      (r) => r.wallet as string,
    );
  }
  async getCredential(h: string) {
    const r = this.db.prepare("select * from credentials where hash = ?").get(h) as Row | undefined;
    return r ? this.toCredential(r) : null;
  }
  async putCredential(c: CredentialRecord) {
    this.db
      .prepare(
        `insert into credentials (hash, key_version, person_id, linked_at, via) values (?, ?, ?, ?, ?)
         on conflict(hash) do update set key_version = excluded.key_version, person_id = excluded.person_id, linked_at = excluded.linked_at, via = excluded.via`,
      )
      .run(c.hash, c.keyVersion, c.personId, c.linkedAt, c.via);
  }
  async credentialsOf(id: string) {
    return (this.db.prepare("select * from credentials where person_id = ? order by linked_at").all(id) as Row[]).map((r) =>
      this.toCredential(r),
    );
  }
  async getRecovery(id: string) {
    const r = this.db.prepare("select * from recoveries where person_id = ?").get(id) as Row | undefined;
    return r ? { personId: r.person_id as string, newWallet: r.new_wallet as string, openedAt: Number(r.opened_at) } : null;
  }
  async putRecovery(rec: RecoveryRecord) {
    this.db
      .prepare(
        `insert into recoveries (person_id, new_wallet, opened_at) values (?, ?, ?)
         on conflict(person_id) do update set new_wallet = excluded.new_wallet, opened_at = excluded.opened_at`,
      )
      .run(rec.personId, rec.newWallet, rec.openedAt);
  }
  async deleteRecovery(id: string) {
    this.db.prepare("delete from recoveries where person_id = ?").run(id);
  }
  async getSponsorUsage(w: string) {
    const r = this.db.prepare("select * from sponsorship where wallet = ?").get(w) as Row | undefined;
    return r ? { wallet: r.wallet as string, day: r.day as string, dayTxs: Number(r.day_txs), atasTotal: Number(r.atas_total) } : null;
  }
  async putSponsorUsage(u: SponsorUsage) {
    this.db
      .prepare(
        `insert into sponsorship (wallet, day, day_txs, atas_total) values (?, ?, ?, ?)
         on conflict(wallet) do update set day = excluded.day, day_txs = excluded.day_txs, atas_total = excluded.atas_total`,
      )
      .run(u.wallet, u.day, u.dayTxs, u.atasTotal);
  }
  async firstTime(e: string) {
    try {
      this.db.prepare("insert into events (event_id, seen_at) values (?, ?)").run(e, Date.now());
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    this.db.close();
  }
}
