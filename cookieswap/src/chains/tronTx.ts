import { createHash } from "node:crypto";

/**
 * Minimal local encoder for Tron transactions (protobuf, see java-tron `Tron.proto`).
 * We build and hash transactions ourselves instead of signing whatever an API node returns,
 * so a compromised node cannot swap the recipient or amount behind our back.
 */

function varint(n: bigint): number[] {
  if (n < 0n) throw new Error("negative varint");
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return out;
}

const tag = (field: number, wire: 0 | 2) => varint(BigInt((field << 3) | wire));
const intField = (field: number, v: bigint) => (v === 0n ? [] : [...tag(field, 0), ...varint(v)]);
const bytesField = (field: number, b: Uint8Array | number[]) =>
  b.length === 0 ? [] : [...tag(field, 2), ...varint(BigInt(b.length)), ...b];
const stringField = (field: number, s: string) => bytesField(field, [...Buffer.from(s, "utf8")]);

export type TronContract =
  | { type: "TransferContract"; owner: Uint8Array; to: Uint8Array; amount: bigint }
  | { type: "TriggerSmartContract"; owner: Uint8Array; contract: Uint8Array; data: Uint8Array; callValue?: bigint };

export interface TronRawTx {
  /** Bytes 6..8 of the 8-byte big-endian reference block number. */
  refBlockBytes: Uint8Array;
  /** Bytes 8..16 of the reference block id. */
  refBlockHash: Uint8Array;
  /** Milliseconds. */
  expiration: bigint;
  timestamp: bigint;
  feeLimit?: bigint;
  contract: TronContract;
}

const CONTRACT_TYPE = { TransferContract: 1n, TriggerSmartContract: 31n } as const;

function encodeContractValue(c: TronContract): number[] {
  if (c.type === "TransferContract") {
    return [...bytesField(1, c.owner), ...bytesField(2, c.to), ...intField(3, c.amount)];
  }
  return [...bytesField(1, c.owner), ...bytesField(2, c.contract), ...intField(3, c.callValue ?? 0n), ...bytesField(4, c.data)];
}

/** Serialized `Transaction.raw` (what the txID hashes and the signature covers). */
export function encodeRawTx(tx: TronRawTx): Uint8Array {
  const any = [
    ...stringField(1, `type.googleapis.com/protocol.${tx.contract.type}`),
    ...bytesField(2, encodeContractValue(tx.contract)),
  ];
  const contract = [...intField(1, CONTRACT_TYPE[tx.contract.type]), ...bytesField(2, any)];
  return Uint8Array.from([
    ...bytesField(1, tx.refBlockBytes),
    ...bytesField(4, tx.refBlockHash),
    ...intField(8, tx.expiration),
    ...bytesField(11, contract),
    ...intField(14, tx.timestamp),
    ...intField(18, tx.feeLimit ?? 0n),
  ]);
}

/** Serialized `Transaction` with signatures, for /wallet/broadcasthex. */
export function encodeSignedTx(raw: Uint8Array, signatures: Uint8Array[]): Uint8Array {
  return Uint8Array.from([...bytesField(1, raw), ...signatures.flatMap((s) => bytesField(2, s))]);
}

export function txId(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Reference block fields from a block number and block id (hex). */
export function refBlock(number: bigint, blockIdHex: string): { refBlockBytes: Uint8Array; refBlockHash: Uint8Array } {
  const num = Buffer.alloc(8);
  num.writeBigUInt64BE(number);
  return {
    refBlockBytes: Uint8Array.from(num.subarray(6, 8)),
    refBlockHash: Uint8Array.from(Buffer.from(blockIdHex, "hex").subarray(8, 16)),
  };
}
