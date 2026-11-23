# instant-swap

A **custodial instant swap** in the style of wagyu.xyz, but without relaying orders to ChangeNOW or a similar exchange API. Routes run **through DEXes** (THORChain, NEAR Intents), and an **XMR inventory leg** fills the gap where no DEX supports Monero.

> **Status: prototype.** Tested with mock chains, live DEX quotes, and live read-only chain access. Nothing has been broadcast on mainnet yet.
>
> This service is **custodial**: users send funds to addresses you control. Read [Security](#security) and [Legal](#legal) before running it for anyone else.

## How a swap works

```
user ──▶ one-time deposit address (our hot wallet, per order)
              │  confirmations → screening → fresh re-quote (rate-drift guard)
              ▼
   ┌────────────────────┬──────────────────────────────┬──────────────────────────┐
   │ dex                │ inventory                    │ inventory_dex            │
   │ BTC/ETH → non-XMR  │ anything ⇄ XMR (BTC/ETH)     │ XMR → SOL/USDC/ZEC/…     │
   │ deposit forwarded  │ we pay out from our own      │ XMR stays with us, our   │
   │ to THORChain vault │ inventory at oracle price    │ ETH inventory goes into  │
   │ (memo) or 1Click   │ − spread                     │ a DEX that pays the user │
   │ deposit address    │                              │                          │
   └─────────┬──────────┴───────────────┬──────────────┴────────────┬─────────────┘
             ▼                          ▼                           ▼
     DEX pays the user directly   payout tx from inventory    DEX pays the user
```

The router asks every route for a quote and picks the one with the **highest output**.

### Why the XMR leg uses inventory
These are the decentralized XMR venues as of 23 Nov 2026:

| Venue | XMR status |
|---|---|
| THORChain | XMR announced in v3.20 (Aug 2026), but the live network (v3.21.5, 44 pools) has **no XMR pool** |
| NEAR Intents | no XMR among its 232 tokens |
| Hyperliquid XMR1 | Wagyu's wrapped XMR, **collapsed** after the 20 Nov 2026 hack |
| eigenwallet makers | atomic swaps, BTC → XMR only, 30–60 min |

So XMR is paid from your own inventory, priced from an oracle: the median of Kraken and CoinGecko. Quotes are refused if the two sources disagree. The THORChain provider **switches XMR on automatically** once an `XMR.XMR` pool is `Available`. Until then, rebalance inventory by hand or through the eigenwallet fork in this repo (see [Next steps](#next-steps)).

### Live quote check (23 Nov 2026, mock chains)
| Pair | Route picked |
|---|---|
| BTC → XMR, XMR → BTC, XMR → ETH | inventory |
| ETH → USDC | thorchain |
| ETH → BTC, BTC → ETH, ETH → SOL, BTC → ZEC | near (THORChain BTC trading was halted at the time) |
| XMR → SOL, XMR → USDC | inventory → near |

## Quick start (development, no funds)
```bash
cd instant-swap
npm install
ADMIN_TOKEN=dev-admin-token-0123456789abcdef npm run dev   # CHAINS=mock, DRY_RUN=true by default
# open http://127.0.0.1:8080, create a swap, open "Developer: simulate deposit"
npm test            # unit + engine + BTC transaction tests
npm run typecheck
npm run smoke       # read-only check of the live BTC/ETH backends (throwaway key)
```
Mock mode uses **live DEX quotes and live prices** but simulated deposits and sends.
For real configs copy `.env.example` to `.env` and run `npm start`.

## Architecture
| File | Role |
|---|---|
| `src/server.ts` | Fastify API and static UI. Logger off and no IPs stored. Rate limits, CSP, per-order secret token. |
| `src/router.ts` | Quotes every route, applies service fee/spread/limits, picks the best one |
| `src/providers/thorchain.ts` | Pools/halts, `quote/swap` (inbound address + memo), `tx/status` |
| `src/providers/nearIntents.ts` | 1Click `quote` (deposit address), `deposit/submit`, `status` |
| `src/oracle.ts` | Median USD price (Kraken, CoinGecko) with a deviation guard |
| `src/engine.ts` | Order state machine, see below |
| `src/chains/btc.ts` | BIP84 HD deposit addresses, Esplora, PSBT signing (vault, OP_RETURN memo, change) |
| `src/chains/evm.ts` | HD accounts via viem; THORChain memo goes in tx `data` |
| `src/chains/xmr.ts` | `monero-wallet-rpc`: a subaddress per order, inventory = subaddress 0 |
| `src/chains/mock.ts` | Mock chains and the `DryRunWallet` decorator |
| `src/screening.ts` | Screening hook (denylist; plug in a sanctions/analytics provider) |
| `src/db.ts` | SQLite with compare-and-set status transitions and retention purge |
| `public/` | Plain HTML/CSS/JS UI: no build step, no third-party scripts |

### Order lifecycle
```
awaiting_deposit → confirming → executing → completed                      (inventory)
                              → executing → dex_pending → completed        (dex)
                                                       ↘ refund_pending → refunding → refunded
awaiting_deposit → expired
any send interrupted by a crash → needs_review   (never re-sent automatically)
```
- **Write-ahead:** the status moves to `executing`/`refunding` *before* any broadcast. If the process dies mid-send, the order goes to `needs_review` instead of risking a double payout.
- **Rate-drift guard:** the route is re-quoted when the deposit confirms. If the user would get more than `MAX_RATE_DRIFT_BPS` less than quoted, the order is refunded.
- **Refunds:** DEXes are told to refund to the order's own deposit address, so a refund is always "sweep the deposit address → the user's refund address".
- **After completion:** whatever is left on the deposit address is consolidated into inventory.

### Admin API (`Authorization: Bearer $ADMIN_TOKEN`)
| Endpoint | Purpose |
|---|---|
| `GET /admin/orders`, `GET /admin/inventory` | overview |
| `POST /admin/orders/:id/refund` | refund (awaiting / confirming / needs_review / expired) |
| `POST /admin/orders/:id/retry` | re-execute a `needs_review` order. **Only** after verifying nothing was broadcast. |
| `POST /admin/orders/:id/resolve` `{status, txid}` | record a manual payout or refund |
| `POST /admin/mock/deposit` `{orderId}` | mock mode only |

## Going live (checklist)
1. **Separate machine.** Run the hot wallet host on its own machine, behind Tor/HTTPS. Expose only the web port, never wallet-rpc.
2. **Hot wallet keys.**
   - Generate a fresh mnemonic and keep it in `MNEMONIC_FILE` (`chmod 600`).
   - Keep only working float on it and sweep profits to cold storage regularly.
   - Never reuse the mnemonic of a cold wallet.
3. **monero-wallet-rpc.** Start it with `--disable-rpc-login --rpc-bind-ip 127.0.0.1` against your own `monerod`. Fund subaddress 0 as XMR inventory.
4. **Fund inventory** (XMR, plus BTC/ETH for XMR → BTC/ETH payouts) and set `MAX_ORDER_USD` below your float.
5. **Dry run on live chains.** Use `CHAINS=live DRY_RUN=true` and check the logs for what *would* be broadcast.
6. **Small live amounts.** Set `DRY_RUN=false` with `MAX_ORDER_USD` small. Do every route at least once, plus a refund.
7. **Monitor.** Watch the `needs_review` queue, inventory levels and DEX halts (THORChain halts chains regularly).

## Security
Lessons taken from Wagyu's incidents (see `../plan/05-wagyu-analysis.md`):
- **No single key controls a wrapped asset.** This service issues no token. Keys only control your own hot wallets, so keep balances small.
- **No IP logging, minimal data.** The Fastify logger is off, orders are hard-deleted after `RETENTION_DAYS`, and the order token is stored as a hash only.
- **Nothing executes on unconfirmed deposits.** Confirmations are configurable per chain (BTC 2, ETH 12, XMR 10).
- **Prices.** The oracle deviation guard blocks quotes when price sources disagree.
- **Defaults are safe.** `DRY_RUN=true` and `CHAINS=mock` are the defaults. Live mainnet refuses to start without `ADMIN_TOKEN`.
- **Still to add for production:**
  - an HSM or a separate signer process (keys are currently in the app process)
  - alerting
  - a real screening provider
  - backups of the DB (it contains in-flight orders)
  - a reorg policy for ETH (use the `finalized` tag)

## Legal
You **hold customer funds**, so this is a crypto-asset service. In the EU/NL that means:
- a **MiCA CASP licence**, plus AML/KYC obligations (Wwft)
- under the EU AML Regulation (2024/1624), regulated providers may **not handle anonymity-enhancing coins such as XMR from July 2027**

Running this for the public without a licence is not legal there. Get legal advice for your jurisdiction before going live.

## Next steps
- **XMR rebalancing via atomic swaps.** Add the fork's taker (BTC → XMR from eigenwallet makers) as a route, and run an `asb` to sell surplus XMR. This needs a headless taker API in the Rust fork.
- **THORChain XMR as input.** Monero deposits to THORChain need the memo in `tx_extra`, which `monero-wallet-rpc` cannot set. A custom signer is needed.
- **More chains and tokens.** ERC-20 deposits (approve/router flow, gas top-ups), SOL and ZEC deposit wallets, Lightning.
- **Affiliate fees.** THORChain affiliate memo and 1Click `appFees`, instead of deducting the fee before forwarding.
