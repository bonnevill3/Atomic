import { type Asset, ASSETS, type EvmChainId, GAS_ASSET, isEvmChain, tokenContract } from "../assets";
import type { Config } from "../config";
import { BtcKeys, BtcWallet, LITECOIN_COIN } from "./btc";
import { Erc20Wallet } from "./erc20";
import { DEFAULT_RPC, EvmKeys, EvmRpc, EvmWallet } from "./evm";
import { DryRunWallet, MockWallet } from "./mock";
import { SolanaKeys, SolWallet, SplAtaSource, SplWallet } from "./solana";
import { TronApi, TronKeys, TronWallet, TrxWallet } from "./tron";
import type { ChainWallet, Wallets } from "./types";
import { BlockcypherUtxoSource, type DepositVerifiers, requireDifferentHost } from "./verify";
import { XmrWallet } from "./xmr";

/** Well-known BIP39 test vector; only used to give mock deposit addresses a realistic format. */
const MOCK_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** Depositable native EVM coins on this network (ETH everywhere; BNB/AVAX on mainnet only). */
function nativeDepositAssets(cfg: Config): Asset[] {
  return Object.values(ASSETS).filter(
    (a) => a.depositable && !a.contracts && isEvmChain(a.chain) && (cfg.NETWORK === "mainnet" || a.chain === "ETH"),
  );
}

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
    AVAX: [cfg.AVAX_RPC_URL, cfg.AVAX_CONFIRMATIONS],
  } as const;
  const [rpcUrl, confirmations] = map[chain];
  return { rpcUrl, confirmations };
}

function esploraUrl(cfg: Config): string {
  return cfg.BTC_ESPLORA_URL ?? (cfg.NETWORK === "mainnet" ? "https://blockstream.info/api" : "https://mempool.space/testnet4/api");
}

function evmVerifyUrl(cfg: Config, chain: EvmChainId): string {
  const map = {
    ETH: cfg.ETH_VERIFY_RPC_URL, BSC: cfg.BSC_VERIFY_RPC_URL, POL: cfg.POL_VERIFY_RPC_URL,
    BASE: cfg.BASE_VERIFY_RPC_URL, ARB: cfg.ARB_VERIFY_RPC_URL, AVAX: cfg.AVAX_VERIFY_RPC_URL,
  } as const;
  return map[chain];
}

/**
 * Second, independent view of every depositable asset (live mainnet only; null otherwise). Built from the same
 * wallet classes pointed at other providers, used read-only: the engine only calls getDeposit on them.
 * XMR has none: its wallet RPC talks to your own monerod.
 */
export function createDepositVerifiers(cfg: Config): DepositVerifiers | null {
  if (cfg.CHAINS !== "live" || cfg.NETWORK !== "mainnet") return null;
  const mnemonic = cfg.mnemonic!;
  const evmKeys = new EvmKeys(mnemonic);
  const tronKeys = new TronKeys(mnemonic);
  const solanaKeys = new SolanaKeys(mnemonic);

  requireDifferentHost("BTC", esploraUrl(cfg), cfg.BTC_VERIFY_ESPLORA_URL);
  requireDifferentHost("TRON", cfg.TRON_API_URL, cfg.TRON_VERIFY_API_URL);
  requireDifferentHost("SOL", cfg.SOLANA_RPC_URL, cfg.SOLANA_VERIFY_RPC_URL);
  requireDifferentHost("LTC", cfg.LTC_ESPLORA_URL, "https://api.blockcypher.com");
  const tron = new TronApi(cfg.TRON_VERIFY_API_URL); // the TronGrid key stays with TronGrid
  const solana = SplWallet.connect(cfg.SOLANA_VERIFY_RPC_URL);
  const evmRpcs = new Map<EvmChainId, EvmRpc>();
  const evmRpc = (chain: EvmChainId) => {
    if (!evmRpcs.has(chain)) {
      requireDifferentHost(chain, evmSettings(cfg, chain).rpcUrl ?? DEFAULT_RPC[chain], evmVerifyUrl(cfg, chain));
      evmRpcs.set(chain, new EvmRpc(chain, cfg.NETWORK, evmVerifyUrl(cfg, chain)));
    }
    return evmRpcs.get(chain)!;
  };

  const v: DepositVerifiers = {
    BTC: new BtcWallet(new BtcKeys(mnemonic, cfg.NETWORK), cfg.BTC_VERIFY_ESPLORA_URL, cfg.BTC_CONFIRMATIONS),
    LTC: new BlockcypherUtxoSource("ltc", cfg.LTC_CONFIRMATIONS, cfg.LTC_VERIFY_BLOCKCYPHER_TOKEN),
    TRX: new TrxWallet(tronKeys, tron),
    SOL: new SolWallet(solanaKeys, solana),
  };
  for (const a of nativeDepositAssets(cfg)) {
    const chain = a.chain as EvmChainId;
    v[a.id] = new EvmWallet(a.id, evmKeys, evmRpc(chain), evmSettings(cfg, chain).confirmations);
  }
  for (const { asset, contract } of tokens(cfg)) {
    if (isEvmChain(asset.chain)) {
      v[asset.id] = new Erc20Wallet(asset.id, contract, evmKeys, evmRpc(asset.chain), evmSettings(cfg, asset.chain).confirmations, GAS_ASSET[asset.chain]);
    } else if (asset.chain === "TRON") {
      v[asset.id] = new TronWallet(asset.id, contract, tronKeys, tron);
    } else if (asset.chain === "SOL") {
      v[asset.id] = new SplAtaSource(contract, solana);
    } else {
      throw new Error(`no deposit double-check for ${asset.id} on ${asset.chain}`);
    }
  }
  return v;
}

export function createWallets(cfg: Config): Wallets {
  if (cfg.CHAINS === "mock") return createMockWallets(cfg);

  const mnemonic = cfg.mnemonic!;
  const esplora = esploraUrl(cfg);
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
    XMR: new XmrWallet(cfg.XMR_WALLET_RPC_URL, cfg.XMR_CONFIRMATIONS),
  };
  // Native coins on EVM chains (ETH, BNB, AVAX) share the EVM key tree.
  for (const a of nativeDepositAssets(cfg).filter((x) => isEvmChain(x.chain))) {
    const chain = a.chain as EvmChainId;
    wallets[a.id] = new EvmWallet(a.id, evmKeys, evmRpc(chain), evmSettings(cfg, chain).confirmations);
  }
  if (cfg.NETWORK === "mainnet") {
    wallets.TRX = new TrxWallet(tronKeys, tronApi);
    wallets.SOL = new SolWallet(solanaKeys, solana);
    wallets.LTC = new BtcWallet(new BtcKeys(mnemonic, "mainnet", LITECOIN_COIN), cfg.LTC_ESPLORA_URL, cfg.LTC_CONFIRMATIONS, {
      asset: "LTC", chain: "LTC", feeApi: "mempool",
    });
  }
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
  const ltc = new BtcKeys(MOCK_MNEMONIC, "mainnet", LITECOIN_COIN);
  const tronAddress = (i: number) => tron.account({ kind: "deposit", index: i }).address;
  const wallets: Wallets = {
    BTC: new MockWallet("BTC", "BTC", 50_000_000n, 1_500n, (i) => btc.address({ kind: "deposit", index: i })),
    ETH: new MockWallet("ETH", "ETH", 5n * 10n ** 18n, 500_000_000_000_000n, evmAddress),
    XMR: new MockWallet("XMR", "XMR", 100n * 10n ** 12n, 100_000_000n),
    // native coins without inventory: network fee in their own unit
    BNB: new MockWallet("BNB", "BSC", 0n, 100_000_000_000_000n, evmAddress),
    AVAX: new MockWallet("AVAX", "AVAX", 0n, 1_000_000_000_000_000n, evmAddress),
    TRX: new MockWallet("TRX", "TRON", 0n, 1_450_000n, tronAddress),
    SOL: new MockWallet("SOL", "SOL", 0n, 10_000n, (i) => sol.address({ kind: "deposit", index: i })),
    LTC: new MockWallet("LTC", "LTC", 0n, 2_000n, (i) => ltc.address({ kind: "deposit", index: i })),
  };
  // Token mocks pay "gas" in the chain's native coin like the real wallets (Tron: ~15 TRX burn).
  const mockGas: Record<string, bigint> = {
    ETH: 500_000_000_000_000n, BSC: 100_000_000_000_000n, POL: 20_000_000_000_000_000n,
    BASE: 2_000_000_000_000n, ARB: 2_000_000_000_000n, AVAX: 1_000_000_000_000_000n, TRON: 15_000_000n, SOL: 2_050_000n,
  };
  for (const { asset } of tokens(cfg)) {
    const addressFor = isEvmChain(asset.chain) ? evmAddress
      : asset.chain === "TRON" ? tronAddress
      : (i: number) => sol.address({ kind: "deposit", index: i });
    wallets[asset.id] = new MockWallet(asset.id, asset.chain, 0n, mockGas[asset.chain], addressFor, GAS_ASSET[asset.chain]);
  }
  return wallets;
}
