import type { Asset, AssetId } from "./assets";
import { fetchJson, log } from "./log";

export interface Price {
  usd: number;
  sources: number;
  deviationBps: number;
}

export interface PriceSource {
  usd(assets: Asset[]): Promise<Partial<Record<AssetId, number>>>;
}

export class OracleError extends Error {}

const KRAKEN = "https://api.kraken.com/0/public/Ticker";
const COINGECKO = "https://api.coingecko.com/api/v3/simple/price";

export const krakenSource: PriceSource = {
  async usd(assets) {
    const out: Partial<Record<AssetId, number>> = {};
    await Promise.all(
      assets
        .filter((a) => a.kraken)
        .map(async (a) => {
          try {
            const res = await fetchJson<{ error: string[]; result: Record<string, { a: string[]; b: string[] }> }>(
              `${KRAKEN}?pair=${a.kraken}`,
            );
            const t = Object.values(res.result ?? {})[0];
            if (t) out[a.id] = (Number(t.a[0]) + Number(t.b[0])) / 2;
          } catch (e) {
            log.warn("kraken price failed", { asset: a.id, err: String(e) });
          }
        }),
    );
    return out;
  },
};

export const coingeckoSource: PriceSource = {
  async usd(assets) {
    const ids = assets.filter((a) => a.coingecko).map((a) => a.coingecko!);
    const out: Partial<Record<AssetId, number>> = {};
    try {
      const res = await fetchJson<Record<string, { usd: number }>>(`${COINGECKO}?ids=${ids.join(",")}&vs_currencies=usd`);
      for (const a of assets) if (a.coingecko && res[a.coingecko]) out[a.id] = res[a.coingecko].usd;
    } catch (e) {
      log.warn("coingecko price failed", { err: String(e) });
    }
    return out;
  },
};

/**
 * Median of independent price sources, cached briefly. Inventory legs depend on this price,
 * so disagreement between sources blocks quoting instead of silently picking one.
 */
export class PriceOracle {
  private cache = new Map<AssetId, { price: Price; at: number }>();

  constructor(
    private assets: Asset[],
    private maxDeviationBps: number,
    private sources: PriceSource[] = [krakenSource, coingeckoSource],
    private ttlMs = 30_000,
  ) {}

  async price(asset: Asset): Promise<Price> {
    const hit = this.cache.get(asset.id);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.price;
    await this.refresh();
    const p = this.cache.get(asset.id);
    if (!p) throw new OracleError(`no price for ${asset.id}`);
    if (p.price.deviationBps > this.maxDeviationBps) {
      throw new OracleError(`price sources disagree for ${asset.id} (${p.price.deviationBps} bps)`);
    }
    return p.price;
  }

  private async refresh(): Promise<void> {
    const results = await Promise.all(this.sources.map((s) => s.usd(this.assets)));
    const now = Date.now();
    for (const a of this.assets) {
      const vals = results.map((r) => r[a.id]).filter((v): v is number => typeof v === "number" && v > 0);
      if (vals.length === 0) {
        // No source confirms a price any more: drop it instead of serving a stale one.
        this.cache.delete(a.id);
        continue;
      }
      vals.sort((x, y) => x - y);
      const mid = vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
      const deviationBps = Math.round(((vals[vals.length - 1] - vals[0]) / vals[0]) * 10_000);
      this.cache.set(a.id, { price: { usd: mid, sources: vals.length, deviationBps }, at: now });
    }
  }
}
