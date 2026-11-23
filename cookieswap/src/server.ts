import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { ASSETS, type Asset, getAsset, isEvmChain, isValidAddress, keyFamily, NETWORK_CODE, tokenContract } from "./assets";
import { MockWallet } from "./chains/mock";
import type { Wallets } from "./chains/types";
import type { Config } from "./config";
import type { Db, OrderRow, OrderStatus } from "./db";
import { log } from "./log";
import { fromAtomic, toAtomic } from "./money";
import { OracleError } from "./oracle";
import { usdValue } from "./money";
import { QuoteError } from "./providers/types";
import type { PriceOracle } from "./oracle";
import type { RoutePlan, Router } from "./router";

const sha256 = (s: string) => createHash("sha256").update(s).digest();

const quoteBody = z.object({
  from: z.string(),
  to: z.string(),
  amount: z.string().max(40),
  recipient: z.string().max(256).optional(),
});
const orderBody = quoteBody.extend({
  recipient: z.string().min(1).max(256),
  refundAddress: z.string().min(1).max(256),
});

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function asset(id: string): Asset {
  const a = getAsset(id);
  if (!a || !a.listed) throw new ApiError(400, `unknown asset ${id}`);
  return a;
}

function quoteView(p: RoutePlan, manualReview: boolean) {
  const rate = Number(fromAtomic(p.amountOut, p.to)) / Number(fromAtomic(p.amountIn, p.from));
  return {
    manualReview,
    route: p.label,
    kind: p.kind,
    amountIn: fromAtomic(p.amountIn, p.from),
    amountOut: fromAtomic(p.amountOut, p.to),
    minAmountOut: fromAtomic(p.minAmountOut, p.to),
    serviceFee: fromAtomic(p.serviceFee, p.from),
    networkFee: fromAtomic(p.forwardFee, p.from),
    rate,
    etaSeconds: p.etaSeconds,
  };
}

/** What the user may see about their order. No internal refs, no other users' data. */
function orderView(o: OrderRow) {
  const from = getAsset(o.from_asset)!;
  const to = getAsset(o.to_asset)!;
  const fmt = (v: string | null, a: Asset) => (v === null ? null : fromAtomic(BigInt(v), a));
  const publicStatus: Record<OrderStatus, string> = {
    awaiting_deposit: "awaiting_deposit", confirming: "confirming", awaiting_approval: "manual_review",
    approved: "processing", executing: "processing",
    dex_pending: "processing", completed: "completed", refund_pending: "refunding", refunding: "refunding",
    refunded: "refunded", expired: "expired", needs_review: "under_review",
  };
  return {
    id: o.id,
    status: publicStatus[o.status],
    from: from.id,
    fromNetwork: from.network,
    to: to.id,
    toNetwork: to.network,
    depositAddress: o.deposit_address,
    depositAmount: fmt(o.amount_in, from),
    received: fmt(o.received_amount, from),
    quotedOut: fmt(o.quoted_out, to),
    amountOut: fmt(o.amount_out, to),
    recipient: o.recipient,
    route: o.provider,
    payoutTxid: o.payout_txid,
    refundTxid: o.refund_txid,
    expiresAt: o.expires_at,
    createdAt: o.created_at,
  };
}

const EVM_CHAIN_ID: Record<string, number> = { ETH: 1, BSC: 56, POL: 137, BASE: 8453, ARB: 42161 };

export async function buildServer(cfg: Config, db: Db, router: Router, wallets: Wallets, oracle: PriceOracle): Promise<FastifyInstance> {
  // Logger off on purpose: no request logs, no IP addresses stored anywhere.
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 16 * 1024 });

  await app.register(fastifyRateLimit, { global: true, max: 120, timeWindow: "1 minute" });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
  });
  await app.register(fastifyStatic, { root: fileURLToPath(new URL("../public", import.meta.url)), prefix: "/" });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof QuoteError || err instanceof OracleError) return reply.status(422).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "invalid request" });
    if ((err as { statusCode?: number }).statusCode === 429) return reply.status(429).send({ error: "too many requests" });
    log.error("unhandled api error", { err: String(err) });
    return reply.status(500).send({ error: "internal error" });
  });

  app.get("/api/health", async () => ({
    ok: true, network: cfg.NETWORK, chains: cfg.CHAINS, dryRun: cfg.DRY_RUN, manualReviewUsd: cfg.MANUAL_REVIEW_USD,
  }));

  /** Indicative only: the binding check runs on the confirmed deposit in the engine. */
  const needsReview = async (amountIn: bigint, from: Asset) =>
    usdValue(amountIn, from, (await oracle.price(from)).usd) > cfg.MANUAL_REVIEW_USD;

  app.get("/api/assets", async () =>
    Object.values(ASSETS).filter((a) => a.listed).map((a) => ({
      id: a.id, symbol: a.symbol, name: a.name, network: a.network, chain: a.chain, decimals: a.decimals,
      token: tokenContract(a, cfg.NETWORK) ?? null,
      code: a.contracts ? NETWORK_CODE[a.chain] : null,
      canSend: a.depositable && !!wallets[a.id], canReceive: true,
    })),
  );

  app.post("/api/quote", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const b = quoteBody.parse(req.body);
    const from = asset(b.from);
    const to = asset(b.to);
    let amountIn: bigint;
    try {
      amountIn = toAtomic(b.amount, from);
    } catch (e) {
      throw new ApiError(400, (e as Error).message);
    }
    const recipient = b.recipient && isValidAddress(to.chain, b.recipient, cfg.NETWORK) ? b.recipient : undefined;
    const plans = await router.plan({ from, to, amountIn, recipient, dry: true });
    const review = await needsReview(amountIn, from);
    return { best: quoteView(plans[0], review), alternatives: plans.slice(1).map((p) => quoteView(p, review)) };
  });

  app.post("/api/orders", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const b = orderBody.parse(req.body);
    const from = asset(b.from);
    const to = asset(b.to);
    if (!isValidAddress(to.chain, b.recipient, cfg.NETWORK)) throw new ApiError(400, `invalid ${to.symbol} receive address`);
    if (!isValidAddress(from.chain, b.refundAddress, cfg.NETWORK)) throw new ApiError(400, `invalid ${from.symbol} refund address`);
    let amountIn: bigint;
    try {
      amountIn = toAtomic(b.amount, from);
    } catch (e) {
      throw new ApiError(400, (e as Error).message);
    }
    // Indicative quote with the real recipient (lets the DEX validate the address too).
    const plan = await router.best({ from, to, amountIn, recipient: b.recipient, dry: true });

    const wallet = wallets[from.id]!;
    // Chains on the same key tree (all EVM chains) share one index counter, so no address is reused.
    const dep = await wallet.depositAddress(db.allocateIndex(keyFamily(from.chain)));
    const token = randomBytes(24).toString("base64url");
    const order = db.insertOrder({
      id: randomBytes(12).toString("hex"),
      token_hash: sha256(token).toString("hex"),
      from_asset: from.id,
      to_asset: to.id,
      amount_in: amountIn.toString(),
      quoted_out: plan.amountOut.toString(),
      route_kind: plan.kind,
      provider: plan.label,
      recipient: b.recipient,
      refund_address: b.refundAddress,
      deposit_chain: from.chain,
      deposit_address: dep.address,
      deposit_index: dep.index,
      expires_at: Date.now() + cfg.ORDER_TTL_MINUTES * 60_000,
    });
    return { token, order: orderView(order), quote: quoteView(plan, await needsReview(amountIn, from)) };
  });

  const authorizedOrder = (req: FastifyRequest<{ Params: { id: string } }>): OrderRow => {
    const token = (req.headers["x-order-token"] as string | undefined) ?? (req.query as { token?: string }).token;
    const o = db.getOrder(req.params.id);
    if (!o || !token) throw new ApiError(404, "order not found");
    const a = Buffer.from(o.token_hash, "hex");
    if (!timingSafeEqual(a, sha256(token))) throw new ApiError(404, "order not found");
    return o;
  };

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (req) => orderView(authorizedOrder(req)));

  app.get<{ Params: { id: string } }>("/api/orders/:id/qr.svg", async (req, reply) => {
    const o = authorizedOrder(req);
    const from = getAsset(o.from_asset)!;
    const amount = fromAtomic(BigInt(o.amount_in), from);
    const token = tokenContract(from, cfg.NETWORK);
    const uri =
      token && isEvmChain(from.chain) // EIP-681 token transfer with chain id
        ? `ethereum:${token}@${EVM_CHAIN_ID[from.chain]}/transfer?address=${o.deposit_address}&uint256=${o.amount_in}`
      : token && from.chain === "SOL" ? `solana:${o.deposit_address}?amount=${amount}&spl-token=${token}` // Solana Pay
      : from.chain === "TRON" ? o.deposit_address // Tron wallets scan the plain address
      : from.chain === "XMR" ? `monero:${o.deposit_address}?tx_amount=${amount}`
      : from.chain === "BTC" ? `bitcoin:${o.deposit_address}?amount=${amount}`
      : `ethereum:${o.deposit_address}@${EVM_CHAIN_ID[from.chain]}`;
    const svg = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return reply.type("image/svg+xml").send(svg);
  });

  // ---- admin ---------------------------------------------------------------------------
  if (cfg.ADMIN_TOKEN) {
    const adminHash = sha256(cfg.ADMIN_TOKEN);
    const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
      const h = req.headers.authorization ?? "";
      const given = h.startsWith("Bearer ") ? sha256(h.slice(7)) : Buffer.alloc(32);
      if (!timingSafeEqual(given, adminHash)) return reply.status(401).send({ error: "unauthorized" });
    };

    app.register(async (admin) => {
      admin.addHook("onRequest", requireAdmin);

      admin.get<{ Querystring: { status?: string } }>("/admin/orders", async (req) => {
        const rows = db.listOrders(500);
        return req.query.status ? rows.filter((r) => r.status === req.query.status) : rows;
      });

      /** Safety net: release a large order for execution (it is still re-quoted and rate-checked). */
      admin.post<{ Params: { id: string } }>("/admin/orders/:id/approve", async (req) => {
        const o = db.getOrder(req.params.id);
        if (!o || o.status !== "awaiting_approval") throw new ApiError(409, "only awaiting_approval orders can be approved");
        db.transition(o.id, "awaiting_approval", { status: "approved", error: null });
        log.info("order approved by operator", { order: o.id });
        return orderView(db.getOrder(o.id)!);
      });

      admin.get("/admin/inventory", async () => {
        const out: Record<string, string> = {};
        for (const [id, w] of Object.entries(wallets)) {
          out[id] = fromAtomic(await w!.inventoryBalance(), getAsset(id)!);
          if (w!.gasBalance) {
            const gas = await w!.gasBalance();
            out[`${id} gas`] = `${fromAtomic(gas.amount, getAsset(gas.asset)!)} ${gas.asset}`;
          }
        }
        return out;
      });

      /** Force a refund (from awaiting/confirming/needs_review). Verify on-chain state first for needs_review. */
      admin.post<{ Params: { id: string } }>("/admin/orders/:id/refund", async (req) => {
        const o = db.getOrder(req.params.id);
        if (!o) throw new ApiError(404, "order not found");
        if (!["awaiting_deposit", "confirming", "awaiting_approval", "needs_review", "expired"].includes(o.status)) {
          throw new ApiError(409, `cannot refund from ${o.status}`);
        }
        db.transition(o.id, o.status, { status: "refund_pending", error: "manual refund" });
        return orderView(db.getOrder(o.id)!);
      });

      /** Re-run execution for a needs_review order. Only after confirming nothing was broadcast. */
      admin.post<{ Params: { id: string } }>("/admin/orders/:id/retry", async (req) => {
        const o = db.getOrder(req.params.id);
        if (!o || o.status !== "needs_review") throw new ApiError(409, "only needs_review orders can be retried");
        db.transition(o.id, "needs_review", { status: "confirming", error: null });
        return orderView(db.getOrder(o.id)!);
      });

      /** Record a manual resolution (e.g. paid or refunded by hand). */
      admin.post<{ Params: { id: string }; Body: { status: "completed" | "refunded"; txid: string } }>(
        "/admin/orders/:id/resolve",
        async (req) => {
          const b = z.object({ status: z.enum(["completed", "refunded"]), txid: z.string().min(1) }).parse(req.body);
          const o = db.getOrder(req.params.id);
          if (!o || o.status !== "needs_review") throw new ApiError(409, "only needs_review orders can be resolved");
          db.transition(o.id, "needs_review", b.status === "completed" ? { status: "completed", payout_txid: b.txid } : { status: "refunded", refund_txid: b.txid });
          return orderView(db.getOrder(o.id)!);
        },
      );

      if (cfg.CHAINS === "mock") {
        /** Development only: simulate the user's deposit for an order. */
        admin.post<{ Body: { orderId: string; amount?: string; confirmed?: boolean } }>("/admin/mock/deposit", async (req) => {
          const b = z.object({ orderId: z.string(), amount: z.string().optional(), confirmed: z.boolean().optional() }).parse(req.body);
          const o = db.getOrder(b.orderId);
          if (!o) throw new ApiError(404, "order not found");
          const w = wallets[o.from_asset];
          if (!(w instanceof MockWallet)) throw new ApiError(400, "not a mock wallet");
          const amount = b.amount ? toAtomic(b.amount, getAsset(o.from_asset)!) : BigInt(o.amount_in);
          const txid = w.simulateDeposit(o.deposit_address, amount, b.confirmed ?? true);
          return { txid };
        });
      }
    });
  }

  return app;
}
