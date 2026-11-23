import { keccak256 } from "viem";
import { ASSETS, type AssetId } from "../src/assets";
import { MockWallet } from "../src/chains/mock";
import type { Wallets } from "../src/chains/types";
import { type Config, loadConfig } from "../src/config";
import { Db } from "../src/db";
import { PriceOracle, type PriceSource } from "../src/oracle";
import type { DexProvider, DexQuote, DexQuoteInput, DexRef, DexStatus } from "../src/providers/types";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const FULL = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function moneroBase58Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8) {
    const block = bytes.slice(i, i + 8);
    let num = 0n;
    for (const b of block) num = (num << 8n) | BigInt(b);
    let s = "";
    for (let j = 0; j < FULL[block.length]; j++) {
      s = ALPHABET[Number(num % 58n)] + s;
      num /= 58n;
    }
    out += s;
  }
  return out;
}

/** Format-valid Monero address with arbitrary key bytes (for tests only). */
export function fakeMoneroAddress(prefix = 18, fill = 7): string {
  const body = Uint8Array.from([prefix, ...new Array(64).fill(fill)]);
  const sum = keccak256(body, "bytes").slice(0, 4);
  return moneroBase58Encode(Uint8Array.from([...body, ...sum]));
}

export function staticSource(prices: Partial<Record<AssetId, number>>): PriceSource & { prices: typeof prices } {
  return { prices, usd: async () => ({ ...prices }) };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    CHAINS: "mock", DB_PATH: ":memory:", ENGINE_INTERVAL_SECONDS: "1", SERVICE_FEE_BPS: "50",
    INVENTORY_SPREAD_BPS: "100", MAX_RATE_DRIFT_BPS: "200", ...overrides,
  } as NodeJS.ProcessEnv);
}

export function setup(prices: Partial<Record<AssetId, number>> = { BTC: 60000, ETH: 2000, XMR: 500, SOL: 100, USDC: 1, ZEC: 50 }) {
  const cfg = testConfig();
  const db = new Db(":memory:");
  const source = staticSource(prices);
  const oracle = new PriceOracle(Object.values(ASSETS), cfg.MAX_ORACLE_DEVIATION_BPS, [source], 0);
  const wallets = {
    BTC: new MockWallet("BTC", 100_000_000n, 1_000n),
    ETH: new MockWallet("ETH", 10n * 10n ** 18n, 10n ** 15n),
    XMR: new MockWallet("XMR", 100n * 10n ** 12n, 10n ** 8n),
  } satisfies Wallets;
  return { cfg, db, oracle, source, wallets };
}

/** Scriptable DEX: quotes at a fixed rate, status controlled by the test. */
export class FakeDex implements DexProvider {
  readonly name = "near" as const;
  status_: DexStatus = { state: "pending" };
  quotes: DexQuoteInput[] = [];

  constructor(private rate: number) {}

  async supports() {
    return true;
  }

  async quote(input: DexQuoteInput): Promise<DexQuote> {
    this.quotes.push(input);
    const inUnits = Number(input.amountIn) / 10 ** input.from.decimals;
    const out = BigInt(Math.floor(inUnits * this.rate * 10 ** input.to.decimals));
    return {
      provider: "near", amountIn: input.amountIn, amountOut: out, minAmountOut: (out * 99n) / 100n, etaSeconds: 60,
      depositAddress: "near-deposit-address", expiry: Math.floor(Date.now() / 1000) + 1800,
    };
  }

  async status(_ref: DexRef): Promise<DexStatus> {
    return this.status_;
  }
}
