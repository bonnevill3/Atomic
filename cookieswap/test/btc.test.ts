import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as bitcoin from "bitcoinjs-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BtcKeys, BtcWallet } from "../src/chains/btc";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const keys = new BtcKeys(MNEMONIC, "mainnet");
const depositAddr = keys.address({ kind: "deposit", index: 1 });
const VAULT = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

let server: Server;
let base = "";
let broadcast = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === `/address/${depositAddr}/utxo`) {
      res.end(JSON.stringify([
        { txid: "11".repeat(32), vout: 0, value: 600_000, status: { confirmed: true, block_height: 100 } },
        { txid: "22".repeat(32), vout: 1, value: 400_000, status: { confirmed: true, block_height: 101 } },
        { txid: "33".repeat(32), vout: 0, value: 5_000, status: { confirmed: false } },
      ]));
    } else if (url === "/blocks/tip/height") res.end("101");
    else if (url === "/fee-estimates") res.end(JSON.stringify({ "3": 4.2 }));
    else if (url === "/tx" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        broadcast = body;
        res.end(bitcoin.Transaction.fromHex(body).getId());
      });
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("BtcWallet", () => {
  it("derives BIP84 addresses (test vector)", () => {
    // BIP84 test vector: first receive address of the "abandon … about" mnemonic
    expect(keys.address({ kind: "deposit", index: 0 })).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it("counts only confirmed deposits with enough confirmations", async () => {
    const w = new BtcWallet(keys, base, 2);
    const d = await w.getDeposit(depositAddr);
    expect(d.seen).toBe(1_005_000n);
    expect(d.confirmed).toBe(600_000n); // the 101-height utxo has 1 conf, the mempool one 0
  });

  it("builds a THORChain-style tx: vault, OP_RETURN memo, change to inventory", async () => {
    const w = new BtcWallet(keys, base, 1);
    const memo = "=:ETH.ETH:0x9858EfFD232B4033E47d90003D41EC34EcaEda94:0/1/0";
    const res = await w.send({ from: { kind: "deposit", index: 1 }, to: VAULT, amount: 900_000n, memo });
    const tx = bitcoin.Transaction.fromHex(broadcast);
    expect(res.txid).toBe(tx.getId());
    expect(tx.ins).toHaveLength(2); // only the two confirmed utxos
    const net = bitcoin.networks.bitcoin;
    expect(bitcoin.address.fromOutputScript(tx.outs[0].script, net)).toBe(VAULT);
    expect(tx.outs[0].value).toBe(900_000n);
    const embedded = bitcoin.payments.embed({ output: tx.outs[1].script }).data![0];
    expect(Buffer.from(embedded).toString("utf8")).toBe(memo);
    expect(bitcoin.address.fromOutputScript(tx.outs[2].script, net)).toBe(keys.address({ kind: "inventory" }));
    // fee = 5 sat/vB × vsize, change = rest
    expect(res.fee).toBe(BigInt(tx.virtualSize() * 5));
    expect(tx.outs[2].value).toBe(1_000_000n - 900_000n - res.fee);
  });

  it("sweeps 'all' minus fee with no change output", async () => {
    const w = new BtcWallet(keys, base, 1);
    const res = await w.send({ from: { kind: "deposit", index: 1 }, to: VAULT, amount: "all" });
    const tx = bitcoin.Transaction.fromHex(broadcast);
    expect(tx.outs).toHaveLength(1);
    expect(tx.outs[0].value).toBe(1_000_000n - res.fee);
  });
});
