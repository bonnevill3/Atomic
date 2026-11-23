import { ASSETS } from "./assets";
import { createWallets } from "./chains";
import { loadConfig } from "./config";
import { Db } from "./db";
import { Engine } from "./engine";
import { log } from "./log";
import { PriceOracle } from "./oracle";
import { NearIntentsProvider } from "./providers/nearIntents";
import { ThorchainProvider } from "./providers/thorchain";
import type { DexName, DexProvider } from "./providers/types";
import { Router } from "./router";
import { DenylistScreening } from "./screening";
import { buildServer } from "./server";

async function main() {
  const cfg = loadConfig();
  const db = new Db(cfg.DB_PATH);
  const wallets = createWallets(cfg);
  const oracle = new PriceOracle(Object.values(ASSETS), cfg.MAX_ORACLE_DEVIATION_BPS);

  // DEX routes only exist on mainnet (THORChain / NEAR Intents have no public testnet).
  const dexes: Partial<Record<DexName, DexProvider>> = {};
  if (cfg.NETWORK === "mainnet" && cfg.ENABLE_THORCHAIN) dexes.thorchain = new ThorchainProvider(cfg.THORCHAIN_API_URL, cfg.SLIPPAGE_BPS);
  if (cfg.NETWORK === "mainnet" && cfg.ENABLE_NEAR) dexes.near = new NearIntentsProvider(cfg.NEAR_1CLICK_URL, cfg.SLIPPAGE_BPS, cfg.NEAR_1CLICK_JWT);

  const router = new Router(cfg, oracle, Object.values(dexes), wallets);
  const engine = new Engine(cfg, db, router, wallets, dexes, new DenylistScreening(process.env.DENYLIST_FILE));
  const app = await buildServer(cfg, db, router, wallets);

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  engine.start();
  log.info("instant-swap started", {
    url: `http://${cfg.HOST}:${cfg.PORT}`, network: cfg.NETWORK, chains: cfg.CHAINS, dryRun: cfg.DRY_RUN,
    dexes: Object.keys(dexes), admin: !!cfg.ADMIN_TOKEN,
  });
  if (cfg.CHAINS === "live" && !cfg.DRY_RUN) log.warn("LIVE MODE: real funds will be moved");

  const shutdown = async () => {
    engine.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error("fatal", { err: String(e instanceof Error ? e.message : e) });
  process.exit(1);
});
