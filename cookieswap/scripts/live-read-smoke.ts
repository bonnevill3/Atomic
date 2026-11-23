// Read-only smoke test of the live chain backends with a throwaway key (nothing is sent).
import { generateMnemonic } from "bip39";
import { BtcKeys, BtcWallet } from "../src/chains/btc";
import { EvmKeys, EvmRpc, EvmWallet } from "../src/chains/evm";
import { SolanaKeys, SplWallet } from "../src/chains/solana";

const m = generateMnemonic(256); // throwaway, never printed
const btc = new BtcWallet(new BtcKeys(m, "mainnet"), "https://blockstream.info/api", 2);
const eth = new EvmWallet(new EvmKeys(m), new EvmRpc("ETH", "mainnet"), 12);
const usdcSol = new SplWallet(
  "USDC-SOL", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 6, new SolanaKeys(m),
  SplWallet.connect("https://api.mainnet-beta.solana.com"),
);

async function main() {
  const b = await btc.depositAddress(1);
  const e = await eth.depositAddress(1);
  const s = await usdcSol.depositAddress(1);
  console.log("BTC deposit", b.address, await btc.getDeposit(b.address), "fee(memo)", await btc.estimateSendFee(true));
  console.log("ETH deposit", e.address, await eth.getDeposit(e.address), "fee(memo)", await eth.estimateSendFee(true));
  console.log("USDC-SOL deposit", s.address, await usdcSol.getDeposit(s.address), "gas", await usdcSol.gasBalance());
  console.log("inventory BTC", await btc.inventoryBalance(), "ETH", await eth.inventoryBalance(), "USDC-SOL", await usdcSol.inventoryBalance());
}
main();
