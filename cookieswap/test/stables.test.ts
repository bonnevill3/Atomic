import { describe, expect, it } from "vitest";
import { PLACEHOLDER_ADDRESS } from "../src/assets";
import { buildFlows } from "./flows";
import { fakeMoneroAddress } from "./helpers";

const XMR = fakeMoneroAddress(18, 5);
const usd6 = (n: number) => BigInt(n) * 1_000_000n;
const usd18 = (n: number) => BigInt(n) * 10n ** 18n;

describe("stablecoin deposits across networks", () => {
  it("USDT on Tron -> XMR is paid from inventory and the USDT is consolidated", async () => {
    const t = buildFlows();
    const { o, plan } = await t.order("USDT-TRON", "XMR", usd6(200), XMR, PLACEHOLDER_ADDRESS.TRON);
    expect(plan.kind).toBe("inventory");
    t.mock("USDT-TRON").simulateDeposit(o.deposit_address, usd6(200));
    await t.run(3);
    const r = t.db.getOrder(o.id)!;
    expect(r.status).toBe("completed");
    // $200 - 0.5% = $199 -> 0.398 XMR -> -1% spread -> -0.0001 XMR fee
    expect(Number(r.amount_out) / 1e12).toBeCloseTo(0.39392, 6);
    expect(t.mock("USDT-TRON").sent.some((s) => s.from.kind === "deposit" && s.amount === "all")).toBe(true);
  });

  it("USDC on Solana -> BTC via DEX: SOL fee is charged in USDC units", async () => {
    const t = buildFlows();
    const { o, plan } = await t.order("USDC-SOL", "BTC", usd6(300), PLACEHOLDER_ADDRESS.BTC, PLACEHOLDER_ADDRESS.SOL);
    expect(plan.kind).toBe("dex");
    // 0.00205 SOL at $100 = $0.205 -> 205_000 USDC units (+1 rounding up)
    expect(plan.forwardFee).toBe(205_001n);
    t.mock("USDC-SOL").simulateDeposit(o.deposit_address, usd6(300));
    await t.run(2);
    expect(t.db.getOrder(o.id)!.status).toBe("dex_pending");
    const fwd = t.mock("USDC-SOL").sent.find((s) => s.to === "near-deposit-address")!;
    expect(fwd.amount).toBe(usd6(300) - 1_500_000n - 205_001n);
  });

  it("USDT on BSC (18 decimals) -> SOL: BNB fee converted into 18-decimal USDT units", async () => {
    const t = buildFlows();
    const { o, plan } = await t.order("USDT-BSC", "SOL", usd18(300), PLACEHOLDER_ADDRESS.SOL, PLACEHOLDER_ADDRESS.BSC);
    // 0.0001 BNB at $500 = $0.05 -> 0.05 * 1e18 (+1)
    expect(plan.forwardFee).toBe(50_000_000_000_000_001n);
    t.mock("USDT-BSC").simulateDeposit(o.deposit_address, usd18(300));
    await t.run(2);
    const fwd = t.mock("USDT-BSC").sent.find((s) => s.to === "near-deposit-address")!;
    expect(fwd.amount).toBe(usd18(300) - usd18(300) / 200n - 50_000_000_000_000_001n);
  });

  it("DAI on Ethereum above $500 waits for manual review", async () => {
    const t = buildFlows();
    const { o } = await t.order("DAI-ETH", "BTC", usd18(2000), PLACEHOLDER_ADDRESS.BTC, PLACEHOLDER_ADDRESS.ETH);
    t.mock("DAI-ETH").simulateDeposit(o.deposit_address, usd18(2000));
    await t.run(3);
    expect(t.db.getOrder(o.id)!.status).toBe("awaiting_approval");
    expect(t.mock("DAI-ETH").sent).toHaveLength(0);
  });

  it("refunding USDT on Polygon sends the tokens back minus the POL gas it costs us", async () => {
    const t = buildFlows();
    const { o } = await t.order("USDT-POL", "BTC", usd6(2000), PLACEHOLDER_ADDRESS.BTC, PLACEHOLDER_ADDRESS.POL);
    t.mock("USDT-POL").simulateDeposit(o.deposit_address, usd6(2000));
    await t.run(3);
    t.db.transition(o.id, "awaiting_approval", { status: "refund_pending", error: "manual refund" });
    await t.run(1);
    const refund = t.mock("USDT-POL").sent.at(-1)!;
    expect(t.db.getOrder(o.id)!.status).toBe("refunded");
    // 0.02 POL at $0.50 = $0.01 = 10_000 USDT units (+1 rounding up)
    expect(refund).toMatchObject({ to: PLACEHOLDER_ADDRESS.POL, amount: usd6(2000) - 10_001n });
    expect(t.mock("USDT-POL").sent).toHaveLength(1);
  });

  it("does not spend our gas refunding a token deposit worth less than the network fee", async () => {
    const t = buildFlows();
    const { o } = await t.order("USDC-ETH", "BTC", usd6(100), PLACEHOLDER_ADDRESS.BTC, PLACEHOLDER_ADDRESS.ETH);
    t.mock("USDC-ETH").simulateDeposit(o.deposit_address, 900_000n); // $0.90 < 0.0005 ETH gas ($1)
    await t.run(4);
    expect(t.db.getOrder(o.id)!).toMatchObject({ status: "needs_review", error: expect.stringMatching(/too small to refund/) });
    expect(t.mock("USDC-ETH").sent).toHaveLength(0);
  });

  it("EVM deposit addresses are never reused across chains (shared index space)", async () => {
    const t = buildFlows();
    const a = await t.order("USDT-BSC", "SOL", usd18(100), PLACEHOLDER_ADDRESS.SOL, PLACEHOLDER_ADDRESS.BSC);
    const b = await t.order("USDC-ETH", "SOL", usd6(100), PLACEHOLDER_ADDRESS.SOL, PLACEHOLDER_ADDRESS.ETH);
    expect(a.o.deposit_index).not.toBe(b.o.deposit_index);
  });
});
