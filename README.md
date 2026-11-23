# Atomic: XMR ⇄ BTC/ETH atomic swaps

> **Status: planfase.** Er is nog geen code. Gebruik niets uit deze repo met echt geld.

Doel: een eigenwallet-achtige app waarmee je **Monero (XMR) verkoopt voor Bitcoin (BTC) of Ethereum (ETH)** via een trustless atomic swap. Er is geen exchange, geen account en geen tussenpartij, en de swap loopt p2p over Tor. De interface is een terminal-UI (TUI), met optioneel een basis-GUI.

## Documentatie
1. [Vergelijkbare projecten](docs/01-vergelijkbare-projecten.md): eigenwallet, AthanorLabs, BasicSwap, Farcaster, Haveno, Bisq, Serai. Wat je ervan kunt leren en hergebruiken.
2. [Hoe het protocol werkt](docs/02-protocol.md): key-splitting, adaptor signatures, DLEQ, het ETH-contract, en de refund- en punish-paden.
3. [Stappenplan](docs/03-stappenplan.md): architectuur, tech-stack, fases 0–9 met "klaar wanneer"-criteria, en TUI-ontwerp.
4. [Beveiliging](docs/04-beveiliging.md): threat model en checklist.

## De belangrijkste conclusies
- **Wat jij wilt (XMR → BTC) doet eigenwallet al aan de maker-kant (`asb`).** De eigenwallet-app zelf werkt alleen andersom: BTC erin, XMR eruit. Nieuw zijn bij jou (1) **ETH** en (2) een app waarmee een XMR-verkoper als **taker** handelt.
- **De chain met scripts (BTC/ETH) lockt altijd eerst en XMR als tweede.** Dat is gunstig voor jou als XMR-verkoper, maar je moet online blijven tot de swap klaar is.
- **Voor ETH ⇄ XMR is er geen onderhouden referentie.** AthanorLabs is sinds sept 2026 gearchiveerd en nooit geaudit. Het ETH-contract is dus nieuw werk en moet geaudit worden.
- **Aanbevolen route:** forken van [eigenwallet/core](https://github.com/eigenwallet/core) (Rust, GPL-3.0). Daarna een ETH-module, de XMR-verkoper-als-taker-flow en een `ratatui`-TUI toevoegen.
