import { fetchJson } from "../log";
import type { ChainWallet, DepositInfo, Fee, SendRequest, SendResult } from "./types";

/** Conservative fee estimate for one normal-priority transfer (piconero). */
const FEE_ESTIMATE = 100_000_000n; // 0.0001 XMR

interface Transfer {
  amount: number | string;
  confirmations?: number;
  txid: string;
  /** Non-zero: the sender time-locked the output (until a block height or timestamp). */
  unlock_time?: number;
  /** Not spendable yet (10-block lock or unlock_time). */
  locked?: boolean;
}

/**
 * A deposit only counts once we could actually spend it. Without this, a sender could time-lock the coins
 * for years: we would pay out from inventory against coins we can never move.
 */
function spendable(t: Transfer, confirmations: number): boolean {
  if (t.unlock_time === undefined) throw new Error("monero-wallet-rpc did not report unlock_time; upgrade monero-wallet-rpc");
  return (t.confirmations ?? 0) >= confirmations && (t.unlock_time === 0 || t.locked === false);
}

/**
 * Monero hot wallet via monero-wallet-rpc (account 0). Each order gets its own subaddress;
 * inventory is the account's unlocked balance.
 */
export class XmrWallet implements ChainWallet {
  readonly asset = "XMR" as const;
  readonly chain = "XMR" as const;
  private id = 0;

  constructor(
    private rpcUrl: string,
    private confirmations: number,
  ) {}

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetchJson<{ result?: T; error?: { code: number; message: string } }>(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: String(++this.id), method, params }),
      timeoutMs: 60_000,
    });
    if (res.error) throw new Error(`monero-wallet-rpc ${method}: ${res.error.message}`);
    return res.result as T;
  }

  async depositAddress(_index: number) {
    const r = await this.rpc<{ address: string; address_index: number }>("create_address", { account_index: 0, label: "order" });
    // Persist the new subaddress count now: after a crash the wallet must never hand out this index again.
    await this.rpc("store");
    return { address: r.address, index: r.address_index };
  }

  async inventoryAddress() {
    const r = await this.rpc<{ address: string }>("get_address", { account_index: 0, address_index: [0] });
    return r.address;
  }

  async getDeposit(_address: string, index: number): Promise<DepositInfo> {
    const r = await this.rpc<{ in?: Transfer[]; pool?: Transfer[] }>("get_transfers", {
      in: true, pool: true, account_index: 0, subaddr_indices: [index],
    });
    const all = [...(r.in ?? []), ...(r.pool ?? [])];
    const seen = all.reduce((s, t) => s + BigInt(t.amount), 0n);
    const confirmed = (r.in ?? [])
      .filter((t) => spendable(t, this.confirmations))
      .reduce((s, t) => s + BigInt(t.amount), 0n);
    return { seen, confirmed, txids: [...new Set(all.map((t) => t.txid))] };
  }

  /** Inventory = subaddress 0 only; order subaddresses hold customer funds until consolidated. */
  async inventoryBalance(): Promise<bigint> {
    const r = await this.rpc<{ per_subaddress?: { address_index: number; unlocked_balance: number | string }[] }>(
      "get_balance", { account_index: 0, address_indices: [0] },
    );
    const main = r.per_subaddress?.find((p) => p.address_index === 0);
    return BigInt(main?.unlocked_balance ?? 0);
  }

  async estimateSendFee(): Promise<Fee> {
    return { asset: "XMR", amount: FEE_ESTIMATE };
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (req.memo) throw new Error("XMR sends with a memo are not supported");
    const subaddr = req.from.kind === "deposit" ? [req.from.index] : undefined;
    if (req.amount === "all") {
      if (!subaddr) throw new Error("sweeping the whole inventory is not allowed");
      const r = await this.rpc<{ tx_hash_list: string[]; amount_list: number[]; fee_list: number[] }>("sweep_all", {
        address: req.to, account_index: 0, subaddr_indices: subaddr, priority: 0,
      });
      return {
        txid: r.tx_hash_list.join(","),
        amount: r.amount_list.reduce((s, a) => s + BigInt(a), 0n),
        fee: r.fee_list.reduce((s, a) => s + BigInt(a), 0n),
      };
    }
    if (req.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount too large for JSON-RPC number");
    const r = await this.rpc<{ tx_hash: string; amount: number; fee: number }>("transfer", {
      destinations: [{ amount: Number(req.amount), address: req.to }],
      account_index: 0,
      subaddr_indices: subaddr ?? [0], // inventory = subaddress 0
      priority: 0,
    });
    return { txid: r.tx_hash, amount: BigInt(r.amount), fee: BigInt(r.fee) };
  }
}
