# 5. Analysis: how wagyu.xyz works and whether it is custodial

Researched on 23 November 2026. At that point wagyu.xyz was **offline** ("Wagyu is temporarily unavailable"), after a hack on 20 November 2026.

## What Wagyu is
An instant-swap website for Monero and Zcash with no account and no KYC. Launched around December 2025 / January 2026. The operator is pseudonymous ("PerpetualCow"), reportedly based in Reykjavik. Self-reported volume ranges from $320M to $1.5B, depending on the source.

**The user flow** (from its docs):
1. Pick a pair and amount, then get a quote with the rate, fee, expected output and expected time.
2. Enter a receive address. When selling XMR or ZEC, also enter a refund address.
3. Send the exact amount to a **one-time deposit address** within 60 minutes.
4. Wagyu screens the deposit, executes the swap and pays out to your address. Typical times:
   - USDC/ETH → XMR: about 1–2 minutes
   - BTC → XMR: about 30 minutes
   - XMR → BTC: about 25 minutes (Monero needs 10 confirmations)

**Fees:** 2% into XMR, 0% out of XMR, plus routing and trading costs. Minimums are about $20–40.

**API:** `api-beta.wagyu.xyz/v2`:
- `POST /swaps/quote`, `POST /swaps` (returns `depositAddress`), `GET /swaps/{id}`
- integrator fee 0–5%

## How it works under the hood
```
user ── deposit ──▶ Wagyu deposit address (operator-controlled)
                         │
           ┌─────────────┴──────────────┐
   non-XMR legs                    XMR leg
   bridge aggregators              Wagyu's own XMR ⇄ XMR1 bridge
   (NEAR, Across, Layerswap,       XMR1 = wrapped XMR issued by Wagyu
    Symbiosis, Mayan)              on Hyperliquid (HyperCore)
           └─────────────┬──────────────┘
                 Hyperliquid order book (XMR1/USDC)
                 market makers fill the order ("no inventory")
                         │
                 payout from Wagyu's wallets ──▶ user address
```
- The **"no inventory" model:** Wagyu does not take the other side of a trade itself. Hyperliquid market makers fill the order, so Wagyu carries no price risk.
- **XMR1** is a wrapped token that Wagyu issues on Hyperliquid. Its backing is "only as good as the operator's word" (xmr.club). Wagyu also operates the Monero side of the bridge itself.

## Is it custodial? **Yes, in practice, while an order is in flight.**
Wagyu says *"swapped or refunded, never held"* and *"No custody"*. The way it actually works contradicts that:
- Deposits go to addresses that **Wagyu controls**. They are screened first and, if rejected, refunded by Wagyu. Some recoveries are done **by hand by support**.
- The **Monero side of the bridge** and the **issuance of XMR1** are in the operator's hands (a single deployer key).
- During each order, the user depends entirely on the operator's honesty and security. That is the definition of custody, even if it only lasts minutes.

## What went wrong
| Date | Incident |
|---|---|
| Apr 2026 | Service paused over DPRK-related funds (xmr.club says it was handled credibly) |
| Oct 2026 | A ransomware group published 3 months of the **order database**. Each order linked the deposit tx to the **XMR receive address and the user's IP**, including orders users had "deleted". This defeats exactly the privacy people use the service for. |
| 20 Nov 2026 | The **XMR1 deployer key** was used to move 5.2M XMR1 and sell it on Hyperliquid for about **$13.5M**. XMR1 fell 99%+. The operator blames an old server at the host 1984 (not independently confirmed), promises personal refunds, and the site is offline. The same key also controlled ~99.97% of ZEC1. |

## Lessons for our project
1. **"Non-custodial" on a website means nothing if the operator holds the deposit keys.** Real non-custody means only the user, or a smart contract or atomic-swap protocol, can move the funds.
2. **A single hot key that controls a wrapped asset is a single point of failure** worth millions.
3. **Logs and order databases are a privacy liability.** Store as little as possible, delete for real, and never log IP addresses.
4. **Regulation (EU/NL):** running a custodial crypto-to-crypto exchange for others requires a MiCA CASP licence plus AML/KYC. Under the EU AML Regulation (2024/1624), regulated providers may not handle anonymity-enhancing coins such as XMR from **July 2027**. A Dutch-operated custodial no-KYC XMR swap is therefore not a viable legal model. Get legal advice before running any public service.

## Sources
- wagyu.xyz and docs.wagyu.xyz (compliance policy, deposits, settlement, API reference), read 23 Nov 2026
- xmr.club review: https://xmr.club/exchanges/wagyu
- The Block, 20 Nov 2026: https://www.theblock.co/news/defi/2026-11-20-wagyus-xmr1-wrapped-monero-plunges-99-after-13-million-hack-founder-promises-refunds-444747
- Cryptopolitan: https://www.cryptopolitan.com/wagyu-operator-pledges-personal-refunds-after-13m-xmr1-collapse/
- TechBullion (promotional, pre-hack): https://techbullion.com/how-wagyu-xyz-built-a-700m-monero-swap-business-without-holding-inventory/
- EU AMLR privacy-coin ban: https://cointelegraph.com/news/eu-crypto-ban-anonymous-privacy-tokens-2027
