import { readFileSync } from "node:fs";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default("127.0.0.1"),
  DB_PATH: z.string().default("./data/cookieswap.db"),

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
  /** Other EVM chains for stablecoin deposits (defaults: publicnode.com RPCs). */
  BSC_RPC_URL: z.string().optional(),
  BSC_CONFIRMATIONS: z.coerce.number().int().min(0).default(15),
  POL_RPC_URL: z.string().optional(),
  POL_CONFIRMATIONS: z.coerce.number().int().min(0).default(64),
  BASE_RPC_URL: z.string().optional(),
  BASE_CONFIRMATIONS: z.coerce.number().int().min(0).default(30),
  ARB_RPC_URL: z.string().optional(),
  ARB_CONFIRMATIONS: z.coerce.number().int().min(0).default(60),
  AVAX_RPC_URL: z.string().optional(),
  AVAX_CONFIRMATIONS: z.coerce.number().int().min(0).default(5),
  /** Litecoin: mempool/Esplora-compatible API. */
  LTC_ESPLORA_URL: z.string().default("https://litecoinspace.org/api"),
  LTC_CONFIRMATIONS: z.coerce.number().int().min(0).default(6),
  /** Tron (TRC-20). Confirmed = solidified by the network (~1 min). */
  TRON_API_URL: z.string().default("https://api.trongrid.io"),
  TRONGRID_API_KEY: z.string().optional(),
  /** Solana (SPL). Confirmed = "finalized" commitment. */
  SOLANA_RPC_URL: z.string().default("https://api.mainnet-beta.solana.com"),
  /** monero-wallet-rpc started with --disable-rpc-login, reachable only on localhost / a private network. */
  XMR_WALLET_RPC_URL: z.string().default("http://127.0.0.1:18083/json_rpc"),
  XMR_CONFIRMATIONS: z.coerce.number().int().min(1).default(10),

  THORCHAIN_API_URL: z.string().default("https://gateway.liquify.com/chain/thorchain_api"),
  NEAR_1CLICK_URL: z.string().default("https://1click.chaindefuser.com"),
  /** Optional 1Click JWT (lower fees / higher limits). */
  NEAR_1CLICK_JWT: z.string().optional(),
  /** Maya Protocol: THORChain fork with the same API (native BTC, ETH, ARB, ZEC, USDC/USDT). */
  MAYA_API_URL: z.string().default("https://mayanode.mayachain.info"),
  ENABLE_THORCHAIN: bool.default(true),
  ENABLE_MAYA: bool.default(true),
  ENABLE_NEAR: bool.default(true),
  ENABLE_INVENTORY: bool.default(true),

  /** Our fee on every swap, taken from the deposit, in basis points (100 = 1%). */
  SERVICE_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(100),
  /** Our fee when the user receives a stablecoin (USDT/USDC/DAI) instead of SERVICE_FEE_BPS. */
  STABLE_PAYOUT_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(200),
  /** Our fee when the user sends (sells) XMR instead of SERVICE_FEE_BPS. Rates don't stack: the highest applies. */
  XMR_SELL_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(200),
  /**
   * Optional extra spread on inventory (XMR) legs on top of the oracle mid price. Default 0, so the
   * advertised fee is the whole markup; it is shown separately in quotes when set.
   */
  INVENTORY_SPREAD_BPS: z.coerce.number().int().min(0).max(1000).default(0),
  /** Slippage tolerance passed to the DEX. */
  SLIPPAGE_BPS: z.coerce.number().int().min(1).max(1000).default(100),
  /** If the re-quote at execution is worse than the order quote by more than this, refund instead. */
  MAX_RATE_DRIFT_BPS: z.coerce.number().int().min(0).max(2000).default(200),
  /** Refuse inventory quotes when price sources disagree by more than this. */
  MAX_ORACLE_DEVIATION_BPS: z.coerce.number().int().min(0).max(2000).default(150),

  ORDER_TTL_MINUTES: z.coerce.number().int().min(5).default(60),
  MIN_ORDER_USD: z.coerce.number().default(20),
  /**
   * Orders worth more than this (USD, at deposit confirmation) wait for the operator, who gets an alert.
   * Internal only: customers just see "processing".
   */
  MANUAL_REVIEW_USD: z.coerce.number().min(0).default(1000),
  MAX_ORDER_USD: z.coerce.number().default(5000),
  /** Completed/refunded/expired orders are deleted after this many days (privacy). */
  RETENTION_DAYS: z.coerce.number().int().min(0).default(7),
  ENGINE_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(10),

  /** Bearer token for /admin endpoints. Admin API is disabled when unset. */
  ADMIN_TOKEN: z.string().min(24).optional(),

  /** Private operator alerts (large orders, orders that need review). Telegram and/or a webhook. */
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  TELEGRAM_API_URL: z.string().default("https://api.telegram.org"),
  /** POSTs JSON {"text", "content"}: works with Slack and Discord incoming webhooks. */
  ALERT_WEBHOOK_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof schema> & { mnemonic?: string };

/** The admin token printed in the README for local testing. It is public, so it is refused on real chains. */
export const DEV_ADMIN_TOKEN = "dev-admin-token-0123456789abcdef";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const cfg: Config = { ...parsed.data };
  if (cfg.MNEMONIC_FILE) cfg.mnemonic = readFileSync(cfg.MNEMONIC_FILE, "utf8").trim();
  else if (cfg.MNEMONIC) cfg.mnemonic = cfg.MNEMONIC.trim();

  if (cfg.CHAINS === "live" && cfg.ADMIN_TOKEN === DEV_ADMIN_TOKEN) {
    throw new Error("ADMIN_TOKEN is the public dev token from the README; generate your own, e.g. `openssl rand -hex 32`");
  }
  if (cfg.CHAINS === "live" && !cfg.mnemonic) {
    throw new Error("CHAINS=live requires MNEMONIC_FILE (or MNEMONIC)");
  }
  if (!!cfg.TELEGRAM_BOT_TOKEN !== !!cfg.TELEGRAM_CHAT_ID) {
    throw new Error("Telegram alerts need both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  }
  if (cfg.CHAINS === "live" && !cfg.TELEGRAM_BOT_TOKEN && !cfg.ALERT_WEBHOOK_URL) {
    throw new Error(
      "CHAINS=live requires an alert channel (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or ALERT_WEBHOOK_URL): " +
        `orders above $${cfg.MANUAL_REVIEW_USD} wait for you and you must be told about them`,
    );
  }
  if (cfg.CHAINS === "live" && !cfg.DRY_RUN && cfg.NETWORK === "mainnet" && !cfg.ADMIN_TOKEN) {
    throw new Error("Refusing to run live on mainnet without ADMIN_TOKEN (needed for refunds/review)");
  }
  return cfg;
}
