import type { ChainId } from "../assets";

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
  /** Exact amount, or "all" = sweep the source minus the network fee. */
  amount: bigint | "all";
  /** THORChain swap memo (BTC: OP_RETURN, ETH: tx data). */
  memo?: string;
}

export interface SendResult {
  txid: string;
  /** Amount that left for `to` (after fee when sweeping). */
  amount: bigint;
  fee: bigint;
}

/**
 * One custodial hot wallet per chain. Per-order deposit addresses are derived from the
 * same seed (BTC/ETH) or are subaddresses (XMR). "inventory" is the operator's float.
 */
export interface ChainWallet {
  chain: ChainId;
  /** Derive (BTC/ETH) or create (XMR, ignores `index`) a deposit address. */
  depositAddress(index: number): Promise<{ address: string; index: number }>;
  inventoryAddress(): Promise<string>;
  getDeposit(address: string, index: number): Promise<DepositInfo>;
  /** Spendable inventory balance. */
  inventoryBalance(): Promise<bigint>;
  /** Estimated network fee for one send (with a memo if `memo`). */
  estimateSendFee(memo: boolean): Promise<bigint>;
  send(req: SendRequest): Promise<SendResult>;
}

export type Wallets = Partial<Record<ChainId, ChainWallet>>;
