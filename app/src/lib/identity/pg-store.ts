/**
 * The identity store on Postgres, for a deployment with more than one app instance or a managed database. Same
 * tables and semantics as the SQLite store; `IDENTITY_DB_URL=postgres://...` selects it (see db.ts). The schema is
 * created on first use (idempotent).
 */
import pg from "pg";
import type { CredentialRecord, IdentityStore, PersonRecord, RecoveryRecord, SponsorUsage, WalletRecord, WalletStatus } from "./store";

type Row = Record<string, unknown>;

export const PG_SCHEMA_SQL = `
  create table if not exists wallets (
    wallet text primary key, inquiry_id text not null, url text, status text not null, person_id text, link_to text, reason text,
    token_address text, created_at bigint not null, updated_at bigint not null
  );
  create index if not exists wallets_inquiry on wallets(inquiry_id);
  create index if not exists wallets_person on wallets(person_id);
  create table if not exists persons (person_id text primary key, wallet text not null, banned_at bigint, created_at bigint not null);
  create table if not exists credentials (
    hash text primary key, key_version integer not null, person_id text not null, linked_at bigint not null, via text not null
  );
  create index if not exists credentials_person on credentials(person_id);
  create table if not exists recoveries (person_id text primary key, new_wallet text not null, opened_at bigint not null);
  create table if not exists sponsorship (wallet text primary key, day text not null, day_txs integer not null, atas_total integer not null);
  create table if not exists events (event_id text primary key, seen_at bigint not null);
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
      `insert into wallets (wallet, inquiry_id, url, status, person_id, link_to, reason, token_address, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (wallet) do update set inquiry_id = excluded.inquiry_id, url = excluded.url, status = excluded.status,
         person_id = excluded.person_id, link_to = excluded.link_to, reason = excluded.reason, token_address = excluded.token_address,
         updated_at = excluded.updated_at`,
      [
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
      ],
    );
  }
  async getPerson(id: string) {
    const r = (await this.q("select * from persons where person_id = $1", [id]))[0];
    if (!r) return null;
    return {
      personId: r.person_id as string,
      wallet: r.wallet as string,
      bannedAt: r.banned_at == null ? undefined : Number(r.banned_at),
      createdAt: Number(r.created_at),
    };
  }
  async putPerson(p: PersonRecord) {
    await this.q(
      `insert into persons (person_id, wallet, banned_at, created_at) values ($1, $2, $3, $4)
       on conflict (person_id) do update set wallet = excluded.wallet, banned_at = excluded.banned_at`,
      [p.personId, p.wallet, p.bannedAt ?? null, p.createdAt],
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
  async getRecovery(id: string) {
    const r = (await this.q("select * from recoveries where person_id = $1", [id]))[0];
    return r ? { personId: r.person_id as string, newWallet: r.new_wallet as string, openedAt: Number(r.opened_at) } : null;
  }
  async putRecovery(rec: RecoveryRecord) {
    await this.q(
      `insert into recoveries (person_id, new_wallet, opened_at) values ($1, $2, $3)
       on conflict (person_id) do update set new_wallet = excluded.new_wallet, opened_at = excluded.opened_at`,
      [rec.personId, rec.newWallet, rec.openedAt],
    );
  }
  async deleteRecovery(id: string) {
    await this.q("delete from recoveries where person_id = $1", [id]);
  }
  async getSponsorUsage(w: string) {
    const r = (await this.q("select * from sponsorship where wallet = $1", [w]))[0];
    return r ? { wallet: r.wallet as string, day: r.day as string, dayTxs: Number(r.day_txs), atasTotal: Number(r.atas_total) } : null;
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
