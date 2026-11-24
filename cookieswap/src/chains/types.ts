import type { AssetId, ChainId } from "../assets";

export interface DepositInfo {
  /** Total received at the address, any confirmations. */
  seen: bigint;
  /** Total received with at least the required confirmations. */
  confirmed: bigint;
  txids: string[];
}

export type SendSource = { kind: "deposit"; index: number } | { kind: "inventory" };

export interface SendRequest {
  from: SendSource;
  to: string;
  /** Exact amount, or "all" = sweep the source (minus the network fee for native coins). */
  amount: bigint | "all";
  /** THORChain/Maya swap memo (BTC/LTC: OP_RETURN). Other wallets refuse memos. */
  memo?: string;
}

export interface SendResult {
  txid: string;
  /** Amount of the wallet's asset that left for `to`. */
  amount: bigint;
  /** Network fee paid, in the chain's native coin (e.g. wei for ERC-20 transfers). */
  fee: bigint;
}

/** A network fee and the asset it is paid in (ERC-20 transfers pay gas in ETH). */
export interface Fee {
  asset: AssetId;
  amount: bigint;
}

/**
 * One custodial hot wallet per asset. Per-order deposit addresses are derived from the
 * same seed (BTC/ETH/ERC-20 share the ETH index space) or are subaddresses (XMR).
 * "inventory" is the operator's float.
 */
export interface ChainWallet {
  asset: AssetId;
  chain: ChainId;
  /** Derive (BTC/ETH/ERC-20) or create (XMR, ignores `index`) a deposit address. */
  depositAddress(index: number): Promise<{ address: string; index: number }>;
  inventoryAddress(): Promise<string>;
  getDeposit(address: string, index: number): Promise<DepositInfo>;
  /** Spendable inventory balance of this asset. */
  inventoryBalance(): Promise<bigint>;
  /** Estimated network fee for one send (with a memo if `memo`). */
  estimateSendFee(memo: boolean): Promise<Fee>;
  /** Token wallets: native gas held by the inventory account (pays top-ups / fees). */
  gasBalance?(): Promise<Fee>;
  send(req: SendRequest): Promise<SendResult>;
}

export type Wallets = Partial<Record<AssetId, ChainWallet>>;
