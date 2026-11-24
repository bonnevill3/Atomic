import { describe, expect, it } from "vitest";
import { ASSETS, PLACEHOLDER_ADDRESS } from "../src/assets";
import { createWallets } from "../src/chains";
import { loadConfig } from "../src/config";
import { PriceOracle } from "../src/oracle";
import { Router } from "../src/router";
import { FakeDex, fakeMoneroAddress, staticSource, TEST_PRICES } from "./helpers";

/** Router with the production fee defaults (only mock chains / in-memory DB overridden). */
function defaultsRouter() {
  const cfg = loadConfig({ CHAINS: "mock", DB_PATH: ":memory:" } as NodeJS.ProcessEnv);
  const wallets = createWallets(cfg); // mock wallets for every asset, including all stablecoins
  // two agreeing sources: production requires that for inventory payouts
  const oracle = new PriceOracle(Object.values(ASSETS), cfg.MAX_ORACLE_DEVIATION_BPS, [staticSource({ ...TEST_PRICES }), staticSource({ ...TEST_PRICES })], 0);
  const dex = new FakeDex(1);
  return { cfg, router: new Router(cfg, oracle, [dex], wallets), wallets };
}

describe("fee policy", () => {
  it("defaults: 1% on every swap, 2% when receiving a stablecoin, buying or selling XMR, no hidden inventory spread", () => {
    const { cfg, router } = defaultsRouter();
    expect(cfg.SERVICE_FEE_BPS).toBe(100);
    expect(cfg.STABLE_PAYOUT_FEE_BPS).toBe(200);
    expect(cfg.XMR_SELL_FEE_BPS).toBe(200);
    expect(cfg.XMR_BUY_FEE_BPS).toBe(200);
    expect(cfg.INVENTORY_SPREAD_BPS).toBe(0);
    expect(cfg.MANUAL_REVIEW_USD).toBe(1000);
    expect(router.feeBps(ASSETS.BTC, ASSETS.ETH)).toBe(100);
    expect(router.feeBps(ASSETS.BTC, ASSETS.XMR)).toBe(200); // buying XMR
    expect(router.feeBps(ASSETS["USDT-TRON"], ASSETS.XMR)).toBe(200);
    expect(router.feeBps(ASSETS.XMR, ASSETS.BTC)).toBe(200); // selling XMR
    expect(router.feeBps(ASSETS.XMR, ASSETS["USDT-TRON"])).toBe(200); // rates don't stack
    for (const id of ["USDT-TRON", "USDT-ETH", "USDC-SOL", "USDC-BASE", "DAI-ETH"] as const) {
      expect(router.feeBps(ASSETS.ETH, ASSETS[id])).toBe(200);
    }
  });

  it("selling XMR takes 2% on both XMR routes (inventory payout and inventory -> DEX)", async () => {
    const { router } = defaultsRouter();
    const toBtc = await router.best({ from: ASSETS.XMR, to: ASSETS.BTC, amountIn: 10n ** 12n, recipient: PLACEHOLDER_ADDRESS.BTC, dry: true });
    expect(toBtc.feeBps).toBe(200);
    expect(toBtc.serviceFee).toBe(2n * 10n ** 10n); // 2% of 1 XMR
    const toSol = await router.best({ from: ASSETS.XMR, to: ASSETS.SOL, amountIn: 10n ** 12n, recipient: PLACEHOLDER_ADDRESS.SOL, dry: true });
    expect(toSol.kind).toBe("inventory_dex");
    expect(toSol.serviceFee).toBe(2n * 10n ** 10n);
  });

  it("BTC -> XMR from inventory takes exactly 2% (+ XMR network fee)", async () => {
    const { router } = defaultsRouter();
    const plan = await router.best({ from: ASSETS.BTC, to: ASSETS.XMR, amountIn: 1_000_000n, recipient: fakeMoneroAddress(), dry: true });
    expect(plan.feeBps).toBe(200);
    expect(plan.serviceFee).toBe(20_000n); // 2% of 0.01 BTC
    expect(plan.spreadBps).toBe(0);
    // 0.0098 BTC * $60,000 = $588 -> 1.176 XMR at $500, minus the mock 0.0001 XMR network fee
    expect(plan.amountOut).toBe(1_176_000_000_000n - 100_000_000n);
  });

  it("buying a stablecoin takes 2%, also for stable -> stable", async () => {
    const { router } = defaultsRouter();
    const eth = await router.best({ from: ASSETS.ETH, to: ASSETS["USDC-ETH"], amountIn: 10n ** 17n, recipient: PLACEHOLDER_ADDRESS.ETH, dry: true });
    expect(eth.feeBps).toBe(200);
    expect(eth.serviceFee).toBe(2n * 10n ** 15n);
    const st = await router.best({ from: ASSETS["USDT-ETH"], to: ASSETS["USDC-ETH"], amountIn: 100_000_000n, recipient: PLACEHOLDER_ADDRESS.ETH, dry: true });
    expect(st.serviceFee).toBe(2_000_000n);
  });

  it("selling a stablecoin for crypto takes 1%", async () => {
    const { router } = defaultsRouter();
    const plan = await router.best({ from: ASSETS["USDT-ETH"], to: ASSETS.BTC, amountIn: 100_000_000n, recipient: PLACEHOLDER_ADDRESS.BTC, dry: true });
    expect(plan.feeBps).toBe(100);
    expect(plan.serviceFee).toBe(1_000_000n);
  });
});
