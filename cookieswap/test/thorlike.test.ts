import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSETS, PLACEHOLDER_ADDRESS } from "../src/assets";
import { MAYA, ThorchainProvider } from "../src/providers/thorchain";

/** Fake mayanode: answers only under /mayachain/, like the real node. */
let server: Server;
let base = "";
const seen: string[] = [];
let statusBody: unknown = { stages: { inbound_observed: { started: false, completed: false } } };

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    seen.push(url.pathname + url.search);
    const json = (x: unknown) => res.end(JSON.stringify(x));
    if (url.pathname === "/mayachain/pools") {
      return json([
        { asset: "BTC.BTC", status: "Available" },
        { asset: "ETH.ETH", status: "Available" },
        { asset: "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48", status: "Available" },
        { asset: "ARB.USDC-0XAF88D065E77C8CC2239327C5EDB3A432268E5831", status: "Staged" },
        { asset: "ZEC.ZEC", status: "Available" },
      ]);
    }
    if (url.pathname === "/mayachain/inbound_addresses") {
      return json([
        { chain: "BTC", halted: false, chain_trading_paused: false },
        { chain: "ETH", halted: false, chain_trading_paused: false },
        { chain: "ZEC", halted: true, chain_trading_paused: true },
      ]);
    }
    if (url.pathname === "/mayachain/quote/swap") {
      return json({
        inbound_address: "bc1qmayavault", memo: `=:e:${url.searchParams.get("destination")}:1/1/0`, expiry: 2_000_000_000,
        expected_amount_out: "35000000", recommended_min_amount_in: "2672",
        inbound_confirmation_seconds: 600, total_swap_seconds: 30, outbound_delay_seconds: 0,
      });
    }
    if (url.pathname.startsWith("/mayachain/tx/status/")) return json(statusBody);
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("Maya provider (THORChain-family API)", () => {
  const maya = () => new ThorchainProvider(base, 100, MAYA);

  it("is named maya and deposits with a memo", () => {
    expect(maya().name).toBe("maya");
    expect(maya().usesMemo).toBe(true);
  });

  it("supports native BTC/ETH pairs, but not halted chains, staged pools, token deposits or XMR", async () => {
    const p = maya();
    expect(await p.supports(ASSETS.BTC, ASSETS.ETH)).toBe(true);
    expect(await p.supports(ASSETS.ETH, ASSETS["USDC-ETH"])).toBe(true); // stable payout is fine
    expect(await p.supports(ASSETS["USDC-ETH"], ASSETS.BTC)).toBe(false); // token deposit needs the router
    expect(await p.supports(ASSETS.BTC, ASSETS.ZEC)).toBe(false); // ZEC chain halted
    expect(await p.supports(ASSETS.BTC, ASSETS["USDC-ARB"])).toBe(false); // pool staged
    expect(await p.supports(ASSETS.XMR, ASSETS.BTC)).toBe(false);
    expect(await p.supports(ASSETS.BTC, ASSETS["USDT-TRON"])).toBe(false); // no Maya id
  });

  it("quotes via /mayachain/ with Maya asset ids, rescales and returns deposit instructions", async () => {
    const q = await maya().quote({
      from: ASSETS.BTC, to: ASSETS.ETH, amountIn: 1_000_000n, recipient: PLACEHOLDER_ADDRESS.ETH, refundTo: PLACEHOLDER_ADDRESS.BTC, dry: false,
    });
    const req = seen.find((u) => u.startsWith("/mayachain/quote/swap"))!;
    expect(req).toContain("from_asset=BTC.BTC");
    expect(req).toContain("to_asset=ETH.ETH");
    expect(req).toContain("liquidity_tolerance_bps=100");
    // refunds go back to the sender (our address); an explicit refund address would overflow BTC's 80-byte OP_RETURN
    expect(req).not.toContain("refund_address");
    expect(q.provider).toBe("maya");
    expect(q.amountOut).toBe(35_000_000n * 10n ** 10n); // 0.35 ETH, 8 -> 18 decimals
    expect(q.minAmountOut).toBe((q.amountOut * 9900n) / 10000n);
    expect(q.depositAddress).toBe("bc1qmayavault");
    expect(q.memo).toContain(PLACEHOLDER_ADDRESS.ETH);
    expect(q.etaSeconds).toBe(630);
  });

  it("rejects amounts below Maya's recommended minimum", async () => {
    await expect(maya().quote({
      from: ASSETS.BTC, to: ASSETS.ETH, amountIn: 2_000n, recipient: PLACEHOLDER_ADDRESS.ETH, refundTo: PLACEHOLDER_ADDRESS.BTC, dry: true,
    })).rejects.toThrow(/maya: amount below recommended minimum/);
  });

  it("reads status: unknown tx (200 without out_txs) = pending, REFUND = refunded, outbound = completed", async () => {
    const ref = { provider: "maya" as const, txid: "0xabc" };
    statusBody = { stages: { inbound_observed: { started: false, completed: false } } };
    expect(await maya().status(ref)).toEqual({ state: "pending" });
    statusBody = { out_txs: [{ id: "R1", memo: "REFUND:ABC" }], stages: { outbound_signed: { completed: true } } };
    expect((await maya().status(ref)).state).toBe("refunded");
    statusBody = { out_txs: [{ id: "OUT1", memo: "OUT:ABC" }], stages: { outbound_signed: { completed: true } } };
    expect(await maya().status(ref)).toEqual({ state: "completed", payoutTxid: "OUT1" });
    expect(seen.some((u) => u === "/mayachain/tx/status/ABC")).toBe(true);
  });
});
