import type { Config } from "../config";
import { BtcKeys, BtcWallet } from "./btc";
import { EvmKeys, EvmWallet } from "./evm";
import { DryRunWallet, MockWallet } from "./mock";
import type { ChainWallet, Wallets } from "./types";
import { XmrWallet } from "./xmr";

/** Well-known BIP39 test vector; only used to give mock deposit addresses a realistic format. */
const MOCK_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

export function createWallets(cfg: Config): Wallets {
  if (cfg.CHAINS === "mock") {
    const btc = new BtcKeys(MOCK_MNEMONIC, cfg.NETWORK);
    const evm = new EvmKeys(MOCK_MNEMONIC);
    return {
      BTC: new MockWallet("BTC", 50_000_000n, 1_500n, (i) => btc.address({ kind: "deposit", index: i })),
      ETH: new MockWallet("ETH", 5n * 10n ** 18n, 500_000_000_000_000n, (i) => evm.account({ kind: "deposit", index: i }).address),
      XMR: new MockWallet("XMR", 100n * 10n ** 12n, 100_000_000n),
    };
  }

  const mnemonic = cfg.mnemonic!;
  const esplora =
    cfg.BTC_ESPLORA_URL ?? (cfg.NETWORK === "mainnet" ? "https://blockstream.info/api" : "https://mempool.space/testnet4/api");
  const wallets: Record<string, ChainWallet> = {
    BTC: new BtcWallet(new BtcKeys(mnemonic, cfg.NETWORK), esplora, cfg.BTC_CONFIRMATIONS),
    ETH: new EvmWallet(new EvmKeys(mnemonic), cfg.NETWORK, cfg.ETH_RPC_URL, cfg.ETH_CONFIRMATIONS),
    XMR: new XmrWallet(cfg.XMR_WALLET_RPC_URL, cfg.XMR_CONFIRMATIONS),
  };
  if (cfg.DRY_RUN) for (const k of Object.keys(wallets)) wallets[k] = new DryRunWallet(wallets[k]);
  return wallets as Wallets;
}
