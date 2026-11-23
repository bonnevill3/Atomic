# cookieswap

**cookieswap** is a **custodial instant swap** in the style of wagyu.xyz, but without relaying orders to ChangeNOW or a similar exchange API. Routes run **through DEXes** (THORChain, NEAR Intents), and an **XMR inventory leg** fills the gap where no DEX supports Monero.

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

### Stablecoin deposits: 11 networks
I picked the networks by circulating supply (DefiLlama, 23 Nov 2026), keeping only those a DEX route supports:

| Stable | Networks (deposit + payout) | Left out |
|---|---|---|
| **USDT** | Tron (TRC-20), Ethereum (ERC-20), BSC (BEP-20, **18 decimals**), Solana (SPL), Polygon | Arbitrum-USDT (#5 by supply): neither NEAR Intents nor THORChain supports it |
| **USDC** | Ethereum, Solana, Base, Arbitrum, Polygon | Hyperliquid L1 (#3): needs a HyperCore wallet |
| **DAI** | Ethereum | Polygon/BSC/Arbitrum/OP: no DEX route, and together under 12% of DAI supply |

| Network | Wallet | How a deposit is forwarded | Gas paid by |
|---|---|---|---|
| Ethereum, BSC, Polygon, Base, Arbitrum | `Erc20Wallet` (one key tree; addresses never reused across chains) | gas top-up from inventory → wait for receipt → `transfer` | inventory ETH / BNB / POL / ETH / ETH |
| Tron | `TronWallet` (BIP44 coin 195) | TRX top-up for energy → `transfer` (tx **built and signed locally**, see below) | inventory TRX (≈15 TRX worst case per forward) |
| Solana | `SplWallet` (SLIP-0010, Phantom paths) | transfer from the deposit's token account; the **inventory account is fee payer**, so no top-up | inventory SOL |

- **Network fee:** quoted in the gas coin and charged to the user in token units at the oracle price. The UI shows it as a separate "Network fee" line.
- **UI:** the dropdowns show the network ("USDT · TRC20"), the deposit screen warns that other networks cannot be recovered, and the QR code follows the network's payment format (EIP-681 with chain id, Solana Pay, plain Tron address).
- **Routes:** stable → BTC/ETH/SOL/ZEC/other stables via NEAR Intents, stable → XMR from inventory. THORChain is only used for stable *payouts*, because token deposits there need `approve` + router, which is not built.
- **Tron transactions are built locally:** the API node only supplies chain data and relays. A compromised node therefore can't change the recipient or amount behind our back. The encoding is checked byte for byte against transactions built by TronGrid (see `test/fixtures/tron-golden.json`).
- **Minimum for Tron USDT:** NEAR Intents currently requires **$100**. With fee and Tron gas, a USDT-TRON order to a DEX route needs about **$106**. Smaller orders get a clear error. Stable → XMR (inventory) has no such minimum.

### Safety net: manual review above $500
When a deposit is confirmed and has passed screening, cookieswap values it in USD (oracle price at that moment).
If it is worth **more than `MANUAL_REVIEW_USD` (default $500)**:
- The order goes to `awaiting_approval`, and **nothing is sent** until an operator acts.
- The UI warns about this on the quote, and the user sees "manual review" as the status.
- `POST /admin/orders/:id/approve` releases the order. It is still re-quoted and rate-checked, so a late approval after a big price move becomes a refund.
- `POST /admin/orders/:id/refund` refunds it instead.
- If the deposit changes after approval (e.g. the user sends more), the approval is void and the order goes back to review.
- If the price oracle is unavailable, the order is held. It is never waved through.

### Why the XMR leg uses inventory
These are the decentralized XMR venues as of 23 Nov 2026:

| Venue | XMR status |
|---|---|
| THORChain | XMR announced in v3.20 (Aug 2026), but the live network (v3.21.5, 44 pools) has **no XMR pool** |
| NEAR Intents | no XMR among its 232 tokens |
| Hyperliquid XMR1 | Wagyu's wrapped XMR, **collapsed** after the 20 Nov 2026 hack |
| eigenwallet makers | atomic swaps, BTC → XMR only, 30–60 min |

So XMR is paid from your own inventory, priced from an oracle: the median of Kraken and CoinGecko. Quotes are refused if the two sources disagree. The THORChain provider **switches XMR on automatically** once an `XMR.XMR` pool is `Available`. Until then, rebalance inventory by hand or through the eigenwallet fork in this repo (see [Next steps](#next-steps)).

### Routes with a live quote (re-checked 23 Nov 2026)
These are **quotes**, run with mock chains and dry-run. Nothing has been sent on mainnet.

| From \ To | BTC | ETH | XMR | SOL | ZEC | stables |
|---|---|---|---|---|---|---|
| **BTC** | | near | inventory | near | near | near (all 11) |
| **ETH** | near | | inventory | near | near (alt: thorchain) | thorchain/near |
| **XMR** | inventory | inventory | | inventory → near | inventory → near | inventory → thorchain/near |
| **10 stables** (all except USDT-TRON), $100 | near | near | inventory | near | near | near |
| **USDT-TRON**, $150 | near | near | inventory | near | near | near |

Notes:
- **51 of 55** stable-deposit pairs quoted at $100. The 4 misses were USDT-TRON → BTC/ETH/SOL/ZEC, which is NEAR's $100 minimum. At $150 those work too.
- THORChain had **BTC and BASE halted** at the time of the check.
- THORChain has **no XMR pool**, and NEAR Intents does not list XMR, so all XMR legs use inventory.

Deposits are possible in **BTC, ETH, XMR and the 11 stablecoins**. SOL and ZEC are payout-only (the DEX pays the user).

## Quick start (development, no funds)
```bash
cd cookieswap
npm install
ADMIN_TOKEN=dev-admin-token-0123456789abcdef npm run dev   # CHAINS=mock, DRY_RUN=true by default
# open http://127.0.0.1:8080, create a swap, open "Developer: simulate deposit"
npm test            # 67 tests: engine, review gate, stablecoin flows, BTC/ERC-20/Tron/Solana wallets
npm run typecheck
npm run smoke       # read-only check of the live BTC/ETH/Solana backends (throwaway key)
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
| `src/chains/evm.ts` | Shared RPC + HD accounts via viem; THORChain memo goes in tx `data` |
| `src/chains/erc20.ts` | ERC-20 on Ethereum/BSC/Polygon/Base/Arbitrum: `balanceOf` deposits, native gas top-up, `transfer` |
| `src/chains/tron.ts`, `tronTx.ts` | TRC-20 via TronGrid; local protobuf tx encoding + secp256k1 signing; TRX top-up for energy |
| `src/chains/solana.ts` | SPL on `@solana/kit` + `@solana-program/token`; SLIP-0010 keys; inventory pays fees and recipient token-account rent |
| `src/chains/xmr.ts` | `monero-wallet-rpc`: a subaddress per order, inventory = subaddress 0 |
| `src/chains/mock.ts` | Mock chains and the `DryRunWallet` decorator |
| `src/screening.ts` | Screening hook (denylist; plug in a sanctions/analytics provider) |
| `src/db.ts` | SQLite with compare-and-set status transitions and retention purge |
| `public/` | Plain HTML/CSS/JS UI: no build step, no third-party scripts |

### Order lifecycle
```
awaiting_deposit → confirming → executing → completed                      (inventory)
                   confirming → awaiting_approval → approved → executing …  (> MANUAL_REVIEW_USD)
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
| `GET /admin/orders[?status=awaiting_approval]`, `GET /admin/inventory` | overview, review queue |
| `POST /admin/orders/:id/approve` | release an order above the review threshold |
| `POST /admin/orders/:id/refund` | refund (awaiting / confirming / awaiting_approval / needs_review / expired) |
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
4. **Fund inventory** and set `MAX_ORDER_USD` below your float:
   - XMR, plus BTC/ETH for XMR → BTC/ETH payouts
   - **gas on every stablecoin network's inventory address**, for top-ups and fees:
     - ETH on Ethereum, Base and Arbitrum
     - BNB on BSC
     - POL on Polygon
     - TRX on Tron (≈15 TRX per USDT forward; consider staking or renting energy)
     - SOL on Solana

     Without it, those orders go to `needs_review`. `GET /admin/inventory` shows the gas balances.
   - stables collected from stable → XMR orders pile up on the ETH inventory address. Sell or rebalance them regularly.
5. **Dry run on live chains.** Use `CHAINS=live DRY_RUN=true` and check the logs for what *would* be broadcast.
6. **Small live amounts.** Set `DRY_RUN=false` with `MAX_ORDER_USD` small. Do every route at least once, plus a refund.
7. **Monitor.** Watch the `awaiting_approval` and `needs_review` queues, inventory levels and DEX halts (THORChain halts chains regularly). Large orders sit still until someone approves them.

## Security
Lessons taken from Wagyu's incidents (see `../plan/05-wagyu-analysis.md`):
- **No single key controls a wrapped asset.** This service issues no token. Keys only control your own hot wallets, so keep balances small.
- **No IP logging, minimal data.** The Fastify logger is off, orders are hard-deleted after `RETENTION_DAYS`, and the order token is stored as a hash only.
- **Nothing executes on unconfirmed deposits.** Confirmations are configurable per chain:
  - BTC 2, ETH 12, XMR 10
  - BSC 15, Polygon 64, Base 30, Arbitrum 60
  - Tron: solidified blocks; Solana: `finalized` commitment
- **Prices.** The oracle deviation guard blocks quotes when price sources disagree. If every source fails, the price is dropped rather than served stale, and orders wait.
- **USDC and USDT can be frozen by their issuers** (Circle / Tether blacklist addresses). Your hot wallet holds them while an order runs and as inventory, so keep stable balances low and sweep often.
- **Gas top-ups wait for a receipt** (up to 3 min). The engine processes orders one by one, so a slow top-up delays other orders. Fine for a prototype; use a worker queue for volume.
- **Dependencies.** `npm audit --omit=dev` reports **0 vulnerabilities**. Solana moved from `@solana/web3.js` v1, which had 9 findings, to `@solana/kit` 8.6.
  A signed transfer was simulated on mainnet with signature verification on; it only failed on the unfunded throwaway fee payer.
- **Tron.** Transactions are built and signed locally (the node cannot alter them). Tron confirmations use solidified blocks (`/walletsolidity`).
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
- **Cheaper Tron forwards.** Stake TRX for energy, or rent it, instead of burning ~15 TRX per USDT forward.
- **Remaining networks.** Arbitrum-USDT and Hyperliquid-USDC, once a DEX route or wallet type exists.
- **THORChain for token deposits.** Add `approve` + `router.depositWithExpiry`, so stable deposits can also use THORChain pools.
- **More deposit coins.** SOL and ZEC deposit wallets, Lightning.
- **Affiliate fees.** THORChain affiliate memo and 1Click `appFees`, instead of deducting the fee before forwarding.
