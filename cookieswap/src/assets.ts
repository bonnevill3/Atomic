import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import { isAddress } from "viem";
import { base58Decode, base58Encode } from "./validate/base58";
import { parseMoneroAddress } from "./validate/monero";

export type Network = "mainnet" | "testnet";
/** A blockchain. EVM chains share one key tree; see `keyFamily`. */
export type ChainId = "BTC" | "ETH" | "BSC" | "POL" | "BASE" | "ARB" | "TRON" | "SOL" | "XMR" | "ZEC";
export type AssetId =
  | "BTC" | "ETH" | "XMR" | "SOL" | "ZEC"
  | "USDT-ETH" | "USDT-TRON" | "USDT-BSC" | "USDT-SOL" | "USDT-POL"
  | "USDC-ETH" | "USDC-SOL" | "USDC-BASE" | "USDC-ARB" | "USDC-POL"
  | "DAI-ETH"
  // gas-only assets: used to price network fees, not offered to users
  | "BNB" | "POL" | "TRX";

export const EVM_CHAINS = ["ETH", "BSC", "POL", "BASE", "ARB"] as const;
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
  BTC: "BTC", ETH: "ETH", BSC: "BNB", POL: "POL", BASE: "ETH", ARB: "ETH", TRON: "TRX", SOL: "SOL", XMR: "XMR", ZEC: "ZEC",
};

/** Short network codes for the UI, e.g. "USDT · TRC20". */
export const NETWORK_CODE: Record<ChainId, string> = {
  BTC: "BTC", ETH: "ERC20", BSC: "BEP20", POL: "Polygon", BASE: "Base", ARB: "Arbitrum", TRON: "TRC20", SOL: "SPL", XMR: "XMR", ZEC: "ZEC",
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
    depositable: true, inventory: false, listed: true, stable: true, near, ...price, ...extra,
  };
}

export const ASSETS: Record<AssetId, Asset> = {
  BTC: {
    id: "BTC", symbol: "BTC", name: "Bitcoin", chain: "BTC", network: "Bitcoin", decimals: 8,
    depositable: true, inventory: true, listed: true, stable: false,
    thorchain: "BTC.BTC", maya: "BTC.BTC", near: "nep141:btc.omft.near", kraken: "XBTUSD", coingecko: "bitcoin",
  },
  ETH: {
    id: "ETH", symbol: "ETH", name: "Ethereum", chain: "ETH", network: "Ethereum", decimals: 18,
    depositable: true, inventory: true, listed: true, stable: false,
    thorchain: "ETH.ETH", maya: "ETH.ETH", near: "nep141:eth.omft.near", kraken: "ETHUSD", coingecko: "ethereum",
  },
  XMR: {
    id: "XMR", symbol: "XMR", name: "Monero", chain: "XMR", network: "Monero", decimals: 12,
    depositable: true, inventory: true, listed: true, stable: false,
    // THORChain announced native XMR; the provider only uses it once an XMR.XMR pool is live.
    thorchain: "XMR.XMR", kraken: "XMRUSD", coingecko: "monero",
  },
  SOL: {
    id: "SOL", symbol: "SOL", name: "Solana", chain: "SOL", network: "Solana", decimals: 9,
    depositable: false, inventory: false, listed: true, stable: false,
    near: "nep141:sol.omft.near", kraken: "SOLUSD", coingecko: "solana",
  },
  ZEC: {
    id: "ZEC", symbol: "ZEC", name: "Zcash", chain: "ZEC", network: "Zcash", decimals: 8,
    depositable: false, inventory: false, listed: true, stable: false,
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

  // --- gas-only (fee pricing) ---
  BNB: {
    id: "BNB", symbol: "BNB", name: "BNB", chain: "BSC", network: "BNB Smart Chain", decimals: 18,
    depositable: false, inventory: false, listed: false, stable: false, kraken: "BNBUSD", coingecko: "binancecoin",
  },
  POL: {
    id: "POL", symbol: "POL", name: "Polygon", chain: "POL", network: "Polygon PoS", decimals: 18,
    depositable: false, inventory: false, listed: false, stable: false, kraken: "POLUSD", coingecko: "polygon-ecosystem-token",
  },
  TRX: {
    id: "TRX", symbol: "TRX", name: "Tron", chain: "TRON", network: "Tron", decimals: 6,
    depositable: false, inventory: false, listed: false, stable: false, kraken: "TRXUSD", coingecko: "tron",
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
  SOL: base58Encode(new Uint8Array(32).fill(0x01)),
  TRON: base58CheckEncode(Uint8Array.from([0x41, ...new Array(20).fill(0x01)])),
  ZEC: base58CheckEncode(Uint8Array.from([0x1c, 0xb8, ...new Array(20).fill(0x01)])),
  XMR: "",
};
