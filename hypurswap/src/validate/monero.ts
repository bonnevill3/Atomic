import { keccak256 } from "viem";
import { moneroBase58Decode } from "./base58";

export type MoneroNetwork = "mainnet" | "stagenet" | "testnet";

/** Network byte prefixes: standard, integrated, subaddress. */
const PREFIXES: Record<MoneroNetwork, { standard: number; integrated: number; subaddress: number }> = {
  mainnet: { standard: 18, integrated: 19, subaddress: 42 },
  stagenet: { standard: 24, integrated: 25, subaddress: 36 },
  testnet: { standard: 53, integrated: 54, subaddress: 63 },
};

export type MoneroAddressKind = "standard" | "integrated" | "subaddress";

/**
 * Validates a Monero address: base58 decoding, network prefix, length and the
 * keccak-256 checksum (Monero's cn_fast_hash is the original Keccak-256, as in Ethereum).
 */
export function parseMoneroAddress(
  address: string,
  network: MoneroNetwork,
): { kind: MoneroAddressKind } | null {
  if (address.length !== 95 && address.length !== 106) return null;
  const raw = moneroBase58Decode(address);
  if (!raw) return null;
  const prefix = PREFIXES[network];
  const tag = raw[0];
  let kind: MoneroAddressKind;
  if (tag === prefix.standard) kind = "standard";
  else if (tag === prefix.subaddress) kind = "subaddress";
  else if (tag === prefix.integrated) kind = "integrated";
  else return null;

  const expectedLen = kind === "integrated" ? 1 + 64 + 8 + 4 : 1 + 64 + 4;
  if (raw.length !== expectedLen) return null;

  const body = raw.slice(0, raw.length - 4);
  const checksum = raw.slice(raw.length - 4);
  const hash = keccak256(body, "bytes");
  for (let i = 0; i < 4; i++) if (hash[i] !== checksum[i]) return null;
  return { kind };
}
