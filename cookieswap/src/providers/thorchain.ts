import type { Asset } from "../assets";
import { fetchJson, HttpError } from "../log";
import { applyBps, rescale } from "../money";
import {
  type DexName, type DexProvider, type DexQuote, type DexQuoteInput, type DexRef, type DexStatus, providerMessage, QuoteError,
} from "./types";

/** Asset amounts in the THORChain-family APIs always use 8 decimals. */
const THOR_DECIMALS = 8;

interface Pool { asset: string; status: string }
interface Inbound { chain: string; address?: string; halted: boolean; chain_trading_paused: boolean; global_trading_paused?: boolean }
interface ThorQuote {
  inbound_address?: string;
  memo?: string;
  expiry: number;
  expected_amount_out: string;
  recommended_min_amount_in?: string;
  inbound_confirmation_seconds?: number;
  outbound_delay_seconds?: number;
  total_swap_seconds?: number;
}

/** THORChain and its fork Maya Protocol share the same node API; they differ in name, path and asset ids. */
export interface ThorFlavor {
  name: Extract<DexName, "thorchain" | "maya">;
  /** URL path segment of the node API ("thorchain" / "mayachain"). */
  path: string;
  assetId: (a: Asset) => string | undefined;
}

/** OP_RETURN carries at most 80 bytes: the only memo transport we use (BTC, LTC). */
const MAX_MEMO_BYTES = 80;
/** Source chains whose deposits we can send the documented way: a plain transfer with the memo in OP_RETURN. */
const MEMO_SOURCE_CHAINS = new Set(["BTC", "LTC"]);

export const THORCHAIN: ThorFlavor = { name: "thorchain", path: "thorchain", assetId: (a) => a.thorchain };
export const MAYA: ThorFlavor = { name: "maya", path: "mayachain", assetId: (a) => a.maya };

/**
 * Native cross-chain AMM (THORChain or Maya). We send the deposit to the vault ("inbound
 * address") with a swap memo; the network pays the user directly from its vaults.
 */
export class ThorchainProvider implements DexProvider {
  readonly name: ThorFlavor["name"];
  readonly usesMemo = true;
  private meta?: { pools: Set<string>; haltedChains: Set<string>; at: number };

  /**
   * @param verifyApi an independent node of the same network. Before we send funds, the vault address from
   *   `api` must match this node's, so one compromised API provider can't redirect deposits.
   */
  constructor(
    private api: string,
    private slippageBps: number,
    private flavor: ThorFlavor = THORCHAIN,
    private verifyApi?: string,
  ) {
    this.name = flavor.name;
  }

  private async metadata() {
    if (this.meta && Date.now() - this.meta.at < 60_000) return this.meta;
    const [pools, inbound] = await Promise.all([
      fetchJson<Pool[]>(`${this.api}/${this.flavor.path}/pools`),
      fetchJson<Inbound[]>(`${this.api}/${this.flavor.path}/inbound_addresses`),
    ]);
    this.meta = {
      pools: new Set(pools.filter((p) => p.status === "Available").map((p) => p.asset)),
      haltedChains: new Set(
        inbound.filter((i) => i.halted || i.chain_trading_paused || i.global_trading_paused).map((i) => i.chain),
      ),
      at: Date.now(),
    };
    return this.meta;
  }

  async supports(from: Asset, to: Asset): Promise<boolean> {
    const fromId = this.flavor.assetId(from);
    const toId = this.flavor.assetId(to);
    if (!fromId || !toId) return false;
    // Only BTC/LTC: memo in OP_RETURN. EVM deposits (native or ERC-20) need router.depositWithExpiry, which we
    // don't implement; XMR needs the memo in tx_extra; our Tron/Solana wallets can't attach memos.
    if (!MEMO_SOURCE_CHAINS.has(from.chain) || from.contracts) return false;
    try {
      const m = await this.metadata();
      const chainOf = (a: string) => a.split(".")[0];
      return m.pools.has(fromId) && m.pools.has(toId) && !m.haltedChains.has(chainOf(fromId)) && !m.haltedChains.has(chainOf(toId));
    } catch {
      return false;
    }
  }

  async quote(input: DexQuoteInput): Promise<DexQuote> {
    const amount = rescale(input.amountIn, input.from.decimals, THOR_DECIMALS);
    const params = new URLSearchParams({
      from_asset: this.flavor.assetId(input.from)!,
      to_asset: this.flavor.assetId(input.to)!,
      amount: amount.toString(),
      streaming_interval: "1",
      streaming_quantity: "0",
      liquidity_tolerance_bps: String(this.slippageBps),
    });
    // CashAddr's "bitcoincash:" prefix contains a colon, the memo field separator.
    if (input.recipient) params.set("destination", input.recipient.replace(/^bitcoincash:/i, ""));
    // No refund_address: refunds go to the sending address, which is already ours (the order's
    // deposit address or inventory). An explicit one also pushes BTC memos past the 80-byte OP_RETURN limit.
    let q: ThorQuote;
    try {
      q = await fetchJson<ThorQuote>(`${this.api}/${this.flavor.path}/quote/swap?${params}`);
    } catch (e) {
      throw new QuoteError(e instanceof HttpError ? providerMessage(this.name, e.body) : `${this.name}: unavailable`);
    }
    if (q.recommended_min_amount_in && amount < BigInt(q.recommended_min_amount_in)) {
      throw new QuoteError(`${this.name}: amount below recommended minimum`);
    }
    const out = rescale(BigInt(q.expected_amount_out), THOR_DECIMALS, input.to.decimals);
    if (!input.dry && (!q.inbound_address || !q.memo)) throw new QuoteError(`${this.name}: quote without inbound/memo`);
    if (q.memo && Buffer.byteLength(q.memo, "utf8") > MAX_MEMO_BYTES) {
      throw new QuoteError(`${this.name}: memo too long for a ${input.from.symbol} deposit`);
    }
    if (!input.dry) await this.verifyInbound(this.flavor.assetId(input.from)!.split(".")[0], q.inbound_address!);
    return {
      provider: this.name,
      amountIn: input.amountIn,
      amountOut: out,
      minAmountOut: applyBps(out, this.slippageBps),
      etaSeconds: (q.inbound_confirmation_seconds ?? 0) + (q.total_swap_seconds ?? 0) + (q.outbound_delay_seconds ?? 0),
      depositAddress: q.inbound_address,
      memo: q.memo,
      expiry: q.expiry,
    };
  }

  /** Fail closed: no independent confirmation of the vault address means no send. */
  private async verifyInbound(chain: string, address: string): Promise<void> {
    if (!this.verifyApi) return;
    let list: Inbound[];
    try {
      list = await fetchJson<Inbound[]>(`${this.verifyApi}/${this.flavor.path}/inbound_addresses`);
    } catch {
      throw new QuoteError(`${this.name}: vault address could not be verified (second node unreachable)`);
    }
    const entry = list.find((i) => i.chain === chain);
    if (!entry || entry.halted || !entry.address || entry.address.toLowerCase() !== address.toLowerCase()) {
      throw new QuoteError(`${this.name}: vault address not confirmed by the second node`);
    }
  }

  async status(ref: DexRef): Promise<DexStatus> {
    const hash = ref.txid.replace(/^0x/, "").toUpperCase();
    let s: {
      out_txs?: { id: string; memo?: string }[];
      stages?: { swap_status?: { pending: boolean }; outbound_signed?: { completed: boolean } };
    };
    try {
      s = await fetchJson(`${this.api}/${this.flavor.path}/tx/status/${hash}`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return { state: "pending" };
      throw e;
    }
    // Unknown/unobserved txs come back without out_txs (Maya answers 200, THORChain 404).
    const out = s.out_txs?.[0];
    if (!out) return { state: "pending" };
    if (out.memo?.toUpperCase().startsWith("REFUND")) return { state: "refunded", detail: out.memo };
    if (s.stages?.outbound_signed && !s.stages.outbound_signed.completed) return { state: "pending" };
    return { state: "completed", payoutTxid: out.id };
  }
}
