import { BIP32Factory, type BIP32Interface } from "bip32";
import { mnemonicToSeedSync } from "bip39";
import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import type { AssetId, ChainId, Network } from "../assets";
import { LITECOIN } from "../validate/chains";
import { fetchJson } from "../log";
import type { ChainWallet, DepositInfo, Fee, SendRequest, SendResult } from "./types";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

interface Utxo { txid: string; vout: number; value: number; status: { confirmed: boolean; block_height?: number } }

/** A UTXO coin with BIP84 (native segwit) support. */
export interface UtxoCoin {
  network: bitcoin.Network;
  /** BIP44 coin type. */
  coinType: number;
}

export const LITECOIN_COIN: UtxoCoin = { network: LITECOIN, coinType: 2 };

/** Pure derivation: m/84'/coin'/0'/0/i for deposits, m/84'/coin'/1'/0/0 for inventory. */
export class BtcKeys {
  readonly network: bitcoin.Network;
  private root: BIP32Interface;
  private coin: number;

  /** Bitcoin by default; pass `LITECOIN_COIN` for Litecoin (mainnet only). */
  constructor(mnemonic: string, net: Network, coin?: UtxoCoin) {
    this.network = coin?.network ?? (net === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet);
    this.coin = coin?.coinType ?? (net === "mainnet" ? 0 : 1);
    this.root = bip32.fromSeed(mnemonicToSeedSync(mnemonic), this.network);
  }

  node(source: { kind: "deposit"; index: number } | { kind: "inventory" }): BIP32Interface {
    return source.kind === "deposit"
      ? this.root.derivePath(`m/84'/${this.coin}'/0'/0/${source.index}`)
      : this.root.derivePath(`m/84'/${this.coin}'/1'/0/0`);
  }

  address(source: { kind: "deposit"; index: number } | { kind: "inventory" }): string {
    return bitcoin.payments.p2wpkh({ pubkey: this.node(source).publicKey, network: this.network }).address!;
  }
}

/** Approximate vsizes for a P2WPKH spend. */
const VBYTES = { overhead: 11, input: 68, output: 43, opReturn: 11 + 80 };

export interface UtxoWalletOptions {
  asset: AssetId;
  chain: ChainId;
  /** "esplora": GET /fee-estimates (blockstream). "mempool": GET /v1/fees/recommended (mempool.space forks, litecoinspace). */
  feeApi: "esplora" | "mempool";
}

/** Bitcoin-family (BTC, LTC) hot wallet backed by an Esplora/mempool HTTP API. */
export class BtcWallet implements ChainWallet {
  readonly asset: AssetId;
  readonly chain: ChainId;
  private feeApi: UtxoWalletOptions["feeApi"];

  constructor(
    private keys: BtcKeys,
    private esplora: string,
    private confirmations: number,
    opts: UtxoWalletOptions = { asset: "BTC", chain: "BTC", feeApi: "esplora" },
  ) {
    this.asset = opts.asset;
    this.chain = opts.chain;
    this.feeApi = opts.feeApi;
  }

  async depositAddress(index: number) {
    return { address: this.keys.address({ kind: "deposit", index }), index };
  }

  async inventoryAddress() {
    return this.keys.address({ kind: "inventory" });
  }

  private async utxos(address: string): Promise<(Utxo & { confs: number })[]> {
    const [list, tip] = await Promise.all([
      fetchJson<Utxo[]>(`${this.esplora}/address/${address}/utxo`),
      fetchJson<number>(`${this.esplora}/blocks/tip/height`),
    ]);
    return list.map((u) => ({
      ...u,
      confs: u.status.confirmed && u.status.block_height ? tip - u.status.block_height + 1 : 0,
    }));
  }

  async getDeposit(address: string): Promise<DepositInfo> {
    const list = await this.utxos(address);
    let seen = 0n;
    let confirmed = 0n;
    for (const u of list) {
      seen += BigInt(u.value);
      if (u.confs >= this.confirmations) confirmed += BigInt(u.value);
    }
    return { seen, confirmed, txids: [...new Set(list.map((u) => u.txid))] };
  }

  async inventoryBalance(): Promise<bigint> {
    const list = await this.utxos(await this.inventoryAddress());
    return list.filter((u) => u.confs >= 1).reduce((s, u) => s + BigInt(u.value), 0n);
  }

  private async feeRate(): Promise<number> {
    if (this.feeApi === "mempool") {
      const rec = await fetchJson<{ halfHourFee: number }>(`${this.esplora}/v1/fees/recommended`);
      return Math.max(1, Math.ceil(rec.halfHourFee));
    }
    const est = await fetchJson<Record<string, number>>(`${this.esplora}/fee-estimates`);
    const target = est["3"] ?? est["6"];
    if (target === undefined) throw new Error("esplora fee-estimates without a 3/6-block target");
    return Math.max(1, Math.ceil(target));
  }

  async estimateSendFee(memo: boolean): Promise<Fee> {
    const vsize = VBYTES.overhead + VBYTES.input + 2 * VBYTES.output + (memo ? VBYTES.opReturn : 0);
    return { asset: this.asset, amount: BigInt(vsize * (await this.feeRate())) };
  }

  async send(req: SendRequest): Promise<SendResult> {
    const sourceAddress = this.keys.address(req.from);
    const node = this.keys.node(req.from);
    const signer = ECPair.fromPrivateKey(node.privateKey!, { network: this.keys.network });
    const minConfs = req.from.kind === "deposit" ? this.confirmations : 1;
    const utxos = (await this.utxos(sourceAddress)).filter((u) => u.confs >= minConfs);
    if (utxos.length === 0) throw new Error("no spendable UTXOs");
    const total = utxos.reduce((s, u) => s + BigInt(u.value), 0n);
    const rate = BigInt(await this.feeRate());
    const script = bitcoin.address.toOutputScript(sourceAddress, this.keys.network);
    const change = await this.inventoryAddress();

    const build = (fee: bigint): { psbt: bitcoin.Psbt; amount: bigint } => {
      const amount = req.amount === "all" ? total - fee : req.amount;
      const rest = total - amount - fee;
      if (amount <= 546n) throw new Error("amount below dust after fee");
      if (rest < 0n) throw new Error("insufficient funds");
      const psbt = new bitcoin.Psbt({ network: this.keys.network });
      for (const u of utxos) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script, value: BigInt(u.value) } });
      // THORChain: first output = vault, then OP_RETURN memo, then change.
      psbt.addOutput({ address: req.to, value: amount });
      if (req.memo) {
        const data = Buffer.from(req.memo, "utf8");
        if (data.length > 80) throw new Error("memo longer than 80 bytes");
        psbt.addOutput({ script: bitcoin.payments.embed({ data: [data] }).output!, value: 0n });
      }
      if (rest > 546n) psbt.addOutput({ address: change, value: rest });
      psbt.signAllInputs(signer);
      psbt.finalizeAllInputs();
      return { psbt, amount };
    };

    // Two passes: estimate, then size the fee on the real signed transaction.
    let { psbt } = build(BigInt(this.estimateVsize(utxos.length, !!req.memo)) * rate);
    const fee = BigInt(psbt.extractTransaction().virtualSize()) * rate;
    const final = build(fee);
    const hex = final.psbt.extractTransaction().toHex();
    const res = await fetch(`${this.esplora}/tx`, { method: "POST", body: hex });
    const txid = (await res.text()).trim();
    if (!res.ok) throw new Error(`broadcast failed: ${txid.slice(0, 300)}`);
    return { txid, amount: final.amount, fee };
  }

  private estimateVsize(inputs: number, memo: boolean): number {
    return VBYTES.overhead + inputs * VBYTES.input + 2 * VBYTES.output + (memo ? VBYTES.opReturn : 0);
  }
}
