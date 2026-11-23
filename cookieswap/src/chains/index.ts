import { ASSETS, tokenContract } from "../assets";
import type { Config } from "../config";
import { BtcKeys, BtcWallet } from "./btc";
import { Erc20Wallet } from "./erc20";
import { EvmKeys, EvmRpc, EvmWallet } from "./evm";
import { DryRunWallet, MockWallet } from "./mock";
import type { ChainWallet, Wallets } from "./types";
import { XmrWallet } from "./xmr";

/** Well-known BIP39 test vector; only used to give mock deposit addresses a realistic format. */
const MOCK_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** ERC-20 assets that have a contract on the configured network. */
function tokens(cfg: Config) {
  return Object.values(ASSETS).flatMap((a) => {
    const contract = tokenContract(a, cfg.NETWORK);
    return a.depositable && contract ? [{ asset: a, contract }] : [];
  });
}

export function createWallets(cfg: Config): Wallets {
  if (cfg.CHAINS === "mock") {
    const btc = new BtcKeys(MOCK_MNEMONIC, cfg.NETWORK);
    const evm = new EvmKeys(MOCK_MNEMONIC);
    const evmAddress = (i: number) => evm.account({ kind: "deposit", index: i }).address;
    const wallets: Wallets = {
      BTC: new MockWallet("BTC", "BTC", 50_000_000n, 1_500n, (i) => btc.address({ kind: "deposit", index: i })),
      ETH: new MockWallet("ETH", "ETH", 5n * 10n ** 18n, 500_000_000_000_000n, evmAddress),
      XMR: new MockWallet("XMR", "XMR", 100n * 10n ** 12n, 100_000_000n),
    };
    // Token mocks pay "gas" in ETH like the real ERC-20 wallet (0.0005 ETH per forward).
    for (const { asset } of tokens(cfg)) {
      wallets[asset.id] = new MockWallet(asset.id, "ETH", 0n, 500_000_000_000_000n, evmAddress, "ETH");
    }
    return wallets;
  }

  const mnemonic = cfg.mnemonic!;
  const esplora =
    cfg.BTC_ESPLORA_URL ?? (cfg.NETWORK === "mainnet" ? "https://blockstream.info/api" : "https://mempool.space/testnet4/api");
  const evmKeys = new EvmKeys(mnemonic);
  const evmRpc = new EvmRpc(cfg.NETWORK, cfg.ETH_RPC_URL);
  const wallets: Wallets = {
    BTC: new BtcWallet(new BtcKeys(mnemonic, cfg.NETWORK), esplora, cfg.BTC_CONFIRMATIONS),
    ETH: new EvmWallet(evmKeys, evmRpc, cfg.ETH_CONFIRMATIONS),
    XMR: new XmrWallet(cfg.XMR_WALLET_RPC_URL, cfg.XMR_CONFIRMATIONS),
  };
  for (const { asset, contract } of tokens(cfg)) {
    wallets[asset.id] = new Erc20Wallet(asset.id, contract, evmKeys, evmRpc, cfg.ETH_CONFIRMATIONS);
  }
  if (cfg.DRY_RUN) {
    for (const [id, w] of Object.entries(wallets)) wallets[id as keyof Wallets] = new DryRunWallet(w as ChainWallet);
  }
  return wallets;
}
