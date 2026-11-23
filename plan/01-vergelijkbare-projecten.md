# 1. Vergelijkbare projecten

Onderzocht in november 2026. Statussen veranderen snel, dus check de repo zelf voordat je iets hergebruikt.

## Overzicht

| Project | Wat het doet | Paren / richting | Techniek | Taal / UI | Licentie | Status (nov 2026) |
|---|---|---|---|---|---|---|
| [eigenwallet/core](https://github.com/eigenwallet/core) | Wallet + atomic-swap-DEX (voorheen UnstoppableSwap) | BTC→XMR. De app is altijd **taker** (koopt XMR met BTC). De `asb` (maker) **verkoopt XMR** voor BTC. | Adaptor signatures + key-splitting (Gugger-protocol) | Rust, Tauri GUI, libp2p + Tor | GPL-3.0 | Actief. Docs bijgewerkt nov 2026, meerdere releases in 2026 |
| [comit-network/xmr-btc-swap](https://github.com/comit-network/xmr-btc-swap) | Originele implementatie waar eigenwallet een fork van is | BTC→XMR | Gugger-protocol | Rust, CLI | GPL-3.0 | Niet meer onderhouden, voortgezet in eigenwallet |
| [AthanorLabs/atomic-swap](https://github.com/athanorlabs/atomic-swap) | Enige serieuze ETH↔XMR-implementatie | ETH↔XMR. De ETH-houder lockt eerst in een smart contract. | Solidity-contract + key-splitting | Go + Solidity, `swapd`/`swapcli` | LGPL-3.0 | **Gearchiveerd op 1 sep 2026**, "beta", "not funded", geen audit gevonden. Laatste release v0.4.3 |
| [BasicSwap](https://github.com/basicswap/basicswap) | Multi-coin DEX (BTC, XMR, LTC, …) | XMR↔BTC **in beide richtingen**, via een apart "reversed" protocol. **Geen ETH.** | Adaptor signatures voor XMR, HTLC voor de rest | Python, web-UI | MIT | Actief (v0.19.x) |
| [Farcaster](https://github.com/farcaster-project/farcaster-node) | Swap-node met microservices | BTC↔XMR in beide richtingen, maker en taker los van wie eerst lockt | Gugger-protocol, eigen RFC's | Rust | zie repo | Laatste activiteit rond 2023 |
| [Haveno](https://github.com/haveno-dex/haveno) | P2P-exchange XMR ↔ fiat/crypto (Bisq-fork, netwerken o.a. RetoSwap) | XMR ↔ alles | **Geen atomic swap**: 2-van-3 multisig met een arbiter, plus borg | Java, desktop-GUI + daemon | AGPL-3.0 | Actief |
| [Bisq](https://github.com/bisq-network/bisq) / [Bisq 2](https://github.com/bisq-network/bisq2) | P2P-exchange BTC ↔ fiat/altcoins | BTC ↔ alles | **Geen atomic swap**: 2-van-2 multisig + borg + mediatie (Bisq 1), reputatie (Bisq Easy) | Java | AGPL-3.0 | Actief |
| [Serai](https://github.com/serai-dex/serai) | DEX voor BTC/ETH/XMR | BTC/ETH/XMR | **Geen atomic swap**: threshold-multisig van validators | Rust | zie repo | Geen mainnet-launch gevonden |

## Wat je van elk project kunt leren

### eigenwallet: je belangrijkste voorbeeld
- **Rollen** (uit de [docs](https://docs.eigenwallet.org/advanced/refund_punish)): *"Taker is the side which has Bitcoin and sells these Bitcoin for Monero"*, *"Maker is the side which has Monero and sells these for Bitcoin."*
- **Timelocks:** de cancel-timelock staat op 30 BTC-blokken (~5 uur) en de punish-timelock op 144 blokken (~24 uur) na de cancel.
- **Uitkomsten:** happy path, refund en punish, plus "cooperative redeem": na een punish kan de maker de taker alsnog helpen.
- **Anti-spam-borg:** sommige makers houden een klein deel van de refund vast, zodat niemand ze kan spammen met swaps die nooit afgerond worden.
- **Opbouw van de monorepo**, handig als blauwdruk voor je eigen crates:
  - `swap-core`, `swap-machine` (state machine), `swap-db` (persistentie), `swap-p2p`
  - `bitcoin-wallet`, `electrum-pool`
  - `monero-wallet`, `monero-sys`, `monero-rpc-pool`
  - `libp2p-tor`, `libp2p-rendezvous-node`
  - `swap-asb` (maker), `swap-controller` (RPC om de daemon te besturen), `src-gui`/`src-tauri` (GUI)
- **Belangrijk voor jou:** wat jij wilt (XMR verkopen voor BTC) is precies wat de **`asb` (maker)** van eigenwallet al doet. Deze repo is daarom een fork van eigenwallet (zie [FORK.md](FORK.md)), en het enige grote nieuwe onderdeel is ETH.
- **Licentie:** GPL-3.0. Kopieer je code, dan moet je project ook GPL-3.0 zijn.

### AthanorLabs: de enige ETH↔XMR-referentie
- **Protocol** (uit [docs/protocol.md](https://github.com/AthanorLabs/atomic-swap/blob/master/docs/protocol.md)):
  1. De ETH-houder lockt ETH in het contract.
  2. De XMR-houder lockt XMR op het gedeelde adres.
  3. De ETH-houder roept `Ready()` aan.
  4. De XMR-houder roept `Claim(s)` aan en onthult daarmee zijn geheime sleuteldeel.
  5. Met dat deel kan de ETH-houder de XMR opnemen.
- **Timeouts:** `t_0` is de deadline voor Ready/Refund. Tussen `t_0` en `t_1` mag de XMR-houder altijd claimen. Na `t_1` mag de ETH-houder weer refunden.
- **Gas-probleem:** wie alleen XMR heeft, heeft geen ETH om `Claim()` te betalen. AthanorLabs loste dit op met *relayers* die een klein deel van de swap krijgen. In onze richting is dat niet nodig: de ETH-kant is de taker, en die heeft zelf ETH.
- **Let op:** het project is gearchiveerd, niet geaudit en niet gefinancierd. Gebruik het als **ontwerpreferentie**, niet als dependency. Het contract moet je zelf herschrijven, testen en laten auditen.

### BasicSwap: hoe de omgekeerde richting werkt
- Lees [`doc/protocols/adaptor_sig.md`](https://github.com/basicswap/basicswap/blob/master/doc/protocols/adaptor_sig.md) en [`adaptor_sig_reversed.md`](https://github.com/basicswap/basicswap/blob/master/doc/protocols/adaptor_sig_reversed.md).
- De kernregel: *"The ITX must be sent from the script chain (coin A)."* De BTC-kant lockt dus **altijd** eerst, wie de offer ook plaatst.
- Biedt iemand XMR aan, dan worden de protocolrollen omgedraaid: de offerer wordt *follower* en de bieder *leader*.
- MIT-licentie, dus vrij om ideeën en code te hergebruiken.

### Farcaster: protocolrol los van marktrol
- Een node kan offers in beide richtingen tegelijk maken en nemen. *Wie eerst lockt* (protocol) staat los van *wie de offer plaatst* (markt). Dat ontwerpprincipe neem je over.
- De [RFC's](https://github.com/farcaster-project/rfcs) zijn goede specificaties om te lezen.

### Haveno en Bisq: netwerk, orderboek en UX
- Ze gebruiken geen atomic swaps, maar je kunt er veel van leren:
  - P2P-orderboek over Tor
  - scheiding tussen daemon en UI (gRPC-API)
  - borg en reputatie tegen spam
  - UX voor geschillen en herstel
- Een [paper uit 2025 (arXiv 2505.02392)](https://arxiv.org/abs/2505.02392) laat zien dat sommige Haveno-trades te herkennen en tussen chains te koppelen zijn. Neem privacy van on-chain patronen dus serieus.

### Serai
- Interessant vanwege de Rust-bibliotheek **monero-oxide** (voorheen *monero-serai*), die ook eigenwallet gebruikt.

## Leeslijst (in deze volgorde)
1. J. Gugger, *Bitcoin–Monero Cross-chain Atomic Swap* (2020): https://eprint.iacr.org/2020/1126
2. eigenwallet docs, *Atomic Swap protocol explained*: https://docs.eigenwallet.org/advanced/refund_punish
3. P. Hoenisch & L. Soriano del Pino, *Atomic Swaps between Bitcoin and Monero* (2021): https://arxiv.org/abs/2101.12332
4. BasicSwap: `adaptor_sig.md` + `adaptor_sig_reversed.md` (links hierboven)
5. AthanorLabs: `docs/protocol.md` (link hierboven)
6. Farcaster RFC's: https://github.com/farcaster-project/rfcs
7. *LightSwap* (ePrint 2022/1650), een variant waarbij maar één chain timelocks nodig heeft: https://eprint.iacr.org/2022/1650
