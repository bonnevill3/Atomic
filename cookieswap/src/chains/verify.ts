import { fetchJson } from "../log";
import type { DepositInfo } from "./types";

/**
 * A read-only view of deposits from a provider independent of the wallet's own backend. The engine only acts
 * on a deposit once both views agree, so a single compromised or buggy API can't fake one.
 */
export interface DepositSource {
  getDeposit(address: string, index: number): Promise<DepositInfo>;
}

export type DepositVerifiers = Partial<Record<string, DepositSource>>;

interface TxRef { tx_hash: string; value: number; confirmations: number }

/** BlockCypher address API (different software and operator than the Esplora/mempool explorers). */
export class BlockcypherUtxoSource implements DepositSource {
  constructor(
    private coin: "ltc" | "btc",
    private confirmations: number,
    private token?: string,
    private api = "https://api.blockcypher.com/v1",
  ) {}

  async getDeposit(address: string): Promise<DepositInfo> {
    const params = new URLSearchParams({ unspentOnly: "true", limit: "200" });
    if (this.token) params.set("token", this.token);
    const r = await fetchJson<{ txrefs?: TxRef[]; unconfirmed_txrefs?: TxRef[] }>(
      `${this.api}/${this.coin}/main/addrs/${encodeURIComponent(address)}?${params}`,
    );
    const all = [...(r.txrefs ?? []), ...(r.unconfirmed_txrefs ?? [])];
    return {
      seen: all.reduce((s, t) => s + BigInt(t.value), 0n),
      confirmed: (r.txrefs ?? []).filter((t) => t.confirmations >= this.confirmations).reduce((s, t) => s + BigInt(t.value), 0n),
      txids: [...new Set(all.map((t) => t.tx_hash))],
    };
  }
}

/** The second source must be another operator: same host means no independent check at all. */
export function requireDifferentHost(what: string, primary: string, second: string): void {
  if (new URL(primary).host === new URL(second).host) {
    throw new Error(`${what}: the deposit double-check must use a different provider than ${new URL(primary).host}`);
  }
}
