import { BIP32Factory } from "bip32";
import { mnemonicToSeedSync } from "bip39";
import * as ecc from "tiny-secp256k1";
import { type Hex, toHex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { type AssetId, base58CheckEncode } from "../assets";
import { fetchJson, log } from "../log";
import { base58Decode } from "../validate/base58";
import { encodeRawTx, encodeSignedTx, refBlock, type TronContract, txId } from "./tronTx";
import type { ChainWallet, DepositInfo, Fee, SendRequest, SendResult, SendSource } from "./types";

const bip32 = BIP32Factory(ecc);

/** Worst case for a USDT transfer to an address that never held USDT. */
const ENERGY_WORST_CASE = 130_000n;
const TX_BYTES = 350n;
const TOPUP_TIMEOUT_MS = 120_000;

/** 21-byte Tron account id (0x41 + 20 bytes) from a base58 address. */
export function tronHex(address: string): Uint8Array {
  const raw = base58Decode(address);
  if (!raw || raw.length !== 25 || raw[0] !== 0x41) throw new Error(`invalid Tron address ${address}`);
  return raw.slice(0, 21);
}

export interface TronAccount {
  address: string;
  id: Uint8Array;
  privateKey: Hex;
}

/** BIP44 coin 195: m/44'/195'/0'/0/i for deposits, m/44'/195'/1'/0/0 for inventory. */
export class TronKeys {
  private root;

  constructor(mnemonic: string) {
    this.root = bip32.fromSeed(mnemonicToSeedSync(mnemonic));
  }

  account(source: SendSource): TronAccount {
    const node = source.kind === "deposit"
      ? this.root.derivePath(`m/44'/195'/0'/0/${source.index}`)
      : this.root.derivePath(`m/44'/195'/1'/0/0`);
    const privateKey = toHex(node.privateKey!);
    // Tron uses the same 20-byte account hash as Ethereum, prefixed with 0x41.
    const evm = privateKeyToAccount(privateKey).address;
    const id = Uint8Array.from([0x41, ...Buffer.from(evm.slice(2), "hex")]);
    return { address: base58CheckEncode(id), id, privateKey };
  }
}

export class TronApi {
  constructor(
    private base: string,
    private apiKey?: string,
  ) {}

  post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["TRON-PRO-API-KEY"] = this.apiKey;
    return fetchJson<T>(`${this.base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  }
}

const pad32 = (b: Uint8Array) => Buffer.concat([Buffer.alloc(32 - b.length), Buffer.from(b)]).toString("hex");
const uint256 = (n: bigint) => n.toString(16).padStart(64, "0");

/**
 * TRC-20 hot wallet (USDT on Tron) over the TronGrid HTTP API.
 *
 * Token transfers burn TRX for energy and bandwidth, so before forwarding from a deposit
 * address we top it up with TRX from the inventory account. Transactions are built,
 * hashed and signed locally (see tronTx.ts); the node only provides chain data and relays.
 */
export class TronWallet implements ChainWallet {
  readonly chain = "TRON" as const;
  private tokenId: Uint8Array;
  private params?: { energyFee: bigint; bandwidthFee: bigint; accountFee: bigint; at: number };

  constructor(
    readonly asset: AssetId,
    private token: string,
    private keys: TronKeys,
    private api: TronApi,
  ) {
    this.tokenId = tronHex(token);
  }

  async depositAddress(index: number) {
    return { address: this.keys.account({ kind: "deposit", index }).address, index };
  }

  async inventoryAddress() {
    return this.keys.account({ kind: "inventory" }).address;
  }

  /** `solid`: only solidified (irreversible) blocks. */
  private async balanceOf(owner: string, solid: boolean): Promise<bigint> {
    const r = await this.api.post<{ constant_result?: string[]; result?: { result?: boolean; message?: string } }>(
      `${solid ? "/walletsolidity" : "/wallet"}/triggerconstantcontract`,
      {
        owner_address: owner, contract_address: this.token, function_selector: "balanceOf(address)",
        parameter: pad32(tronHex(owner).slice(1)), visible: true,
      },
    );
    const out = r.constant_result?.[0];
    if (!out) throw new Error(`tron balanceOf failed: ${JSON.stringify(r.result)}`);
    return BigInt(`0x${out}`);
  }

  private async trxBalance(address: string): Promise<bigint> {
    // An account that never received TRX is not activated and has no balance field.
    const r = await this.api.post<{ balance?: number }>("/wallet/getaccount", { address, visible: true });
    return BigInt(r.balance ?? 0);
  }

  private async chainParams() {
    if (this.params && Date.now() - this.params.at < 600_000) return this.params;
    const r = await this.api.post<{ chainParameter: { key: string; value?: number }[] }>("/wallet/getchainparameters", {});
    const get = (key: string) => {
      const p = r.chainParameter.find((x) => x.key === key);
      if (p?.value === undefined) throw new Error(`tron chain parameter ${key} missing`);
      return BigInt(p.value);
    };
    this.params = {
      energyFee: get("getEnergyFee"),
      bandwidthFee: get("getTransactionFee"),
      accountFee: get("getCreateNewAccountFeeInSystemContract") + get("getCreateAccountFee"),
      at: Date.now(),
    };
    return this.params;
  }

  async getDeposit(address: string): Promise<DepositInfo> {
    const [seen, confirmed] = await Promise.all([this.balanceOf(address, false), this.balanceOf(address, true)]);
    return { seen, confirmed, txids: [] };
  }

  async inventoryBalance(): Promise<bigint> {
    return this.balanceOf(await this.inventoryAddress(), true);
  }

  async gasBalance(): Promise<Fee> {
    return { asset: "TRX", amount: await this.trxBalance(await this.inventoryAddress()) };
  }

  /** Worst case: energy for a first-time recipient, bandwidth for two txs, activation of a new deposit account. */
  async estimateSendFee(memo: boolean): Promise<Fee> {
    if (memo) throw new Error("memo transfers are not supported on Tron");
    const p = await this.chainParams();
    return { asset: "TRX", amount: ENERGY_WORST_CASE * p.energyFee + 2n * TX_BYTES * p.bandwidthFee + p.accountFee };
  }

  private transferData(to: string, amount: bigint): Uint8Array {
    return Uint8Array.from(Buffer.from(`a9059cbb${pad32(tronHex(to).slice(1))}${uint256(amount)}`, "hex"));
  }

  /** Energy the transfer would use, simulated by the node. */
  private async simulateEnergy(owner: string, to: string, amount: bigint): Promise<bigint> {
    const r = await this.api.post<{ energy_used?: number; result?: { result?: boolean; message?: string } }>(
      "/wallet/triggerconstantcontract",
      {
        owner_address: owner, contract_address: this.token, function_selector: "transfer(address,uint256)",
        parameter: `${pad32(tronHex(to).slice(1))}${uint256(amount)}`, visible: true,
      },
    );
    if (!r.result?.result || r.energy_used === undefined) throw new Error(`tron transfer simulation failed: ${JSON.stringify(r.result)}`);
    return BigInt(r.energy_used);
  }

  private async signAndBroadcast(account: TronAccount, contract: TronContract, feeLimit?: bigint): Promise<string> {
    const block = await this.api.post<{ blockID: string; block_header: { raw_data: { number: number; timestamp: number } } }>(
      "/wallet/getnowblock", {},
    );
    const raw = encodeRawTx({
      ...refBlock(BigInt(block.block_header.raw_data.number), block.blockID),
      expiration: BigInt(block.block_header.raw_data.timestamp) + 60_000n,
      timestamp: BigInt(Date.now()),
      feeLimit,
      contract,
    });
    const id = txId(raw);
    const sig = await sign({ hash: `0x${id}`, privateKey: account.privateKey });
    const signature = Uint8Array.from([
      ...Buffer.from(sig.r.slice(2).padStart(64, "0"), "hex"),
      ...Buffer.from(sig.s.slice(2).padStart(64, "0"), "hex"),
      27 + (sig.yParity ?? 0),
    ]);
    const r = await this.api.post<{ result?: boolean; code?: string; message?: string }>("/wallet/broadcasthex", {
      transaction: Buffer.from(encodeSignedTx(raw, [signature])).toString("hex"),
    });
    if (!r.result) {
      const msg = r.message ? Buffer.from(r.message, "hex").toString("utf8") : "";
      throw new Error(`tron broadcast failed: ${r.code ?? ""} ${msg}`);
    }
    return id;
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (req.memo) throw new Error("memo transfers are not supported on Tron");
    const account = this.keys.account(req.from);
    const balance = await this.balanceOf(account.address, false);
    const amount = req.amount === "all" ? balance : req.amount;
    if (amount <= 0n) throw new Error("nothing to send");
    if (amount > balance) throw new Error(`insufficient ${this.asset}: have ${balance}, need ${amount}`);

    const p = await this.chainParams();
    const energy = await this.simulateEnergy(account.address, req.to, amount);
    const burn = (energy * p.energyFee * 12n) / 10n + TX_BYTES * p.bandwidthFee;
    const trx = await this.trxBalance(account.address);
    if (trx < burn) {
      if (req.from.kind === "inventory") throw new Error("inventory account has no TRX for energy");
      await this.topUp(account.address, burn - trx);
    }

    const txid = await this.signAndBroadcast(
      account,
      { type: "TriggerSmartContract", owner: account.id, contract: this.tokenId, data: this.transferData(req.to, amount) },
      (burn * 15n) / 10n, // fee_limit: cap on TRX the contract call may burn
    );
    return { txid, amount, fee: burn };
  }

  /** Send TRX from the inventory account and wait until the deposit address holds it. */
  private async topUp(to: string, missing: bigint): Promise<void> {
    const inventory = this.keys.account({ kind: "inventory" });
    const before = await this.trxBalance(to);
    const amount = (missing * 12n) / 10n;
    const txid = await this.signAndBroadcast(inventory, { type: "TransferContract", owner: inventory.id, to: tronHex(to), amount });
    log.info("tron energy top-up sent", { asset: this.asset, to, amount, txid });
    const deadline = Date.now() + TOPUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      if ((await this.trxBalance(to)) >= before + amount) return;
    }
    throw new Error(`tron top-up ${txid} not visible after ${TOPUP_TIMEOUT_MS / 1000}s`);
  }
}
