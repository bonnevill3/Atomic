import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import { isAddress } from "viem";
import { base58Decode, base58Encode } from "./validate/base58";
import { isAdaAddress, isBchAddress, isDogeAddress, isLtcAddress, isSuiAddress, isXlmAddress, isXrpAddress } from "./validate/chains";
import { parseMoneroAddress } from "./validate/monero";

export type Network = "mainnet" | "testnet";
/** A blockchain. EVM chains share one key tree; see `keyFamily`. */
export type ChainId =
  | "BTC" | "ETH" | "BSC" | "POL" | "BASE" | "ARB" | "AVAX" | "TRON" | "SOL" | "XMR" | "ZEC"
  | "XRP" | "DOGE" | "ADA" | "XLM" | "BCH" | "LTC" | "SUI";
export type AssetId =
  | "BTC" | "ETH" | "XMR" | "SOL" | "ZEC"
  | "USDT-ETH" | "USDT-TRON" | "USDT-BSC" | "USDT-SOL" | "USDT-POL"
  | "USDC-ETH" | "USDC-SOL" | "USDC-BASE" | "USDC-ARB" | "USDC-POL"
  | "DAI-ETH"
  // top-20 coins (by market cap, those a DEX route supports)
  | "BNB" | "TRX" | "AVAX" | "LINK" | "UNI" | "LTC" | "XRP" | "DOGE" | "ADA" | "XLM" | "BCH" | "SUI"
  // gas-only asset: used to price network fees, not offered to users
  | "POL";

export const EVM_CHAINS = ["ETH", "BSC", "POL", "BASE", "ARB", "AVAX"] as const;
export type EvmChainId = (typeof EVM_CHAINS)[number];

export function isEvmChain(chain: ChainId): chain is EvmChainId {
  return (EVM_CHAINS as readonly string[]).includes(chain);
}

/** Chains whose addresses come from the same key tree share one deposit index counter. */
export function keyFamily(chain: ChainId): string {
  return isEvmChain(chain) ? "EVM" : chain;
}

/** Native coin that pays gas on each chain (for fee pricing). */
export const GAS_ASSET: Record<ChainId, AssetId> = {
  BTC: "BTC", ETH: "ETH", BSC: "BNB", POL: "POL", BASE: "ETH", ARB: "ETH", AVAX: "AVAX", TRON: "TRX", SOL: "SOL",
  XMR: "XMR", ZEC: "ZEC", XRP: "XRP", DOGE: "DOGE", ADA: "ADA", XLM: "XLM", BCH: "BCH", LTC: "LTC", SUI: "SUI",
};

/** Short network codes for the UI, e.g. "USDT · TRC20". */
export const NETWORK_CODE: Record<ChainId, string> = {
  BTC: "BTC", ETH: "ERC20", BSC: "BEP20", POL: "Polygon", BASE: "Base", ARB: "Arbitrum", AVAX: "Avalanche", TRON: "TRC20",
  SOL: "SPL", XMR: "XMR", ZEC: "ZEC", XRP: "XRP", DOGE: "DOGE", ADA: "Cardano", XLM: "Stellar", BCH: "BCH", LTC: "LTC", SUI: "Sui",
};

export interface Asset {
  id: AssetId;
  symbol: string;
  name: string;
  chain: ChainId;
  /** Network label shown to users, e.g. "Tron (TRC-20)". */
  network: string;
  decimals: number;
  /** Token contract (EVM / Tron) or mint (Solana) per network; set only for tokens. */
  contracts?: Partial<Record<Network, string>>;
  /** We run a deposit wallet for this asset (users can send it to us). */
  depositable: boolean;
  /** We hold inventory of this asset and can pay it out directly. */
  inventory: boolean;
  /** Offered to users (false for gas-only assets). */
  listed: boolean;
  /** Stablecoin (USDT/USDC/DAI): receiving one costs STABLE_PAYOUT_FEE_BPS. */
  stable: boolean;
  /** Chains where exchange deposit addresses usually need a destination tag/memo, which we can't attach. */
  memoWarning?: boolean;
  /** Rank by market cap when added (for sorting the token list). */
  rank?: number;
  thorchain?: string;
  maya?: string;
  near?: string;
  kraken?: string;
  coingecko?: string;
}

const USDT_PRICE = { kraken: "USDTUSD", coingecko: "tether" };
const USDC_PRICE = { kraken: "USDCUSD", coingecko: "usd-coin" };

function stable(
  id: AssetId, symbol: string, name: string, chain: ChainId, network: string, decimals: number,
  mainnet: string, near: string, price: { kraken: string; coingecko: string }, extra: Partial<Asset> = {},
): Asset {
  return {
    id, symbol, name, chain, network, decimals, contracts: { mainnet },
    depositable: true, inventory: false, listed: true, stable: true, near, ...price,
    rank: symbol === "USDT" ? 3 : symbol === "USDC" ? 5 : 24, ...extra,
  };
}

/** Native coin of a chain we only pay out to (no deposit wallet yet). */
function receiveOnly(id: AssetId, name: string, chain: ChainId, network: string, decimals: number, ids: Partial<Asset>): Asset {
  return { id, symbol: id, name, chain, network, decimals, depositable: false, inventory: false, listed: true, stable: false, ...ids };
}

export const ASSETS: Record<AssetId, Asset> = {
  BTC: {
    id: "BTC", symbol: "BTC", name: "Bitcoin", chain: "BTC", network: "Bitcoin", decimals: 8,
    depositable: true, inventory: true, listed: true, stable: false, rank: 1,
    thorchain: "BTC.BTC", maya: "BTC.BTC", near: "nep141:btc.omft.near", kraken: "XBTUSD", coingecko: "bitcoin",
  },
  ETH: {
    id: "ETH", symbol: "ETH", name: "Ethereum", chain: "ETH", network: "Ethereum", decimals: 18,
    depositable: true, inventory: true, listed: true, stable: false, rank: 2,
    thorchain: "ETH.ETH", maya: "ETH.ETH", near: "nep141:eth.omft.near", kraken: "ETHUSD", coingecko: "ethereum",
  },
  XMR: {
    id: "XMR", symbol: "XMR", name: "Monero", chain: "XMR", network: "Monero", decimals: 12,
    depositable: true, inventory: true, listed: true, stable: false, rank: 13,
    // THORChain announced native XMR; the provider only uses it once an XMR.XMR pool is live.
    thorchain: "XMR.XMR", kraken: "XMRUSD", coingecko: "monero",
  },
  SOL: {
    id: "SOL", symbol: "SOL", name: "Solana", chain: "SOL", network: "Solana", decimals: 9,
    depositable: true, inventory: false, listed: true, stable: false, rank: 7,
    thorchain: "SOL.SOL", near: "nep141:sol.omft.near", kraken: "SOLUSD", coingecko: "solana",
  },
  ZEC: {
    id: "ZEC", symbol: "ZEC", name: "Zcash", chain: "ZEC", network: "Zcash", decimals: 8,
    depositable: false, inventory: false, listed: true, stable: false, rank: 11,
    thorchain: "ZEC.ZEC", maya: "ZEC.ZEC", near: "nep141:zec.omft.near", kraken: "ZECUSD", coingecko: "zcash",
  },

  // --- USDT: the 5 largest networks by supply that a DEX route supports (Arbitrum-USDT has none) ---
  "USDT-TRON": stable("USDT-TRON", "USDT", "Tether USD", "TRON", "Tron (TRC-20)", 6,
    "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", USDT_PRICE,
    { thorchain: "TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T" }),
  "USDT-ETH": stable("USDT-ETH", "USDT", "Tether USD", "ETH", "Ethereum (ERC-20)", 6,
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", USDT_PRICE,
    { thorchain: "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7", maya: "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7" }),
  "USDT-BSC": stable("USDT-BSC", "USDT", "Tether USD", "BSC", "BNB Smart Chain (BEP-20)", 18,
    "0x55d398326f99059fF775485246999027B3197955", "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near", USDT_PRICE,
    { thorchain: "BSC.USDT-0X55D398326F99059FF775485246999027B3197955" }),
  "USDT-SOL": stable("USDT-SOL", "USDT", "Tether USD", "SOL", "Solana (SPL)", 6,
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", USDT_PRICE),
  "USDT-POL": stable("USDT-POL", "USDT", "Tether USD", "POL", "Polygon PoS", 6,
    "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "nep141:pol-0xc2132d05d31c914a87c6611c10748aeb04b58e8f.omdep.near", USDT_PRICE),

  // --- USDC: the 5 largest networks by supply with a DEX route (Hyperliquid L1 needs a HyperCore wallet) ---
  "USDC-ETH": stable("USDC-ETH", "USDC", "USD Coin", "ETH", "Ethereum (ERC-20)", 6,
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", USDC_PRICE,
    {
      contracts: {
        mainnet: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        testnet: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle's Sepolia USDC
      },
      thorchain: "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
      maya: "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
    }),
  "USDC-SOL": stable("USDC-SOL", "USDC", "USD Coin", "SOL", "Solana (SPL)", 6,
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", USDC_PRICE),
  "USDC-BASE": stable("USDC-BASE", "USDC", "USD Coin", "BASE", "Base", 6,
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", USDC_PRICE,
    { thorchain: "BASE.USDC-0X833589FCD6EDB6E08F4C7C32D4F71B54BDA02913" }),
  "USDC-ARB": stable("USDC-ARB", "USDC", "USD Coin", "ARB", "Arbitrum One", 6,
    "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", USDC_PRICE,
    { maya: "ARB.USDC-0XAF88D065E77C8CC2239327C5EDB3A432268E5831" }),
  "USDC-POL": stable("USDC-POL", "USDC", "USD Coin", "POL", "Polygon PoS", 6,
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near", USDC_PRICE),

  // --- DAI: only Ethereum has a DEX route (and ~90% of DAI supply) ---
  "DAI-ETH": stable("DAI-ETH", "DAI", "Dai", "ETH", "Ethereum (ERC-20)", 18,
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", "nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near",
    { kraken: "DAIUSD", coingecko: "dai" }),

  // --- top-20 coins: deposit + payout (deposit wallets: EVM native, ERC-20, Tron native, Litecoin) ---
  BNB: {
    id: "BNB", symbol: "BNB", name: "BNB", chain: "BSC", network: "BNB Smart Chain", decimals: 18,
    depositable: true, inventory: false, listed: true, stable: false, rank: 4,
    thorchain: "BSC.BNB", near: "nep141:bnb.omdep.near", kraken: "BNBUSD", coingecko: "binancecoin",
  },
  TRX: {
    id: "TRX", symbol: "TRX", name: "Tron", chain: "TRON", network: "Tron", decimals: 6,
    depositable: true, inventory: false, listed: true, stable: false, rank: 8,
    thorchain: "TRON.TRX", near: "nep141:tron.omft.near", kraken: "TRXUSD", coingecko: "tron",
  },
  AVAX: {
    id: "AVAX", symbol: "AVAX", name: "Avalanche", chain: "AVAX", network: "Avalanche C-Chain", decimals: 18,
    depositable: true, inventory: false, listed: true, stable: false, rank: 33,
    thorchain: "AVAX.AVAX", near: "nep141:avax.omdep.near", kraken: "AVAXUSD", coingecko: "avalanche-2",
  },
  LINK: {
    id: "LINK", symbol: "LINK", name: "Chainlink", chain: "ETH", network: "Ethereum (ERC-20)", decimals: 18,
    contracts: { mainnet: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
    depositable: true, inventory: false, listed: true, stable: false, rank: 18,
    near: "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near", kraken: "LINKUSD", coingecko: "chainlink",
  },
  UNI: {
    id: "UNI", symbol: "UNI", name: "Uniswap", chain: "ETH", network: "Ethereum (ERC-20)", decimals: 18,
    contracts: { mainnet: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
    depositable: true, inventory: false, listed: true, stable: false, rank: 32,
    near: "nep141:eth-0x1f9840a85d5af5bf1d1762f925bdaddc4201f984.omft.near", kraken: "UNIUSD", coingecko: "uniswap",
  },
  LTC: {
    id: "LTC", symbol: "LTC", name: "Litecoin", chain: "LTC", network: "Litecoin", decimals: 8,
    depositable: true, inventory: false, listed: true, stable: false, rank: 30,
    thorchain: "LTC.LTC", near: "nep141:ltc.omft.near", kraken: "LTCUSD", coingecko: "litecoin",
  },

  // --- top-20 coins: payout only (each needs its own deposit wallet type first) ---
  XRP: receiveOnly("XRP", "XRP", "XRP", "XRP Ledger", 6,
    { rank: 6, memoWarning: true, thorchain: "XRP.XRP", near: "nep141:xrp.omft.near", kraken: "XRPUSD", coingecko: "ripple" }),
  DOGE: receiveOnly("DOGE", "Dogecoin", "DOGE", "Dogecoin", 8,
    { rank: 12, thorchain: "DOGE.DOGE", near: "nep141:doge.omft.near", kraken: "XDGUSD", coingecko: "dogecoin" }),
  ADA: receiveOnly("ADA", "Cardano", "ADA", "Cardano", 6,
    { rank: 22, maya: "ADA.ADA", near: "nep141:cardano.omft.near", kraken: "ADAUSD", coingecko: "cardano" }),
  XLM: receiveOnly("XLM", "Stellar", "XLM", "Stellar", 7, {
    rank: 23, memoWarning: true, kraken: "XLMUSD", coingecko: "stellar",
    near: "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz",
  }),
  BCH: receiveOnly("BCH", "Bitcoin Cash", "BCH", "Bitcoin Cash", 8,
    { rank: 26, thorchain: "BCH.BCH", near: "nep141:bch.omft.near", kraken: "BCHUSD", coingecko: "bitcoin-cash" }),
  SUI: receiveOnly("SUI", "Sui", "SUI", "Sui", 9,
    { rank: 36, near: "nep141:sui.omft.near", kraken: "SUIUSD", coingecko: "sui" }),

  // --- gas-only (fee pricing) ---
  POL: {
    id: "POL", symbol: "POL", name: "Polygon", chain: "POL", network: "Polygon PoS", decimals: 18,
    depositable: false, inventory: false, listed: false, stable: false, kraken: "POLUSD", coingecko: "polygon-ecosystem-token",
  },
};

export function getAsset(id: string): Asset | undefined {
  return (ASSETS as Record<string, Asset>)[id];
}

/** Token contract / mint of an asset on this network, or undefined for native coins. */
export function tokenContract(asset: Asset, network: Network): string | undefined {
  return asset.contracts?.[network];
}

function sha256d(data: Uint8Array): Buffer {
  return createHash("sha256").update(createHash("sha256").update(data).digest()).digest();
}

function base58CheckDecode(addr: string, length: number): Uint8Array | null {
  const raw = base58Decode(addr);
  if (!raw || raw.length !== length) return null;
  const body = raw.slice(0, length - 4);
  if (!sha256d(body).subarray(0, 4).equals(Buffer.from(raw.slice(length - 4)))) return null;
  return body;
}

export function base58CheckEncode(body: Uint8Array): string {
  return base58Encode(Uint8Array.from([...body, ...sha256d(body).subarray(0, 4)]));
}

function isZcashTransparent(addr: string, network: Network): boolean {
  const body = base58CheckDecode(addr, 26);
  if (!body) return false;
  const prefix = (body[0] << 8) | body[1];
  return network === "mainnet"
    ? prefix === 0x1cb8 || prefix === 0x1cbd // t1 / t3
    : prefix === 0x1d25 || prefix === 0x1cba; // tm / t2
}

/** Tron: base58check of 0x41 + 20-byte account id ("T…"). */
export function isTronAddress(addr: string): boolean {
  const body = base58CheckDecode(addr, 25);
  return body !== null && body[0] === 0x41;
}

const BECH32 = "[02-9ac-hj-np-z]";

export function isValidAddress(chain: ChainId, address: string, network: Network): boolean {
  const a = address.trim();
  if (a !== address || a.length === 0 || a.length > 256) return false;
  if (isEvmChain(chain)) return isAddress(a);
  switch (chain) {
    case "BTC":
      try {
        bitcoin.address.toOutputScript(a, network === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet);
        return true;
      } catch {
        return false;
      }
    case "XMR":
      return parseMoneroAddress(a, network === "mainnet" ? "mainnet" : "stagenet") !== null;
    case "SOL": {
      const raw = base58Decode(a);
      return raw !== null && raw.length === 32;
    }
    case "TRON":
      return isTronAddress(a);
    case "XRP":
      return network === "mainnet" && isXrpAddress(a);
    case "DOGE":
      return network === "mainnet" && isDogeAddress(a);
    case "LTC":
      return network === "mainnet" && isLtcAddress(a);
    case "BCH":
      return network === "mainnet" && isBchAddress(a);
    case "ADA":
      return network === "mainnet" && isAdaAddress(a);
    case "XLM":
      return network === "mainnet" && isXlmAddress(a);
    case "SUI":
      return isSuiAddress(a);
    case "ZEC":
      if (a.startsWith("tex1")) return false; // TEX addresses are refused by most routes
      if (network === "mainnet" && new RegExp(`^u1${BECH32}{100,}$`).test(a)) return true;
      if (network === "mainnet" && new RegExp(`^zs1${BECH32}{75}$`).test(a)) return true;
      return isZcashTransparent(a, network);
  }
  return false;
}

const EVM_PLACEHOLDER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94"; // first address of the BIP39 "abandon … about" vector

/** Format-valid placeholder addresses, used only for indicative (dry) quotes. */
export const PLACEHOLDER_ADDRESS: Record<ChainId, string> = {
  BTC: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  ETH: EVM_PLACEHOLDER,
  BSC: EVM_PLACEHOLDER,
  POL: EVM_PLACEHOLDER,
  BASE: EVM_PLACEHOLDER,
  ARB: EVM_PLACEHOLDER,
  AVAX: EVM_PLACEHOLDER,
  SOL: base58Encode(new Uint8Array(32).fill(0x01)),
  TRON: base58CheckEncode(Uint8Array.from([0x41, ...new Array(20).fill(0x01)])),
  ZEC: base58CheckEncode(Uint8Array.from([0x1c, 0xb8, ...new Array(20).fill(0x01)])),
  XMR: "",
  XRP: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", // XRP Ledger genesis account
  DOGE: base58CheckEncode(Uint8Array.from([0x1e, ...new Array(20).fill(0x01)])),
  LTC: "ltc1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpq4933p",
  BCH: "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a", // CashAddr spec example
  ADA: "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x", // CIP-19 example
  XLM: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
  SUI: `0x${"01".repeat(32)}`,
};
