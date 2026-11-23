# 4. Beveiliging: threat model en checklist

## Threat model (kort)

| Aanvaller | Wil | Belangrijkste verdediging |
|---|---|---|
| Kwaadwillende tegenpartij | jouw XMR krijgen zonder te betalen | DLEQ verifiëren, pas locken na finality, timelock-marges |
| Tegenpartij die afhaakt (griefing) | jouw liquiditeit urenlang vastzetten | rate-limits, limieten voor onbekende peers, anti-spam-fee |
| Netwerkaanvaller | swaps koppelen aan je IP of identiteit | Tor standaard, geen hergebruik van adressen |
| Chain-reorg of double-spend | een lock terugdraaien nadat jij hebt gelockt | genoeg confirmaties, ETH alleen `finalized` |
| Mempool-observant / front-runner | geheimen uit pending transacties misbruiken | uitbetaling naar een vast adres, ruime marges vóór deadlines |
| Malware of diefstal van het apparaat | seed of swap-geheimen stelen | versleutelde opslag, zeroize, nooit loggen |
| Supply chain | een gemanipuleerde dependency | gepinde dependencies, `cargo-audit`/`cargo-deny`, reproduceerbare builds |

## Checklist

### Cryptografie
- [ ] DLEQ-bewijzen van de tegenpartij **altijd** verifiëren vóór je XMR lockt. Een fout bewijs betekent direct afbreken.
- [ ] Alle ontvangen publieke sleutels controleren: geldig punt, niet de identiteit, en (ed25519) geen kleine-subgroep-punt.
- [ ] Adaptor signatures van de tegenpartij verifiëren vóórdat je erop vertrouwt.
- [ ] Bestaande, gebruikte libraries gebruiken (`ecdsa_fun`, `sigma_fun`, `curve25519-dalek`, `k256`/`secp256k1`). Geen eigen crypto-primitieven.
- [ ] Goede randomness (`OsRng`). Sleutels per swap deterministisch uit de seed, zodat herstel kan.

### Bitcoin
- [ ] Bedrag, script en sleutels van `TxLock` exact controleren.
- [ ] Pas XMR locken na voldoende confirmaties, afhankelijk van het bedrag (instelbaar). Nooit op een onbevestigde of RBF-vervangbare lock vertrouwen.
- [ ] Alleen XMR locken als er nog **ruim** tijd is tot de cancel-timelock, bijv. minstens de helft van `T1`.
- [ ] Redeem met een fee die ruim op tijd bevestigt. Houd rekening met mempool-drukte en plan CPFP als noodoptie.
- [ ] Bewaar alle vooraf getekende transacties (cancel, refund, punish) in de DB vóórdat je verder gaat.

### Ethereum en het contract
- [ ] Alleen vertrouwen op een **finalized** blok (~13 min) vóór je XMR lockt.
- [ ] Controleren dat het contract het juiste adres en de juiste code-hash heeft, en dat de swap-struct klopt: bedrag, claimer-adres, commitments, `t0`/`t1` en asset.
- [ ] Uitbetaling **altijd** naar het vooraf vastgelegde adres, nooit naar `msg.sender`. Zo heeft front-runnen van `claim` geen zin.
- [ ] Checks-effects-interactions, reentrancy-guard, en geen `tx.origin`.
- [ ] Een swap kan maar één keer worden afgewikkeld (claim **of** refund), afgedwongen in de contract-state.
- [ ] Scalar `s` controleren: `0 < s < n`. Ook afvangen dat `ecrecover` het nul-adres teruggeeft.
- [ ] Relayer-handtekening (EIP-712) bevat chain-id, contractadres, swap-id, fee en nonce, als bescherming tegen replay.
- [ ] Claim ruim vóór `t1`, met minstens enkele uren marge.
- [ ] Foundry fuzz- en invariant-tests, Slither, en een externe audit.

### Monero
- [ ] De tegenpartij controleert de XMR-lock met de gedeelde view key: het juiste adres, bedrag ≥ afgesproken, en 10 confirmaties.
- [ ] Houd rekening met de 10-blok-lock van Monero-outputs vóór je ze kunt sweepen.
- [ ] Restore-height per swap opslaan, zodat scannen snel gaat.
- [ ] Bestudeer de Monero-double-spend-fix uit eigenwallet 4.15 (sept 2026, volgens release-overzichten). Dit soort aanvallen speelt echt.
- [ ] Wees voorbereid op de FCMP++/Carrot-hardfork: Monero-logica achter een interface, en testen op testnetten zodra die fork daar draait.

### Toestand en herstel
- [ ] **Write-ahead:** sla de nieuwe toestand op (in een DB-transactie) **vóór** elk bericht of elke transactie.
- [ ] Na een herstart worden alle lopende swaps automatisch hervat.
- [ ] Elke toestand heeft een "deadline-actie": wat de daemon doet als een timelock nadert.
- [ ] Crash-tests in elke toestand (zie fase 3).
- [ ] Herstel uit seed + DB-backup getest. De DB bevat geheimen, dus backups versleutelen.

### Netwerk en privacy
- [ ] Standaard Tor. Clearnet alleen bewust en met een waarschuwing.
- [ ] Nieuwe adressen per swap (BTC/ETH-ontvangst, XMR-refund).
- [ ] Bedenk dat on-chain patronen herkenbaar zijn: 2-van-2 P2WSH en het tijdstip van locks. Taproot met MuSig2 maakt BTC-locks minder herkenbaar (latere verbetering).
- [ ] Berichten met maximale groottes en versienummers, en fuzzing van de parser.

### Sleutelbeheer en software
- [ ] Seed versleuteld op schijf (bijv. Argon2id + ChaCha20-Poly1305).
- [ ] Geheimen `zeroize`, nooit in logs, crash-dumps of foutmeldingen.
- [ ] `cargo-audit` + `cargo-deny` in CI, en gepinde versies (`Cargo.lock` in git).
- [ ] Reproduceerbare builds en gesigneerde releases.

### Operationeel
- [ ] Limieten per swap en per peer, die je later kunt verhogen.
- [ ] Een kill-switch voor **nieuwe** swaps. Lopende swaps altijd laten afronden.
- [ ] De gebruiker duidelijk laten weten dat atomicd moet blijven draaien tot de swap klaar is.
- [ ] Monitoring van daemon-status, node-verbindingen en naderende deadlines.
