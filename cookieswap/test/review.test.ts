import { describe, expect, it } from "vitest";
import { PLACEHOLDER_ADDRESS } from "../src/assets";
import { buildFlows } from "./flows";
import { fakeMoneroAddress } from "./helpers";

const XMR = fakeMoneroAddress(18, 4);

describe("manual review above MANUAL_REVIEW_USD ($500)", () => {
  it("stops a $600 order until approved, then executes it", async () => {
    const t = buildFlows();
    const { o } = await t.order("BTC", "XMR", 1_000_000n, XMR, PLACEHOLDER_ADDRESS.BTC);
    t.mock("BTC").simulateDeposit(o.deposit_address, 1_000_000n);
    await t.run(4);
    const held = t.db.getOrder(o.id)!;
    expect(held.status).toBe("awaiting_approval");
    expect(held.error).toMatch(/manual review: ~\$600 > \$500/);
    expect(t.mock("XMR").sent).toHaveLength(0);

    t.db.transition(o.id, "awaiting_approval", { status: "approved", error: null });
    await t.run(1);
    expect(t.db.getOrder(o.id)!.status).toBe("completed");
    expect(t.mock("XMR").sent.some((s) => s.to === XMR)).toBe(true);
  });

  it("lets $300 and exactly $500 through without review", async () => {
    const t = buildFlows();
    const small = await t.order("BTC", "XMR", 500_000n, XMR, PLACEHOLDER_ADDRESS.BTC);
    t.mock("BTC").simulateDeposit(small.o.deposit_address, 500_000n);
    const edge = await t.order("XMR", "ETH", 10n ** 12n, PLACEHOLDER_ADDRESS.ETH, XMR); // 1 XMR = $500
    t.mock("XMR").simulateDeposit(edge.o.deposit_address, 10n ** 12n);
    await t.run(3);
    expect(t.db.getOrder(small.o.id)!.status).toBe("completed");
    expect(t.db.getOrder(edge.o.id)!.status).toBe("completed");
  });

  it("refunds from review without ever touching the DEX", async () => {
    const t = buildFlows();
    const { o } = await t.order("ETH", "SOL", 10n ** 18n, PLACEHOLDER_ADDRESS.SOL, PLACEHOLDER_ADDRESS.ETH); // $2000
    t.mock("ETH").simulateDeposit(o.deposit_address, 10n ** 18n);
    await t.run(3);
    expect(t.db.getOrder(o.id)!.status).toBe("awaiting_approval");
    t.db.transition(o.id, "awaiting_approval", { status: "refund_pending", error: "manual refund" });
    await t.run(1);
    expect(t.db.getOrder(o.id)!.status).toBe("refunded");
    expect(t.mock("ETH").sent.at(-1)!.to).toBe(PLACEHOLDER_ADDRESS.ETH);
    expect(t.mock("ETH").sent.some((s) => s.to === "near-deposit-address")).toBe(false);
  });

  it("voids the approval when the deposit changes afterwards", async () => {
    const t = buildFlows();
    const { o } = await t.order("BTC", "XMR", 1_000_000n, XMR, PLACEHOLDER_ADDRESS.BTC);
    t.mock("BTC").simulateDeposit(o.deposit_address, 1_000_000n);
    await t.run(3);
    t.db.transition(o.id, "awaiting_approval", { status: "approved", error: null });
    t.mock("BTC").simulateDeposit(o.deposit_address, 2_000_000n);
    await t.run(3);
    const r = t.db.getOrder(o.id)!;
    expect(r.status).toBe("awaiting_approval");
    expect(r.received_amount).toBe("3000000");
    expect(t.mock("XMR").sent).toHaveLength(0);
  });

  it("holds the order (no fallback) when the price oracle fails", async () => {
    const t = buildFlows();
    const { o } = await t.order("BTC", "XMR", 1_000_000n, XMR, PLACEHOLDER_ADDRESS.BTC);
    t.mock("BTC").simulateDeposit(o.deposit_address, 1_000_000n);
    await t.run(1); // -> confirming
    delete t.source.prices.BTC;
    await t.run(2);
    expect(t.db.getOrder(o.id)!.status).toBe("confirming");
    expect(t.mock("XMR").sent).toHaveLength(0);
  });
});
