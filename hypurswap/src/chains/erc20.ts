import { type Address, encodeFunctionData, erc20Abi } from "viem";
import type { AssetId } from "../assets";
import { log } from "../log";
import type { EvmKeys, EvmRpc } from "./evm";
import type { ChainWallet, DepositInfo, Fee, SendRequest, SendResult } from "./types";

const GAS_ETH_TRANSFER = 21_000n;
/** Upper bound for a plain ERC-20 transfer (USDC/USDT use ~40–65k). */
const GAS_TOKEN_TRANSFER = 100_000n;
const TOPUP_RECEIPT_TIMEOUT_MS = 180_000;

/**
 * ERC-20 hot wallet (USDC, USDT, …) on the same keys as the ETH wallet.
 *
 * Per-order deposit addresses only hold tokens, so before forwarding them we top up gas
 * from the ETH inventory account and wait for that to confirm. Gas is paid in ETH, which
 * is why `estimateSendFee` reports the fee in ETH.
 */
export class Erc20Wallet implements ChainWallet {
  readonly chain = "ETH" as const;

  constructor(
    readonly asset: AssetId,
    private token: Address,
    private keys: EvmKeys,
    private rpc: EvmRpc,
    private confirmations: number,
  ) {}

  async depositAddress(index: number) {
    return { address: this.keys.account({ kind: "deposit", index }).address, index };
  }

  async inventoryAddress() {
    return this.keys.account({ kind: "inventory" }).address;
  }

  private balanceOf(owner: Address, blockNumber?: bigint): Promise<bigint> {
    return this.rpc.client.readContract({
      address: this.token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber,
    });
  }

  async getDeposit(address: string): Promise<DepositInfo> {
    const blockNumber = await this.rpc.safeBlock(this.confirmations);
    const [seen, confirmed] = await Promise.all([
      this.balanceOf(address as Address),
      this.balanceOf(address as Address, blockNumber),
    ]);
    return { seen, confirmed, txids: [] };
  }

  async inventoryBalance(): Promise<bigint> {
    return this.balanceOf((await this.inventoryAddress()) as Address);
  }

  /** Gas top-up (ETH transfer) + token transfer, paid in ETH. */
  async estimateSendFee(memo: boolean): Promise<Fee> {
    if (memo) throw new Error("memo transfers of tokens need the THORChain router (not supported)");
    return { asset: "ETH", amount: (GAS_ETH_TRANSFER + GAS_TOKEN_TRANSFER) * (await this.rpc.fees()).maxFeePerGas };
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (req.memo) throw new Error("memo transfers of tokens need the THORChain router (not supported)");
    const account = this.keys.account(req.from);
    const balance = await this.balanceOf(account.address);
    const amount = req.amount === "all" ? balance : req.amount;
    if (amount <= 0n) throw new Error("nothing to send");
    if (amount > balance) throw new Error(`insufficient ${this.asset}: have ${balance}, need ${amount}`);

    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [req.to as Address, amount] });
    const fees = await this.rpc.fees();
    const gas = GAS_TOKEN_TRANSFER;
    const gasCost = gas * fees.maxFeePerGas;

    const ethBalance = await this.rpc.client.getBalance({ address: account.address });
    if (ethBalance < gasCost) {
      if (req.from.kind === "inventory") throw new Error("inventory account has no ETH for gas");
      await this.topUpGas(account.address, gasCost - ethBalance, fees);
    }

    const txid = await this.rpc.walletFor(account).sendTransaction({ to: this.token, data, gas, ...fees });
    return { txid, amount, fee: gasCost };
  }

  /** Send ETH for gas from the inventory account to a deposit address and wait for it. */
  private async topUpGas(to: Address, missing: bigint, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
    const inventory = this.keys.account({ kind: "inventory" });
    const value = (missing * 12n) / 10n; // 20% headroom for fee movement
    const hash = await this.rpc.walletFor(inventory).sendTransaction({ to, value, gas: GAS_ETH_TRANSFER, ...fees });
    log.info("gas top-up sent", { asset: this.asset, to, value, txid: hash });
    const receipt = await this.rpc.client.waitForTransactionReceipt({ hash, timeout: TOPUP_RECEIPT_TIMEOUT_MS });
    if (receipt.status !== "success") throw new Error(`gas top-up ${hash} reverted`);
  }
}
