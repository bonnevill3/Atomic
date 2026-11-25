import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ASSETS, PLACEHOLDER_ADDRESS } from "../src/assets";
import { createDepositVerifiers } from "../src/chains";
import type { DepositInfo } from "../src/chains/types";
import { BlockcypherUtxoSource, type DepositSource } from "../src/chains/verify";
import { loadConfig } from "../src/config";
import { buildFlows } from "./flows";
import { fakeMoneroAddress } from "./helpers";

const XMR = fakeMoneroAddress(18, 11);

/** A second source whose answer the test controls. */
class FakeSource implements DepositSource {
  answer: DepositInfo | Error = { seen: 0n, confirmed: 0n, txids: [] };
  calls = 0;
  async getDeposit(): Promise<DepositInfo> {
    this.calls++;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("deposit double-check", () => {
  const setup = () => {
    const btc = new FakeSource();
    const t = buildFlows({ verifiers: { BTC: btc } });
    return { t, btc };
  };
  const deposit = async (t: ReturnType<typeof buildFlows>) => {
    const { o } = await t.order("BTC", "XMR", 500_000n, XMR, PLACEHOLDER_ADDRESS.BTC); // $300
    t.mock("BTC").simulateDeposit(o.deposit_address, 500_000n);
    return o;
  };

  it("pays out once the second source confirms the same amount", async () => {
    const { t, btc } = setup();
    const o = await deposit(t);
    btc.answer = { seen: 500_000n, confirmed: 500_000n, txids: ["x"] };
    await t.run(3);
    expect(t.db.getOrder(o.id)!.status).toBe("completed");
    expect(btc.calls).toBeGreaterThan(0);
  });

  it("holds while the second source doesn't see it (or less of it), and never pays", async () => {
    const { t, btc } = setup();
    const o = await deposit(t);
    btc.answer = { seen: 500_000n, confirmed: 100_000n, txids: ["x"] }; // a faked or partial deposit
    await t.run(4);
    expect(t.db.getOrder(o.id)!.status).toBe("confirming");
    expect(t.mock("XMR").sent).toHaveLength(0);

    btc.answer = new Error("second source down");
    await t.run(2);
    expect(t.db.getOrder(o.id)!.status).toBe("confirming");

    btc.answer = { seen: 500_000n, confirmed: 500_000n, txids: ["x"] }; // it caught up
    await t.run(2);
    expect(t.db.getOrder(o.id)!.status).toBe("completed");
  });

  it("hands the order to the operator after 30 minutes without confirmation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
    const { t } = setup();
    const o = await deposit(t);
    await t.run(3);
    vi.setSystemTime(new Date("2026-11-25T10:31:00Z"));
    await t.run(2); // review, then the alert on the next tick
    expect(t.db.getOrder(o.id)!).toMatchObject({ status: "needs_review", error: expect.stringMatching(/not confirmed by the second source/) });
    expect(t.notifier.sent.at(-1)).toContain("needs review");
    expect(t.mock("XMR").sent).toHaveLength(0);
  });

  it("doesn't double-check XMR deposits (monero-wallet-rpc reads our own node)", async () => {
    const t = buildFlows({ verifiers: {} });
    const { o } = await t.order("XMR", "ETH", 5n * 10n ** 11n, PLACEHOLDER_ADDRESS.ETH, XMR);
    t.mock("XMR").simulateDeposit(o.deposit_address, 5n * 10n ** 11n);
    await t.run(3);
    expect(t.db.getOrder(o.id)!.status).toBe("completed");
  });

  it("never acts on an asset without a configured second source", async () => {
    const t = buildFlows({ verifiers: {} });
    const o = await deposit(t);
    await t.run(4);
    expect(t.db.getOrder(o.id)!.status).toBe("confirming");
    expect(t.mock("XMR").sent).toHaveLength(0);
  });
});

describe("BlockCypher second source (Litecoin)", () => {
  let server: Server;
  let base = "";
  let lastUrl = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      lastUrl = req.url!;
      res.end(JSON.stringify({
        txrefs: [
          { tx_hash: "a", value: 150_000_000, confirmations: 9 },
          { tx_hash: "b", value: 50_000_000, confirmations: 2 },
        ],
        unconfirmed_txrefs: [{ tx_hash: "c", value: 1_000_000, confirmations: 0 }],
      }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("sums unspent outputs and counts only those with enough confirmations", async () => {
    const src = new BlockcypherUtxoSource("ltc", 6, "tok", base);
    const d = await src.getDeposit("ltc1qexample");
    expect(d).toEqual({ seen: 201_000_000n, confirmed: 150_000_000n, txids: ["a", "b", "c"] });
    expect(lastUrl).toMatch(/^\/ltc\/main\/addrs\/ltc1qexample\?unspentOnly=true&limit=200&token=tok$/);
  });
});

describe("second sources on live mainnet", () => {
  const live = {
    CHAINS: "live", MNEMONIC: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    ADMIN_TOKEN: "a".repeat(32), ALERT_WEBHOOK_URL: "https://hooks.example.com/x",
  };

  it("covers every depositable asset except XMR", () => {
    const v = createDepositVerifiers(loadConfig(live as NodeJS.ProcessEnv))!;
    const depositable = Object.values(ASSETS).filter((a) => a.depositable && a.listed && a.id !== "XMR").map((a) => a.id).sort();
    expect(Object.keys(v).sort()).toEqual(depositable);
    expect(v.XMR).toBeUndefined();
  });

  it("is off with mock chains", () => {
    expect(createDepositVerifiers(loadConfig({ CHAINS: "mock" } as NodeJS.ProcessEnv))).toBeNull();
  });

  it("refuses a second source run by the same provider as the primary", () => {
    expect(() => createDepositVerifiers(loadConfig({ ...live, BTC_VERIFY_ESPLORA_URL: "https://blockstream.info/api" } as NodeJS.ProcessEnv)))
      .toThrow(/BTC: the deposit double-check must use a different provider/);
    expect(() => createDepositVerifiers(loadConfig({ ...live, ETH_RPC_URL: "https://eth.drpc.org" } as NodeJS.ProcessEnv)))
      .toThrow(/ETH: the deposit double-check must use a different provider/);
  });
});

describe("Solana token second source (associated token account read)", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const OWNER = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
  let server: Server;
  let url = "";
  let account: unknown = null;
  const commitments: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id, method, params } = JSON.parse(body);
        expect(method).toBe("getAccountInfo"); // a plain account read, no token index needed
        commitments.push(params[1].commitment);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: account } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const tokenAccount = (mint: string, amount: string) => ({
    data: { parsed: { info: { mint, owner: OWNER, state: "initialized", tokenAmount: { amount, decimals: 6, uiAmount: 1, uiAmountString: "1" } }, type: "account" }, program: "spl-token", space: 165 },
    executable: false, lamports: 2039280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 165,
  });

  it("reads confirmed and finalized balances of the deposit's token account", async () => {
    const { SplAtaSource, SplWallet } = await import("../src/chains/solana");
    account = tokenAccount(USDC, "250000000");
    const d = await new SplAtaSource(USDC, SplWallet.connect(url)).getDeposit(OWNER);
    expect(d).toEqual({ seen: 250_000_000n, confirmed: 250_000_000n, txids: [] });
    // @solana/kit leaves out "finalized": it is the RPC's default commitment
    expect(commitments.slice(-2).map((c) => c ?? "finalized").sort()).toEqual(["confirmed", "finalized"]);
  });

  it("no token account means nothing deposited; another mint's data is an error", async () => {
    const { SplAtaSource, SplWallet } = await import("../src/chains/solana");
    account = null;
    expect((await new SplAtaSource(USDC, SplWallet.connect(url)).getDeposit(OWNER)).confirmed).toBe(0n);
    account = tokenAccount("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "1");
    await expect(new SplAtaSource(USDC, SplWallet.connect(url)).getDeposit(OWNER)).rejects.toThrow(/unexpected token account/);
  });
});
