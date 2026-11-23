import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";
import { isAddress } from "viem";
import { base58Decode, base58Encode } from "./validate/base58";
import { parseMoneroAddress } from "./validate/monero";

export type Network = "mainnet" | "testnet";
export type ChainId = "BTC" | "ETH" | "XMR" | "SOL" | "ZEC";
export type AssetId = "BTC" | "ETH" | "USDC" | "USDT" | "XMR" | "SOL" | "ZEC";

export interface Asset {
  id: AssetId;
  symbol: string;
  name: string;
  chain: ChainId;
  /** Network label shown to users, e.g. "Ethereum (ERC-20)". */
  network: string;
  decimals: number;
  /** ERC-20 contract per network; set only for tokens. */
  contracts?: Partial<Record<Network, `0x${string}`>>;
  /** We run a deposit wallet for this asset (users can send it to us). */
  depositable: boolean;
  /** We hold inventory of this asset and can pay it out directly. */
  inventory: boolean;
  thorchain?: string;
  near?: string;
  kraken?: string;
  coingecko?: string;
}

export const ASSETS: Record<AssetId, Asset> = {
  BTC: {
    id: "BTC", symbol: "BTC", name: "Bitcoin", chain: "BTC", network: "Bitcoin", decimals: 8,
    depositable: true, inventory: true,
    thorchain: "BTC.BTC", near: "nep141:btc.omft.near", kraken: "XBTUSD", coingecko: "bitcoin",
  },
  ETH: {
    id: "ETH", symbol: "ETH", name: "Ethereum", chain: "ETH", network: "Ethereum", decimals: 18,
    depositable: true, inventory: true,
    thorchain: "ETH.ETH", near: "nep141:eth.omft.near", kraken: "ETHUSD", coingecko: "ethereum",
  },
  USDC: {
    id: "USDC", symbol: "USDC", name: "USD Coin", chain: "ETH", network: "Ethereum (ERC-20)", decimals: 6,
    depositable: true, inventory: false,
    contracts: {
      mainnet: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      testnet: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle's Sepolia USDC
    },
    thorchain: "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
    near: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    kraken: "USDCUSD", coingecko: "usd-coin",
  },
  USDT: {
    id: "USDT", symbol: "USDT", name: "Tether USD", chain: "ETH", network: "Ethereum (ERC-20)", decimals: 6,
    depositable: true, inventory: false,
    contracts: { mainnet: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    thorchain: "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7",
    near: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    kraken: "USDTUSD", coingecko: "tether",
  },
  XMR: {
    id: "XMR", symbol: "XMR", name: "Monero", chain: "XMR", network: "Monero", decimals: 12,
    depositable: true, inventory: true,
    // THORChain announced native XMR; the provider only uses it once an XMR.XMR pool is live.
    thorchain: "XMR.XMR", kraken: "XMRUSD", coingecko: "monero",
  },
  SOL: {
    id: "SOL", symbol: "SOL", name: "Solana", chain: "SOL", network: "Solana", decimals: 9,
    depositable: false, inventory: false,
    near: "nep141:sol.omft.near", kraken: "SOLUSD", coingecko: "solana",
  },
  ZEC: {
    id: "ZEC", symbol: "ZEC", name: "Zcash", chain: "ZEC", network: "Zcash", decimals: 8,
    depositable: false, inventory: false,
    thorchain: "ZEC.ZEC", near: "nep141:zec.omft.near", kraken: "ZECUSD", coingecko: "zcash",
  },
};

export function getAsset(id: string): Asset | undefined {
  return (ASSETS as Record<string, Asset>)[id];
}

/** ERC-20 contract of a token on this network, or undefined for native coins. */
export function tokenContract(asset: Asset, network: Network): `0x${string}` | undefined {
  return asset.contracts?.[network];
}

function sha256d(data: Uint8Array): Buffer {
  return createHash("sha256").update(createHash("sha256").update(data).digest()).digest();
}

function isZcashTransparent(addr: string, network: Network): boolean {
  const raw = base58Decode(addr);
  if (!raw || raw.length !== 26) return false;
  const check = sha256d(raw.slice(0, 22));
  if (!check.subarray(0, 4).equals(Buffer.from(raw.slice(22)))) return false;
  const prefix = (raw[0] << 8) | raw[1];
  return network === "mainnet"
    ? prefix === 0x1cb8 || prefix === 0x1cbd // t1 / t3
    : prefix === 0x1d25 || prefix === 0x1cba; // tm / t2
}

const BECH32 = "[02-9ac-hj-np-z]";

export function isValidAddress(chain: ChainId, address: string, network: Network): boolean {
  const a = address.trim();
  if (a !== address || a.length === 0 || a.length > 256) return false;
  switch (chain) {
    case "BTC":
      try {
        bitcoin.address.toOutputScript(a, network === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet);
        return true;
      } catch {
        return false;
      }
    case "ETH":
      return isAddress(a);
    case "XMR":
      return parseMoneroAddress(a, network === "mainnet" ? "mainnet" : "stagenet") !== null;
    case "SOL": {
      const raw = base58Decode(a);
      return raw !== null && raw.length === 32;
    }
    case "ZEC":
      if (a.startsWith("tex1")) return false; // TEX addresses are refused by most routes
      if (network === "mainnet" && new RegExp(`^u1${BECH32}{100,}$`).test(a)) return true;
      if (network === "mainnet" && new RegExp(`^zs1${BECH32}{75}$`).test(a)) return true;
      return isZcashTransparent(a, network);
  }
}

function zcashTransparentPlaceholder(): string {
  const body = Uint8Array.from([0x1c, 0xb8, ...new Array(20).fill(0x01)]);
  return base58Encode(Uint8Array.from([...body, ...sha256d(body).subarray(0, 4)]));
}

/** Format-valid placeholder addresses, used only for indicative (dry) quotes. */
export const PLACEHOLDER_ADDRESS: Record<ChainId, string> = {
  BTC: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  ETH: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", // first address of the BIP39 "abandon … about" test vector
  SOL: base58Encode(new Uint8Array(32).fill(0x01)),
  ZEC: zcashTransparentPlaceholder(),
  XMR: "",
};
