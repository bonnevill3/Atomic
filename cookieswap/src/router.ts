import { ASSETS, type Asset, type ChainId, getAsset, PLACEHOLDER_ADDRESS } from "./assets";
import type { Fee, Wallets } from "./chains/types";
import type { Config } from "./config";
import type { RouteKind } from "./db";
import { log } from "./log";
import { applyBps, bpsOf, convertByPrice, usdValue } from "./money";
import { OracleError, type Price, type PriceOracle } from "./oracle";
import { type DexProvider, type DexQuote, QuoteError } from "./providers/types";

export interface RoutePlan {
  kind: RouteKind;
  /** Human-readable route, e.g. "thorchain", "inventory", "inventory → near". */
  label: string;
  from: Asset;
  to: Asset;
  /** Gross amount the user deposits. */
  amountIn: bigint;
  /** Our fee rate: see `Router.feeBps`. */
  feeBps: number;
  serviceFee: bigint;
  /** Extra inventory spread applied on top of the oracle price (inventory legs only). */
  spreadBps: number;
  /** Estimated fee for forwarding the deposit (dex routes), in `from` units. */
  forwardFee: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  etaSeconds: number;
  dex?: DexQuote;
  /** inventory_dex: inventory asset we feed into the DEX and how much of it. */
  bridgeAsset?: Asset;
  bridgeAmount?: bigint;
}

export interface PlanInput {
  from: Asset;
  to: Asset;
  amountIn: bigint;
  /** User payout address; a placeholder is used for indicative quotes. */
  recipient?: string;
  /** Where a DEX should refund to. Executions pass the order's deposit address so refunds land where we sweep from. */
  refundTo?: string;
  /** Non-dry quotes reserve DEX deposit instructions; only used right before executing. */
  dry: boolean;
}

/** Rough deposit confirmation time per chain, for ETA display. */
/** Rough time until a deposit on each chain is confirmed (ETA display only). */
export const CONFIRM_SECONDS: Record<ChainId, number> = {
  BTC: 1200, ETH: 160, BSC: 45, POL: 150, BASE: 60, ARB: 30, AVAX: 10, TRON: 60, SOL: 15, XMR: 1200, ZEC: 300,
  XRP: 5, DOGE: 360, ADA: 120, XLM: 6, BCH: 1200, LTC: 900, SUI: 3,
};
/** Bridge asset for XMR deposits paid out via a DEX. */
const BRIDGE: Asset = ASSETS.ETH;

export class Router {
  constructor(
    private cfg: Config,
    private oracle: PriceOracle,
    private dexes: DexProvider[],
    private wallets: Wallets,
  ) {}

  /** All viable routes, best first. Throws QuoteError when none is possible. */
  async plan(input: PlanInput): Promise<RoutePlan[]> {
    const { from, to } = input;
    if (from.id === to.id) throw new QuoteError("from and to must differ");
    if (!from.depositable || !this.wallets[from.id]) throw new QuoteError(`${from.symbol} deposits are not supported`);
    await this.checkLimits(input);

    const feeBps = this.feeBps(from, to);
    const serviceFee = bpsOf(input.amountIn, feeBps);
    const attempts: Promise<RoutePlan>[] = [];
    const xmrInvolved = from.id === "XMR" || to.id === "XMR";

    if (this.cfg.ENABLE_INVENTORY && xmrInvolved && to.inventory) attempts.push(this.inventoryRoute(input, serviceFee));
    if (this.cfg.ENABLE_INVENTORY && from.id === "XMR" && !to.inventory) attempts.push(this.inventoryDexRoute(input, serviceFee));
    if (from.chain !== "XMR") {
      for (const dex of this.dexes) attempts.push(this.dexRoute(dex, input, serviceFee));
    }

    const settled = await Promise.allSettled(attempts);
    const plans = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    if (plans.length === 0) {
      const errors = settled.flatMap((s) => (s.status === "rejected" ? [s.reason as unknown] : []));
      log.info("no route", { from: from.id, to: to.id, reasons: errors.map((e) => String((e as Error)?.message ?? e)) });
      // A missing price is temporary: surface it as such, so the engine holds the order instead of refunding.
      const oracle = errors.find((e) => e instanceof OracleError);
      if (oracle) throw oracle;
      // Only our own messages reach users. Other errors can contain RPC URLs (with API keys) or node responses.
      const message = errors.flatMap((e) => (e instanceof QuoteError ? [e.message] : [])).find((m) => !m.includes("not supported"));
      throw new QuoteError(message ?? "no route available for this pair right now");
    }
    return plans.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  }

  /**
   * SERVICE_FEE_BPS, raised to STABLE_PAYOUT_FEE_BPS when receiving a stablecoin and to XMR_SELL_FEE_BPS
   * when selling XMR. The rates don't stack: the highest one that applies is charged.
   */
  feeBps(from: Asset, to: Asset): number {
    const rates = [this.cfg.SERVICE_FEE_BPS];
    if (to.stable) rates.push(this.cfg.STABLE_PAYOUT_FEE_BPS);
    if (from.id === "XMR") rates.push(this.cfg.XMR_SELL_FEE_BPS);
    return Math.max(...rates);
  }

  async best(input: PlanInput): Promise<RoutePlan> {
    return (await this.plan(input))[0];
  }

  private async checkLimits(input: PlanInput): Promise<void> {
    const p = await this.oracle.price(input.from);
    const usd = usdValue(input.amountIn, input.from, p.usd);
    if (usd < this.cfg.MIN_ORDER_USD) throw new QuoteError(`minimum is about $${this.cfg.MIN_ORDER_USD}`);
    if (usd > this.cfg.MAX_ORDER_USD) throw new QuoteError(`maximum is about $${this.cfg.MAX_ORDER_USD}`);
  }

  /** Express a network fee in `asset` units (ERC-20 transfers pay gas in ETH). Rounds up. */
  async feeIn(fee: Fee, asset: Asset): Promise<bigint> {
    if (fee.asset === asset.id) return fee.amount;
    const feeAsset = getAsset(fee.asset)!;
    const [pf, pa] = await Promise.all([this.oracle.price(feeAsset), this.oracle.price(asset)]);
    return convertByPrice(fee.amount, feeAsset, pf.usd, asset, pa.usd) + 1n; // round up
  }

  private recipientFor(input: PlanInput): string {
    return input.recipient ?? PLACEHOLDER_ADDRESS[input.to.chain];
  }

  /** Deposit (minus fees) is forwarded to a DEX, which pays the user directly. */
  private async dexRoute(dex: DexProvider, input: PlanInput, serviceFee: bigint): Promise<RoutePlan> {
    if (!(await dex.supports(input.from, input.to))) throw new QuoteError(`${dex.name}: pair not supported`);
    const wallet = this.wallets[input.from.id]!;
    const forwardFee = await this.feeIn(await wallet.estimateSendFee(dex.usesMemo), input.from);
    const net = input.amountIn - serviceFee - forwardFee;
    if (net <= 0n) throw new QuoteError("amount too small to cover fees");
    const q = await dex.quote({
      from: input.from,
      to: input.to,
      amountIn: net,
      recipient: this.recipientFor(input),
      refundTo: input.refundTo ?? (await wallet.inventoryAddress()),
      dry: input.dry,
    });
    return {
      kind: "dex", label: dex.name, from: input.from, to: input.to,
      amountIn: input.amountIn, feeBps: this.feeBps(input.from, input.to), serviceFee, spreadBps: 0, forwardFee,
      amountOut: q.amountOut, minAmountOut: q.minAmountOut,
      etaSeconds: CONFIRM_SECONDS[input.from.chain] + q.etaSeconds,
      dex: q,
    };
  }

  /** We pay `to` from our own inventory at the oracle price minus spread. */
  private async inventoryRoute(input: PlanInput, serviceFee: bigint): Promise<RoutePlan> {
    const { from, to } = input;
    const wallet = this.wallets[to.id];
    if (!wallet) throw new QuoteError(`no ${to.symbol} wallet`);
    const [pf, pt] = await Promise.all([this.oracle.price(from), this.oracle.price(to)]);
    this.requireSources(from, pf);
    this.requireSources(to, pt);
    const gross = convertByPrice(input.amountIn - serviceFee, from, pf.usd, to, pt.usd);
    const payoutFee = await this.feeIn(await wallet.estimateSendFee(false), to);
    const out = applyBps(gross, this.cfg.INVENTORY_SPREAD_BPS) - payoutFee;
    if (out <= 0n) throw new QuoteError("amount too small to cover fees");
    await this.requireInventory(to, out);
    return {
      kind: "inventory", label: "inventory", from, to,
      amountIn: input.amountIn, feeBps: this.feeBps(input.from, to), serviceFee, spreadBps: this.cfg.INVENTORY_SPREAD_BPS, forwardFee: 0n,
      amountOut: out, minAmountOut: out,
      etaSeconds: CONFIRM_SECONDS[from.chain] + 120,
    };
  }

  /** XMR in, then our ETH inventory goes through a DEX to the user (e.g. XMR → SOL). */
  private async inventoryDexRoute(input: PlanInput, serviceFee: bigint): Promise<RoutePlan> {
    const { from, to } = input;
    const ethWallet = this.wallets.ETH;
    if (!ethWallet) throw new QuoteError("no ETH inventory wallet");
    const [pf, pb] = await Promise.all([this.oracle.price(from), this.oracle.price(BRIDGE)]);
    this.requireSources(from, pf);
    this.requireSources(BRIDGE, pb);
    // Plain transfer: memo routes (THORChain/Maya) don't accept EVM deposits from us, see ThorchainProvider.supports.
    const forwardFee = await this.feeIn(await ethWallet.estimateSendFee(false), BRIDGE);
    const bridgeAmount =
      applyBps(convertByPrice(input.amountIn - serviceFee, from, pf.usd, BRIDGE, pb.usd), this.cfg.INVENTORY_SPREAD_BPS) - forwardFee;
    if (bridgeAmount <= 0n) throw new QuoteError("amount too small to cover fees");
    await this.requireInventory(BRIDGE, bridgeAmount + forwardFee);

    let best: DexQuote | undefined;
    for (const dex of this.dexes) {
      if (!(await dex.supports(BRIDGE, to))) continue;
      try {
        const q = await dex.quote({
          from: BRIDGE, to, amountIn: bridgeAmount,
          recipient: this.recipientFor(input), refundTo: await ethWallet.inventoryAddress(), dry: input.dry,
        });
        if (!best || q.amountOut > best.amountOut) best = q;
      } catch (e) {
        log.debug("bridge dex quote failed", { dex: dex.name, err: String(e) });
      }
    }
    if (!best) throw new QuoteError(`no DEX route from ${BRIDGE.symbol} to ${to.symbol}`);
    return {
      kind: "inventory_dex", label: `inventory → ${best.provider}`, from, to,
      amountIn: input.amountIn, feeBps: this.feeBps(input.from, to), serviceFee, spreadBps: this.cfg.INVENTORY_SPREAD_BPS, forwardFee: 0n,
      amountOut: best.amountOut, minAmountOut: best.minAmountOut,
      etaSeconds: CONFIRM_SECONDS[from.chain] + best.etaSeconds,
      dex: best, bridgeAsset: BRIDGE, bridgeAmount,
    };
  }

  /** Inventory payouts spend our own funds at the oracle price: one source alone is not trusted for that. */
  private requireSources(asset: Asset, p: Price): void {
    if (p.sources < this.cfg.MIN_PRICE_SOURCES) {
      throw new OracleError(`${asset.symbol} price confirmed by ${p.sources} source(s), ${this.cfg.MIN_PRICE_SOURCES} needed`);
    }
  }

  private async requireInventory(asset: Asset, amount: bigint): Promise<void> {
    const bal = await this.wallets[asset.id]!.inventoryBalance();
    if (bal < amount) throw new QuoteError(`insufficient ${asset.symbol} liquidity`);
  }
}
