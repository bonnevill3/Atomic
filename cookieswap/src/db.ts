import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { AssetId, ChainId } from "./assets";

export type OrderStatus =
  | "awaiting_deposit" // waiting for the user's deposit
  | "confirming" // deposit seen, waiting for confirmations
  | "awaiting_approval" // above MANUAL_REVIEW_USD: deposit confirmed, operator must approve, fill or refund
  | "approved" // operator approved; engine executes on the next tick
  | "executing" // write-ahead marker: a send is in progress (never auto-retried)
  | "dex_pending" // forwarded to the DEX, waiting for its payout
  | "completed"
  | "refund_pending"
  | "refunding" // write-ahead marker for the refund send
  | "refunded"
  | "expired"
  | "needs_review"; // operator must look at it (admin API)

export const FINAL_STATUSES: OrderStatus[] = ["completed", "refunded", "expired"];

export type RouteKind = "dex" | "inventory" | "inventory_dex";

export interface OrderRow {
  id: string;
  token_hash: string;
  from_asset: AssetId;
  to_asset: AssetId;
  amount_in: string;
  quoted_out: string;
  route_kind: RouteKind;
  provider: string;
  recipient: string;
  refund_address: string;
  deposit_chain: ChainId;
  deposit_address: string;
  deposit_index: number;
  status: OrderStatus;
  received_amount: string | null;
  deposit_txids: string | null;
  exec_txid: string | null;
  exec_ref: string | null;
  payout_txid: string | null;
  refund_txid: string | null;
  amount_out: string | null;
  /** dex route: how much of the deposit we forwarded to the DEX (a DEX refund comes back to the deposit address). */
  forwarded_amount: string | null;
  /** Rate tolerance the user chose; null only on orders created before per-order slippage existed. */
  max_drift_bps: number | null;
  /** When the operator was alerted about the current hold (awaiting_approval / needs_review); null = not yet. */
  alert_sent_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  finished_at: number | null;
}

export type NewOrder = Pick<
  OrderRow,
  | "id" | "token_hash" | "from_asset" | "to_asset" | "amount_in" | "quoted_out" | "route_kind" | "provider"
  | "recipient" | "refund_address" | "deposit_chain" | "deposit_address" | "deposit_index" | "expires_at"
> & { max_drift_bps: number };

export class Db {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        from_asset TEXT NOT NULL,
        to_asset TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        quoted_out TEXT NOT NULL,
        route_kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        recipient TEXT NOT NULL,
        refund_address TEXT NOT NULL,
        deposit_chain TEXT NOT NULL,
        deposit_address TEXT NOT NULL UNIQUE,
        deposit_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        received_amount TEXT,
        deposit_txids TEXT,
        exec_txid TEXT,
        exec_ref TEXT,
        payout_txid TEXT,
        refund_txid TEXT,
        amount_out TEXT,
        forwarded_amount TEXT,
        max_drift_bps INTEGER,
        alert_sent_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
      CREATE TABLE IF NOT EXISTS address_counters (
        chain TEXT PRIMARY KEY,
        next_index INTEGER NOT NULL
      );
    `);
    this.migrate();
  }

  /** Additive column migrations for databases created by older versions. */
  private migrate(): void {
    const cols = new Set((this.db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("max_drift_bps")) this.db.exec("ALTER TABLE orders ADD COLUMN max_drift_bps INTEGER");
    if (!cols.has("alert_sent_at")) this.db.exec("ALTER TABLE orders ADD COLUMN alert_sent_at INTEGER");
    if (!cols.has("forwarded_amount")) this.db.exec("ALTER TABLE orders ADD COLUMN forwarded_amount TEXT");
  }

  /**
   * Atomically reserve the next HD index for a key family (see `keyFamily`: all EVM chains share one).
   * Index 0 is reserved for the hot/inventory wallet.
   */
  allocateIndex(family: string): number {
    const tx = this.db.transaction((c: string) => {
      const row = this.db.prepare("SELECT next_index FROM address_counters WHERE chain = ?").get(c) as
        | { next_index: number }
        | undefined;
      const index = row?.next_index ?? 1;
      this.db
        .prepare("INSERT INTO address_counters(chain, next_index) VALUES(?, ?) ON CONFLICT(chain) DO UPDATE SET next_index = excluded.next_index")
        .run(c, index + 1);
      return index;
    });
    return tx(family);
  }

  insertOrder(o: NewOrder): OrderRow {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO orders (id, token_hash, from_asset, to_asset, amount_in, quoted_out, route_kind, provider,
        recipient, refund_address, deposit_chain, deposit_address, deposit_index, max_drift_bps, status, created_at, updated_at, expires_at)
        VALUES (@id, @token_hash, @from_asset, @to_asset, @amount_in, @quoted_out, @route_kind, @provider,
        @recipient, @refund_address, @deposit_chain, @deposit_address, @deposit_index, @max_drift_bps, 'awaiting_deposit', @now, @now, @expires_at)`)
      .run({ ...o, now });
    return this.getOrder(o.id)!;
  }

  getOrder(id: string): OrderRow | undefined {
    return this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  }

  listOpenOrders(): OrderRow[] {
    const placeholders = FINAL_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM orders WHERE status NOT IN (${placeholders}) ORDER BY created_at`)
      .all(...FINAL_STATUSES) as OrderRow[];
  }

  listOrders(limit = 100): OrderRow[] {
    return this.db.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?").all(limit) as OrderRow[];
  }

  /**
   * Compare-and-set update: only applies when the order is still in `expected` status.
   * Returns false if another transition happened first.
   */
  transition(id: string, expected: OrderStatus, patch: Partial<OrderRow>): boolean {
    const fields = Object.keys(patch).filter((k) => k !== "id");
    const now = Date.now();
    const sets = [...fields.map((f) => `${f} = @${f}`), "updated_at = @updated_at"];
    if (patch.status && FINAL_STATUSES.includes(patch.status)) sets.push("finished_at = @updated_at");
    const res = this.db
      .prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = @id AND status = @expected`)
      .run({ ...patch, id, expected, updated_at: now });
    return res.changes === 1;
  }

  /** Privacy: hard-delete finished orders after the retention period. */
  purgeFinished(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const placeholders = FINAL_STATUSES.map(() => "?").join(",");
    const res = this.db
      .prepare(`DELETE FROM orders WHERE status IN (${placeholders}) AND finished_at IS NOT NULL AND finished_at < ?`)
      .run(...FINAL_STATUSES, cutoff);
    if (res.changes > 0) this.db.exec("VACUUM");
    return res.changes;
  }

  close(): void {
    this.db.close();
  }
}
