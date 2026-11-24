import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSETS, PLACEHOLDER_ADDRESS } from "../src/assets";
import { OracleError, PriceOracle } from "../src/oracle";
import type { DexProvider } from "../src/providers/types";
import { Router } from "../src/router";
import { buildServer } from "../src/server";
import { buildFlows } from "./flows";
import { FakeDex, fakeMoneroAddress, setup, staticSource, TEST_PRICES } from "./helpers";

const XMR = fakeMoneroAddress(18, 9);

afterEach(() => {
  vi.useRealTimers();
});

describe("errors shown to users", () => {
  it("never pass on internal error text (RPC URLs can carry API keys)", async () => {
    const env = setup();
    const leaky: DexProvider = Object.assign(new FakeDex(1), {
      quote: async () => {
        throw new Error("HTTP request failed. URL: https://eth-mainnet.example.com/v2/SECRET-API-KEY");
      },
    });
    const router = new Router(env.cfg, env.oracle, [leaky], env.wallets);
    const err = await router.plan({ from: ASSETS.BTC, to: ASSETS.ETH, amountIn: 1_000_000n, dry: true }).catch((e: Error) => e);
    expect(String(err)).not.toContain("SECRET-API-KEY");
    expect((err as Error).message).toBe("no route available for this pair right now");
  });

  it("still shows our own explanations, like a DEX minimum", async () => {
    const env = setup();
    const router = new Router(env.cfg, env.oracle, [new FakeDex(1)], env.wallets);
    await expect(router.plan({ from: ASSETS.BTC, to: ASSETS.ETH, amountIn: 1_000n, dry: true })).rejects.toThrow(/minimum is about/);
  });
});

describe("inventory payouts need two agreeing price sources", () => {
  const plan = (sources: number) => {
    const env = setup();
    env.cfg.MIN_PRICE_SOURCES = 2;
    const oracle = new PriceOracle(Object.values(ASSETS), env.cfg.MAX_ORACLE_DEVIATION_BPS,
      Array.from({ length: sources }, () => staticSource({ ...TEST_PRICES })), 0);
    const router = new Router(env.cfg, oracle, [], env.wallets);
    return router.plan({ from: ASSETS.BTC, to: ASSETS.XMR, amountIn: 1_000_000n, recipient: XMR, dry: true });
  };

  it("refuses to price our XMR from a single source", async () => {
    await expect(plan(1)).rejects.toBeInstanceOf(OracleError);
  });

  it("pays out when two sources agree", async () => {
    expect((await plan(2))[0].kind).toBe("inventory");
  });

  it("holds a deposited order while prices are unreliable, then hands it to the operator", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-24T10:00:00Z"));
    const t = buildFlows();
    const { o } = await t.order("BTC", "XMR", 500_000n, XMR, PLACEHOLDER_ADDRESS.BTC); // $300, below review
    t.cfg.MIN_PRICE_SOURCES = 2; // the flow oracle has one source: from now on prices count as unreliable
    t.mock("BTC").simulateDeposit(o.deposit_address, 500_000n);
    await t.run(3);
    expect(t.db.getOrder(o.id)!.status).toBe("confirming"); // held, not refunded
    expect(t.mock("XMR").sent).toHaveLength(0);
    expect(t.mock("BTC").sent).toHaveLength(0);

    vi.setSystemTime(new Date("2026-11-24T10:16:00Z"));
    await t.run(2);
    expect(t.db.getOrder(o.id)!).toMatchObject({ status: "needs_review", error: expect.stringMatching(/no reliable price/) });
    expect(t.notifier.sent.at(-1)).toContain("needs review");
  });
});

describe("rate limits behind a reverse proxy", () => {
  const hammer = async (trustProxy: number) => {
    const t = buildFlows();
    t.cfg.TRUST_PROXY = trustProxy;
    const app = await buildServer(t.cfg, t.db, t.router, t.wallets, t.oracle, ["near"]);
    const post = (ip: string) => app.inject({ method: "POST", url: "/api/orders", payload: {}, headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 10; i++) await post("203.0.113.1"); // 10 orders/minute per visitor
    const same = (await post("203.0.113.1")).statusCode;
    const other = (await post("198.51.100.7")).statusCode;
    await app.close();
    return { same, other };
  };

  it("with TRUST_PROXY=1 each visitor has their own limit", async () => {
    expect(await hammer(1)).toEqual({ same: 429, other: 400 });
  });

  it("without it, the proxy's address is shared (and X-Forwarded-For can't be faked)", async () => {
    expect(await hammer(0)).toEqual({ same: 429, other: 429 });
  });
});
