# Plan: eigenwallet-fork met ETH → XMR

> **Status:** de fork van eigenwallet/core is gemaakt (zie [FORK.md](FORK.md)). Er is nog geen eigen code. BTC → XMR werkt zoals upstream, en ETH → XMR moet nog gebouwd worden. Gebruik niets uit deze fork met echt geld zonder eigen tests en een audit.

**Richting:** één richting, net als eigenwallet. De **taker** koopt XMR met BTC (bestaat al) of **ETH** (nieuw). De **maker** (`asb`) verkoopt XMR.

## Documenten
1. [Vergelijkbare projecten](01-vergelijkbare-projecten.md): eigenwallet, AthanorLabs, BasicSwap, Farcaster, Haveno, Bisq, Serai.
2. [Hoe het protocol werkt](02-protocol.md): key-splitting, adaptor signatures, DLEQ, het ETH-contract, en de refund- en punish-paden.
3. [Stappenplan](03-stappenplan.md): de fases om ETH → XMR in deze fork te bouwen.
4. [Beveiliging](04-beveiliging.md): threat model en checklist.
5. [Fork-administratie](FORK.md): upstream, wijzigingen, upstream bijhouden, bouwen.
6. [Wagyu.xyz analysis](05-wagyu-analysis.md): how it works, whether it is custodial (yes, in practice), the Nov 2026 hack, and lessons (EN).
7. [`hypurswap/`](../hypurswap/README.md): hypurswap, the custodial, DEX-routed swap service built from that analysis (EN).

## Belangrijkste punten
- **BTC → XMR hoef je niet te bouwen.** Dat is precies wat eigenwallet doet en wat je nu in de fork hebt. Interface: de taker koopt via de Tauri-GUI en beheert swaps met de `swap` CLI. De maker gebruikt `asb` met de `asb-controller` REPL in de terminal.
- **Het echte werk is ETH → XMR.** Dat betekent een nieuw smart contract, een ETH-wallet in maker en taker, een nieuwe state machine, nieuwe p2p-berichten, en ETH in de GUI.
- **Voor ETH ⇄ XMR is er geen onderhouden referentie.** AthanorLabs is gearchiveerd en niet geaudit. Het contract moet dus grondig getest en geaudit worden.
- **Bijkomend voordeel van deze richting:** de ETH-kant (taker) heeft zelf ETH en kan dus gas betalen. De maker krijgt ETH binnen via `claim()` en moet daarvoor een klein beetje ETH voor gas aanhouden. Een relayer is daardoor niet nodig.
