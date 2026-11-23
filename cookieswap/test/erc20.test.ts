import { custom } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { Erc20Wallet } from "../src/chains/erc20";
import { EvmKeys, EvmRpc } from "../src/chains/evm";
import { FakeEvmNode } from "./fakeEvmNode";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DEX = "0x1111111111111111111111111111111111111111";

describe.each([
  { chain: "ETH" as const, chainId: 1, token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", asset: "USDC-ETH" as const, gas: "ETH" as const },
  { chain: "BSC" as const, chainId: 56, token: "0x55d398326f99059ff775485246999027b3197955", asset: "USDT-BSC" as const, gas: "BNB" as const },
  { chain: "BASE" as const, chainId: 8453, token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", asset: "USDC-BASE" as const, gas: "ETH" as const },
])("Erc20Wallet on $chain", ({ chain, chainId, token, asset, gas }) => {
  let node: FakeEvmNode;
  let w: Erc20Wallet;
  let dep: string;
  let inv: string;

  beforeEach(async () => {
    node = new FakeEvmNode(token, chainId);
    const rpc = new EvmRpc(chain, "mainnet", undefined, custom({ request: (a) => node.request(a as any) }));
    w = new Erc20Wallet(asset, token, new EvmKeys(MNEMONIC), rpc, 1, gas);
    dep = (await w.depositAddress(5)).address.toLowerCase();
    inv = (await w.inventoryAddress()).toLowerCase();
    node.set(node.tok, dep, 250_000_000n);
    node.set(node.eth, inv, 10n ** 18n);
  });

  it("reports the fee in the chain's gas asset and detects deposits", async () => {
    const fee = await w.estimateSendFee(false);
    expect(fee.asset).toBe(gas);
    expect(fee.amount).toBeGreaterThan(0n);
    expect(await w.getDeposit(dep)).toMatchObject({ seen: 250_000_000n, confirmed: 250_000_000n });
  });

  it("tops up gas from inventory, then forwards the tokens", async () => {
    const r = await w.send({ from: { kind: "deposit", index: 5 }, to: DEX, amount: 249_000_000n });
    expect(node.sent).toHaveLength(2);
    expect(node.sent[0]).toMatchObject({ from: inv, to: dep });
    expect(node.sent[0].value).toBeGreaterThan(0n);
    expect(node.sent[1]).toMatchObject({ from: dep, to: token });
    expect(node.get(node.tok, DEX)).toBe(249_000_000n);
    expect(node.get(node.tok, dep)).toBe(1_000_000n);
    expect(r.amount).toBe(249_000_000n);
    expect((node.receipts.get(r.txid) as { status: string }).status).toBe("0x1");
  });

  it("skips the top-up when the deposit address already has gas, and sweeps 'all'", async () => {
    node.set(node.eth, dep, 10n ** 16n);
    await w.send({ from: { kind: "deposit", index: 5 }, to: inv, amount: "all" });
    expect(node.sent).toHaveLength(1);
    expect(node.sent[0].from).toBe(dep);
    expect(node.get(node.tok, dep)).toBe(0n);
  });

  it("refuses over-balance sends before broadcasting anything", async () => {
    await expect(w.send({ from: { kind: "deposit", index: 5 }, to: DEX, amount: 300_000_000n })).rejects.toThrow(/insufficient/);
    expect(node.sent).toHaveLength(0);
  });

  it("propagates a failed top-up (no gas in inventory) and leaves the tokens", async () => {
    node.set(node.eth, inv, 0n);
    await expect(w.send({ from: { kind: "deposit", index: 5 }, to: DEX, amount: 1_000_000n })).rejects.toThrow(/insufficient funds/);
    expect(node.get(node.tok, dep)).toBe(250_000_000n);
  });

  it("refuses memo transfers (THORChain router not supported)", async () => {
    await expect(w.send({ from: { kind: "deposit", index: 5 }, to: DEX, amount: 1n, memo: "=:BTC.BTC:x" })).rejects.toThrow(/THORChain router/);
  });
});
