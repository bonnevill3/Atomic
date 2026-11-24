import { getAsset } from "./assets";
import type { ChainWallet, Wallets } from "./chains/types";
import type { Config } from "./config";
import type { Db, OrderRow, OrderStatus } from "./db";
import { log } from "./log";
import { fromAtomic, usdValue } from "./money";
import type { Notifier } from "./notify";
import { OracleError, type PriceOracle } from "./oracle";
import type { DexName, DexProvider, DexRef } from "./providers/types";
import type { RoutePlan, Router } from "./router";
import type { Screening } from "./screening";

const LATE_DEPOSIT_GRACE_MS = 2 * 3_600_000;
const DEX_TIMEOUT_MS = 6 * 3_600_000;
const REFUND_WAIT_TIMEOUT_MS = 24 * 3_600_000;
/** How long an order may wait for a reliable price before the operator is asked to look at it. */
const PRICE_HOLD_MS = 15 * 60_000;

function isSimulated(txid: string): boolean {
  return txid.startsWith("mock-") || txid.startsWith("dryrun-");
}

/** Move an order's whole deposit to the inventory address (after we paid the user from inventory or by hand). */
export async function sweepToInventory(wallet: ChainWallet, o: OrderRow): Promise<string | null> {
  const d = await wallet.getDeposit(o.deposit_address, o.deposit_index);
  if (d.confirmed === 0n) return null;
  const res = await wallet.send({ from: { kind: "deposit", index: o.deposit_index }, to: await wallet.inventoryAddress(), amount: "all" });
  return res.txid;
}

/** The private operator alert for an order that waits for a human. */
export function alertText(o: OrderRow): string {
  const from = getAsset(o.from_asset)!;
  const to = getAsset(o.to_asset)!;
  const amount = fromAtomic(BigInt(o.received_amount ?? o.amount_in), from);
  const api = `/admin/orders/${o.id}`;
  const lines = o.status === "awaiting_approval"
    ? [
        "cookieswap: large order waiting for you",
        `${amount} ${from.symbol} (${from.network}) -> ${to.symbol} (${to.network}), quoted ~${fromAtomic(BigInt(o.quoted_out), to)} ${to.symbol}`,
        `Why: ${o.error}`,
        "The customer sees 'processing'. Choose one:",
        `- let the engine swap it: POST ${api}/approve`,
        `- fill it by hand, then record it: POST ${api}/resolve {"status":"completed","txid":"<payout txid>","amountOut":"<amount>"}`,
        `- refund it: POST ${api}/refund`,
      ]
    : [
        "cookieswap: order needs review",
        `${amount} ${from.symbol} (${from.network}) -> ${to.symbol} (${to.network})`,
        `Why: ${o.error}`,
        `Check on-chain first, then POST ${api}/retry, ${api}/resolve or ${api}/refund`,
      ];
  return [
    ...lines,
    "",
    `Order: ${o.id}`,
    `Deposit address: ${o.deposit_address}`,
    `Pay out to: ${o.recipient}`,
    `Refund address: ${o.refund_address}`,
  ].join("\n");
}

/**
 * Order state machine. Every send is preceded by a write-ahead transition ("executing" /
 * "refunding"); if the process dies mid-send the order lands in needs_review instead of
 * being sent twice.
 */
export class Engine {
  private running = false;
  private timer?: NodeJS.Timeout;
  private lastPurge = 0;
  /** Orders currently held because no reliable price was available, with the time the hold started. */
  private priceHolds = new Map<string, number>();

  constructor(
    private cfg: Config,
    private db: Db,
    private router: Router,
    private wallets: Wallets,
    private dexes: Partial<Record<DexName, DexProvider>>,
    private screening: Screening,
    private oracle: PriceOracle,
    private notifier: Notifier,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.cfg.ENGINE_INTERVAL_SECONDS * 1000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const o of this.db.listOpenOrders()) {
        try {
          await this.step(o);
          this.priceHolds.delete(o.id);
        } catch (e) {
          if (e instanceof OracleError) this.holdForPrice(o, e);
          else log.error("order step failed", { order: o.id, status: o.status, err: String(e) });
        }
      }
      if (Date.now() - this.lastPurge > 3_600_000) {
        this.lastPurge = Date.now();
        const n = this.db.purgeFinished(this.cfg.RETENTION_DAYS);
        if (n) log.info("purged finished orders", { count: n });
      }
    } finally {
      this.running = false;
    }
  }

  async step(o: OrderRow): Promise<void> {
    switch (o.status) {
      case "awaiting_deposit":
      case "confirming":
        return this.checkDeposit(o);
      case "executing":
      case "refunding":
        // Only reachable after a crash during a send: never resend automatically.
        this.review(o, o.status, `interrupted while ${o.status}; verify on-chain before retrying`);
        return;
      case "approved":
        return this.executeApproved(o);
      case "dex_pending":
        return this.checkDex(o);
      case "refund_pending":
        return this.refund(o);
      case "awaiting_approval":
      case "needs_review":
        // Waits for the operator (admin API); make sure they know.
        return this.alertOperator(o);
      default:
        return;
    }
  }

  /** Alert once per hold. A failed alert throws and is retried on the next tick. */
  private async alertOperator(o: OrderRow): Promise<void> {
    if (o.alert_sent_at !== null) return;
    await this.notifier.send(alertText(o));
    this.db.transition(o.id, o.status, { alert_sent_at: Date.now() });
    log.info("operator alerted", { order: o.id, status: o.status });
  }

  /** Never guess a price: retry on the next tick, and hand the order to the operator if it takes too long. */
  private holdForPrice(o: OrderRow, e: OracleError): void {
    const since = this.priceHolds.get(o.id) ?? Date.now();
    this.priceHolds.set(o.id, since);
    log.warn("order held: no reliable price", { order: o.id, status: o.status, err: e.message });
    if (Date.now() - since < PRICE_HOLD_MS) return;
    this.priceHolds.delete(o.id);
    this.review(o, o.status, `no reliable price for ${PRICE_HOLD_MS / 60_000} min: ${e.message}`);
  }

  private review(o: OrderRow, from: OrderStatus, error: string): void {
    if (this.db.transition(o.id, from, { status: "needs_review", error, alert_sent_at: null })) {
      log.warn("order needs review", { order: o.id, error });
    }
  }

  private async checkDeposit(o: OrderRow): Promise<void> {
    const wallet = this.wallets[o.from_asset]!;
    const d = await wallet.getDeposit(o.deposit_address, o.deposit_index);
    const now = Date.now();

    if (d.seen === 0n) {
      if (now > o.expires_at) this.db.transition(o.id, o.status, { status: "expired" });
      return;
    }
    if (o.status === "awaiting_deposit") {
      if (now > o.expires_at + LATE_DEPOSIT_GRACE_MS) {
        this.review(o, "awaiting_deposit", "late deposit after expiry");
        return;
      }
      this.db.transition(o.id, "awaiting_deposit", {
        status: "confirming", received_amount: d.seen.toString(), deposit_txids: JSON.stringify(d.txids),
      });
      return; // continue next tick from "confirming"
    }
    // Wait until everything that arrived is confirmed, then act on the full amount.
    if (d.confirmed === 0n || d.confirmed < d.seen) {
      if (d.seen.toString() !== o.received_amount) {
        this.db.transition(o.id, "confirming", { received_amount: d.seen.toString(), deposit_txids: JSON.stringify(d.txids) });
      }
      return;
    }

    const screen = await this.screening.check({
      chain: o.deposit_chain, depositTxids: d.txids, recipient: o.recipient, refundAddress: o.refund_address,
    });
    if (!screen.allowed) {
      this.db.transition(o.id, "confirming", { status: "refund_pending", error: `screening: ${screen.reason}` });
      return;
    }

    // Safety net: large orders wait for an operator before anything is executed.
    const from = getAsset(o.from_asset)!;
    const usd = usdValue(d.confirmed, from, (await this.oracle.price(from)).usd);
    if (usd > this.cfg.MANUAL_REVIEW_USD) {
      if (this.db.transition(o.id, "confirming", {
        status: "awaiting_approval", received_amount: d.confirmed.toString(), deposit_txids: JSON.stringify(d.txids),
        error: `manual review: ~$${Math.round(usd)} > $${this.cfg.MANUAL_REVIEW_USD}`, alert_sent_at: null,
      })) log.warn("order awaiting manual approval", { order: o.id, usd: Math.round(usd) });
      return;
    }

    await this.planAndExecute(o, "confirming", d.confirmed);
  }

  /** Approved by the operator: execute the approved amount, unless the deposit changed since. */
  private async executeApproved(o: OrderRow): Promise<void> {
    const d = await this.wallets[o.from_asset]!.getDeposit(o.deposit_address, o.deposit_index);
    const approved = BigInt(o.received_amount!);
    if (d.confirmed !== approved || d.seen !== d.confirmed) {
      // More (or less) arrived after approval: run the normal flow again, which re-checks the threshold.
      this.db.transition(o.id, "approved", { status: "confirming", error: "deposit changed after approval" });
      return;
    }
    await this.planAndExecute(o, "approved", approved);
  }

  private async planAndExecute(o: OrderRow, current: "confirming" | "approved", amount: bigint): Promise<void> {
    const from = getAsset(o.from_asset)!;
    const to = getAsset(o.to_asset)!;
    let plan: RoutePlan;
    try {
      plan = await this.router.best({
        from, to, amountIn: amount, recipient: o.recipient, refundTo: o.deposit_address, dry: false,
      });
    } catch (e) {
      if (e instanceof OracleError) throw e; // temporary: hold the order (see holdForPrice)
      this.db.transition(o.id, current, { status: "refund_pending", error: `no route at execution: ${String((e as Error).message)}` });
      return;
    }

    // Rate protection: compare the new rate with the one the user accepted, within the slippage they chose.
    // Orders from before per-order slippage carry no value and keep the operator's tolerance.
    const driftBps = o.max_drift_bps ?? this.cfg.MAX_RATE_DRIFT_BPS;
    const quotedIn = BigInt(o.amount_in);
    const quotedOut = BigInt(o.quoted_out);
    const floor = (quotedOut * amount * BigInt(10_000 - driftBps)) / (quotedIn * 10_000n);
    if (plan.amountOut < floor) {
      this.db.transition(o.id, current, { status: "refund_pending", error: "rate moved beyond tolerance" });
      return;
    }
    if (plan.dex?.expiry && plan.dex.expiry * 1000 < Date.now() + 60_000) return; // stale instructions, retry next tick

    if (!this.db.transition(o.id, current, {
      status: "executing", route_kind: plan.kind, provider: plan.label, amount_out: plan.amountOut.toString(),
      received_amount: amount.toString(),
    })) return;

    try {
      await this.execute(o, plan);
    } catch (e) {
      // Unknown whether anything was broadcast: a human must check.
      this.review({ ...o, status: "executing" }, "executing", `execution error: ${String((e as Error).message)}`);
    }
  }

  private async execute(o: OrderRow, plan: RoutePlan): Promise<void> {
    if (plan.kind === "inventory") {
      const payout = await this.wallets[plan.to.id]!.send({
        from: { kind: "inventory" }, to: o.recipient, amount: plan.amountOut,
      });
      this.db.transition(o.id, "executing", { status: "completed", payout_txid: payout.txid, amount_out: payout.amount.toString() });
      log.info("order completed from inventory", { order: o.id, txid: payout.txid });
      await this.consolidate(o);
      return;
    }

    const q = plan.dex!;
    const source = plan.kind === "dex"
      ? { wallet: this.wallets[o.from_asset]!, from: { kind: "deposit" as const, index: o.deposit_index } }
      : { wallet: this.wallets[plan.bridgeAsset!.id]!, from: { kind: "inventory" as const } };
    const sent = await source.wallet.send({ from: source.from, to: q.depositAddress!, amount: q.amountIn, memo: q.memo });
    const ref: DexRef = { provider: q.provider, txid: sent.txid, depositAddress: q.depositAddress };
    this.db.transition(o.id, "executing", {
      status: "dex_pending", exec_txid: sent.txid, exec_ref: JSON.stringify(ref),
      forwarded_amount: plan.kind === "dex" ? sent.amount.toString() : null,
    });
    log.info("forwarded to dex", { order: o.id, dex: q.provider, txid: sent.txid });
    if (!isSimulated(sent.txid)) await this.dexes[q.provider]?.notifyDeposit?.(ref);
  }

  /** After completion, move whatever is left on the deposit address (deposit or fee residue) into inventory. */
  private async consolidate(o: OrderRow): Promise<void> {
    try {
      await sweepToInventory(this.wallets[o.from_asset]!, o);
    } catch (e) {
      log.warn("consolidation failed (funds stay on the deposit address)", { order: o.id, err: String(e) });
    }
  }

  private async checkDex(o: OrderRow): Promise<void> {
    const ref = JSON.parse(o.exec_ref!) as DexRef;
    if (isSimulated(ref.txid)) {
      this.db.transition(o.id, "dex_pending", { status: "completed", payout_txid: `${ref.txid}-payout` });
      await this.consolidate(o);
      return;
    }
    const dex = this.dexes[ref.provider];
    if (!dex) return this.review(o, "dex_pending", `dex ${ref.provider} not configured`);
    const s = await dex.status(ref);
    switch (s.state) {
      case "completed":
        this.db.transition(o.id, "dex_pending", { status: "completed", payout_txid: s.payoutTxid ?? null });
        log.info("order completed via dex", { order: o.id, dex: ref.provider });
        await this.consolidate(o);
        return;
      case "refunded":
        // dex route: the DEX refunded to our deposit address. inventory_dex: ETH went back to
        // inventory and the user's XMR deposit is still on its subaddress. Either way: sweep the deposit back.
        this.db.transition(o.id, "dex_pending", { status: "refund_pending", error: `dex refunded: ${s.detail ?? ""}` });
        return;
      case "failed":
        return this.review(o, "dex_pending", `dex failed: ${s.detail}`);
      case "pending":
        if (Date.now() - o.updated_at > DEX_TIMEOUT_MS) this.review(o, "dex_pending", "dex timeout");
        return;
    }
  }

  private async refund(o: OrderRow): Promise<void> {
    const wallet = this.wallets[o.from_asset]!;
    const d = await wallet.getDeposit(o.deposit_address, o.deposit_index);
    if (!refundArrived(o, d.confirmed)) {
      // e.g. a DEX refund still on its way back to the deposit address
      if (Date.now() - o.updated_at > REFUND_WAIT_TIMEOUT_MS) this.review(o, "refund_pending", "refund funds never arrived");
      return;
    }
    const amount = await this.refundAmount(o, wallet, d.confirmed);
    if (amount === null) return;
    if (!this.db.transition(o.id, "refund_pending", { status: "refunding" })) return;
    try {
      const res = await wallet.send({ from: { kind: "deposit", index: o.deposit_index }, to: o.refund_address, amount });
      this.db.transition(o.id, "refunding", { status: "refunded", refund_txid: res.txid });
      log.info("order refunded", { order: o.id, txid: res.txid });
    } catch (e) {
      this.review({ ...o, status: "refunding" }, "refunding", `refund error: ${String((e as Error).message)}`);
    }
  }

  /**
   * Native coins pay the refund's network fee out of the deposit ("all"). Tokens are sent with gas from our
   * inventory, so that cost is taken from the refunded tokens; a deposit worth less than the fee is not refunded
   * automatically (otherwise dust deposits could drain our gas). Returns null when the order went to review.
   */
  private async refundAmount(o: OrderRow, wallet: ChainWallet, confirmed: bigint): Promise<bigint | "all" | null> {
    const fee = await wallet.estimateSendFee(false);
    if (fee.asset === o.from_asset) return "all";
    const feeInAsset = await this.router.feeIn(fee, getAsset(o.from_asset)!);
    if (confirmed <= feeInAsset) {
      this.review(o, "refund_pending", "deposit too small to refund: worth less than the network fee");
      return null;
    }
    return confirmed - feeInAsset;
  }
}

/**
 * Can we refund now? After a DEX refund, the deposit address first holds only what stayed behind when we
 * forwarded (at most received - forwarded); refunding then would send the user just that remainder and close
 * the order before the DEX's refund lands. So wait until more than half of the forwarded amount is back.
 */
export function refundArrived(o: OrderRow, confirmed: bigint): boolean {
  if (confirmed === 0n) return false;
  if (o.forwarded_amount === null) return true;
  const forwarded = BigInt(o.forwarded_amount);
  const leftBehind = BigInt(o.received_amount!) - forwarded;
  return confirmed > leftBehind + forwarded / 2n;
}
