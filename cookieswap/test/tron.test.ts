import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { recoverAddress } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { base58CheckEncode, isTronAddress } from "../src/assets";
import { TronApi, tronHex, TronKeys, TronWallet } from "../src/chains/tron";
import { encodeRawTx, txId } from "../src/chains/tronTx";
import golden from "./fixtures/tron-golden.json";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const hexb = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

// ---- minimal protobuf reader for the fake node --------------------------------------
type PbField = { field: number; value: bigint | Uint8Array };
function readPb(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  const varint = () => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return r;
      s += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    if ((key & 7) === 0) out.push({ field: key >> 3, value: varint() });
    else {
      const len = Number(varint());
      out.push({ field: key >> 3, value: buf.slice(i, i + len) });
      i += len;
    }
  }
  return out;
}
const pbGet = (f: PbField[], n: number) => f.find((x) => x.field === n)?.value;

describe("Tron transaction encoding (golden vectors from TronGrid)", () => {
  const reencode = (raw: any) => {
    const v = raw.contract[0].parameter.value;
    return encodeRawTx({
      refBlockBytes: hexb(raw.ref_block_bytes), refBlockHash: hexb(raw.ref_block_hash),
      expiration: BigInt(raw.expiration), timestamp: BigInt(raw.timestamp), feeLimit: raw.fee_limit ? BigInt(raw.fee_limit) : undefined,
      contract: raw.contract[0].type === "TransferContract"
        ? { type: "TransferContract", owner: hexb(v.owner_address), to: hexb(v.to_address), amount: BigInt(v.amount) }
        : { type: "TriggerSmartContract", owner: hexb(v.owner_address), contract: hexb(v.contract_address), data: hexb(v.data) },
    });
  };

  it("TRX transfer matches the node byte for byte", () => {
    const raw = reencode(golden.trx.raw_data);
    expect(Buffer.from(raw).toString("hex")).toBe(golden.trx.raw_data_hex);
    expect(txId(raw)).toBe(golden.trx.txID);
  });

  it("USDT transfer (TriggerSmartContract) matches the node byte for byte", () => {
    const raw = reencode(golden.trig.raw_data);
    expect(Buffer.from(raw).toString("hex")).toBe(golden.trig.raw_data_hex);
    expect(txId(raw)).toBe(golden.trig.txID);
  });
});

describe("TronKeys", () => {
  it("derives valid, distinct T-addresses", () => {
    const k = new TronKeys(MNEMONIC);
    const a = k.account({ kind: "deposit", index: 1 });
    const b = k.account({ kind: "deposit", index: 2 });
    const inv = k.account({ kind: "inventory" });
    for (const x of [a, b, inv]) expect(isTronAddress(x.address)).toBe(true);
    expect(new Set([a.address, b.address, inv.address]).size).toBe(3);
    expect(base58CheckEncode(tronHex(a.address))).toBe(a.address);
  });
});

describe("TronWallet against a fake TronGrid", () => {
  const keys = new TronKeys(MNEMONIC);
  const dep = keys.account({ kind: "deposit", index: 7 });
  const inv = keys.account({ kind: "inventory" });
  const DEX = base58CheckEncode(Uint8Array.from([0x41, ...new Array(20).fill(0x22)]));
  const ENERGY = 65_000n;
  const ENERGY_FEE = 100n;

  let server: Server;
  let wallet: TronWallet;
  let trx: Map<string, bigint>;
  let tok: Map<string, bigint>;
  let broadcasts: { type: number; owner: string; signer: string; value: PbField[]; feeLimit?: bigint }[];
  let paths: string[];

  const idToB58 = (id: Uint8Array) => base58CheckEncode(id);

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const b = body ? JSON.parse(body) : {};
        paths.push(req.url!);
        const json = (x: unknown) => res.end(JSON.stringify(x));
        switch (req.url) {
          case "/wallet/getchainparameters":
            return json({ chainParameter: [
              { key: "getEnergyFee", value: Number(ENERGY_FEE) }, { key: "getTransactionFee", value: 1000 },
              { key: "getCreateNewAccountFeeInSystemContract", value: 1_000_000 }, { key: "getCreateAccountFee", value: 100_000 },
            ] });
          case "/wallet/getaccount": {
            const bal = trx.get(b.address) ?? 0n;
            return json(bal > 0n ? { balance: Number(bal) } : {});
          }
          case "/wallet/triggerconstantcontract":
          case "/walletsolidity/triggerconstantcontract":
            if (b.function_selector === "balanceOf(address)") {
              const owner = idToB58(Uint8Array.from([0x41, ...hexb(b.parameter.slice(24))]));
              return json({ constant_result: [(tok.get(owner) ?? 0n).toString(16).padStart(64, "0")], result: { result: true } });
            }
            return json({ result: { result: true }, energy_used: Number(ENERGY) });
          case "/wallet/getnowblock":
            return json({ blockID: "0".repeat(16) + "ab".repeat(24), block_header: { raw_data: { number: 80_000_000, timestamp: Date.now() } } });
          case "/wallet/broadcasthex": {
            const tx = readPb(hexb(b.transaction));
            const raw = pbGet(tx, 1) as Uint8Array;
            const sig = pbGet(tx, 2) as Uint8Array;
            const id = txId(raw);
            const rawF = readPb(raw);
            const contract = readPb(pbGet(rawF, 11) as Uint8Array);
            const type = Number(pbGet(contract, 1));
            const value = readPb(pbGet(readPb(pbGet(contract, 2) as Uint8Array), 2) as Uint8Array);
            const owner = idToB58(pbGet(value, 1) as Uint8Array);
            const signer = await recoverAddress({ hash: `0x${id}`, signature: `0x${Buffer.from(sig).toString("hex")}` });
            broadcasts.push({ type, owner, signer, value, feeLimit: pbGet(rawF, 18) as bigint | undefined });
            if (type === 1) {
              const to = idToB58(pbGet(value, 2) as Uint8Array);
              const amount = pbGet(value, 3) as bigint;
              trx.set(owner, (trx.get(owner) ?? 0n) - amount - 1_100_000n); // + activation fee
              trx.set(to, (trx.get(to) ?? 0n) + amount);
            } else {
              const burn = ENERGY * ENERGY_FEE;
              if ((trx.get(owner) ?? 0n) < burn) return json({ result: false, code: "CONTRACT_VALIDATE_ERROR", message: Buffer.from("no TRX").toString("hex") });
              trx.set(owner, (trx.get(owner) ?? 0n) - burn);
              const data = Buffer.from(pbGet(value, 4) as Uint8Array).toString("hex");
              const to = idToB58(Uint8Array.from([0x41, ...hexb(data.slice(8 + 24, 72))]));
              const amount = BigInt(`0x${data.slice(72)}`);
              tok.set(owner, (tok.get(owner) ?? 0n) - amount);
              tok.set(to, (tok.get(to) ?? 0n) + amount);
            }
            return json({ result: true, txid: id });
          }
          default:
            res.statusCode = 404;
            return res.end("{}");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    wallet = new TronWallet("USDT-TRON", USDT, keys, new TronApi(url));
  });
  afterAll(() => server.close());
  beforeEach(() => {
    trx = new Map([[inv.address, 1000_000_000n]]);
    tok = new Map([[dep.address, 250_000_000n]]);
    broadcasts = [];
    paths = [];
  });

  it("prices the worst case in TRX and reads solidified balances for confirmations", async () => {
    expect(await wallet.estimateSendFee(false)).toEqual({ asset: "TRX", amount: 130_000n * 100n + 2n * 350n * 1000n + 1_100_000n });
    expect(await wallet.getDeposit(dep.address)).toMatchObject({ seen: 250_000_000n, confirmed: 250_000_000n });
    expect(paths).toContain("/walletsolidity/triggerconstantcontract");
  });

  it("tops up TRX for energy, then sends a locally built, correctly signed USDT transfer", async () => {
    const r = await wallet.send({ from: { kind: "deposit", index: 7 }, to: DEX, amount: 249_000_000n });
    expect(broadcasts).toHaveLength(2);
    const [topUp, transfer] = broadcasts;
    expect(topUp.type).toBe(1); // TransferContract
    expect(topUp.owner).toBe(inv.address);
    expect(base58CheckEncode(Uint8Array.from([0x41, ...hexb(topUp.signer.slice(2))]))).toBe(inv.address);
    expect(idToB58(pbGet(topUp.value, 2) as Uint8Array)).toBe(dep.address);
    expect(transfer.type).toBe(31); // TriggerSmartContract
    expect(transfer.owner).toBe(dep.address);
    expect(base58CheckEncode(Uint8Array.from([0x41, ...hexb(transfer.signer.slice(2))]))).toBe(dep.address);
    expect(idToB58(pbGet(transfer.value, 2) as Uint8Array)).toBe(USDT);
    expect(transfer.feeLimit).toBeGreaterThan(0n);
    expect(tok.get(DEX)).toBe(249_000_000n);
    expect(tok.get(dep.address)).toBe(1_000_000n);
    expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
  }, 20_000);

  it("refuses over-balance sends and memos without broadcasting", async () => {
    await expect(wallet.send({ from: { kind: "deposit", index: 7 }, to: DEX, amount: 300_000_000n })).rejects.toThrow(/insufficient/);
    await expect(wallet.send({ from: { kind: "deposit", index: 7 }, to: DEX, amount: 1n, memo: "x" })).rejects.toThrow(/memo/);
    expect(broadcasts).toHaveLength(0);
  });
});
