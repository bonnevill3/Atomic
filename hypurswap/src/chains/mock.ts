import { randomBytes } from "node:crypto";
import { type AssetId, type ChainId, PLACEHOLDER_ADDRESS } from "../assets";
import { log } from "../log";
import type { ChainWallet, DepositInfo, Fee, SendRequest, SendResult } from "./types";

/**
 * In-memory chain for development and tests. Deposits are simulated via `simulateDeposit`
 * (exposed on the admin API in CHAINS=mock mode). Nothing touches a real network.
 */
export class MockWallet implements ChainWallet {
  readonly sent: (SendRequest & { txid: string })[] = [];
  private deposits = new Map<string, { amount: bigint; confirmed: boolean; txid: string }[]>();

  /**
   * @param fee network fee per send; for ERC-20 mocks pass `feeAsset: "ETH"`, like the real token wallet.
   *            Fees in another asset are not deducted from this wallet's balances.
   */
  constructor(
    readonly asset: AssetId,
    readonly chain: ChainId,
    private inventory: bigint,
    private fee: bigint,
    private addressFor: (index: number) => string = (i) => `mock-${asset.toLowerCase()}-deposit-${i}`,
    private feeAsset: AssetId = asset,
  ) {}

  /** Fee deducted from this wallet's own balances (0 when gas is paid in another asset). */
  private get ownFee(): bigint {
    return this.feeAsset === this.asset ? this.fee : 0n;
  }

  async depositAddress(index: number) {
    return { address: this.addressFor(index), index };
  }

  async inventoryAddress() {
    return PLACEHOLDER_ADDRESS[this.chain] || `mock-${this.chain.toLowerCase()}-inventory`;
  }

  simulateDeposit(address: string, amount: bigint, confirmed = true): string {
    const txid = randomBytes(32).toString("hex");
    const list = this.deposits.get(address) ?? [];
    list.push({ amount, confirmed, txid });
    this.deposits.set(address, list);
    return txid;
  }

  confirmAll(address: string): void {
    for (const d of this.deposits.get(address) ?? []) d.confirmed = true;
  }

  async getDeposit(address: string): Promise<DepositInfo> {
    const list = this.deposits.get(address) ?? [];
    return {
      seen: list.reduce((s, d) => s + d.amount, 0n),
      confirmed: list.filter((d) => d.confirmed).reduce((s, d) => s + d.amount, 0n),
      txids: list.map((d) => d.txid),
    };
  }

  async inventoryBalance() {
    return this.inventory;
  }

  async estimateSendFee(): Promise<Fee> {
    return { asset: this.feeAsset, amount: this.fee };
  }

  async send(req: SendRequest): Promise<SendResult> {
    const txid = `mock-${randomBytes(16).toString("hex")}`;
    let amount: bigint;
    const fee = this.ownFee;
    if (req.from.kind === "inventory") {
      amount = req.amount === "all" ? this.inventory - fee : req.amount;
      if (amount + fee > this.inventory) throw new Error("mock: insufficient inventory");
      this.inventory -= amount + fee;
    } else {
      const addr = this.addressFor(req.from.index);
      const total = (await this.getDeposit(addr)).confirmed;
      amount = req.amount === "all" ? total - fee : req.amount;
      if (amount <= 0n || amount + fee > total) throw new Error("mock: insufficient deposit");
      const rest = total - amount - fee;
      this.deposits.set(addr, []); // swept; change goes to inventory
      this.inventory += rest;
    }
    if (req.to === (await this.inventoryAddress())) this.inventory += amount; // consolidation
    this.sent.push({ ...req, txid });
    log.info("mock send", { asset: this.asset, to: req.to, amount, memo: req.memo, txid });
    return { txid, amount, fee: this.fee };
  }
}

/** Wraps a real wallet: reads are live, sends are logged and never broadcast. */
export class DryRunWallet implements ChainWallet {
  constructor(private inner: ChainWallet) {}
  get asset() {
    return this.inner.asset;
  }
  get chain() {
    return this.inner.chain;
  }
  depositAddress(i: number) {
    return this.inner.depositAddress(i);
  }
  inventoryAddress() {
    return this.inner.inventoryAddress();
  }
  getDeposit(a: string, i: number) {
    return this.inner.getDeposit(a, i);
  }
  inventoryBalance() {
    return this.inner.inventoryBalance();
  }
  estimateSendFee(m: boolean) {
    return this.inner.estimateSendFee(m);
  }
  async send(req: SendRequest): Promise<SendResult> {
    const txid = `dryrun-${randomBytes(16).toString("hex")}`;
    log.warn("DRY_RUN: not broadcasting", { asset: this.asset, from: req.from, to: req.to, amount: req.amount, memo: req.memo, txid });
    return { txid, amount: req.amount === "all" ? 0n : req.amount, fee: 0n };
  }
}
