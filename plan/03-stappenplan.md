# 3. Stappenplan: ETH → XMR toevoegen aan de eigenwallet-fork

**Uitgangspunt:** de fork bevat al alles voor BTC → XMR, in één richting zoals eigenwallet. De taker koopt XMR, de maker (`asb`) verkoopt XMR. Dit plan voegt **ETH → XMR** toe in precies dezelfde richting en met hetzelfde veiligheidsmodel.

**Interface:** die is er al.
- **Maker:** `asb` met de `asb-controller` REPL in de terminal.
- **Taker:** de Tauri-GUI om te kopen, en de `swap` CLI om te beheren (`history`, `resume`, `cancel-and-refund`, …).
- Optioneel later: een `ratatui`-dashboard voor de asb (zie fase 7).

Grove doorlooptijd: **~4–7 maanden** voor één ervaren Rust-ontwikkelaar tot testnet-klaar, exclusief de externe audit.

## Waar ETH in de bestaande code komt

| Crate / map | Bestaat al (BTC) | Toevoegen (ETH) |
|---|---|---|
| `contracts/` (nieuw) | – | `SwapCreator.sol` + Foundry-tests |
| `ethereum-wallet/` (nieuw) | vgl. `bitcoin-wallet/`, `electrum-pool/` | ETH-wallet met `alloy`: sleutels uit de bestaande seed (`swap/src/seed.rs`), RPC-pool, finality-watcher |
| `swap-core/` | `bitcoin/` (lock, redeem, refund, …), `monero/` | `ethereum/`: contract-bindings, commitments, calldata |
| `swap-machine/` | `AliceState`, `BobState` | **aparte** enums voor ETH-swaps (bijv. `AliceEthState`/`BobEthState`), zodat het BTC-pad niet geraakt wordt |
| `swap/src/protocol/` | `alice/swap.rs`, `bob/swap.rs` | `alice/swap_eth.rs`, `bob/swap_eth.rs` |
| `swap-p2p/src/protocols/` | `swap_setup`, `quote(s)`, `transfer_proof`, `encrypted_signature`, … | `swap_setup` en quotes uitbreiden met een **paar**-veld (BTC of ETH). `transfer_proof` hergebruiken. `encrypted_signature` is bij ETH niet nodig, want `setReady` gaat on-chain. |
| `swap-db/` + `.sqlx/` | swap-states | migraties voor ETH-states. Daarna `just generate-sqlx-cache` |
| `swap-env/` | config + defaults | ETH-RPC-URL's, finality-instelling, timeouts `t1`/`t2`, contractadres per netwerk |
| `swap-feed/` | XMR/BTC-koers | XMR/ETH-koers (bijv. via XMR/BTC × BTC/ETH, mediaan van bronnen) |
| `swap/src/asb/` + `swap-controller(-api)` | BTC-saldo, opnemen, … | ETH-saldo, ETH opnemen, waarschuwing bij een te lage gas-buffer |
| `swap/src/cli/` + `src-tauri/` + `src-gui/` | BTC kiezen en storten | **ETH kiezen**, ETH-wallet, contract-status en refund-knop |
| `swap/tests/` + `monero-harness/` | docker-tests met bitcoind + monerod | `anvil`-container erbij, plus ETH-varianten van de belangrijkste tests |

---

## Fases

Elke fase eindigt met **"klaar wanneer"**. Ga pas door als dat echt klopt.

### Fase 0: De fork leren kennen (1–2 weken)
- [ ] `git submodule update --init --recursive`, daarna `just swap` (de eerste build van `monero-sys` duurt lang).
- [ ] `just docker_test happy_path` en `just docker_test alice_refunds_after_restart_bob_refunded` draaien.
- [ ] Testnet: `just asb-testnet` + `just asb-testnet-controller` als maker, en `just gui` als taker. Doe één swap met jezelf.
- [ ] Lees `swap-machine/src/alice/mod.rs` en `bob/mod.rs` (de states) en `swap/src/protocol/{alice,bob}/swap.rs` (de overgangen).
- [ ] Bekijk hoe `swap_setup` de sleutels en DLEQ-bewijzen uitwisselt. Dat hergebruik je voor ETH.

**Klaar wanneer:** de docker-tests lokaal groen zijn, je een testnet-swap hebt gedaan, en je elke BTC-state kunt uitleggen.

### Fase 1: ETH-specificatie (1–2 weken)
- [ ] Schrijf `plan/05-eth-spec.md`:
  - contract-interface en de regels uit [02-protocol.md](02-protocol.md)
  - de states van maker en taker
  - p2p-berichten
  - timeouts (`t1`, `t2`, vergelijkbaar met de cancel- en punish-timelocks)
  - finality-regels
- [ ] Beslissingen vastleggen:
  - alleen native ETH in v1 (ERC-20 later)
  - eigenwallet-semantiek (`claim` alleen na `setReady`)
  - geen relayer
- [ ] Bepaal welke eigenwallet-features je voor ETH overslaat in v1: anti-spam-borg/partial refund, developer tip, Hermes/Apollo.

**Klaar wanneer:** de spec voor elke state zegt wat er gebeurt bij elke deadline en elke crash.

### Fase 2: Smart contract (2–4 weken)
- [ ] `contracts/` als Foundry-project: `SwapCreator.sol` met `newSwap`, `setReady`, `claim`, `refund` en `punish`.
- [ ] Tests:
  - unit-tests en fuzzing
  - invariants: geld kan maar één keer weg, alleen in de juiste tijdvensters, alleen naar de vaste adressen
  - statische analyse met Slither
- [ ] Controle op `s`: `0 < s < n`, het ecrecover-nul-adres afvangen, en een reentrancy-guard.
- [ ] Deploy-script voor anvil en Sepolia. CI-job die `forge test` draait.

**Klaar wanneer:** 100% branch coverage op het contract en invariant-tests zonder bevindingen.

### Fase 3: ETH-wallet en core (2–3 weken)
- [ ] Crate `ethereum-wallet/` (`alloy`): sleutel afgeleid uit de bestaande seed, saldo, transacties sturen, nonce- en fee-beheer (EIP-1559), meerdere RPC-endpoints.
- [ ] Watcher die alleen `finalized` blokken als definitief behandelt.
- [ ] `swap-core/src/ethereum/`: commitments uit secp256k1-pubkeys (dezelfde sleutels als in het DLEQ-bewijs), en calldata voor alle contractfuncties.
- [ ] Unit-tests tegen anvil.

**Klaar wanneer:** een test via de Rust-code een volledige `newSwap → setReady → claim` doet op anvil, en ook `refund` en `punish`.

### Fase 4: Protocol en state machines (4–6 weken)
- [ ] `swap_setup` uitbreiden met een paar-veld, **geversioneerd**, zodat oude BTC-takers en -makers blijven werken.
- [ ] Quotes per paar (BTC en ETH), met min/max per paar.
- [ ] ETH-states in `swap-machine` en de overgangen in `swap/src/protocol/{alice,bob}/swap_eth.rs`.
- [ ] Persistentie: elke state eerst opslaan in `swap-db`, dan pas handelen (write-ahead, zoals de bestaande code doet).
- [ ] Hervatten na herstart, en handmatige commando's (`refund`, `punish`) in CLI en controller.
- [ ] Docker-tests met anvil, naar het voorbeeld van de bestaande tests:
  - `eth_happy_path`
  - `eth_taker_refunds_before_ready` (maker lockt nooit XMR)
  - `eth_taker_refunds_when_xmr_amount_wrong`
  - `eth_taker_refunds_after_t1_maker_offline`
  - `eth_maker_punishes_after_t2_taker_offline`
  - `eth_restart_maker_after_xmr_locked`
  - `eth_restart_taker_after_ready`
  - `eth_concurrent_takers`

**Klaar wanneer:** alle ETH-docker-tests groen zijn **en** alle bestaande BTC-docker-tests nog groen zijn.

### Fase 5: Maker (asb) (1–2 weken)
- [ ] Config: ETH-RPC, contractadres, `t1`/`t2`, minimaal en maximaal bedrag per paar.
- [ ] XMR/ETH-koers in `swap-feed`.
- [ ] Controller-commando's: `eth-balance`, `withdraw-eth`. Waarschuwing bij een te lage gas-buffer.
- [ ] Metrics en logs voor ETH-swaps, zonder geheimen.

**Klaar wanneer:** de asb op Sepolia + stagenet zowel BTC- als ETH-offers aanbiedt en afhandelt.

### Fase 6: Taker (CLI + GUI) (2–3 weken)
- [ ] API: `BuyXmrArgs`/`buy_xmr` in `swap/src/cli/api/request.rs` uitbreiden met ETH. De GUI koopt via deze API.
- [ ] CLI: `resume`, `cancel-and-refund` en `balance` laten werken voor ETH-swaps.
- [ ] GUI (`src-gui`):
  - bij het kiezen van een maker het paar BTC of ETH tonen
  - ETH-stortingsadres en ETH-saldo
  - de status van de swap in stappen, met aftelling naar `t1`/`t2`
- [ ] Duidelijke waarschuwing: **"Houd de app open tot de swap klaar is."** Na een herstart wordt de swap automatisch hervat.

**Klaar wanneer:** een niet-technische tester zonder hulp een ETH → XMR-swap op testnet kan doen.

### Fase 7 (optioneel): Terminal-dashboard voor de maker
- [ ] `ratatui`-app die via `swap-controller-api` (JSON-RPC) praat met de asb. Ze toont saldi (XMR/BTC/ETH), actieve swaps met deadlines, quotes en verbindingen.

```
┌ asb ─ XMR → BTC/ETH ────────────────────────────── [Tor ✓] [stagenet] ┐
│ Saldo          │ Actieve swaps                                         │
│ XMR  12.4000   │  id      paar     bedrag     status         deadline  │
│ BTC   0.0310   │  7f3a…   ETH→XMR  2.0 XMR    wacht op ready  t1 3u12m │
│ ETH   0.0450   │  91c2…   BTC→XMR  0.5 XMR    XMR gelockt     T1 4u01m │
├────────────────┴───────────────────────────────────────────────────────┤
│ Quote: 1 XMR = 0.00412 BTC | 0.1290 ETH     min 0.1  max 5 XMR         │
│ q stoppen   r verversen   w opnemen   l logs   ? help                  │
└────────────────────────────────────────────────────────────────────────┘
```

### Fase 8: Testnet en hardening (4+ weken)
- [ ] Sepolia + Monero stagenet (+ BTC testnet voor regressie).
- [ ] Soak-test: 100+ ETH-swaps, waarvan een deel met chaos (netwerk weg, RPC down, proces gekilld).
- [ ] De checklist in [04-beveiliging.md](04-beveiliging.md) doorlopen.
- [ ] Upstream mergen en alles opnieuw testen (zie [FORK.md](FORK.md)).

**Klaar wanneer:** 100 testnet-swaps zonder fondsverlies zijn gedaan, en elk faalpad minstens 10× echt is doorlopen.

### Fase 9: Audit en mainnet-beta
- [ ] Externe audit van het contract **en** van de ETH-protocolcode. Daarna een bug bounty.
- [ ] Mainnet met harde limieten per swap (begin klein).
- [ ] Een kill-switch voor **nieuwe** ETH-swaps. Lopende swaps altijd laten afronden.
- [ ] **Monero-hardfork (FCMP++/Carrot):** er is nog geen mainnet-datum (de roadmap mikt op 2027). Volg upstream, want eigenwallet zal dit voor BTC al moeten oplossen.
- [ ] **Juridisch:** een publieke maker draaien voor anderen kan onder MiCA/DNB-regels vallen. Laat dat checken.

---

## Samengevat
1. Fork bouwen, testen en begrijpen (fase 0)
2. ETH-spec en contract (fase 1–2)
3. ETH-wallet, core en state machines met docker-tests (fase 3–4)
4. Maker en taker UI (fase 5–6), optioneel een TUI-dashboard (fase 7)
5. Testnet, audit, mainnet-beta (fase 8–9)
