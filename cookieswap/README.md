# cookieswap

**cookieswap** is a **custodial instant swap** in the style of wagyu.xyz, but without relaying orders to ChangeNOW or a similar exchange API. Routes run **through DEXes**: THORChain, Maya Protocol and NEAR Intents, with the best quote winning per order. An **XMR inventory leg** fills the gap where no DEX supports Monero.

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
   │ to THORChain/Maya  │ inventory at oracle price    │ ETH inventory goes into  │
   │ vault (memo) or    │ (+ optional spread)          │ a DEX that pays the user │
   │ 1Click address     │                              │                          │
   │ deposit address    │                              │                          │
   └─────────┬──────────┴───────────────┬──────────────┴────────────┬─────────────┘
             ▼                          ▼                           ▼
     DEX pays the user directly   payout tx from inventory    DEX pays the user
```

The router asks every route for a quote and picks the one with the **highest output**.

### Fees
| What | Default | Config |
|---|---|---|
| Every swap | **1%** of the deposit | `SERVICE_FEE_BPS=100` |
| Swaps where the user **receives a stablecoin** (USDT/USDC/DAI, incl. stable → stable) | **2%** | `STABLE_PAYOUT_FEE_BPS=200` |
| Swaps where the user **buys XMR** (receives Monero) | **2%** | `XMR_BUY_FEE_BPS=200` |
| Swaps where the user **sells XMR** (sends Monero) | **2%** | `XMR_SELL_FEE_BPS=200` |
| Extra spread on XMR inventory legs | **0%**, so the fee above is the whole markup | `INVENTORY_SPREAD_BPS` |
| Network fee | the gas to forward the deposit, at cost | shown separately in every quote |

- The fee is taken from the deposit before routing.
- The rates don't stack: XMR → USDT costs 2%, not 4%.
- DEX costs (pool fees, solver spread) are part of the DEX quote, so they're already in the rate.
- If you set an inventory spread, the quote shows it next to the fee ("Our fee (1% + 0.5% spread)"). It is never hidden.

### The swap page
cookieswap has its own look (warm dark theme with a light-mode variant); the UX patterns follow modern swap apps such as wagyu.xyz. Plain HTML/CSS/JS, no build step, strict CSP (`'self'` only, no external fonts, images or scripts).
- **Swap card:** "You send" / "You receive" panels with large amounts, USD values (from `GET /api/prices`), a value-difference hint, and a flip button (refuses receive-only coins).
- **Token picker:** searchable modal (name, symbol or network), popular-token chips, ranking by market cap, network badges, USD prices, "Receive only" tags; a bottom sheet on phones.
- **Slippage settings** (gear icon): Auto (`MAX_RATE_DRIFT_BPS`), 0.5%, 1%, 3% or custom 0.1–5%. The choice is sent with the quote and stored on the order (`max_drift_bps`), and the engine refunds if the fresh rate at execution is worse than that.
- **Transaction details** (collapsible): rate (tap to invert), our fee, network fee, slippage, **minimum received** (= DEX limit minus your slippage), route ("best of N"), estimated time. Quotes refresh every 30 s (progress ring).
- **Connect wallet (optional):** EVM wallets via EIP-6963 (falls back to `window.ethereum`). Fills in addresses, shows balances with **Max** (keeps gas back), switches networks, and on the order screen **sends the deposit** in one click (native transfer or ERC-20 `transfer`). It never asks for signatures or approvals; non-EVM deposits work as before (address + QR).
- **Order screen:** stepper (Deposit → Confirming → Swapping → Done), exact amount and address with copy buttons, QR in the network's payment format, live expiry countdown, status pill, recent swaps kept in this browser.
- **Warnings:** XRP and XLM payouts warn not to use exchange addresses that need a destination tag/memo (we can't attach one); token deposits warn about the network.
- Responsive down to 320 px, hover/press micro-animations, honours `prefers-reduced-motion`.
- **FAQ section**, filled from `GET /api/info` so it always matches the running config:
  - how it works, what it costs (fee table), how long it takes (per network, from the confirmation settings)
  - limits, what happens when something goes wrong
  - custody, stated plainly: we hold the deposit during the swap
  - what data is stored, supported networks, and which exchanges are compared

### Coins: the top 20
The 20 largest coins by market cap (CoinPaprika, 23 Nov 2026) that a DEX route can deliver. Wrapped/staked derivatives (WBTC, stETH, …) are left out, and HYPE, LEO, WBT, USDS and USDe have no route on THORChain, Maya or NEAR Intents, so the next coins move up.

| | Coins |
|---|---|
| **Send and receive** | BTC, ETH, XMR, USDT, USDC, DAI, **BNB, SOL, TRX, AVAX, LTC, LINK, UNI** |
| **Receive only** (no deposit wallet yet) | **XRP, DOGE, ADA, XLM, BCH, SUI**, ZEC |

- **New deposit wallets:** native BNB (BSC) and AVAX (C-Chain) use the EVM wallet on their chain; LINK and UNI are ERC-20s with gas top-ups; TRX is a native Tron transfer (signed locally); SOL is a system transfer with the inventory as fee payer; LTC uses the Bitcoin wallet with BIP84 coin type 2 and a mempool.space-style API (litecoinspace.org).
- Native deposits pay their own network fee, charged in the quote. They can't use memo routes (THORChain/Maya) from Tron or Solana; those orders go through NEAR Intents.
- **Address checks** (format and checksum, no network lookups): XRP (ripple base58check), DOGE, LTC (bech32/base58), BCH (CashAddr; legacy `1…` is refused to avoid BTC mix-ups), ADA (Shelley `addr1…`), XLM (StrKey with CRC16), SUI. Cross-checked against the reference libraries.

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

### Large orders: held for you above $1,000 (invisible to the customer)
When a deposit is confirmed and has passed screening, cookieswap values it in USD (oracle price at that moment).
If it is worth **more than `MANUAL_REVIEW_USD` (default $1,000)**:
- The order goes to `awaiting_approval`, and **nothing is sent** until you act.
- **You get an alert** (Telegram and/or webhook) with the amount, pair, addresses and the three admin calls below. Undelivered alerts are retried every engine tick until they go through.
- **The customer is not told.** Quotes, the FAQ and the public API don't mention the threshold, and the order simply shows "processing".
- Choose one:
  - `POST /admin/orders/:id/approve`: let the engine swap it. It is still re-quoted and rate-checked, so a late approval after a big price move becomes a refund.
  - `POST /admin/orders/:id/resolve` `{"status":"completed","txid":"…","amountOut":"…"}`: you **filled it by hand** (e.g. paid the customer from your own wallet). The order is marked completed with your txid and amount, and its deposit is swept to the inventory address.
  - `POST /admin/orders/:id/refund`: refund it.
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

So XMR is paid from your own inventory, priced from an oracle: the median of Kraken and CoinGecko. Inventory payouts need **both** sources (`MIN_PRICE_SOURCES=2`), and quotes are refused if they disagree. The THORChain provider **switches XMR on automatically** once an `XMR.XMR` pool is `Available`. Until then, rebalance inventory by hand or through the eigenwallet fork in this repo (see [Next steps](#next-steps)).

### Routes with a live quote (re-checked 23 Nov 2026, 3 DEXes)
These are **quotes**, run with mock chains and dry-run; nothing has been sent on mainnet. The winner changes from minute to minute, which is why every order compares all routes again.

| Pair (≈$120) | Winner | Others quoting |
|---|---|---|
| BTC → ETH / USDC / USDT / ZEC | NEAR Intents | Maya, within ~0.1–0.3% |
| LTC → BTC, BTC → BCH | THORChain | NEAR |
| ETH / BNB / AVAX → anything, stables → crypto | NEAR Intents | — (see note) |
| anything ⇄ XMR | cookieswap inventory | — |
| XMR → USDC / SOL / ZEC | inventory → NEAR | — |

Notes:
- **THORChain and Maya only take BTC and LTC deposits from us.** For EVM chains their docs only describe deposits through their router contract (`depositWithExpiry`); a plain transfer to the vault with the memo as calldata is not a documented method and could lose funds. Until the router call is implemented, ETH/BNB/AVAX deposits and the ETH inventory bridge go through NEAR Intents (this costs some rate: Maya often beat NEAR on ETH → BTC).
- At the time of the check, THORChain had **BTC and BASE halted**. Maya's BTC was live.
- No DEX lists native XMR (THORChain has no XMR pool, and neither NEAR nor Maya lists XMR), so XMR legs use inventory.
- Deposits are possible in **BTC, ETH, XMR, BNB, SOL, TRX, AVAX, LTC, LINK, UNI and the 11 stablecoins**. XRP, DOGE, ADA, XLM, BCH, SUI and ZEC are payout-only.
- Every order is quoted on **every** route again when the deposit confirms.

## Quick start (development, no funds)
```bash
cd cookieswap
npm install
ADMIN_TOKEN=dev-admin-token-0123456789abcdef npm run dev   # CHAINS=mock, DRY_RUN=true by default
# open http://127.0.0.1:8080, create a swap, open "Developer: simulate deposit"
npm test            # 134 tests: engine, slippage, review gate + operator alerts, stablecoin + top-20 coin flows, BTC/LTC/EVM/Tron/Solana wallets, address checks, deposit double-check
npm run typecheck
npm run smoke       # read-only check of the live BTC/ETH/Solana backends (throwaway key)
```
> The dev token above is public. It only works with mock chains: the server refuses to start live with it.
> For real use, generate your own with `openssl rand -hex 32`.

Mock mode uses **live DEX quotes and live prices** but simulated deposits and sends.
For real configs copy `.env.example` to `.env` and run `npm start`.

## Architecture
| File | Role |
|---|---|
| `src/server.ts` | Fastify API and static UI. Logger off and no IPs stored. Rate limits, CSP, per-order secret token. |
| `src/router.ts` | Quotes every route, applies service fee/spread/limits, picks the best one |
| `src/providers/thorchain.ts` | THORChain **and Maya** (same node API, `ThorFlavor`): pools/halts, `quote/swap` (inbound address + memo), `tx/status` |
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
| `POST /admin/orders/:id/resolve` `{status, txid, amountOut?}` | record a manual payout or refund (`needs_review`), or a large order you filled by hand (`awaiting_approval`, `completed` only; sweeps the deposit to inventory) |
| `POST /admin/mock/deposit` `{orderId}` | mock mode only |

## Going live (checklist)
**Use the setup kit: [`deploy/README.md`](deploy/README.md).** One script sets up a fresh Ubuntu 24.04 server: HTTPS, your own Monero node, keys created on the server with a paper-backup check, alerts, firewall and backups. The server starts in dry run, and every deposit is held for you. The checklist below explains what the kit does and why.
1. **Separate machine.** Run the hot wallet host on its own machine, behind Tor/HTTPS. Expose only the web port, never wallet-rpc.
2. **Hot wallet keys.** See [Security review](#security-review-24-nov-2026) for server hardening.
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
     - SOL on Solana: the inventory pays the fee of **every** Solana forward, SOL deposits included

     Without it, those orders go to `needs_review`. `GET /admin/inventory` shows the gas balances.
   - stables collected from stable → XMR orders pile up on the ETH inventory address. Sell or rebalance them regularly.
5. **Dry run on live chains.** Use `CHAINS=live DRY_RUN=true` and check the logs for what *would* be broadcast.
6. **Small live amounts.** Set `DRY_RUN=false` with `MAX_ORDER_USD` small. Do every route at least once, plus a refund.
7. **Monitor.** Set up the alert channel (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, or `ALERT_WEBHOOK_URL`); the server refuses to start on live chains without one. You get an alert for every order above `MANUAL_REVIEW_USD` and every order that lands in `needs_review`. Alerts contain addresses and amounts, so they pass through Telegram's or the webhook provider's servers. Also watch inventory levels and DEX halts (THORChain halts chains regularly). Large orders sit still until you act.

## Security
Lessons taken from Wagyu's incidents (see `../plan/05-wagyu-analysis.md`):
- **No single key controls a wrapped asset.** This service issues no token. Keys only control your own hot wallets, so keep balances small.
- **No IP logging, minimal data.** The Fastify logger is off, orders are hard-deleted after `RETENTION_DAYS`, and the order token is stored as a hash only.
- **Nothing executes on unconfirmed deposits.** Confirmations are configurable per chain:
  - BTC 2, ETH 12, XMR 10
  - BSC 15, Polygon 64, Base 30, Arbitrum 60, Avalanche 5, Litecoin 6
  - Tron: solidified blocks; Solana: `finalized` commitment
- **Prices.** The oracle deviation guard blocks quotes when price sources disagree. If every source fails, the price is dropped rather than served stale. Inventory payouts need two agreeing sources; without them a deposited order is held (never refunded or paid at a guess) and goes to review after 15 minutes.
- **USDC and USDT can be frozen by their issuers** (Circle / Tether blacklist addresses). Your hot wallet holds them while an order runs and as inventory, so keep stable balances low and sweep often.
- **Gas top-ups wait for a receipt** (up to 3 min). The engine processes orders one by one, so a slow top-up delays other orders. Fine for a prototype; use a worker queue for volume.
- **Dependencies.** `npm audit --omit=dev` reports **0 vulnerabilities**. Solana moved from `@solana/web3.js` v1, which had 9 findings, to `@solana/kit` 8.6.
  A signed transfer was simulated on mainnet with signature verification on; it only failed on the unfunded throwaway fee payer.
- **Tron.** Transactions are built and signed locally (the node cannot alter them). Tron confirmations use solidified blocks (`/walletsolidity`).
- **Defaults are safe.** `DRY_RUN=true` and `CHAINS=mock` are the defaults. Live mainnet refuses to start without `ADMIN_TOKEN` and an alert channel.
- **The admin token can't move funds to new addresses.** Admin calls only approve, refund to the customer's own refund address, record manual resolutions, or sweep a deposit into your own inventory.

### Security review (24 Nov 2026)
A review of all code paths that move funds. Fixed, each with tests:

| Finding | Risk | Fix |
|---|---|---|
| ETH/BNB/AVAX were sent straight to THORChain/Maya vaults with the memo as calldata; their docs only describe the router's `depositWithExpiry` | possible loss of forwarded funds | THORChain/Maya only take BTC/LTC deposits; the EVM wallet refuses memo sends |
| After a DEX refund, the engine could refund just the ~1% left on the deposit address and close the order before the DEX's refund arrived | customer's refund stuck in our wallet | the forwarded amount is stored; refunds wait until the DEX refund is back (review after 24 h) |
| Monero deposits with a future `unlock_time` counted as confirmed | attacker paid from inventory against coins we can't spend for years | only spendable transfers count; wallet must report `unlock_time` |
| THORChain vault address came from one third-party API (Liquify) | a compromised API could redirect forwarded BTC | every vault address is confirmed by an independent node (`THORCHAIN_VERIFY_API_URL`, default Nine Realms) before sending; fails closed |
| Token refunds were paid with our gas, even for dust | attackers could drain gas inventory (~15 TRX per Tron refund) | the gas is deducted from the refunded tokens; deposits worth less than the fee go to review |
| Internal error text (e.g. RPC URLs with API keys) could appear in quote errors | leaked API keys | only our own messages reach users |
| Inventory payouts accepted a single price source | a glitch or manipulated price on one source could pay out too much | two agreeing sources required (`MIN_PRICE_SOURCES`) |
| Each deposit was read from one outside API (Esplora, an RPC provider, TronGrid, ...) | a compromised API could fake a deposit and get paid from inventory | **deposit double-check**: an independent provider must confirm the same amount before we act (see below); XMR uses your own node |
| A recovery phrase with a typo was accepted | a mistyped restore would silently open a different, empty wallet | the app refuses an invalid BIP39 phrase |
| BCH `bitcoincash:` prefix broke THORChain memos; memos over 80 bytes failed only after the swap had started | refunds / orders stuck in review | prefix stripped; long memos rejected at quote time |
| Behind a reverse proxy every visitor shared one rate limit | spam could block real users | `TRUST_PROXY` setting |

**Deposit double-check.** Before cookieswap acts on a deposit (paying from inventory, forwarding or refunding), a second provider run by someone else must see the same confirmed amount. If it doesn't (lagging, unreachable, or disagreeing), the order is held; after 30 minutes it goes to review with an alert. Defaults, each a different operator than the chain's primary:

| Chain | Primary | Second source |
|---|---|---|
| BTC | blockstream.info | mempool.space |
| LTC | litecoinspace.org | BlockCypher |
| ETH, BSC, Polygon, Base, Arbitrum, Avalanche | publicnode (or your own key) | drpc / the chains' official RPCs |
| Tron | TronGrid | publicnode |
| Solana | api.mainnet-beta | publicnode (reads the deposit's token account directly) |
| XMR | your own `monerod` | not needed |

The server refuses to start if a second source is run by the same provider as the primary.

No code can make a hot wallet unhackable. What protects the funds beyond the code:
- **The server is the key.** Anyone who gets a shell on it can read the mnemonic. Use a dedicated machine or VPS with SSH keys only (no passwords), automatic security updates, a firewall that only opens 443, and nothing else running on it.
- **Keep the hot wallet small.** Hold a few days of float, sweep profits to a cold wallet (hardware wallet, a mnemonic that never touches the server), and set `MAX_ORDER_USD` below the float.
- **`MNEMONIC_FILE` with `chmod 600`**, owned by the service user. Never `MNEMONIC=` in the environment, never in git, never in chat or e-mail.
- **monero-wallet-rpc** must be a current release (0.18+), bound to `127.0.0.1`, and never reachable from the internet.
- **Use your own RPC keys** (Alchemy/Infura/QuickNode, TronGrid) and keep `.env` readable only by the service user.
- **Protect the admin token and the Telegram bot token** like passwords. Run admin calls over SSH on the server itself.
- **Still to add for production:**
  - an HSM or a separate signer process (keys are currently in the app process)
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
- **Chainflip** as a fourth route. It uses deposit channels like NEAR and has native BTC/ETH/SOL and stables. Its quoting API was down for maintenance on 23 Nov 2026; add it once it is back.
- **THORChain/Maya for token deposits.** Add `approve` + `router.depositWithExpiry`, so stable deposits can also use their pools. Maya often has the best stable rates.
- **Arbitrum USDT** via Maya (it has an `ARB.USDT` pool), once token deposits through the router exist.
- **More deposit coins.** Deposit wallets for XRP, DOGE, ADA, XLM, BCH, SUI and ZEC (they are payout-only today), Lightning.
- **Affiliate fees.** THORChain affiliate memo and 1Click `appFees`, instead of deducting the fee before forwarding.
