import type { Asset } from "../assets";

export type DexName = "thorchain" | "maya" | "near";

export interface DexQuoteInput {
  from: Asset;
  to: Asset;
  /** Amount we will actually send into the DEX (after our fees), in `from` atomic units. */
  amountIn: bigint;
  /** Where the DEX pays out: the user's address. */
  recipient: string;
  /** Where the DEX refunds to: one of OUR addresses on the source chain. */
  refundTo: string;
  /** Indicative quote only (no deposit address reserved). */
  dry: boolean;
}

export interface DexQuote {
  provider: DexName;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  etaSeconds: number;
  /** Execution instructions (non-dry): send `amountIn` here, with `memo` if set, before `expiry`. */
  depositAddress?: string;
  memo?: string;
  /** Unix seconds after which the instructions must not be used. */
  expiry?: number;
}

export type DexStatus =
  | { state: "pending" }
  | { state: "completed"; payoutTxid?: string }
  | { state: "refunded"; detail?: string }
  | { state: "failed"; detail: string };

export interface DexRef {
  provider: DexName;
  /** Our inbound tx (THORChain tracks by inbound tx hash). */
  txid: string;
  /** 1Click tracks by its deposit address. */
  depositAddress?: string;
}

export interface DexProvider {
  name: DexName;
  /** Deposits carry a swap memo (THORChain/Maya); otherwise a plain transfer to a deposit address (NEAR). */
  usesMemo: boolean;
  /** Cheap check from cached metadata (pools / token lists). */
  supports(from: Asset, to: Asset): Promise<boolean>;
  quote(input: DexQuoteInput): Promise<DexQuote>;
  /** Optional: tell the DEX about our deposit tx to speed things up. */
  notifyDeposit?(ref: DexRef): Promise<void>;
  status(ref: DexRef): Promise<DexStatus>;
}

export class QuoteError extends Error {}

/** Extract a short human-readable message from a provider's JSON error body. */
export function providerMessage(provider: string, body: string): string {
  try {
    const j = JSON.parse(body) as { message?: string; error?: string };
    const m = (j.message ?? j.error ?? body).toString();
    return `${provider}: ${m.replace(/: invalid request$/, "").slice(0, 200)}`;
  } catch {
    return `${provider}: ${body.slice(0, 200)}`;
  }
}
