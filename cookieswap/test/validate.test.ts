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

describe("new stablecoin networks", () => {
  it("validates Tron addresses (base58check, 0x41 prefix)", () => {
    expect(isValidAddress("TRON", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", "mainnet")).toBe(true); // USDT contract
    expect(isValidAddress("TRON", PLACEHOLDER_ADDRESS.TRON, "mainnet")).toBe(true);
    expect(isValidAddress("TRON", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u", "mainnet")).toBe(false); // checksum
    expect(isValidAddress("TRON", PLACEHOLDER_ADDRESS.ETH, "mainnet")).toBe(false);
  });
  it("uses EVM validation on BSC, Polygon, Base and Arbitrum", () => {
    for (const chain of ["BSC", "POL", "BASE", "ARB"] as const) {
      expect(isValidAddress(chain, PLACEHOLDER_ADDRESS.ETH, "mainnet")).toBe(true);
      expect(isValidAddress(chain, PLACEHOLDER_ADDRESS.TRON, "mainnet")).toBe(false);
    }
  });
  it("lists 11 depositable stablecoins and hides gas-only assets", () => {
    const stables = Object.values(ASSETS).filter((a) => a.stable && a.depositable);
    expect(stables.map((a) => a.id).sort()).toEqual([
      "DAI-ETH", "USDC-ARB", "USDC-BASE", "USDC-ETH", "USDC-POL", "USDC-SOL",
      "USDT-BSC", "USDT-ETH", "USDT-POL", "USDT-SOL", "USDT-TRON",
    ]);
    expect(ASSETS.POL.listed).toBe(false);
  });
});

describe("top-20 coins", () => {
  it("lists every top-20 coin and ranks them uniquely", () => {
    const top = ["BTC", "ETH", "USDT", "BNB", "USDC", "XRP", "SOL", "TRX", "ZEC", "DOGE",
      "XMR", "LINK", "ADA", "XLM", "DAI", "BCH", "LTC", "UNI", "AVAX", "SUI"];
    const listed = new Set(Object.values(ASSETS).filter((a) => a.listed).map((a) => a.symbol));
    expect(top.filter((s) => !listed.has(s))).toEqual([]);
    const ranks = Object.values(ASSETS).filter((a) => a.rank !== undefined && !a.stable).map((a) => a.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("can deposit BNB, AVAX, LINK, UNI, TRX, SOL and LTC; the rest is receive-only", () => {
    for (const id of ["BNB", "AVAX", "LINK", "UNI", "TRX", "SOL", "LTC"] as const) expect(ASSETS[id].depositable).toBe(true);
    for (const id of ["XRP", "DOGE", "ADA", "XLM", "BCH", "SUI", "ZEC"] as const) expect(ASSETS[id].depositable).toBe(false);
  });

  it("marks memo/tag chains so the UI can warn about exchange deposit addresses", () => {
    expect(ASSETS.XRP.memoWarning).toBe(true);
    expect(ASSETS.XLM.memoWarning).toBe(true);
    expect(ASSETS.BTC.memoWarning).toBeFalsy();
  });

  it("validates receive addresses for the new chains and rejects cross-chain mix-ups", () => {
    const valid: [keyof typeof ASSETS, string][] = [
      ["XRP", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"],
      ["LTC", "ltc1qqyqszqgpqyqszqgpqyqszqgpqyqszqgpq4933p"],
      ["BCH", "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a"],
      ["BCH", "qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a"],
      ["ADA", "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x"],
      ["XLM", "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ"],
      ["SUI", "0x" + "ab".repeat(32)],
      ["AVAX", "0x52908400098527886E0F7030069857D2E4169EE7"],
    ];
    for (const [id, a] of valid) expect(isValidAddress(ASSETS[id].chain, a, "mainnet"), `${id} ${a}`).toBe(true);
    for (const id of ["XRP", "DOGE", "LTC", "BCH", "ADA", "XLM", "SUI"] as const) {
      expect(isValidAddress(id, PLACEHOLDER_ADDRESS[id], "mainnet"), id).toBe(true);
    }
    const invalid: [keyof typeof ASSETS, string][] = [
      ["XRP", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi"], // checksum
      ["BCH", "1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu"], // a BTC address is not a BCH address
      ["BCH", "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b"],
      ["LTC", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"], // BTC bech32
      ["DOGE", "1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu"],
      ["XLM", "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGA"],
      ["ADA", "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3y"],
      ["SUI", "0x1234"],
    ];
    for (const [id, a] of invalid) expect(isValidAddress(ASSETS[id].chain, a, "mainnet"), `${id} ${a}`).toBe(false);
  });
});

describe("config safety", () => {
  it("refuses the public dev admin token on real chains, but allows it with mock chains", async () => {
    const { loadConfig, DEV_ADMIN_TOKEN } = await import("../src/config");
    expect(() => loadConfig({ CHAINS: "live", MNEMONIC: "x", ADMIN_TOKEN: DEV_ADMIN_TOKEN } as NodeJS.ProcessEnv)).toThrow(/public dev token/);
    expect(loadConfig({ CHAINS: "mock", ADMIN_TOKEN: DEV_ADMIN_TOKEN } as NodeJS.ProcessEnv).ADMIN_TOKEN).toBe(DEV_ADMIN_TOKEN);
  });

  it("treats blank settings (KEY=) as not set, so .env.example loads", async () => {
    const { loadConfig } = await import("../src/config");
    const c = loadConfig({ CHAINS: "mock", TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", ALERT_WEBHOOK_URL: "", ADMIN_TOKEN: "", THORCHAIN_VERIFY_API_URL: "" } as NodeJS.ProcessEnv);
    expect(c.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(c.ADMIN_TOKEN).toBeUndefined();
    expect(c.THORCHAIN_VERIFY_API_URL).toBe("https://thornode.ninerealms.com"); // blank never switches a check off
  });

  it("refuses a recovery phrase with a typo instead of opening a different, empty wallet", async () => {
    const { loadConfig } = await import("../src/config");
    const base = { CHAINS: "live", ADMIN_TOKEN: "a".repeat(32), ALERT_WEBHOOK_URL: "https://hooks.example.com/x" };
    expect(loadConfig({ ...base, MNEMONIC: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" } as NodeJS.ProcessEnv).mnemonic).toContain("about");
    expect(() => loadConfig({ ...base, MNEMONIC: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abuot" } as NodeJS.ProcessEnv))
      .toThrow(/not a valid BIP39 phrase/);
  });
});
