import { describe, expect, it } from "vitest";
import { PLACEHOLDER_ADDRESS } from "../src/assets";
import { buildServer } from "../src/server";
import { buildFlows } from "./flows";
import { fakeMoneroAddress } from "./helpers";

const XMR = fakeMoneroAddress(18, 7);
const ADMIN = "test-admin-token-0123456789abcdef";

describe("operator alerts for orders above MANUAL_REVIEW_USD", () => {
  it("alerts once with the order details and the admin actions", async () => {
    const t = buildFlows(); // threshold $500 in the flow tests
    const { o } = await t.order("BTC", "XMR", 1_000_000n, XMR, PLACEHOLDER_ADDRESS.BTC); // $600
    t.mock("BTC").simulateDeposit(o.deposit_address, 1_000_000n);
    await t.run(4);
    expect(t.db.getOrder(o.id)!.status).toBe("awaiting_approval");
    expect(t.notifier.sent).toHaveLength(1);
    const msg = t.notifier.sent[0];
    for (const part of [o.id, "0.01 BTC", "~$600 > $500", XMR, o.deposit_address, `/admin/orders/${o.id}/approve`, "/resolve", "/refund"]) {
      expect(msg).toContain(part);
    }
    await t.run(3);
    expect(t.notifier.sent).toHaveLength(1); // not repeated while it waits
  });

  it("retries an alert that could not be delivered", async () => {
    const t = buildFlows();
    const { o } = await t.order("BTC", "XMR", 1_000_000n, XMR, PLACEHOLDER_ADDRESS.BTC);
    t.mock("BTC").simulateDeposit(o.deposit_address, 1_000_000n);
    t.notifier.failing = true;
    await t.run(4);
    expect(t.db.getOrder(o.id)!).toMatchObject({ status: "awaiting_approval", alert_sent_at: null });
    t.notifier.failing = false;
    await t.run(1);
    expect(t.notifier.sent).toHaveLength(1);
    expect(t.db.getOrder(o.id)!.alert_sent_at).not.toBeNull();
  });

  it("alerts again when the order is held a second time, and for needs_review", async () => {
    const t = buildFlows();
    const big = await t.order("BTC", "XMR", 1_000_000n, XMR, PLACEHOLDER_ADDRESS.BTC);
    t.mock("BTC").simulateDeposit(big.o.deposit_address, 1_000_000n);
    await t.run(3);
    t.db.transition(big.o.id, "awaiting_approval", { status: "approved", error: null });
    t.mock("BTC").simulateDeposit(big.o.deposit_address, 2_000_000n); // deposit changed: approval is void
    await t.run(4);
    expect(t.db.getOrder(big.o.id)!.status).toBe("awaiting_approval");
    expect(t.notifier.sent).toHaveLength(2);

    const small = await t.order("BTC", "XMR", 100_000n, XMR, PLACEHOLDER_ADDRESS.BTC);
    t.db.transition(small.o.id, "awaiting_deposit", { status: "executing" }); // as if we crashed mid-send
    await t.run(2);
    expect(t.db.getOrder(small.o.id)!.status).toBe("needs_review");
    expect(t.notifier.sent).toHaveLength(3);
    expect(t.notifier.sent[2]).toContain("needs review");
  });
});

describe("customers never see the operator hold", () => {
  it("hides the threshold and the hold from the public API, and lets the operator fill the order by hand", async () => {
    const t = buildFlows();
    t.cfg.ADMIN_TOKEN = ADMIN;
    const app = await buildServer(t.cfg, t.db, t.router, t.wallets, t.oracle, ["near"]);
    const json = async (method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await app.inject({ method, url, payload: body as object | undefined, headers });
      return { status: r.statusCode, body: r.json(), raw: r.body };
    };

    const health = await json("GET", "/api/health");
    const info = await json("GET", "/api/info");
    expect(health.raw).not.toMatch(/review/i);
    expect(info.raw).not.toMatch(/manualReview/);
    expect(info.body.fees.xmrSellBps).toBe(t.cfg.XMR_SELL_FEE_BPS);

    const quote = await json("POST", "/api/quote", { from: "BTC", to: "XMR", amount: "0.01" });
    expect(quote.status).toBe(200);
    expect(quote.raw).not.toMatch(/review/i);

    const created = await json("POST", "/api/orders", { from: "BTC", to: "XMR", amount: "0.01", recipient: XMR, refundAddress: PLACEHOLDER_ADDRESS.BTC });
    expect(created.status).toBe(200);
    const { order, token } = created.body;
    t.mock("BTC").simulateDeposit(order.depositAddress, 1_000_000n);
    await t.run(4);
    expect(t.db.getOrder(order.id)!.status).toBe("awaiting_approval");

    const seen = await json("GET", `/api/orders/${order.id}`, undefined, { "x-order-token": token });
    expect(seen.body.status).toBe("processing");
    expect(seen.raw).not.toMatch(/review|approv/i);

    // The operator pays the customer by hand and records it; the deposit is swept to inventory.
    const auth = { authorization: `Bearer ${ADMIN}` };
    const resolved = await json("POST", `/admin/orders/${order.id}/resolve`, { status: "completed", txid: "manual-payout-1", amountOut: "1.17" }, auth);
    expect(resolved.status).toBe(200);
    expect(resolved.body.order).toMatchObject({ status: "completed", amountOut: "1.17", payoutTxid: "manual-payout-1" });
    expect(resolved.body.sweepTxid).toMatch(/^mock-/);
    expect(t.mock("BTC").sent.at(-1)).toMatchObject({ from: { kind: "deposit", index: t.db.getOrder(order.id)!.deposit_index }, amount: "all" });

    const again = await json("POST", `/admin/orders/${order.id}/resolve`, { status: "completed", txid: "x" }, auth);
    expect(again.status).toBe(409);
    const customer = await json("GET", `/api/orders/${order.id}`, undefined, { "x-order-token": token });
    expect(customer.body).toMatchObject({ status: "completed", amountOut: "1.17" });
    await app.close();
  });

  it("only allows 'completed' when resolving a held order by hand", async () => {
    const t = buildFlows();
    t.cfg.ADMIN_TOKEN = ADMIN;
    const app = await buildServer(t.cfg, t.db, t.router, t.wallets, t.oracle, ["near"]);
    const { o } = await t.order("BTC", "XMR", 1_000_000n, XMR, PLACEHOLDER_ADDRESS.BTC);
    t.mock("BTC").simulateDeposit(o.deposit_address, 1_000_000n);
    await t.run(4);
    const r = await app.inject({
      method: "POST", url: `/admin/orders/${o.id}/resolve`, headers: { authorization: `Bearer ${ADMIN}` },
      payload: { status: "refunded", txid: "x" },
    });
    expect(r.statusCode).toBe(409);
    expect(t.db.getOrder(o.id)!.status).toBe("awaiting_approval");
    await app.close();
  });
});
