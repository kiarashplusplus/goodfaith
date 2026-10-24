/**
 * The identity store on Postgres, for a deployment with more than one app instance or a managed database. Same
 * tables and semantics as the SQLite store; `IDENTITY_DB_URL=postgres://...` selects it (see db.ts). The schema is
 * created on first use (idempotent).
 */
import pg from "pg";
import {
  RECOVERY_COLUMNS,
  personFromRow,
  recoveryFromRow,
  recoveryValues,
  type BudgetCaps,
  type CredentialRecord,
  type IdentityStore,
  type PersonRecord,
  type RecoveryClosedAs,
  type RecoveryRecord,
  type SponsorCaps,
  type SponsorUsage,
  type WalletRecord,
  type WalletStatus,
} from "./store";

type Row = Record<string, unknown>;

export const PG_SCHEMA_SQL = `
  create table if not exists wallets (
    wallet text primary key, inquiry_id text not null, url text, status text not null, person_id text, link_to text, reason text,
    token_address text, contact text, created_at bigint not null, updated_at bigint not null
  );
  create index if not exists wallets_inquiry on wallets(inquiry_id);
  create index if not exists wallets_person on wallets(person_id);
  create table if not exists persons (
    person_id text primary key, wallet text not null, banned_at bigint, banned_until bigint, contact text, created_at bigint not null
  );
  create table if not exists credentials (
    hash text primary key, key_version integer not null, person_id text not null, linked_at bigint not null, via text not null
  );
  create index if not exists credentials_person on credentials(person_id);
  create table if not exists recoveries (
    person_id text primary key, new_wallet text not null, opened_at bigint not null, notified_at bigint, delivery text,
    proposed_at bigint, signature text, closed_as text, closed_at bigint
  );
  create table if not exists sponsorship (wallet text primary key, day text not null, day_txs integer not null, atas_total integer not null);
  create table if not exists sponsor_budget (day text primary key, txs integer not null, new_wallets integer not null);
  create table if not exists events (event_id text primary key, seen_at bigint not null);
  alter table wallets add column if not exists contact text;
  alter table persons add column if not exists banned_until bigint;
  alter table persons add column if not exists contact text;
  alter table recoveries add column if not exists notified_at bigint;
  alter table recoveries add column if not exists delivery text;
  alter table recoveries add column if not exists proposed_at bigint;
  alter table recoveries add column if not exists signature text;
  alter table recoveries add column if not exists closed_as text;
  alter table recoveries add column if not exists closed_at bigint;
`;

export class PgStore implements IdentityStore {
  private readonly ready: Promise<void>;
  constructor(private readonly pool: pg.Pool) {
    this.ready = pool.query(PG_SCHEMA_SQL).then(() => undefined);
  }
  static fromUrl(url: string): PgStore {
    return new PgStore(new pg.Pool({ connectionString: url, max: 5 }));
  }
  private async q(text: string, values: unknown[] = []): Promise<Row[]> {
    await this.ready;
    return (await this.pool.query(text, values)).rows as Row[];
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
    return this.toWallet((await this.q("select * from wallets where wallet = $1", [w]))[0]);
  }
  async getByInquiry(id: string) {
    return this.toWallet((await this.q("select * from wallets where inquiry_id = $1 order by updated_at desc limit 1", [id]))[0]);
  }
  async putWallet(r: WalletRecord) {
    await this.q(
      `insert into wallets (wallet, inquiry_id, url, status, person_id, link_to, reason, token_address, contact, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (wallet) do update set inquiry_id = excluded.inquiry_id, url = excluded.url, status = excluded.status,
         person_id = excluded.person_id, link_to = excluded.link_to, reason = excluded.reason, token_address = excluded.token_address,
         contact = excluded.contact, updated_at = excluded.updated_at`,
      [
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
      ],
    );
  }
  async getPerson(id: string) {
    const r = (await this.q("select * from persons where person_id = $1", [id]))[0];
    return r ? personFromRow(r) : null;
  }
  async listBarredPersons(): Promise<PersonRecord[]> {
    return (await this.q("select * from persons where banned_until is not null")).map(personFromRow);
  }
  async putPerson(p: PersonRecord) {
    await this.q(
      `insert into persons (person_id, wallet, banned_at, banned_until, contact, created_at) values ($1, $2, $3, $4, $5, $6)
       on conflict (person_id) do update set wallet = excluded.wallet, banned_at = excluded.banned_at,
         banned_until = excluded.banned_until, contact = excluded.contact`,
      [p.personId, p.wallet, p.bannedAt ?? null, p.bannedUntil ?? null, p.contact ?? null, p.createdAt],
    );
  }
  async walletsOf(id: string) {
    return (await this.q("select wallet from wallets where person_id = $1 order by updated_at", [id])).map((r) => r.wallet as string);
  }
  async getCredential(h: string) {
    const r = (await this.q("select * from credentials where hash = $1", [h]))[0];
    return r ? this.toCredential(r) : null;
  }
  async putCredential(c: CredentialRecord) {
    await this.q(
      `insert into credentials (hash, key_version, person_id, linked_at, via) values ($1, $2, $3, $4, $5)
       on conflict (hash) do update set key_version = excluded.key_version, person_id = excluded.person_id, linked_at = excluded.linked_at, via = excluded.via`,
      [c.hash, c.keyVersion, c.personId, c.linkedAt, c.via],
    );
  }
  async credentialsOf(id: string) {
    return (await this.q("select * from credentials where person_id = $1 order by linked_at", [id])).map((r) => this.toCredential(r));
  }
  async getRecovery(id: string): Promise<RecoveryRecord | null> {
    const r = (await this.q("select * from recoveries where person_id = $1 and closed_as is null", [id]))[0];
    return r ? recoveryFromRow(r) : null;
  }
  async getRecoveryHistory(id: string): Promise<RecoveryRecord | null> {
    const r = (await this.q("select * from recoveries where person_id = $1", [id]))[0];
    return r ? recoveryFromRow(r) : null;
  }
  async listRecoveries() {
    return (await this.q("select * from recoveries where closed_as is null order by opened_at")).map(recoveryFromRow);
  }
  async putRecovery(rec: RecoveryRecord) {
    await this.q(
      `insert into recoveries (${RECOVERY_COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (person_id) do update set new_wallet = excluded.new_wallet, opened_at = excluded.opened_at,
         notified_at = excluded.notified_at, delivery = excluded.delivery, proposed_at = excluded.proposed_at,
         signature = excluded.signature, closed_as = excluded.closed_as, closed_at = excluded.closed_at`,
      recoveryValues(rec),
    );
  }
  async closeRecovery(id: string, as: RecoveryClosedAs, at: number) {
    await this.q("update recoveries set closed_as = $1, closed_at = $2 where person_id = $3 and closed_as is null", [as, at, id]);
  }
  private usageOf(r: Row | undefined): SponsorUsage | null {
    return r ? { wallet: r.wallet as string, day: r.day as string, dayTxs: Number(r.day_txs), atasTotal: Number(r.atas_total) } : null;
  }
  async getSponsorUsage(w: string) {
    return this.usageOf((await this.q("select * from sponsorship where wallet = $1", [w]))[0]);
  }
  async reserveSponsorUsage(w: string, day: string, atas: number, caps: SponsorCaps) {
    await this.q("insert into sponsorship (wallet, day, day_txs, atas_total) values ($1, $2, 0, 0) on conflict (wallet) do nothing", [
      w,
      day,
    ]);
    await this.q("update sponsorship set day = $1, day_txs = 0 where wallet = $2 and day <> $1", [day, w]);
    const rows = await this.q(
      `update sponsorship set day_txs = day_txs + 1, atas_total = atas_total + $1
       where wallet = $2 and day = $3 and day_txs < $4 and atas_total + $1 <= $5 returning *`,
      [atas, w, day, caps.dailyTxs, caps.totalAtas],
    );
    return this.usageOf(rows[0]);
  }
  async releaseSponsorUsage(w: string, day: string, atas: number) {
    await this.q(
      `update sponsorship set day_txs = greatest(day_txs - 1, 0), atas_total = greatest(atas_total - $1, 0) where wallet = $2 and day = $3`,
      [atas, w, day],
    );
  }
  async reserveSponsorBudget(day: string, newWallet: boolean, caps: BudgetCaps) {
    await this.q("insert into sponsor_budget (day, txs, new_wallets) values ($1, 0, 0) on conflict (day) do nothing", [day]);
    const rows = await this.q(
      `update sponsor_budget set txs = txs + 1, new_wallets = new_wallets + $1
       where day = $2 and txs < $3 and new_wallets + $1 <= $4 returning day`,
      [newWallet ? 1 : 0, day, caps.dailyTxs, caps.dailyNewWallets],
    );
    return rows.length > 0;
  }
  async releaseSponsorBudget(day: string, newWallet: boolean) {
    await this.q("update sponsor_budget set txs = greatest(txs - 1, 0), new_wallets = greatest(new_wallets - $1, 0) where day = $2", [
      newWallet ? 1 : 0,
      day,
    ]);
  }
  async getSponsorBudget(day: string) {
    const r = (await this.q("select * from sponsor_budget where day = $1", [day]))[0];
    return r ? { day: r.day as string, txs: Number(r.txs), newWallets: Number(r.new_wallets) } : null;
  }
  async putSponsorUsage(u: SponsorUsage) {
    await this.q(
      `insert into sponsorship (wallet, day, day_txs, atas_total) values ($1, $2, $3, $4)
       on conflict (wallet) do update set day = excluded.day, day_txs = excluded.day_txs, atas_total = excluded.atas_total`,
      [u.wallet, u.day, u.dayTxs, u.atasTotal],
    );
  }
  async firstTime(e: string) {
    const rows = await this.q("insert into events (event_id, seen_at) values ($1, $2) on conflict do nothing returning event_id", [
      e,
      Date.now(),
    ]);
    return rows.length > 0;
  }
  async close() {
    await this.pool.end();
  }
}
