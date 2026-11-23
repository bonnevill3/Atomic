const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

/** Standard (Bitcoin/Solana) base58 decode. Returns null on invalid input. */
export function base58Decode(input: string): Uint8Array | null {
  if (input.length === 0) return null;
  let num = 0n;
  for (const ch of input) {
    const v = INDEX.get(ch);
    if (v === undefined) return null;
    num = num * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  for (const ch of input) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * Monero base58: the input is split into 11-character blocks that each encode 8 bytes;
 * the last block may be shorter.
 */
const MONERO_BLOCK_SIZES = [0, -1, 1, 2, -1, 3, 4, 5, -1, 6, 7, 8];

export function moneroBase58Decode(input: string): Uint8Array | null {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 11) {
    const block = input.slice(i, i + 11);
    const size = MONERO_BLOCK_SIZES[block.length];
    if (size === undefined || size < 0) return null;
    let num = 0n;
    for (const ch of block) {
      const v = INDEX.get(ch);
      if (v === undefined) return null;
      num = num * 58n + BigInt(v);
    }
    if (num >> BigInt(size * 8) !== 0n) return null; // overflow for block size
    const bytes = new Array<number>(size);
    for (let j = size - 1; j >= 0; j--) {
      bytes[j] = Number(num & 0xffn);
      num >>= 8n;
    }
    out.push(...bytes);
  }
  return Uint8Array.from(out);
}

/** Standard base58 encode. */
export function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const b of bytes) num = (num << 8n) | BigInt(b);
  let out = "";
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
