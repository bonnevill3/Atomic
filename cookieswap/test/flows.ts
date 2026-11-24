import { randomBytes } from "node:crypto";
import { ASSETS, type AssetId, GAS_ASSET, keyFamily } from "../src/assets";
import { MockWallet } from "../src/chains/mock";
import type { Wallets } from "../src/chains/types";
import type { OrderRow } from "../src/db";
import { Engine } from "../src/engine";
import { type RoutePlan, Router } from "../src/router";
import { DenylistScreening } from "../src/screening";
import { FakeDex, RecordingNotifier, setup } from "./helpers";

/** Engine + router over mock wallets for every asset, with a DEX that (like today's DEXes) has no XMR. */
export function buildFlows(opts: { reviewUsd?: number; dexRate?: number; denylist?: string } = {}) {
  const env = setup();
  env.cfg.MANUAL_REVIEW_USD = opts.reviewUsd ?? 500;
  const tokenGas: Partial<Record<AssetId, bigint>> = {
    "USDT-TRON": 15_000_000n, // 15 TRX
    "USDC-SOL": 2_050_000n, // 0.00205 SOL
    "USDT-BSC": 100_000_000_000_000n, // 0.0001 BNB
    "DAI-ETH": 500_000_000_000_000n, // 0.0005 ETH
    "USDT-POL": 20_000_000_000_000_000n, // 0.02 POL
    "USDC-ETH": 500_000_000_000_000n,
  };
  const wallets: Wallets = { ...env.wallets };
  for (const [id, fee] of Object.entries(tokenGas)) {
    const a = ASSETS[id as AssetId];
    wallets[a.id] = new MockWallet(a.id, a.chain, 0n, fee!, undefined, GAS_ASSET[a.chain]);
  }
  // Native coins pay their network fee in their own unit and hold no inventory.
  const nativeFee: Partial<Record<AssetId, bigint>> = {
    BNB: 100_000_000_000_000n, AVAX: 1_000_000_000_000_000n, TRX: 1_450_000n, SOL: 10_000n, LTC: 2_000n,
  };
  for (const [id, fee] of Object.entries(nativeFee)) {
    const a = ASSETS[id as AssetId];
    wallets[a.id] = new MockWallet(a.id, a.chain, 0n, fee!);
  }
  const dex = new FakeDex(opts.dexRate ?? 0.01);
  dex.supports = async (f, t) => f.id !== "XMR" && t.id !== "XMR";
  const router = new Router(env.cfg, env.oracle, [dex], wallets);
  const notifier = new RecordingNotifier();
  const engine = new Engine(env.cfg, env.db, router, wallets, { near: dex }, new DenylistScreening(opts.denylist), env.oracle, notifier);

  const run = async (n: number) => {
    for (let i = 0; i < n; i++) await engine.tick();
  };
  const order = async (
    from: AssetId, to: AssetId, amountIn: bigint, recipient: string, refund: string, slippageBps = env.cfg.MAX_RATE_DRIFT_BPS,
  ): Promise<{ o: OrderRow; plan: RoutePlan }> => {
    const plan = await router.best({ from: ASSETS[from], to: ASSETS[to], amountIn, recipient, dry: true });
    const dep = await wallets[from]!.depositAddress(env.db.allocateIndex(keyFamily(ASSETS[from].chain)));
    const o = env.db.insertOrder({
      id: randomBytes(8).toString("hex"), token_hash: "x", from_asset: from, to_asset: to, amount_in: amountIn.toString(),
      quoted_out: plan.amountOut.toString(), route_kind: plan.kind, provider: plan.label, recipient, refund_address: refund,
      deposit_chain: ASSETS[from].chain, deposit_address: dep.address, deposit_index: dep.index, max_drift_bps: slippageBps, expires_at: Date.now() + 3_600_000,
    });
    return { o, plan };
  };
  const mock = (id: AssetId) => wallets[id] as MockWallet;
  return { ...env, wallets, dex, router, engine, run, order, mock, notifier };
}
