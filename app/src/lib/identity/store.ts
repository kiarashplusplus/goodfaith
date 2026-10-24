/**
 * What the identity service remembers, and nothing more:
 *   wallets      one row per wallet that started a check (status, inquiry, the person it resolved to)
 *   persons      one row per person: an opaque random id (the only thing that reaches the chain)
 *   credentials  the keyed fingerprints that resolve to a person, each with the key version that made it
 *   recoveries   wallet-recovery requests: opened, notified, proposed on chain, and how they closed
 *   sponsorship  per-wallet counters behind the fee-sponsor caps (reserved atomically before a transaction is forwarded)
 *   sponsor_budget  the fund-wide daily counters (transactions, wallets sponsored for the first time)
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
  /** Optional contact (an email) the member gave when verifying; copied to the person, used for notices only. */
  contact?: string;
  createdAt: number;
  updatedAt: number;
};

export type PersonRecord = {
  /** Opaque 32-byte id (hex) seeded into the on-chain Person account. */
  personId: string;
  /** Wallet the person first verified with (the chain is the source of truth for the bound wallet). */
  wallet: string;
  /** When the person was last barred (history). */
  bannedAt?: number;
  /** Unix seconds until which the person is barred, mirroring the chain; `PERMANENT_UNTIL` for good; absent when not barred. */
  bannedUntil?: number;
  /** Where to send notices (recovery requests, bars), when the member gave one. */
  contact?: string;
  createdAt: number;
};

/** `bannedUntil` at or above this means for good (the chain's i64 max does not fit a JS number exactly). */
export const PERMANENT_UNTIL = Number.MAX_SAFE_INTEGER;

export type CredentialRecord = {
  /** Keyed fingerprint (hex) of the ID fields; see person-hash.ts. */
  hash: string;
  keyVersion: number;
  personId: string;
  linkedAt: number;
  /** How it got attached: the person's first check, a later check under a rotated key, or an explicit link. */
  via: "verify" | "rotate" | "link";
};

export type RecoveryDelivery = "sent" | "failed";
export type RecoveryClosedAs = "finalized" | "vetoed" | "rejected" | "withdrawn" | "barred";
/** One recovery request per person at a time; a closed one stays as history until the next request replaces it. */
export type RecoveryRecord = {
  personId: string;
  newWallet: string;
  /** Unix milliseconds. */
  openedAt: number;
  /** When the notice about the request went out, and whether the configured channel took it. */
  notifiedAt?: number;
  delivery?: RecoveryDelivery;
  /** The operator's on-chain proposal, once sent. */
  proposedAt?: number;
  signature?: string;
  closedAs?: RecoveryClosedAs;
  closedAt?: number;
};

export type SponsorUsage = { wallet: string; day: string; dayTxs: number; atasTotal: number };
export type SponsorCaps = { dailyTxs: number; totalAtas: number };
export type BudgetCaps = { dailyTxs: number; dailyNewWallets: number };

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
  /** The open recovery request of a person (a closed one reads as null). */
  getRecovery(personId: string): Promise<RecoveryRecord | null>;
  /** The latest request, open or closed. */
  getRecoveryHistory(personId: string): Promise<RecoveryRecord | null>;
  putRecovery(rec: RecoveryRecord): Promise<void>;
  /** Closes the open request, recording how. */
  closeRecovery(personId: string, as: RecoveryClosedAs, at: number): Promise<void>;
  /** Every open recovery request, oldest first. */
  listRecoveries(): Promise<RecoveryRecord[]>;
  /** Every person the store has as barred (temporarily or for good). */
  listBarredPersons(): Promise<PersonRecord[]>;
  getSponsorUsage(wallet: string): Promise<SponsorUsage | null>;
  putSponsorUsage(rec: SponsorUsage): Promise<void>;
  /**
   * Counts one more sponsored transaction (and `atas` new token accounts) for a wallet on `day` if its caps allow,
   * atomically, so two requests in flight cannot both pass. Returns the usage after, or null when a cap is reached.
   */
  reserveSponsorUsage(wallet: string, day: string, atas: number, caps: SponsorCaps): Promise<SponsorUsage | null>;
  /** Gives a reservation back after a definite refusal (not after a timeout: the transaction may have landed). */
  releaseSponsorUsage(wallet: string, day: string, atas: number): Promise<void>;
  /** The fund-wide counters for `day`: one more transaction, and one more new wallet when `newWallet`. */
  reserveSponsorBudget(day: string, newWallet: boolean, caps: BudgetCaps): Promise<boolean>;
  releaseSponsorBudget(day: string, newWallet: boolean): Promise<void>;
  getSponsorBudget(day: string): Promise<{ day: string; txs: number; newWallets: number } | null>;
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
  private readonly budget = new Map<string, { day: string; txs: number; newWallets: number }>();
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
    const r = this.recoveries.get(id);
    return r && !r.closedAs ? { ...r } : null;
  }
  async getRecoveryHistory(id: string) {
    const r = this.recoveries.get(id);
    return r ? { ...r } : null;
  }
  async putRecovery(r: RecoveryRecord) {
    this.recoveries.set(r.personId, { ...r });
  }
  async closeRecovery(id: string, as: RecoveryClosedAs, at: number) {
    const r = this.recoveries.get(id);
    if (r && !r.closedAs) this.recoveries.set(id, { ...r, closedAs: as, closedAt: at });
  }
  async listRecoveries() {
    return [...this.recoveries.values()]
      .filter((r) => !r.closedAs)
      .sort((a, b) => a.openedAt - b.openedAt)
      .map((r) => ({ ...r }));
  }
  async listBarredPersons() {
    return [...this.persons.values()].filter((p) => p.bannedUntil !== undefined).map((p) => ({ ...p }));
  }
  async getSponsorUsage(w: string) {
    return this.usage.get(w) ?? null;
  }
  async putSponsorUsage(u: SponsorUsage) {
    this.usage.set(u.wallet, { ...u });
  }
  async reserveSponsorUsage(w: string, day: string, atas: number, caps: SponsorCaps) {
    const cur = this.usage.get(w);
    const base: SponsorUsage = cur && cur.day === day ? cur : { wallet: w, day, dayTxs: 0, atasTotal: cur?.atasTotal ?? 0 };
    if (base.dayTxs >= caps.dailyTxs || base.atasTotal + atas > caps.totalAtas) {
      if (!cur || cur.day !== day) this.usage.set(w, base);
      return null;
    }
    const next = { ...base, dayTxs: base.dayTxs + 1, atasTotal: base.atasTotal + atas };
    this.usage.set(w, next);
    return { ...next };
  }
  async releaseSponsorUsage(w: string, day: string, atas: number) {
    const cur = this.usage.get(w);
    if (!cur || cur.day !== day) return;
    this.usage.set(w, { ...cur, dayTxs: Math.max(0, cur.dayTxs - 1), atasTotal: Math.max(0, cur.atasTotal - atas) });
  }
  async reserveSponsorBudget(day: string, newWallet: boolean, caps: BudgetCaps) {
    const cur = this.budget.get(day) ?? { day, txs: 0, newWallets: 0 };
    if (cur.txs >= caps.dailyTxs || (newWallet && cur.newWallets >= caps.dailyNewWallets)) {
      this.budget.set(day, cur);
      return false;
    }
    this.budget.set(day, { day, txs: cur.txs + 1, newWallets: cur.newWallets + (newWallet ? 1 : 0) });
    return true;
  }
  async releaseSponsorBudget(day: string, newWallet: boolean) {
    const cur = this.budget.get(day);
    if (!cur) return;
    this.budget.set(day, { day, txs: Math.max(0, cur.txs - 1), newWallets: Math.max(0, cur.newWallets - (newWallet ? 1 : 0)) });
  }
  async getSponsorBudget(day: string) {
    const b = this.budget.get(day);
    return b ? { ...b } : null;
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
    token_address text, contact text, created_at integer not null, updated_at integer not null
  );
  create index if not exists wallets_inquiry on wallets(inquiry_id);
  create index if not exists wallets_person on wallets(person_id);
  create table if not exists persons (
    person_id text primary key, wallet text not null, banned_at integer, banned_until integer, contact text, created_at integer not null
  );
  create table if not exists credentials (
    hash text primary key, key_version integer not null, person_id text not null, linked_at integer not null, via text not null
  );
  create index if not exists credentials_person on credentials(person_id);
  create table if not exists recoveries (
    person_id text primary key, new_wallet text not null, opened_at integer not null, notified_at integer, delivery text,
    proposed_at integer, signature text, closed_as text, closed_at integer
  );
  create table if not exists sponsorship (wallet text primary key, day text not null, day_txs integer not null, atas_total integer not null);
  create table if not exists sponsor_budget (day text primary key, txs integer not null, new_wallets integer not null);
  create table if not exists events (event_id text primary key, seen_at integer not null);
`;

/** Columns added after the first release; `alter table` fails harmlessly where they already exist. */
export const MIGRATIONS_SQL = [
  "alter table wallets add column contact text",
  "alter table persons add column banned_until integer",
  "alter table persons add column contact text",
  "alter table recoveries add column notified_at integer",
  "alter table recoveries add column delivery text",
  "alter table recoveries add column proposed_at integer",
  "alter table recoveries add column signature text",
  "alter table recoveries add column closed_as text",
  "alter table recoveries add column closed_at integer",
];

const RECOVERY_COLUMNS = "person_id, new_wallet, opened_at, notified_at, delivery, proposed_at, signature, closed_as, closed_at";
const recoveryValues = (r: RecoveryRecord) => [
  r.personId,
  r.newWallet,
  r.openedAt,
  r.notifiedAt ?? null,
  r.delivery ?? null,
  r.proposedAt ?? null,
  r.signature ?? null,
  r.closedAs ?? null,
  r.closedAt ?? null,
];
/** Shared by the SQL stores: a row of the recoveries table. */
export function recoveryFromRow(r: Record<string, unknown>): RecoveryRecord {
  const num = (v: unknown) => (v == null ? undefined : Number(v));
  return {
    personId: r.person_id as string,
    newWallet: r.new_wallet as string,
    openedAt: Number(r.opened_at),
    notifiedAt: num(r.notified_at),
    delivery: (r.delivery as RecoveryDelivery | null) ?? undefined,
    proposedAt: num(r.proposed_at),
    signature: (r.signature as string | null) ?? undefined,
    closedAs: (r.closed_as as RecoveryClosedAs | null) ?? undefined,
    closedAt: num(r.closed_at),
  };
}
export function personFromRow(r: Record<string, unknown>): PersonRecord {
  return {
    personId: r.person_id as string,
    wallet: r.wallet as string,
    bannedAt: r.banned_at == null ? undefined : Number(r.banned_at),
    bannedUntil: r.banned_until == null ? undefined : Number(r.banned_until),
    contact: (r.contact as string | null) ?? undefined,
    createdAt: Number(r.created_at),
  };
}
export { RECOVERY_COLUMNS, recoveryValues };

export class SqliteStore implements IdentityStore {
  constructor(private readonly db: Db) {
    db.exec(SCHEMA_SQL);
    for (const sql of MIGRATIONS_SQL) {
      try {
        db.exec(sql);
      } catch {
        // the column is there already
      }
    }
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
      contact: (r.contact as string | null) ?? undefined,
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
        `insert into wallets (wallet, inquiry_id, url, status, person_id, link_to, reason, token_address, contact, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(wallet) do update set inquiry_id = excluded.inquiry_id, url = excluded.url, status = excluded.status,
           person_id = excluded.person_id, link_to = excluded.link_to, reason = excluded.reason, token_address = excluded.token_address,
           contact = excluded.contact, updated_at = excluded.updated_at`,
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
        r.contact ?? null,
        r.createdAt,
        r.updatedAt,
      );
  }
  async getPerson(id: string) {
    const r = this.db.prepare("select * from persons where person_id = ?").get(id) as Row | undefined;
    return r ? personFromRow(r) : null;
  }
  async listBarredPersons() {
    return (this.db.prepare("select * from persons where banned_until is not null").all() as Row[]).map(personFromRow);
  }
  async putPerson(p: PersonRecord) {
    this.db
      .prepare(
        `insert into persons (person_id, wallet, banned_at, banned_until, contact, created_at) values (?, ?, ?, ?, ?, ?)
         on conflict(person_id) do update set wallet = excluded.wallet, banned_at = excluded.banned_at,
           banned_until = excluded.banned_until, contact = excluded.contact`,
      )
      .run(p.personId, p.wallet, p.bannedAt ?? null, p.bannedUntil ?? null, p.contact ?? null, p.createdAt);
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
    const r = this.db.prepare("select * from recoveries where person_id = ? and closed_as is null").get(id) as Row | undefined;
    return r ? recoveryFromRow(r) : null;
  }
  async getRecoveryHistory(id: string) {
    const r = this.db.prepare("select * from recoveries where person_id = ?").get(id) as Row | undefined;
    return r ? recoveryFromRow(r) : null;
  }
  async listRecoveries() {
    return (this.db.prepare("select * from recoveries where closed_as is null order by opened_at").all() as Row[]).map(recoveryFromRow);
  }
  async putRecovery(rec: RecoveryRecord) {
    this.db
      .prepare(
        `insert into recoveries (${RECOVERY_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(person_id) do update set new_wallet = excluded.new_wallet, opened_at = excluded.opened_at,
           notified_at = excluded.notified_at, delivery = excluded.delivery, proposed_at = excluded.proposed_at,
           signature = excluded.signature, closed_as = excluded.closed_as, closed_at = excluded.closed_at`,
      )
      .run(...recoveryValues(rec));
  }
  async closeRecovery(id: string, as: RecoveryClosedAs, at: number) {
    this.db.prepare("update recoveries set closed_as = ?, closed_at = ? where person_id = ? and closed_as is null").run(as, at, id);
  }
  private usageOf(r: Row | undefined): SponsorUsage | null {
    return r ? { wallet: r.wallet as string, day: r.day as string, dayTxs: Number(r.day_txs), atasTotal: Number(r.atas_total) } : null;
  }
  async getSponsorUsage(w: string) {
    return this.usageOf(this.db.prepare("select * from sponsorship where wallet = ?").get(w) as Row | undefined);
  }
  async reserveSponsorUsage(w: string, day: string, atas: number, caps: SponsorCaps) {
    // A row for today (a stale day rolls over to zero), then one conditional increment.
    this.db
      .prepare("insert into sponsorship (wallet, day, day_txs, atas_total) values (?, ?, 0, 0) on conflict(wallet) do nothing")
      .run(w, day);
    this.db.prepare("update sponsorship set day = ?, day_txs = 0 where wallet = ? and day <> ?").run(day, w, day);
    return this.usageOf(
      this.db
        .prepare(
          `update sponsorship set day_txs = day_txs + 1, atas_total = atas_total + ?
           where wallet = ? and day = ? and day_txs < ? and atas_total + ? <= ? returning *`,
        )
        .get(atas, w, day, caps.dailyTxs, atas, caps.totalAtas) as Row | undefined,
    );
  }
  async releaseSponsorUsage(w: string, day: string, atas: number) {
    this.db
      .prepare(`update sponsorship set day_txs = max(day_txs - 1, 0), atas_total = max(atas_total - ?, 0) where wallet = ? and day = ?`)
      .run(atas, w, day);
  }
  async reserveSponsorBudget(day: string, newWallet: boolean, caps: BudgetCaps) {
    this.db.prepare("insert into sponsor_budget (day, txs, new_wallets) values (?, 0, 0) on conflict(day) do nothing").run(day);
    const row = this.db
      .prepare(
        `update sponsor_budget set txs = txs + 1, new_wallets = new_wallets + ?
         where day = ? and txs < ? and new_wallets + ? <= ? returning day`,
      )
      .get(newWallet ? 1 : 0, day, caps.dailyTxs, newWallet ? 1 : 0, caps.dailyNewWallets);
    return row !== undefined;
  }
  async releaseSponsorBudget(day: string, newWallet: boolean) {
    this.db
      .prepare("update sponsor_budget set txs = max(txs - 1, 0), new_wallets = max(new_wallets - ?, 0) where day = ?")
      .run(newWallet ? 1 : 0, day);
  }
  async getSponsorBudget(day: string) {
    const r = this.db.prepare("select * from sponsor_budget where day = ?").get(day) as Row | undefined;
    return r ? { day: r.day as string, txs: Number(r.txs), newWallets: Number(r.new_wallets) } : null;
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
