import { type Asset, ASSETS, type EvmChainId, GAS_ASSET, isEvmChain, tokenContract } from "../assets";
import type { Config } from "../config";
import { BtcKeys, BtcWallet } from "./btc";
import { Erc20Wallet } from "./erc20";
import { EvmKeys, EvmRpc, EvmWallet } from "./evm";
import { DryRunWallet, MockWallet } from "./mock";
import { SolanaKeys, SplWallet } from "./solana";
import { TronApi, TronKeys, TronWallet } from "./tron";
import type { ChainWallet, Wallets } from "./types";
import { XmrWallet } from "./xmr";

/** Well-known BIP39 test vector; only used to give mock deposit addresses a realistic format. */
const MOCK_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Deposit tokens that have a contract/mint on the configured network. */
function tokens(cfg: Config): { asset: Asset; contract: string }[] {
  return Object.values(ASSETS).flatMap((a) => {
    const contract = tokenContract(a, cfg.NETWORK);
    return a.depositable && contract ? [{ asset: a, contract }] : [];
  });
}

function evmSettings(cfg: Config, chain: EvmChainId): { rpcUrl?: string; confirmations: number } {
  const map = {
    ETH: [cfg.ETH_RPC_URL, cfg.ETH_CONFIRMATIONS],
    BSC: [cfg.BSC_RPC_URL, cfg.BSC_CONFIRMATIONS],
    POL: [cfg.POL_RPC_URL, cfg.POL_CONFIRMATIONS],
    BASE: [cfg.BASE_RPC_URL, cfg.BASE_CONFIRMATIONS],
    ARB: [cfg.ARB_RPC_URL, cfg.ARB_CONFIRMATIONS],
  } as const;
  const [rpcUrl, confirmations] = map[chain];
  return { rpcUrl, confirmations };
}

export function createWallets(cfg: Config): Wallets {
  if (cfg.CHAINS === "mock") return createMockWallets(cfg);

  const mnemonic = cfg.mnemonic!;
  const esplora =
    cfg.BTC_ESPLORA_URL ?? (cfg.NETWORK === "mainnet" ? "https://blockstream.info/api" : "https://mempool.space/testnet4/api");
  const evmKeys = new EvmKeys(mnemonic);
  const evmRpcs = new Map<EvmChainId, EvmRpc>();
  const evmRpc = (chain: EvmChainId) => {
    if (!evmRpcs.has(chain)) evmRpcs.set(chain, new EvmRpc(chain, cfg.NETWORK, evmSettings(cfg, chain).rpcUrl));
    return evmRpcs.get(chain)!;
  };
  const tronKeys = new TronKeys(mnemonic);
  const tronApi = new TronApi(cfg.TRON_API_URL, cfg.TRONGRID_API_KEY);
  const solanaKeys = new SolanaKeys(mnemonic);
  const solana = SplWallet.connect(cfg.SOLANA_RPC_URL);

  const wallets: Wallets = {
    BTC: new BtcWallet(new BtcKeys(mnemonic, cfg.NETWORK), esplora, cfg.BTC_CONFIRMATIONS),
    ETH: new EvmWallet(evmKeys, evmRpc("ETH"), cfg.ETH_CONFIRMATIONS),
    XMR: new XmrWallet(cfg.XMR_WALLET_RPC_URL, cfg.XMR_CONFIRMATIONS),
  };
  for (const { asset, contract } of tokens(cfg)) {
    if (isEvmChain(asset.chain)) {
      const { confirmations } = evmSettings(cfg, asset.chain);
      wallets[asset.id] = new Erc20Wallet(asset.id, contract, evmKeys, evmRpc(asset.chain), confirmations, GAS_ASSET[asset.chain]);
    } else if (asset.chain === "TRON") {
      wallets[asset.id] = new TronWallet(asset.id, contract, tronKeys, tronApi);
    } else if (asset.chain === "SOL") {
      wallets[asset.id] = new SplWallet(asset.id, contract, asset.decimals, solanaKeys, solana);
    } else {
      throw new Error(`no wallet type for ${asset.id} on ${asset.chain}`);
    }
  }
  if (cfg.DRY_RUN) {
    for (const [id, w] of Object.entries(wallets)) wallets[id as keyof Wallets] = new DryRunWallet(w as ChainWallet);
  }
  return wallets;
}

function createMockWallets(cfg: Config): Wallets {
  const btc = new BtcKeys(MOCK_MNEMONIC, cfg.NETWORK);
  const evm = new EvmKeys(MOCK_MNEMONIC);
  const tron = new TronKeys(MOCK_MNEMONIC);
  const sol = new SolanaKeys(MOCK_MNEMONIC);
  const evmAddress = (i: number) => evm.account({ kind: "deposit", index: i }).address;
  const wallets: Wallets = {
    BTC: new MockWallet("BTC", "BTC", 50_000_000n, 1_500n, (i) => btc.address({ kind: "deposit", index: i })),
    ETH: new MockWallet("ETH", "ETH", 5n * 10n ** 18n, 500_000_000_000_000n, evmAddress),
    XMR: new MockWallet("XMR", "XMR", 100n * 10n ** 12n, 100_000_000n),
  };
  // Token mocks pay "gas" in the chain's native coin like the real wallets (Tron: ~15 TRX burn).
  const mockGas: Record<string, bigint> = {
    ETH: 500_000_000_000_000n, BSC: 100_000_000_000_000n, POL: 20_000_000_000_000_000n,
    BASE: 2_000_000_000_000n, ARB: 2_000_000_000_000n, TRON: 15_000_000n, SOL: 2_050_000n,
  };
  for (const { asset } of tokens(cfg)) {
    const addressFor = isEvmChain(asset.chain) ? evmAddress
      : asset.chain === "TRON" ? (i: number) => tron.account({ kind: "deposit", index: i }).address
      : (i: number) => sol.address({ kind: "deposit", index: i });
    wallets[asset.id] = new MockWallet(asset.id, asset.chain, 0n, mockGas[asset.chain], addressFor, GAS_ASSET[asset.chain]);
  }
  return wallets;
}
