import { createHmac } from "node:crypto";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { type Commitment, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { mnemonicToSeedSync } from "bip39";
import type { AssetId } from "../assets";
import type { ChainWallet, DepositInfo, Fee, SendRequest, SendResult, SendSource } from "./types";

/** Two signatures + rent for creating the recipient's token account if it is missing. */
const FEE_ESTIMATE_LAMPORTS = 2 * 5_000 + 2_039_280;

/** SLIP-0010 ed25519 derivation (hardened only). */
export function slip10Ed25519(seed: Uint8Array, path: number[]): Uint8Array {
  let I = createHmac("sha512", "ed25519 seed").update(seed).digest();
  let key = I.subarray(0, 32);
  let chain = I.subarray(32);
  for (const index of path) {
    const data = Buffer.alloc(37);
    key.copy(data, 1);
    data.writeUInt32BE((index | 0x80000000) >>> 0, 33);
    I = createHmac("sha512", chain).update(data).digest();
    key = I.subarray(0, 32);
    chain = I.subarray(32);
  }
  return Uint8Array.from(key);
}

/** Phantom/Solflare layout m/44'/501'/i'/0': index 0 = inventory, 1.. = per-order deposits. */
export class SolanaKeys {
  private seed: Uint8Array;

  constructor(mnemonic: string) {
    this.seed = mnemonicToSeedSync(mnemonic);
  }

  keypair(source: SendSource): Keypair {
    const i = source.kind === "deposit" ? source.index : 0;
    if (source.kind === "deposit" && i === 0) throw new Error("deposit index 0 is the inventory account");
    return Keypair.fromSeed(slip10Ed25519(this.seed, [44, 501, i, 0]));
  }
}

/**
 * SPL token hot wallet (USDT/USDC on Solana). Deposits land in the deposit owner's associated
 * token account. When forwarding, the inventory account pays the transaction fee (and the rent
 * for the recipient's token account if missing), so deposit addresses never need SOL.
 */
export class SplWallet implements ChainWallet {
  readonly chain = "SOL" as const;
  private mint: PublicKey;

  constructor(
    readonly asset: AssetId,
    mint: string,
    private decimals: number,
    private keys: SolanaKeys,
    private connection: Connection,
  ) {
    this.mint = new PublicKey(mint);
  }

  static connect(url: string): Connection {
    return new Connection(url, "confirmed");
  }

  async depositAddress(index: number) {
    return { address: this.keys.keypair({ kind: "deposit", index }).publicKey.toBase58(), index };
  }

  async inventoryAddress() {
    return this.keys.keypair({ kind: "inventory" }).publicKey.toBase58();
  }

  /** Sum of all token accounts of `owner` for this mint. */
  private async tokenBalance(owner: PublicKey, commitment: Commitment): Promise<bigint> {
    const r = await this.connection.getParsedTokenAccountsByOwner(owner, { mint: this.mint }, commitment);
    return r.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n);
  }

  async getDeposit(address: string): Promise<DepositInfo> {
    const owner = new PublicKey(address);
    const [seen, confirmed] = await Promise.all([this.tokenBalance(owner, "confirmed"), this.tokenBalance(owner, "finalized")]);
    return { seen, confirmed, txids: [] };
  }

  async inventoryBalance(): Promise<bigint> {
    return this.tokenBalance(this.keys.keypair({ kind: "inventory" }).publicKey, "finalized");
  }

  async gasBalance(): Promise<Fee> {
    return { asset: "SOL", amount: BigInt(await this.connection.getBalance(this.keys.keypair({ kind: "inventory" }).publicKey, "confirmed")) };
  }

  async estimateSendFee(memo: boolean): Promise<Fee> {
    if (memo) throw new Error("memo transfers are not supported on Solana");
    return { asset: "SOL", amount: BigInt(FEE_ESTIMATE_LAMPORTS) };
  }

  /**
   * Transfer from `source`'s associated token account to `to`'s (created idempotently).
   * Fee payer: inventory account. Signed, not sent.
   */
  buildTransfer(source: Keypair, payer: Keypair, to: string, amount: bigint, recentBlockhash: string): Transaction {
    const destOwner = new PublicKey(to);
    const sourceAta = getAssociatedTokenAddressSync(this.mint, source.publicKey);
    const destAta = getAssociatedTokenAddressSync(this.mint, destOwner, true);
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash }).add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destAta, destOwner, this.mint),
      createTransferCheckedInstruction(sourceAta, this.mint, destAta, source.publicKey, amount, this.decimals),
    );
    const signers = source.publicKey.equals(payer.publicKey) ? [payer] : [payer, source];
    tx.sign(...signers);
    return tx;
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (req.memo) throw new Error("memo transfers are not supported on Solana");
    const source = this.keys.keypair(req.from);
    const payer = this.keys.keypair({ kind: "inventory" });
    const ata = getAssociatedTokenAddressSync(this.mint, source.publicKey);
    // Only the associated token account is spent; funds in other token accounts need manual handling.
    const bal = await this.connection.getTokenAccountBalance(ata, "confirmed");
    const balance = BigInt(bal.value.amount);
    const amount = req.amount === "all" ? balance : req.amount;
    if (amount <= 0n) throw new Error("nothing to send");
    if (amount > balance) throw new Error(`insufficient ${this.asset} in the associated token account: have ${balance}, need ${amount}`);

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const tx = this.buildTransfer(source, payer, req.to, amount, blockhash);
    const signature = await this.connection.sendRawTransaction(tx.serialize());
    const res = await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`solana transfer ${signature} failed: ${JSON.stringify(res.value.err)}`);
    return { txid: signature, amount, fee: BigInt(FEE_ESTIMATE_LAMPORTS) };
  }
}
