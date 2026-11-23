import {
  type Chain,
  createPublicClient,
  createWalletClient,
  type HDAccount,
  http,
  type PublicClient,
  stringToHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import type { Network } from "../assets";
import type { ChainWallet, DepositInfo, SendRequest, SendResult, SendSource } from "./types";

const GAS_PLAIN = 21_000n;
const GAS_MEMO = 60_000n;

/** Pure derivation: m/44'/60'/0'/0/i for deposits, m/44'/60'/1'/0/0 for inventory. */
export class EvmKeys {
  constructor(private mnemonic: string) {}

  account(source: SendSource): HDAccount {
    return source.kind === "deposit"
      ? mnemonicToAccount(this.mnemonic, { accountIndex: 0, addressIndex: source.index })
      : mnemonicToAccount(this.mnemonic, { accountIndex: 1, addressIndex: 0 });
  }
}

/** Ethereum (native ETH only) hot wallet over JSON-RPC. */
export class EvmWallet implements ChainWallet {
  readonly chain = "ETH" as const;
  private client: PublicClient;
  private evmChain: Chain;
  private rpcUrl: string;

  constructor(
    private keys: EvmKeys,
    network: Network,
    rpcUrl: string | undefined,
    private confirmations: number,
  ) {
    this.evmChain = network === "mainnet" ? mainnet : sepolia;
    this.rpcUrl =
      rpcUrl ?? (network === "mainnet" ? "https://ethereum-rpc.publicnode.com" : "https://ethereum-sepolia-rpc.publicnode.com");
    this.client = createPublicClient({ chain: this.evmChain, transport: http(this.rpcUrl) });
  }

  async depositAddress(index: number) {
    return { address: this.keys.account({ kind: "deposit", index }).address, index };
  }

  async inventoryAddress() {
    return this.keys.account({ kind: "inventory" }).address;
  }

  async getDeposit(address: string): Promise<DepositInfo> {
    const latest = await this.client.getBlockNumber();
    const safeBlock = latest - BigInt(Math.max(0, this.confirmations - 1));
    const [seen, confirmed] = await Promise.all([
      this.client.getBalance({ address: address as `0x${string}` }),
      this.client.getBalance({ address: address as `0x${string}`, blockNumber: safeBlock }),
    ]);
    // Native transfers are not indexed by plain JSON-RPC; txids need an indexer (not required here).
    return { seen, confirmed, txids: [] };
  }

  async inventoryBalance(): Promise<bigint> {
    return this.client.getBalance({ address: await this.inventoryAddress() as `0x${string}` });
  }

  private async fees() {
    const f = await this.client.estimateFeesPerGas();
    return { maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas! };
  }

  async estimateSendFee(memo: boolean): Promise<bigint> {
    return (memo ? GAS_MEMO : GAS_PLAIN) * (await this.fees()).maxFeePerGas;
  }

  async send(req: SendRequest): Promise<SendResult> {
    const account = this.keys.account(req.from);
    const wallet = createWalletClient({ account, chain: this.evmChain, transport: http(this.rpcUrl) });
    const data = req.memo ? stringToHex(req.memo) : undefined;
    const fees = await this.fees();
    const gas = data
      ? await this.client.estimateGas({ account, to: req.to as `0x${string}`, value: 1n, data }).then((g) => (g * 12n) / 10n)
      : GAS_PLAIN;
    const maxFee = gas * fees.maxFeePerGas;
    const balance = await this.client.getBalance({ address: account.address });
    const value = req.amount === "all" ? balance - maxFee : req.amount;
    if (value <= 0n || value + maxFee > balance) throw new Error("insufficient ETH for amount + gas");
    const txid = await wallet.sendTransaction({ to: req.to as `0x${string}`, value, data, gas, ...fees });
    return { txid, amount: value, fee: maxFee };
  }
}
