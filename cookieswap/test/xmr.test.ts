import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XmrWallet } from "../src/chains/xmr";

/** Fake monero-wallet-rpc: get_transfers answers with `incoming`. */
let server: Server;
let url = "";
let incoming: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      const result = method === "get_transfers" ? { in: incoming } : {};
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/json_rpc`;
});
afterAll(() => server.close());

describe("XmrWallet deposit detection", () => {
  const w = () => new XmrWallet(url, 10);

  it("counts normal transfers once they have enough confirmations", async () => {
    incoming = [
      { amount: 2_000_000_000_000, confirmations: 12, txid: "a", unlock_time: 0, locked: false },
      { amount: 500_000_000_000, confirmations: 3, txid: "b", unlock_time: 0, locked: true },
    ];
    expect(await w().getDeposit("x", 5)).toMatchObject({ seen: 2_500_000_000_000n, confirmed: 2_000_000_000_000n });
  });

  it("never counts time-locked coins, however many confirmations they have", async () => {
    incoming = [{ amount: 9_000_000_000_000, confirmations: 50, txid: "c", unlock_time: 9_999_999, locked: true }];
    const d = await w().getDeposit("x", 5);
    expect(d.seen).toBe(9_000_000_000_000n);
    expect(d.confirmed).toBe(0n); // the order stays "confirming": no payout against unspendable coins
  });

  it("counts an unlock_time that has already passed (the wallet reports it unlocked)", async () => {
    incoming = [{ amount: 1_000_000_000_000, confirmations: 40, txid: "d", unlock_time: 3_000_000, locked: false }];
    expect((await w().getDeposit("x", 5)).confirmed).toBe(1_000_000_000_000n);
  });

  it("refuses to guess when the wallet doesn't report unlock_time", async () => {
    incoming = [{ amount: 1_000_000_000_000, confirmations: 40, txid: "e" }];
    await expect(w().getDeposit("x", 5)).rejects.toThrow(/unlock_time/);
  });
});
