import {
  type Chain,
  createPublicClient,
  createWalletClient,
  type HDAccount,
  http,
  type PublicClient,
  type Transport,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { arbitrum, avalanche, base, bsc, mainnet, polygon, sepolia } from "viem/chains";
import type { AssetId, EvmChainId, Network } from "../assets";
import type { ChainWallet, DepositInfo, Fee, SendRequest, SendResult, SendSource } from "./types";

const GAS_PLAIN = 21_000n;

/**
 * THORChain and Maya only document EVM deposits through their router contract (depositWithExpiry).
 * A plain transfer to the vault with the memo as calldata is not a supported method, so we never do it.
 */
const NO_MEMO = "memo deposits on EVM chains need the THORChain/Maya router (depositWithExpiry), which is not implemented";

/** Pure derivation: m/44'/60'/0'/0/i for deposits, m/44'/60'/1'/0/0 for inventory. */
export class EvmKeys {
  constructor(private mnemonic: string) {}

  account(source: SendSource): HDAccount {
    return source.kind === "deposit"
      ? mnemonicToAccount(this.mnemonic, { accountIndex: 0, addressIndex: source.index })
      : mnemonicToAccount(this.mnemonic, { accountIndex: 1, addressIndex: 0 });
  }
}

const VIEM_CHAIN: Record<EvmChainId, Chain> = { ETH: mainnet, BSC: bsc, POL: polygon, BASE: base, ARB: arbitrum, AVAX: avalanche };
const DEFAULT_RPC: Record<EvmChainId, string> = {
  ETH: "https://ethereum-rpc.publicnode.com",
  BSC: "https://bsc-rpc.publicnode.com",
  POL: "https://polygon-bor-rpc.publicnode.com",
  BASE: "https://base-rpc.publicnode.com",
  ARB: "https://arbitrum-one-rpc.publicnode.com",
  AVAX: "https://avalanche-c-chain-rpc.publicnode.com",
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

/** Native-coin hot wallet on an EVM chain (ETH on Ethereum, BNB on BSC, AVAX on Avalanche) over JSON-RPC. */
export class EvmWallet implements ChainWallet {
  readonly chain: EvmChainId;

  constructor(
    readonly asset: AssetId,
    private keys: EvmKeys,
    private rpc: EvmRpc,
    private confirmations: number,
  ) {
    this.chain = rpc.chainId;
  }

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
    if (memo) throw new Error(NO_MEMO);
    return { asset: this.asset, amount: GAS_PLAIN * (await this.rpc.fees()).maxFeePerGas };
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (req.memo) throw new Error(NO_MEMO);
    const account = this.keys.account(req.from);
    const fees = await this.rpc.fees();
    const gas = GAS_PLAIN;
    const maxFee = gas * fees.maxFeePerGas;
    const balance = await this.rpc.client.getBalance({ address: account.address });
    const value = req.amount === "all" ? balance - maxFee : req.amount;
    if (value <= 0n || value + maxFee > balance) throw new Error(`insufficient ${this.asset} for amount + gas`);
    const txid = await this.rpc.walletFor(account).sendTransaction({ to: req.to as `0x${string}`, value, gas, ...fees });
    return { txid, amount: value, fee: maxFee };
  }
}
