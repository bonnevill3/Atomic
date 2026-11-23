import { createHash } from "node:crypto";
import * as bitcoin from "bitcoinjs-lib";

/** Receive-address validators for chains we pay out to (format + checksum, no network lookups). */

const sha256d = (b: Uint8Array) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();

function baseDecode(input: string, alphabet: string): Uint8Array | null {
  let num = 0n;
  for (const ch of input) {
    const v = alphabet.indexOf(ch);
    if (v < 0) return null;
    num = num * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of input) {
    if (ch !== alphabet[0]) break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** base58check with a given alphabet: returns the payload (version + data) or null. */
function base58Check(input: string, alphabet: string, length: number): Uint8Array | null {
  const raw = baseDecode(input, alphabet);
  if (!raw || raw.length !== length) return null;
  const body = raw.slice(0, length - 4);
  return sha256d(body).subarray(0, 4).equals(Buffer.from(raw.slice(length - 4))) ? body : null;
}

const BITCOIN_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RIPPLE_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/** XRP Ledger classic address ("r…"): ripple base58check, version 0x00, 20-byte account id. */
export function isXrpAddress(a: string): boolean {
  const body = base58Check(a, RIPPLE_ALPHABET, 25);
  return body !== null && body[0] === 0x00;
}

/** Dogecoin: base58check P2PKH (0x1e, "D…") or P2SH (0x16, "9…"/"A…"). */
export function isDogeAddress(a: string): boolean {
  const body = base58Check(a, BITCOIN_ALPHABET, 25);
  return body !== null && (body[0] === 0x1e || body[0] === 0x16);
}

export const LITECOIN: bitcoin.Network = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

/** Litecoin: bech32 "ltc1…", P2PKH "L…", P2SH "M…". */
export function isLtcAddress(a: string): boolean {
  try {
    bitcoin.address.toOutputScript(a, LITECOIN);
    return true;
  } catch {
    return false;
  }
}

// ---- bech32 (BIP-173) checksum, used by Cardano "addr1…" ------------------------------
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function bech32Valid(addr: string, hrp: string, minDataLen: number): boolean {
  if (addr !== addr.toLowerCase()) return false;
  const sep = addr.lastIndexOf("1");
  if (addr.slice(0, sep) !== hrp) return false;
  const data = [...addr.slice(sep + 1)].map((c) => BECH32_CHARSET.indexOf(c));
  if (data.length < minDataLen + 6 || data.some((d) => d < 0)) return false;
  const expanded = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  return bech32Polymod([...expanded, ...data]) === 1; // bech32 (not bech32m)
}

/** Cardano Shelley-era mainnet address ("addr1…", bech32 without the 90-char limit). */
export function isAdaAddress(a: string): boolean {
  return a.length <= 200 && bech32Valid(a, "addr", 40);
}

// ---- CashAddr (Bitcoin Cash) ------------------------------------------------------------
function cashPolymod(values: number[]): bigint {
  const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c ^ 1n;
}

/** Bitcoin Cash CashAddr ("bitcoincash:q…" for P2PKH, "p…" for P2SH; prefix optional). Legacy 1…/3… is refused to avoid BTC mix-ups. */
export function isBchAddress(input: string): boolean {
  const lower = input.toLowerCase();
  if (input !== lower && input !== input.toUpperCase()) return false;
  const [prefix, payload] = lower.includes(":") ? lower.split(":") : ["bitcoincash", lower];
  if (prefix !== "bitcoincash" || !payload || payload.length !== 42) return false;
  if (payload[0] !== "q" && payload[0] !== "p") return false;
  const data = [...payload].map((c) => BECH32_CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) return false;
  const pre = [...prefix].map((c) => c.charCodeAt(0) & 31);
  return cashPolymod([...pre, 0, ...data]) === 0n;
}

// ---- Stellar StrKey ("G…" public key) ---------------------------------------------------
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

function crc16xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Stellar account id: 56 chars, version byte 6<<3, 32-byte key, CRC16-XModem (little endian). */
export function isXlmAddress(a: string): boolean {
  if (a.length !== 56 || a[0] !== "G") return false;
  const raw = base32Decode(a);
  if (!raw || raw.length !== 35 || raw[0] !== 6 << 3) return false;
  const crc = crc16xmodem(raw.slice(0, 33));
  return raw[33] === (crc & 0xff) && raw[34] === crc >> 8;
}

/** Sui address: 0x + 32 bytes hex. */
export function isSuiAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(a);
}
