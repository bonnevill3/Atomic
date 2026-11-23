import { formatUnits, parseUnits } from "viem";
import type { Asset } from "./assets";

/** Decimal string (user input) -> atomic units. Throws on invalid input. */
export function toAtomic(amount: string, asset: Asset): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error("invalid amount");
  const [, frac = ""] = amount.split(".");
  if (frac.length > asset.decimals) throw new Error(`too many decimals for ${asset.symbol}`);
  return parseUnits(amount, asset.decimals);
}

export function fromAtomic(amount: bigint, asset: Asset): string {
  return formatUnits(amount, asset.decimals);
}

/** Convert between asset decimals (e.g. 18-decimals ETH to THORChain's fixed 1e8). */
export function rescale(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (fromDecimals > toDecimals) return amount / 10n ** BigInt(fromDecimals - toDecimals);
  return amount * 10n ** BigInt(toDecimals - fromDecimals);
}

export function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

export function bpsOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

/** Value conversion using USD prices (floating point only for prices, amounts stay bigint). */
export function convertByPrice(amountIn: bigint, from: Asset, fromUsd: number, to: Asset, toUsd: number): bigint {
  // Scale prices to integers with 1e8 precision to keep the arithmetic in bigint.
  const p1 = BigInt(Math.round(fromUsd * 1e8));
  const p2 = BigInt(Math.round(toUsd * 1e8));
  if (p2 === 0n) throw new Error("zero price");
  const valueScaled = amountIn * p1; // from-atomic * usd*1e8
  const out = (valueScaled * 10n ** BigInt(to.decimals)) / (p2 * 10n ** BigInt(from.decimals));
  return out;
}

export function usdValue(amount: bigint, asset: Asset, usdPrice: number): number {
  return Number(formatUnits(amount, asset.decimals)) * usdPrice;
}
