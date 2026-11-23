# 3. Stappenplan

Doel: een app waarmee je **XMR verkoopt voor BTC of ETH** via een atomic swap, zonder tussenpartij, met dezelfde aanpak als eigenwallet (p2p over Tor, refund- en punish-routes, automatisch herstel). De interface is een **TUI** (terminal), met optioneel een heel eenvoudige GUI.

## Eerst kiezen: route A of route B

| | **Route A: fork van eigenwallet/core (aanbevolen)** | **Route B: eigen codebase** |
|---|---|---|
| BTC-leg | bestaat al en is in productie getest | zelf bouwen met `ecdsa_fun`, `sigma_fun` en `bdk` |
| Monero-wallet, p2p, Tor, DB | bestaat al | zelf bouwen |
| Wat jij bouwt | ETH-leg, XMR-verkoper-als-taker-flow, TUI | alles |
| Licentie | **verplicht GPL-3.0** | vrij te kiezen (let op de licenties van dependencies) |
| Nadeel | grote codebase (~35 crates) om te leren, upstream bijhouden | veel meer werk, meer kans op fatale fouten |
| Grove doorlooptijd* | ~4–7 maanden tot testnet-klaar | ~8–14 maanden tot testnet-klaar |

\* Schatting voor één ervaren Rust-ontwikkelaar, exclusief externe audit.

**Advies: route A.** De gevaarlijkste code (adaptor signatures, DLEQ, het BTC-protocol, Monero-integratie) is daar al jaren met echt geld in gebruik. Bouw zelf alleen wat nog niet bestaat.

## Architectuur

```
            ┌───────────────┐   JSON-RPC    ┌──────────────────────────────┐
  jij  ───▶ │ atomic-tui    │◀────────────▶ │ atomicd (daemon)             │
            │ atomic-cli    │  (unix sock)  │  ├─ protocol: state machines │
            │ (gui: egui)   │               │  ├─ db: SQLite (swap-state)  │
            └───────────────┘               │  ├─ p2p: libp2p over Tor     │
                                            │  ├─ chain-btc  (Electrum)    │
                                            │  ├─ chain-xmr  (wallet)      │
                                            │  └─ chain-eth  (RPC + contr.)│
                                            └──────────────────────────────┘
```

- **Daemon en UI zijn gescheiden** (net als eigenwallet `asb` + `swap-controller` en Haveno daemon + UI). Crasht of sluit de TUI, dan loopt de swap gewoon door. Een GUI is later "gewoon een extra client".
- **Elke swap is een state machine** die vóór elke uitgaande actie (bericht of transactie) zijn nieuwe toestand opslaat in SQLite. Na een herstart gaat hij verder waar hij was.

### Modules / crates

```
atomic/
├── crates/
│   ├── core-crypto/   # sleutels, key-split, DLEQ, adaptor signatures, zeroize
│   ├── chain-btc/     # wallet, Lock/Redeem/Cancel/Refund/Punish, watcher
│   ├── chain-xmr/     # wallet, gedeeld adres, lock-verificatie, sweep
│   ├── chain-eth/     # contract-bindings, finality-watcher, relayer-client
│   ├── protocol/      # state machines: XMR-kant en BTC/ETH-kant per paar
│   ├── p2p/           # libp2p, berichten (geversioneerd), rendezvous, Tor
│   ├── db/            # SQLite + migraties
│   └── daemon/        # atomicd: orkestratie + JSON-RPC
├── contracts/         # Solidity + Foundry-tests
├── apps/
│   ├── cli/           # atomic-cli (clap)
│   ├── tui/           # atomic-tui (ratatui)
│   └── gui/           # optioneel: egui/eframe
└── dev/               # docker-compose: bitcoind, monerod, anvil
```

In route A koppel je deze aan de bestaande eigenwallet-crates (`swap-core`, `swap-machine`, `swap-db`, `swap-p2p`, `bitcoin-wallet`, `monero-wallet`, …). Je voegt dan vooral `chain-eth`, `contracts/` en `apps/tui` toe.

### Tech-stack (Rust)

| Onderdeel | Keuze | Waarom |
|---|---|---|
| Async | `tokio` | standaard, gebruikt door eigenwallet |
| BTC | `bitcoin`, `bdk_wallet` + Electrum | eigenwallet-aanpak, light client |
| Adaptor signatures | `ecdsa_fun` (feature `adaptor`) | gebruikt door xmr-btc-swap/eigenwallet |
| Cross-curve DLEQ | `sigma_fun` (ed25519 + secp256k1) | idem, **niet zelf schrijven** |
| Monero | `monero-wallet-rpc` om te beginnen, later `monero-oxide` | snel starten, later pure Rust |
| ETH | `alloy` + Solidity/Foundry (`forge`, `anvil`) | modern, goede test- en fuzz-tools |
| P2P | `rust-libp2p` (request-response, rendezvous, noise) + Tor (`arti`) | zoals eigenwallet |
| Opslag | `sqlx` + SQLite | eenvoudig, transacties |
| CLI / TUI / GUI | `clap` / `ratatui` + `crossterm` / `egui` | TUI eerst. egui is de simpelste GUI in pure Rust |
| Tests | `cargo nextest`, `proptest`, `cargo-fuzz`, Foundry fuzz/invariant | |

---

## Fases

Elke fase eindigt met een **"klaar wanneer"**. Ga pas door als dat echt klopt.

### Fase 0: Leren en beslissen (1–2 weken)
- [ ] Lees de leeslijst in [01-vergelijkbare-projecten.md](01-vergelijkbare-projecten.md) en [02-protocol.md](02-protocol.md).
- [ ] Installeer eigenwallet en doe een swap op **testnet/stagenet**.
- [ ] Draai lokaal een `asb` (de XMR-verkoper).
- [ ] Lees in eigenwallet/core de state machine (`swap-machine`, `swap-core`) en volg één swap in de logs.
- [ ] Kies route A of B en de licentie.

**Klaar wanneer:** je elke transactie uit protocol A kunt uitleggen (wie, wanneer, waarom) en je een testswap hebt gedaan.

### Fase 1: Lokale ontwikkelomgeving (1 week)
- [ ] `dev/docker-compose.yml` met `bitcoind -regtest` + `electrs`, `monerod --regtest` + `monero-wallet-rpc`, en `anvil`.
- [ ] Scripts om blokken te minen en wallets te vullen (`just up`, `just mine 10`, `just fund`).
- [ ] CI (GitHub Actions) die deze stack start en de integratietests draait.

**Klaar wanneer:** één commando de hele stack start en een test BTC, XMR en ETH kan versturen.

### Fase 2: Crypto-kern (2–4 weken; route A: vooral integreren)
- [ ] Monero key-split: per swap `s_xmr` genereren, gedeeld adres `S_xmr + S_ander` en gedeelde view key.
- [ ] DLEQ-bewijzen maken en verifiëren, met **negatieve tests** (fout bewijs → swap afbreken).
- [ ] BTC adaptor signatures: encsign, verify, decrypt en secret recovery.
- [ ] ETH-commitment-formaat dat exact overeenkomt met het contract.
- [ ] Sleutels per swap deterministisch afleiden uit de seed + swap-id (herstel uit seed + DB).
- [ ] Geheimen `zeroize`n en nooit loggen.

**Klaar wanneer:** property-tests aantonen dat geheimen altijd terug te halen zijn uit een on-chain handtekening of claim, en dat ongeldige bewijzen altijd worden afgewezen.

### Fase 3: BTC-leg (4–8 weken; route A: 1–3 weken)
- [ ] Transacties: `TxLock`, `TxRedeem`, `TxCancel`, `TxRefund`, `TxPunish` (2-van-2 P2WSH, relatieve timelocks).
- [ ] State machines voor de XMR-kant en de BTC-kant.
- [ ] Watchers voor BTC (Electrum) en XMR.
- [ ] Integratietests op regtest voor **elk** pad:
  - happy path
  - XMR nooit gelockt → refund
  - XMR gelockt maar geen redeem → refund
  - punish
  - cooperative redeem
- [ ] **Crash-tests:** proces killen (`kill -9`) in elke toestand, herstarten, en de swap moet goed aflopen.
- [ ] Fee-strategie: fee-schatting en marges op vooraf getekende transacties.

**Klaar wanneer:** alle paden en alle crash-punten groen zijn op regtest.

### Fase 4: ETH-leg (4–8 weken)
- [ ] `contracts/SwapCreator.sol` met `newSwap`, `setReady`, `claim`, `claimRelayer` en `refund` (zie [02-protocol.md](02-protocol.md)).
- [ ] Foundry-tests:
  - unit-tests en fuzzing
  - invariants: geld kan maar één keer weg, alleen in de juiste tijdvensters, alleen naar het vaste adres
  - statische analyse met Slither
- [ ] Relayer: EIP-712-handtekening met swap-id, fee, chain-id, contractadres en nonce.
- [ ] Rust-client (`alloy`) plus watcher die alleen op **finalized** blokken vertrouwt.
- [ ] Dezelfde pad- en crash-tests als in fase 3, eerst op anvil en daarna op Sepolia.
- [ ] (Later) ERC-20 (bijv. USDC/DAI) met `SafeERC20`, en tokens met fee-on-transfer weigeren.

**Klaar wanneer:** alle paden groen zijn op anvil en minstens 20 swaps op Sepolia + Monero stagenet goed zijn gegaan.

### Fase 5: P2P en markt (3–6 weken; route A: grotendeels aanwezig)
- [ ] libp2p request-response met **geversioneerde** berichten, noise-encryptie en standaard via Tor.
- [ ] Peers vinden via rendezvous-nodes (zoals eigenwallet).
- [ ] Quotes: koers (mediaan van meerdere bronnen), min/max bedrag en geldigheidsduur.
- [ ] Anti-spam aan de BTC/ETH-kant: rate-limits per peer, maximumbedrag voor onbekende peers, en optioneel een kleine upfront fee.
- [ ] Fuzzing van het parsen van berichten (`cargo-fuzz`).

**Klaar wanneer:** twee nodes op verschillende machines elkaar via Tor vinden en een testnet-swap doen.

### Fase 6: Interface (2–4 weken)

**CLI (`clap`):**
```
atomic-cli quotes --pair xmr-btc
atomic-cli sell --xmr 1.5 --for btc --receive-address bc1q...
atomic-cli sell --xmr 2.0 --for eth --receive-address 0x...
atomic-cli list | status <swap-id> | resume <swap-id> | refund <swap-id>
```

**TUI (`ratatui`):**
```
┌ Atomic ─ XMR ⇄ BTC/ETH ─────────────────────────── [Tor ✓] [stagenet] ┐
│ Wallets          │ Offers                                              │
│ XMR  12.4000     │  #  Peer         Paar      Koers     Min–Max        │
│ BTC   0.0310     │  1  12D3K…a9f    XMR→BTC   0.00412   0.1–5 XMR      │
│ ETH   0.0000     │▶ 2  12D3K…77c    XMR→ETH   0.1290    0.5–20 XMR     │
├──────────────────┴─────────────────────────────────────────────────────┤
│ Swap 7f3a…  XMR→ETH   2.0 XMR → 0.258 ETH                              │
│ [✓] sleutels + DLEQ  [✓] ETH gelockt (finalized)  [✓] XMR gelockt 10/10│
│ [~] wacht op setReady …            claim-deadline t1 over 3u 12m       │
├────────────────────────────────────────────────────────────────────────┤
│ n nieuwe swap   r hervatten   l logs   s seed-backup   ? help   q stop │
└────────────────────────────────────────────────────────────────────────┘
```
- [ ] Schermen: wallets, offers, nieuwe swap (met bevestigingsscherm), actieve swaps met timelock-aftelling, geschiedenis en logs.
- [ ] Duidelijke waarschuwing: **"Sluit atomicd niet af tot de swap klaar is."**
- [ ] (Optioneel) Basis-GUI in `egui`: dezelfde schermen, die dezelfde JSON-RPC aanroept.

**Klaar wanneer:** je een volledige swap alleen via de TUI kunt doen, en de TUI na een herstart de juiste status toont en de swap automatisch hervat.

### Fase 7: Testnet en hardening (4+ weken)
- [ ] Bitcoin testnet4/signet, Monero stagenet en Ethereum Sepolia.
- [ ] Soak-test: 100+ swaps, waarvan een deel met chaos (netwerk weg, node down, proces gekilld).
- [ ] Wallet- en DB-bestanden versleuteld. Logs zonder geheimen.
- [ ] Reproduceerbare builds en gesigneerde releases.
- [ ] Doorloop de checklist in [04-beveiliging.md](04-beveiliging.md).

**Klaar wanneer:** 100 testnet-swaps zonder fondsverlies zijn gedaan, en elk faalpad minstens 10× echt is doorlopen.

### Fase 8: Externe audit (4–8 weken doorlooptijd)
- [ ] Schrijf een threat model (zie [04-beveiliging.md](04-beveiliging.md)).
- [ ] Laat het Solidity-contract en de protocol- en crypto-code auditen. Het ETH-deel is nieuw en **niet geaudit** bij AthanorLabs.
- [ ] Bug bounty starten.

**Klaar wanneer:** alle kritieke en hoge bevindingen zijn opgelost en hertest.

### Fase 9: Mainnet-beta
- [ ] Harde limieten per swap (begin klein, bijv. een paar honderd euro).
- [ ] Een kill-switch die **nieuwe** swaps stopt. Refunds en redeems blijven altijd werken.
- [ ] Monitoring en een incidentplan.
- [ ] **Monero-hardfork (FCMP++/Carrot):** nieuw transactieformaat en adresschema. Er is nog geen mainnet-datum (de roadmap mikt op 2027). Test de key-split-aanpak opnieuw op de testnetten zodra die fork daar draait, en volg eigenwallet en de Monero-devs.
- [ ] **Juridisch:** zelf p2p handelen met eigen software is iets anders dan een dienst voor anderen draaien. Wil je als maker publiek handelen, check dan MiCA/DNB-regels in NL.

---

## Samengevat: de volgorde
1. Leren + eigenwallet op stagenet (fase 0)
2. Regtest-omgeving (fase 1)
3. Crypto-kern + BTC-leg met alle faalpaden (fase 2–3)
4. ETH-contract + ETH-leg (fase 4)
5. P2P + markt (fase 5)
6. CLI → TUI → optioneel GUI (fase 6)
7. Testnet, audit, mainnet-beta met limieten (fase 7–9)
