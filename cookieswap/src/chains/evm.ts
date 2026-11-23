import {
  type Chain,
  createPublicClient,
  createWalletClient,
  type HDAccount,
  http,
  type PublicClient,
  stringToHex,
  type Transport,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { arbitrum, base, bsc, mainnet, polygon, sepolia } from "viem/chains";
import type { EvmChainId, Network } from "../assets";
import type { ChainWallet, DepositInfo, Fee, SendRequest, SendResult, SendSource } from "./types";

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

const VIEM_CHAIN: Record<EvmChainId, Chain> = { ETH: mainnet, BSC: bsc, POL: polygon, BASE: base, ARB: arbitrum };
const DEFAULT_RPC: Record<EvmChainId, string> = {
  ETH: "https://ethereum-rpc.publicnode.com",
  BSC: "https://bsc-rpc.publicnode.com",
  POL: "https://polygon-bor-rpc.publicnode.com",
  BASE: "https://base-rpc.publicnode.com",
  ARB: "https://arbitrum-one-rpc.publicnode.com",
};

/** JSON-RPC access to one EVM chain, shared by its native and ERC-20 wallets. */
export class EvmRpc {
  readonly client: PublicClient;
  readonly chain: Chain;
  private transport: Transport;

  constructor(
    readonly chainId: EvmChainId,
    network: Network,
    rpcUrl?: string,
    transport?: Transport,
  ) {
    if (network === "testnet" && chainId !== "ETH") throw new Error(`${chainId}: only mainnet is supported`);
    this.chain = network === "testnet" ? sepolia : VIEM_CHAIN[chainId];
    const url = rpcUrl ?? (network === "testnet" ? "https://ethereum-sepolia-rpc.publicnode.com" : DEFAULT_RPC[chainId]);
    this.transport = transport ?? http(url);
    this.client = createPublicClient({ chain: this.chain, transport: this.transport });
  }

  walletFor(account: HDAccount) {
    return createWalletClient({ account, chain: this.chain, transport: this.transport });
  }

  async fees() {
    const f = await this.client.estimateFeesPerGas();
    return { maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas! };
  }

  /** Block number that has at least `confirmations` confirmations. */
  async safeBlock(confirmations: number): Promise<bigint> {
    const latest = await this.client.getBlockNumber();
    return latest - BigInt(Math.max(0, confirmations - 1));
  }
}

/** Ethereum (native ETH) hot wallet over JSON-RPC. */
export class EvmWallet implements ChainWallet {
  readonly asset = "ETH" as const;
  readonly chain = "ETH" as const;

  constructor(
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

  async getDeposit(address: string): Promise<DepositInfo> {
    const blockNumber = await this.rpc.safeBlock(this.confirmations);
    const [seen, confirmed] = await Promise.all([
      this.rpc.client.getBalance({ address: address as `0x${string}` }),
      this.rpc.client.getBalance({ address: address as `0x${string}`, blockNumber }),
    ]);
    // Native transfers are not indexed by plain JSON-RPC; txids need an indexer (not required here).
    return { seen, confirmed, txids: [] };
  }

  async inventoryBalance(): Promise<bigint> {
    return this.rpc.client.getBalance({ address: (await this.inventoryAddress()) as `0x${string}` });
  }

  async estimateSendFee(memo: boolean): Promise<Fee> {
    return { asset: "ETH", amount: (memo ? GAS_MEMO : GAS_PLAIN) * (await this.rpc.fees()).maxFeePerGas };
  }

  async send(req: SendRequest): Promise<SendResult> {
    const account = this.keys.account(req.from);
    const data = req.memo ? stringToHex(req.memo) : undefined;
    const fees = await this.rpc.fees();
    const gas = data
      ? await this.rpc.client.estimateGas({ account, to: req.to as `0x${string}`, value: 1n, data }).then((g) => (g * 12n) / 10n)
      : GAS_PLAIN;
    const maxFee = gas * fees.maxFeePerGas;
    const balance = await this.rpc.client.getBalance({ address: account.address });
    const value = req.amount === "all" ? balance - maxFee : req.amount;
    if (value <= 0n || value + maxFee > balance) throw new Error("insufficient ETH for amount + gas");
    const txid = await this.rpc.walletFor(account).sendTransaction({ to: req.to as `0x${string}`, value, data, gas, ...fees });
    return { txid, amount: value, fee: maxFee };
  }
}
