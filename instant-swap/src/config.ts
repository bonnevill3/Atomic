import { readFileSync } from "node:fs";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default("127.0.0.1"),
  DB_PATH: z.string().default("./data/instant-swap.db"),

  /** mainnet: real chains + DEX routes. testnet: BTC testnet4 / Sepolia / XMR stagenet, inventory routes only. */
  NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
  /** mock: in-memory chains for development (no funds, simulated deposits). live: real chain wallets. */
  CHAINS: z.enum(["mock", "live"]).default("mock"),
  /** When true, nothing is ever broadcast: sends are logged and return a fake txid. */
  DRY_RUN: bool.default(true),

  /** BIP39 mnemonic for the BTC and EVM hot wallets. Prefer MNEMONIC_FILE. */
  MNEMONIC: z.string().optional(),
  MNEMONIC_FILE: z.string().optional(),

  BTC_ESPLORA_URL: z.string().optional(),
  BTC_CONFIRMATIONS: z.coerce.number().int().min(0).default(2),
  ETH_RPC_URL: z.string().optional(),
  ETH_CONFIRMATIONS: z.coerce.number().int().min(0).default(12),
  /** monero-wallet-rpc started with --disable-rpc-login, reachable only on localhost / a private network. */
  XMR_WALLET_RPC_URL: z.string().default("http://127.0.0.1:18083/json_rpc"),
  XMR_CONFIRMATIONS: z.coerce.number().int().min(1).default(10),

  THORCHAIN_API_URL: z.string().default("https://gateway.liquify.com/chain/thorchain_api"),
  NEAR_1CLICK_URL: z.string().default("https://1click.chaindefuser.com"),
  /** Optional 1Click JWT (lower fees / higher limits). */
  NEAR_1CLICK_JWT: z.string().optional(),
  ENABLE_THORCHAIN: bool.default(true),
  ENABLE_NEAR: bool.default(true),
  ENABLE_INVENTORY: bool.default(true),

  /** Service fee taken from every deposit, in basis points (100 = 1%). */
  SERVICE_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(50),
  /** Extra spread on inventory (XMR) legs on top of the oracle mid price. */
  INVENTORY_SPREAD_BPS: z.coerce.number().int().min(0).max(1000).default(100),
  /** Slippage tolerance passed to the DEX. */
  SLIPPAGE_BPS: z.coerce.number().int().min(1).max(1000).default(100),
  /** If the re-quote at execution is worse than the order quote by more than this, refund instead. */
  MAX_RATE_DRIFT_BPS: z.coerce.number().int().min(0).max(2000).default(200),
  /** Refuse inventory quotes when price sources disagree by more than this. */
  MAX_ORACLE_DEVIATION_BPS: z.coerce.number().int().min(0).max(2000).default(150),

  ORDER_TTL_MINUTES: z.coerce.number().int().min(5).default(60),
  MIN_ORDER_USD: z.coerce.number().default(20),
  MAX_ORDER_USD: z.coerce.number().default(5000),
  /** Completed/refunded/expired orders are deleted after this many days (privacy). */
  RETENTION_DAYS: z.coerce.number().int().min(0).default(7),
  ENGINE_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(10),

  /** Bearer token for /admin endpoints. Admin API is disabled when unset. */
  ADMIN_TOKEN: z.string().min(24).optional(),
});

export type Config = z.infer<typeof schema> & { mnemonic?: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const cfg: Config = { ...parsed.data };
  if (cfg.MNEMONIC_FILE) cfg.mnemonic = readFileSync(cfg.MNEMONIC_FILE, "utf8").trim();
  else if (cfg.MNEMONIC) cfg.mnemonic = cfg.MNEMONIC.trim();

  if (cfg.CHAINS === "live" && !cfg.mnemonic) {
    throw new Error("CHAINS=live requires MNEMONIC_FILE (or MNEMONIC)");
  }
  if (cfg.CHAINS === "live" && !cfg.DRY_RUN && cfg.NETWORK === "mainnet" && !cfg.ADMIN_TOKEN) {
    throw new Error("Refusing to run live on mainnet without ADMIN_TOKEN (needed for refunds/review)");
  }
  return cfg;
}
