// Read-only smoke test of the live chain backends with a throwaway key (nothing is sent).
import { generateMnemonic } from "bip39";
import { BtcKeys, BtcWallet } from "../src/chains/btc";
import { EvmKeys, EvmWallet } from "../src/chains/evm";
const m = generateMnemonic(256); // throwaway, never printed
const btc = new BtcWallet(new BtcKeys(m, "mainnet"), "https://blockstream.info/api", 2);
const eth = new EvmWallet(new EvmKeys(m), "mainnet", undefined, 12);
async function main() {
  const b = await btc.depositAddress(1);
  const e = await eth.depositAddress(1);
  console.log("BTC deposit", b.address, await btc.getDeposit(b.address), "fee(memo) sats", await btc.estimateSendFee(true));
  console.log("ETH deposit", e.address, await eth.getDeposit(e.address), "fee(memo) wei", await eth.estimateSendFee(true));
  console.log("inventory BTC", await btc.inventoryBalance(), "ETH", await eth.inventoryBalance());
}
main();

