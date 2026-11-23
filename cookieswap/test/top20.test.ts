import { custom } from "viem";
import { describe, expect, it } from "vitest";
import { PLACEHOLDER_ADDRESS } from "../src/assets";
import { EvmKeys, EvmRpc, EvmWallet } from "../src/chains/evm";
import { FakeEvmNode } from "./fakeEvmNode";
import { buildFlows } from "./flows";
import { fakeMoneroAddress } from "./helpers";

const XMR = fakeMoneroAddress(18, 6);
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("new deposit coins through the engine", () => {
  it("BNB -> XMR is paid from XMR inventory and the BNB deposit is swept", async () => {
    const t = buildFlows();
    const { o, plan } = await t.order("BNB", "XMR", 4n * 10n ** 17n, XMR, PLACEHOLDER_ADDRESS.BSC); // 0.4 BNB = $200
    expect(plan.kind).toBe("inventory");
    t.mock("BNB").simulateDeposit(o.deposit_address, 4n * 10n ** 17n);
    await t.run(3);
    expect(t.db.getOrder(o.id)!.status).toBe("completed");
    expect(t.mock("BNB").sent.some((s) => s.from.kind === "deposit" && s.amount === "all")).toBe(true);
  });

  it("LTC -> BTC via DEX: the Litecoin network fee is charged in LTC", async () => {
    const t = buildFlows();
    const amount = 250_000_000n; // 2.5 LTC = $200
    const { o, plan } = await t.order("LTC", "BTC", amount, PLACEHOLDER_ADDRESS.BTC, PLACEHOLDER_ADDRESS.LTC);
    expect(plan.kind).toBe("dex");
    expect(plan.forwardFee).toBe(2_000n);
    t.mock("LTC").simulateDeposit(o.deposit_address, amount);
    await t.run(2);
    expect(t.db.getOrder(o.id)!.status).toBe("dex_pending");
    const fwd = t.mock("LTC").sent.find((s) => s.to === "near-deposit-address")!;
    expect(fwd.amount).toBe(amount - amount / 200n - 2_000n);
  });

  it("TRX -> ETH and SOL -> XRP (receive-only coin) both forward to the DEX", async () => {
    const t = buildFlows();
    const trx = await t.order("TRX", "ETH", 800_000_000n, PLACEHOLDER_ADDRESS.ETH, PLACEHOLDER_ADDRESS.TRON); // 800 TRX
    const sol = await t.order("SOL", "XRP", 2_000_000_000n, PLACEHOLDER_ADDRESS.XRP, PLACEHOLDER_ADDRESS.SOL); // 2 SOL
    expect(trx.plan.forwardFee).toBe(1_450_000n);
    expect(sol.plan.forwardFee).toBe(10_000n);
    t.mock("TRX").simulateDeposit(trx.o.deposit_address, 800_000_000n);
    t.mock("SOL").simulateDeposit(sol.o.deposit_address, 2_000_000_000n);
    await t.run(2);
    expect(t.db.getOrder(trx.o.id)!.status).toBe("dex_pending");
    expect(t.db.getOrder(sol.o.id)!.status).toBe("dex_pending");
  });
});

describe("per-order slippage", () => {
  it("refunds when the rate falls further than the user's tolerance, executes when within it", async () => {
    const t = buildFlows();
    const amount = 250_000_000n;
    const tight = await t.order("LTC", "BTC", amount, PLACEHOLDER_ADDRESS.BTC, PLACEHOLDER_ADDRESS.LTC, 50); // 0.5%
    const loose = await t.order("LTC", "BTC", amount, PLACEHOLDER_ADDRESS.BTC, PLACEHOLDER_ADDRESS.LTC, 300); // 3%
    t.dex.rate *= 0.99; // market moves 1% against the user
    t.mock("LTC").simulateDeposit(tight.o.deposit_address, amount);
    t.mock("LTC").simulateDeposit(loose.o.deposit_address, amount);
    await t.run(3);
    expect(t.db.getOrder(tight.o.id)!).toMatchObject({ status: "refunded", error: "rate moved beyond tolerance" });
    expect(t.db.getOrder(loose.o.id)!).toMatchObject({ status: "completed", error: null }); // mock DEX settles next tick
    expect(t.mock("LTC").sent.filter((s) => s.to === "near-deposit-address")).toHaveLength(1);
  });

  it("orders created before per-order slippage keep the operator's tolerance", async () => {
    const t = buildFlows();
    const { o } = await t.order("LTC", "BTC", 250_000_000n, PLACEHOLDER_ADDRESS.BTC, PLACEHOLDER_ADDRESS.LTC);
    t.db.transition(o.id, "awaiting_deposit", { max_drift_bps: null });
    t.dex.rate *= 1 - (t.cfg.MAX_RATE_DRIFT_BPS + 50) / 10_000;
    t.mock("LTC").simulateDeposit(o.deposit_address, 250_000_000n);
    await t.run(3);
    expect(t.db.getOrder(o.id)!.error).toBe("rate moved beyond tolerance");
  });
});

describe("EvmWallet for native BNB on BNB Smart Chain", () => {
  it("reports deposits and fees in BNB and sweeps the deposit minus gas", async () => {
    const node = new FakeEvmNode("0x0000000000000000000000000000000000000000", 56);
    const rpc = new EvmRpc("BSC", "mainnet", undefined, custom({ request: (a) => node.request(a as any) }));
    const w = new EvmWallet("BNB", new EvmKeys(MNEMONIC), rpc, 1);
    expect(w.chain).toBe("BSC");
    const dep = (await w.depositAddress(9)).address;
    node.set(node.eth, dep, 3n * 10n ** 17n);
    expect(await w.getDeposit(dep)).toMatchObject({ seen: 3n * 10n ** 17n, confirmed: 3n * 10n ** 17n });
    expect((await w.estimateSendFee(false)).asset).toBe("BNB");
    const dest = "0x1111111111111111111111111111111111111111";
    const r = await w.send({ from: { kind: "deposit", index: 9 }, to: dest, amount: "all" });
    expect(r.amount).toBe(3n * 10n ** 17n - r.fee);
    expect(node.sent).toHaveLength(1);
    expect(node.sent[0]).toMatchObject({ from: dep.toLowerCase(), to: dest, value: r.amount });
  });
});
