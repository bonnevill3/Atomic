import type { Asset } from "../assets";
import { fetchJson, HttpError } from "../log";
import { type DexProvider, type DexQuote, type DexQuoteInput, type DexRef, type DexStatus, providerMessage, QuoteError } from "./types";

interface Token { assetId: string }
interface QuoteResponse {
  quote: {
    amountIn: string;
    amountOut: string;
    minAmountOut: string;
    timeEstimate?: number;
    depositAddress?: string;
    deadline?: string;
  };
}

/**
 * NEAR Intents 1Click: solver network. A non-dry quote returns a one-time deposit address;
 * whatever arrives there is swapped by solvers and paid to `recipient`, refunds go to `refundTo`.
 */
export class NearIntentsProvider implements DexProvider {
  readonly name = "near" as const;
  private tokens?: { ids: Set<string>; at: number };

  constructor(
    private api: string,
    private slippageBps: number,
    private jwt?: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.jwt) h.authorization = `Bearer ${this.jwt}`;
    return h;
  }

  async supports(from: Asset, to: Asset): Promise<boolean> {
    if (!from.near || !to.near) return false;
    try {
      if (!this.tokens || Date.now() - this.tokens.at > 300_000) {
        const list = await fetchJson<Token[]>(`${this.api}/v0/tokens`);
        this.tokens = { ids: new Set(list.map((t) => t.assetId)), at: Date.now() };
      }
      return this.tokens.ids.has(from.near) && this.tokens.ids.has(to.near);
    } catch {
      return false;
    }
  }

  async quote(input: DexQuoteInput): Promise<DexQuote> {
    const body = {
      dry: input.dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: this.slippageBps,
      originAsset: input.from.near,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: input.to.near,
      amount: input.amountIn.toString(),
      refundTo: input.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: input.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    let res: QuoteResponse;
    try {
      res = await fetchJson<QuoteResponse>(`${this.api}/v0/quote`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new QuoteError(e instanceof HttpError ? providerMessage("near", e.body) : `near: unavailable`);
    }
    const q = res.quote;
    if (!input.dry && !q.depositAddress) throw new QuoteError("near: quote without deposit address");
    return {
      provider: this.name,
      amountIn: BigInt(q.amountIn),
      amountOut: BigInt(q.amountOut),
      minAmountOut: BigInt(q.minAmountOut),
      etaSeconds: q.timeEstimate ?? 600,
      depositAddress: q.depositAddress,
      expiry: q.deadline ? Math.floor(Date.parse(q.deadline) / 1000) : undefined,
    };
  }

  async notifyDeposit(ref: DexRef): Promise<void> {
    if (!ref.depositAddress) return;
    await fetchJson(`${this.api}/v0/deposit/submit`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ txHash: ref.txid, depositAddress: ref.depositAddress }),
    }).catch(() => undefined); // best effort
  }

  async status(ref: DexRef): Promise<DexStatus> {
    if (!ref.depositAddress) return { state: "failed", detail: "missing 1Click deposit address" };
    const s = await fetchJson<{
      status: string;
      swapDetails?: { destinationChainTxHashes?: { hash: string }[]; refundedAmount?: string };
    }>(`${this.api}/v0/status?depositAddress=${encodeURIComponent(ref.depositAddress)}`, { headers: this.headers() });
    switch (s.status) {
      case "SUCCESS":
        return { state: "completed", payoutTxid: s.swapDetails?.destinationChainTxHashes?.[0]?.hash };
      case "REFUNDED":
        return { state: "refunded" };
      case "FAILED":
        return { state: "failed", detail: "1Click reported FAILED" };
      default: // PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, INCOMPLETE_DEPOSIT
        return { state: "pending" };
    }
  }
}
