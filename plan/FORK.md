# Fork-administratie

| | |
|---|---|
| Upstream | https://github.com/eigenwallet/core (branch `master`) |
| Gebaseerd op | `bac42bed64220ee3e4a6ab834a4c5873f12e191f` (22 nov 2026) |
| Licentie | GPL-3.0. Deze fork moet ook GPL-3.0 blijven, en wie binaries verspreidt moet de broncode beschikbaar maken. |
| Geschiedenis | De volledige upstream-geschiedenis (3.924 commits) is behouden, dus upstream-updates kun je gewoon mergen. |

## Gekozen richting
Precies zoals eigenwallet, in één richting:

| Rol | Heeft | Krijgt | Software |
|---|---|---|---|
| **Taker** (de gebruiker van de app) | BTC, **later ook ETH** | XMR | Tauri-GUI (`src-gui`) om te kopen, `swap` CLI om te beheren |
| **Maker** (jij, de liquiditeitsaanbieder) | XMR | BTC, **later ook ETH** | `asb` + `asb-controller` |

De BTC/ETH-kant lockt dus altijd eerst (zie [02-protocol.md](02-protocol.md)).

## Wijzigingen ten opzichte van upstream
| Bestand | Wijziging | Waarom |
|---|---|---|
| `README.md` | fork-melding bovenaan | GPL: wijzigingen duidelijk vermelden |
| `plan/` | nieuw: onderzoek, protocol, stappenplan, beveiliging | eigen documentatie |
| `cookieswap/` | nieuw: custodial DEX-routed swap service (TypeScript, los van de Rust-workspace) | eigen project |
| `.github/workflows/preview-release.yml` | `if: github.repository == 'eigenwallet/core'` | de dagelijkse geplande release-job zou anders elke dag in deze fork draaien (en falen zonder upstream-secrets) |

Houd deze tabel bij bij elke wijziging aan upstream-bestanden. Zo blijven toekomstige merges overzichtelijk.

## Upstream bijhouden
```bash
git remote add upstream https://github.com/eigenwallet/core   # eenmalig
git fetch upstream master
git merge upstream/master          # conflicten oplossen, testen, committen
```
Doe dit regelmatig. eigenwallet brengt vaak beveiligings- en betrouwbaarheidsfixes uit.

## Bouwen en testen (zie ook `dev-docs/` en `just help`)
```bash
git submodule update --init --recursive   # Monero C++-code voor monero-sys (groot, duurt even)
just swap                                 # bouwt asb + swap
just asb-testnet                          # maker op testnet
just asb-testnet-controller               # REPL om de asb te besturen
just gui                                  # Tauri-GUI (taker)
just list-docker-tests                    # end-to-end-tests met lokale chains
just docker_test happy_path
```
- Het eerste bouwen van `monero-sys` duurt lang. Draai **nooit** `cargo clean` (zie `AGENTS.md`).
- Voor de docker-tests heb je Docker nodig.

## Bijdragen aan upstream
Wil je later een verbetering terugsturen naar eigenwallet, volg dan hun [`AI_POLICY.md`](../AI_POLICY.md) en [`CONTRIBUTING.md`](../CONTRIBUTING.md). Je moet AI-gebruik melden, zelf alles testen, en commit-berichten en PR-teksten zelf schrijven.
