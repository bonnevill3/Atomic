# Going live with cookieswap

This kit turns a fresh **Ubuntu 24.04** server into a running cookieswap: HTTPS website, your own Monero node, the hot wallet, alerts, backups and a firewall. Everything starts in **dry-run mode**, so no funds move until you switch it on.

## What you need
| | |
|---|---|
| Server | Ubuntu 24.04, x86_64 or arm64, **8 GB RAM, 250 GB SSD** (the pruned Monero node needs about 100 GB and grows). Use it for cookieswap only. |
| SSH key | Add your SSH key when you create the server, so password login can be switched off. |
| Domain | An **A record** for e.g. `swap.example.com` pointing to the server's IP. |
| Telegram | A bot from **@BotFather** (gives a token), plus your chat id: send the bot a message, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `"chat":{"id":...}`. |
| Paper and pen | For two recovery phrases (24 and 25 words). |

## 1. Run the setup (about 15 minutes)
```
ssh root@YOUR_SERVER_IP
curl -fsSL -o setup.sh https://raw.githubusercontent.com/bonnevill3/Atomic/claude/atomic-swap-xmr-eth-btc-pet5yn/cookieswap/deploy/setup.sh
bash setup.sh --domain swap.example.com --email you@example.com
```
It asks for three things:
1. **Telegram bot token and chat id.** It sends a test message, so you know alerts work.
2. **The hot wallet recovery phrase (24 words)** for BTC, LTC, ETH and the EVM chains, Tron and Solana. It appears once. Write it on paper, then type back two of the words it asks for.
3. **The Monero wallet seed (25 words).** Same procedure.

Both phrases are created **on the server**. They never pass through your computer, this chat or GitHub. Keep the paper safe and offline: with these words the funds can be recovered on a new server, and anyone who finds them can take the funds.

What the script sets up:
- **Software.** Node.js 22 (checksum-verified) and Monero (signature-verified against binaryFate's key).
- **The app.** cookieswap is installed and its tests run before anything starts.
- **Your own Monero node** (`monerod`, pruned) and `monero-wallet-rpc`, both reachable only from the server itself.
- **Services.** systemd keeps everything running and restarts it after a crash or reboot, each service locked to its own folder.
- **HTTPS** via Caddy, with an automatic certificate. The admin API is blocked from the internet, and no visitor IPs are logged.
- **Server protection.** A firewall opens only SSH, 80 and 443. Security updates install automatically, fail2ban blocks SSH guessing, and SSH switches to key-only login if you used a key.
- **Daily backups** of the order database, kept for 14 days.

Running the script again is safe: existing keys, wallets and settings are kept.

## 2. Wait for the Monero node (1–3 days)
```
/opt/monero/monerod status
```
Monero swaps work once it says it is synchronized. Everything else works right away.

## 3. Send working funds
```
cookieswap-admin addresses
```
This lists one address per coin: the hot wallet's "inventory". Start small: enough XMR for a few customer purchases, some BTC/ETH for customers selling XMR, and a little gas on each network you offer (ETH, BNB, POL, TRX, SOL). The more you hold here, the more you can lose if the server is ever compromised. Move profits to a hardware wallet regularly.

## 4. Dry run: test with a small real deposit
The settings start with `DRY_RUN=true`, `MANUAL_REVIEW_USD=0` and `MAX_ORDER_USD=100`:
- Make a swap on your site yourself and send a small real deposit.
- cookieswap detects it, waits for the confirmations, and **double-checks it with a second, independent provider**.
- Then it **holds the order and alerts you on Telegram**. Nothing is sent.
- Watch it happen: `journalctl -u cookieswap -f`
- See held orders: `cookieswap-admin held`

## 5. Go live
```
nano /etc/cookieswap/cookieswap.env     # set DRY_RUN=false and MANUAL_REVIEW_USD=1000
systemctl restart cookieswap
cookieswap-admin approve <id>           # or: cookieswap-admin refund <id>  (your test order from step 4)
```
Raise `MAX_ORDER_USD` step by step as you gain confidence. For more reliable chain access, put your own RPC keys (Alchemy, TronGrid, Helius) in the same file. The commented lines show where.

## Everyday commands
| Command | What it does |
|---|---|
| `cookieswap-admin held` | Orders above $1,000 waiting for you (you also get a Telegram alert) |
| `cookieswap-admin approve <id>` | Let the engine swap it (the rate is checked again first) |
| `cookieswap-admin fill <id> <txid> <amount>` | You paid the customer yourself: record the payout. The deposit moves to your inventory. |
| `cookieswap-admin refund <id>` | Refund to the customer's refund address |
| `cookieswap-admin review` | Orders that need a human (stuck, too small to refund, ...) |
| `cookieswap-admin inventory` | Balances of your working funds and gas |
| `cookieswap-update` | Install the newest version (tests first; only restarts if they pass) |
| `journalctl -u cookieswap -f` | Live log |
| `systemctl status cookieswap monerod monero-wallet-rpc caddy` | Are the services running? |

The admin commands only work on the server itself: ssh in first. The admin API is not reachable from the internet.

## Backups and recovery
- **The two paper phrases are the real backup.** With them, every coin can be recovered.
- **Order history** is backed up daily to `/var/lib/cookieswap/backups/`. Copy it off the server now and then: `scp root@SERVER:/var/lib/cookieswap/backups/*.db .`
- **New server:**
  1. Before running `setup.sh`, create `/var/lib/cookieswap/secrets/mnemonic.txt` with your 24 words. The script keeps an existing phrase instead of making a new one.
  2. Restore the Monero wallet from its 25 words with `monero-wallet-cli --restore-deterministic-wallet`, as file `/var/lib/cookieswap/xmr/cookieswap`.
  3. Copy the latest database backup to `/var/lib/cookieswap/cookieswap.db`.

## Where things are
| Path | Contents |
|---|---|
| `/etc/cookieswap/cookieswap.env` | All settings (readable by root and the service only) |
| `/var/lib/cookieswap/secrets/` | The recovery phrase file and Monero wallet password (mode 600) |
| `/var/lib/cookieswap/xmr/` | Monero wallet files |
| `/var/lib/monero/` | Monero blockchain (pruned) |
| `/opt/cookieswap/app/cookieswap/` | The code |
