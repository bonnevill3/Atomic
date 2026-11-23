import { describe, expect, it } from "vitest";
import { ASSETS, isValidAddress, PLACEHOLDER_ADDRESS } from "../src/assets";
import { convertByPrice, rescale, toAtomic } from "../src/money";
import { parseMoneroAddress } from "../src/validate/monero";
import { fakeMoneroAddress } from "./helpers";

// Public donation address published in the eigenwallet README (a real mainnet address).
const REAL_XMR = "4A1tNBcsxhQA7NkswREXTD1QGz8mRyA7fGnCzPyTwqzKdDFMNje7iHUbGhCetfVUZa1PTuZCoPKj8gnJuRrFYJ2R2CEzqbJ";

describe("monero address validation", () => {
  it("accepts a real mainnet address", () => {
    expect(parseMoneroAddress(REAL_XMR, "mainnet")).toEqual({ kind: "standard" });
  });
  it("rejects a single changed character (checksum)", () => {
    const bad = REAL_XMR.slice(0, 50) + (REAL_XMR[50] === "a" ? "b" : "a") + REAL_XMR.slice(51);
    expect(parseMoneroAddress(bad, "mainnet")).toBeNull();
  });
  it("rejects the wrong network", () => {
    expect(parseMoneroAddress(REAL_XMR, "stagenet")).toBeNull();
  });
  it("recognises subaddresses and stagenet", () => {
    expect(parseMoneroAddress(fakeMoneroAddress(42), "mainnet")).toEqual({ kind: "subaddress" });
    expect(parseMoneroAddress(fakeMoneroAddress(24), "stagenet")).toEqual({ kind: "standard" });
  });
});

describe("address validation per chain", () => {
  it("validates placeholders and rejects garbage", () => {
    for (const chain of ["BTC", "ETH", "SOL", "ZEC"] as const) {
      expect(isValidAddress(chain, PLACEHOLDER_ADDRESS[chain], "mainnet")).toBe(true);
      expect(isValidAddress(chain, "not-an-address", "mainnet")).toBe(false);
    }
  });
  it("rejects testnet BTC on mainnet and whitespace", () => {
    expect(isValidAddress("BTC", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "mainnet")).toBe(false);
    expect(isValidAddress("ETH", ` ${PLACEHOLDER_ADDRESS.ETH}`, "mainnet")).toBe(false);
  });
  it("refuses Zcash TEX addresses", () => {
    expect(isValidAddress("ZEC", "tex1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "mainnet")).toBe(false);
  });
});

describe("money", () => {
  it("parses decimals strictly", () => {
    expect(toAtomic("0.5", ASSETS.BTC)).toBe(50_000_000n);
    expect(() => toAtomic("0.123456789", ASSETS.BTC)).toThrow();
    expect(() => toAtomic("1e3", ASSETS.BTC)).toThrow();
  });
  it("converts by price across decimals", () => {
    // 1 BTC at $60k into XMR at $500 = 120 XMR (12 decimals)
    expect(convertByPrice(100_000_000n, ASSETS.BTC, 60_000, ASSETS.XMR, 500)).toBe(120n * 10n ** 12n);
    expect(rescale(10n ** 18n, 18, 8)).toBe(10n ** 8n);
  });
});
