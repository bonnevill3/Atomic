import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSETS, type AssetId, PLACEHOLDER_ADDRESS } from "../src/assets";
import type { OrderRow } from "../src/db";
import { Engine } from "../src/engine";
import { Router } from "../src/router";
import { DenylistScreening } from "../src/screening";
import { FakeDex, fakeMoneroAddress, RecordingNotifier, setup } from "./helpers";

const XMR_ADDR = fakeMoneroAddress(18, 3);

async function createOrder(env: ReturnType<typeof setup>, router: Router, from: AssetId, to: AssetId, amountIn: bigint, recipient: string, refund: string, ttlMs = 3_600_000): Promise<OrderRow> {
  const plan = await router.best({ from: ASSETS[from], to: ASSETS[to], amountIn, recipient, dry: true });
  const wallet = env.wallets[ASSETS[from].chain as "BTC" | "ETH" | "XMR"];
  const dep = await wallet.depositAddress(env.db.allocateIndex(ASSETS[from].chain));
  return env.db.insertOrder({
    id: randomBytes(8).toString("hex"), token_hash: "x", from_asset: from, to_asset: to,
    amount_in: amountIn.toString(), quoted_out: plan.amountOut.toString(), route_kind: plan.kind, provider: plan.label,
    recipient, refund_address: refund, deposit_chain: ASSETS[from].chain, deposit_address: dep.address,
    deposit_index: dep.index, max_drift_bps: env.cfg.MAX_RATE_DRIFT_BPS, expires_at: Date.now() + ttlMs,
  });
}

function build(denylist?: string) {
  const env = setup();
  const dex = new FakeDex(20); // 1 ETH = 20 SOL
  const router = new Router(env.cfg, env.oracle, [dex], env.wallets);
  const notifier = new RecordingNotifier();
  const engine = new Engine(env.cfg, env.db, router, env.wallets, { near: dex }, new DenylistScreening(denylist), env.oracle, notifier);
  const run = async (n = 3) => {
    for (let i = 0; i < n; i++) await engine.tick();
  };
  return { ...env, dex, router, engine, run, notifier };
}

describe("engine", () => {
  it("BTC → XMR from inventory: deposit, confirm, payout, consolidate", async () => {
    const t = build();
    const o = await createOrder(t, t.router, "BTC", "XMR", 1_000_000n, XMR_ADDR, PLACEHOLDER_ADDRESS.BTC);
    expect(o.route_kind).toBe("inventory");

    t.wallets.BTC.simulateDeposit(o.deposit_address, 1_000_000n, false);
    await t.run(1);
    expect(t.db.getOrder(o.id)!.status).toBe("confirming");
    await t.run(1);
    expect(t.db.getOrder(o.id)!.status).toBe("confirming"); // unconfirmed: wait

    t.wallets.BTC.confirmAll(o.deposit_address);
    await t.run(1);
    const done = t.db.getOrder(o.id)!;
    expect(done.status).toBe("completed");
    const payout = t.wallets.XMR.sent.find((s) => s.to === XMR_ADDR)!;
    expect(payout.from).toEqual({ kind: "inventory" });
    expect(BigInt(done.amount_out!)).toBe(payout.amount as bigint);
    // 0.01 BTC = $600 → minus 0.5% fee → 1.194 XMR → minus 1% spread → minus fee
    expect(Number(done.amount_out) / 1e12).toBeCloseTo(1.18206 - 0.0001, 4);
    // deposit swept into BTC inventory
    expect(t.wallets.BTC.sent.some((s) => s.from.kind === "deposit" && s.amount === "all")).toBe(true);
  });

  it("ETH → SOL through a DEX: forwards net amount to the DEX deposit address", async () => {
    const t = build();
    const o = await createOrder(t, t.router, "ETH", "SOL", 10n ** 18n, PLACEHOLDER_ADDRESS.SOL, PLACEHOLDER_ADDRESS.ETH);
    expect(o.route_kind).toBe("dex");
    t.wallets.ETH.simulateDeposit(o.deposit_address, 10n ** 18n);
    await t.run(2);
    const pending = t.db.getOrder(o.id)!;
    expect(pending.status).toBe("dex_pending");
    const fwd = t.wallets.ETH.sent.find((s) => s.to === "near-deposit-address")!;
    // 1 ETH - 0.5% fee - forward fee (0.001 ETH)
    expect(fwd.amount).toBe(10n ** 18n - 5n * 10n ** 15n - 10n ** 15n);
    // the real execution quote must refund to the order's deposit address
    expect(t.dex.quotes.at(-1)!.refundTo).toBe(o.deposit_address);

    // mock txids are treated as simulated → completed without asking the DEX
    await t.run(1);
    expect(t.db.getOrder(o.id)!.status).toBe("completed");
  });

  it("DEX refund → refunds the user from the deposit address", async () => {
    const t = build();
    const o = await createOrder(t, t.router, "ETH", "SOL", 10n ** 18n, PLACEHOLDER_ADDRESS.SOL, PLACEHOLDER_ADDRESS.ETH);
    // put the order directly into dex_pending with a non-simulated ref
    t.db.transition(o.id, "awaiting_deposit", {
      status: "dex_pending", exec_txid: "0xabc", exec_ref: JSON.stringify({ provider: "near", txid: "0xabc", depositAddress: "near-deposit-address" }),
    });
    t.dex.status_ = { state: "refunded" };
    await t.run(1);
    expect(t.db.getOrder(o.id)!.status).toBe("refund_pending");
    // refund waits until funds are back on the deposit address
    await t.run(1);
    expect(t.db.getOrder(o.id)!.status).toBe("refund_pending");
    t.wallets.ETH.simulateDeposit(o.deposit_address, 99n * 10n ** 16n);
    await t.run(1);
    const r = t.db.getOrder(o.id)!;
    expect(r.status).toBe("refunded");
    expect(t.wallets.ETH.sent.at(-1)!.to).toBe(PLACEHOLDER_ADDRESS.ETH);
  });

  it("expires orders without a deposit", async () => {
    const t = build();
    const o = await createOrder(t, t.router, "BTC", "XMR", 1_000_000n, XMR_ADDR, PLACEHOLDER_ADDRESS.BTC, -1);
    await t.run(1);
    expect(t.db.getOrder(o.id)!.status).toBe("expired");
  });

  it("refunds when the rate moved beyond tolerance", async () => {
    const t = build();
    const o = await createOrder(t, t.router, "BTC", "XMR", 1_000_000n, XMR_ADDR, PLACEHOLDER_ADDRESS.BTC);
    t.source.prices.XMR = 520; // XMR +4% → user would get ~4% less XMR
    t.wallets.BTC.simulateDeposit(o.deposit_address, 1_000_000n);
    await t.run(3);
    const r = t.db.getOrder(o.id)!;
    expect(r.status).toBe("refunded");
    expect(r.error).toMatch(/rate moved/);
    expect(t.wallets.XMR.sent).toHaveLength(0);
  });

  it("never re-sends after a crash mid-send", async () => {
    const t = build();
    const o = await createOrder(t, t.router, "BTC", "XMR", 1_000_000n, XMR_ADDR, PLACEHOLDER_ADDRESS.BTC);
    t.db.transition(o.id, "awaiting_deposit", { status: "executing" });
    await t.run(1);
    expect(t.db.getOrder(o.id)!.status).toBe("needs_review");
    expect(t.wallets.XMR.sent).toHaveLength(0);
  });

  it("screening blocks and refunds", async () => {
    const file = join(tmpdir(), `deny-${randomBytes(4).toString("hex")}.txt`);
    writeFileSync(file, `# test\n${XMR_ADDR}\n`);
    const t = build(file);
    const o = await createOrder(t, t.router, "BTC", "XMR", 1_000_000n, XMR_ADDR, PLACEHOLDER_ADDRESS.BTC);
    t.wallets.BTC.simulateDeposit(o.deposit_address, 1_000_000n);
    await t.run(3);
    const r = t.db.getOrder(o.id)!;
    expect(r.status).toBe("refunded");
    expect(r.error).toMatch(/screening/);
  });

  it("XMR → SOL goes inventory ETH → DEX", async () => {
    const t = build();
    const o = await createOrder(t, t.router, "XMR", "SOL", 2n * 10n ** 12n, PLACEHOLDER_ADDRESS.SOL, XMR_ADDR);
    expect(o.route_kind).toBe("inventory_dex");
    t.wallets.XMR.simulateDeposit(o.deposit_address, 2n * 10n ** 12n);
    await t.run(2);
    expect(t.db.getOrder(o.id)!.status).toBe("dex_pending");
    const fwd = t.wallets.ETH.sent.find((s) => s.to === "near-deposit-address")!;
    expect(fwd.from).toEqual({ kind: "inventory" });
  });
});
