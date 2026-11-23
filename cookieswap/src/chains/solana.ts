import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  type Commitment,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type KeyPairSigner,
  pipe,
  type Rpc,
  type SolanaRpcApi,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { mnemonicToSeedSync } from "bip39";
import type { AssetId } from "../assets";
import { base58Encode } from "../validate/base58";
import type { ChainWallet, DepositInfo, Fee, SendRequest, SendResult, SendSource } from "./types";

/** Two signatures + rent for creating the recipient's token account if it is missing. */
const FEE_ESTIMATE_LAMPORTS = 2 * 5_000 + 2_039_280;
/** Native SOL transfer: two signatures (inventory fee payer + deposit owner). */
const SOL_TRANSFER_FEE_LAMPORTS = 2 * 5_000;
const CONFIRM_TIMEOUT_MS = 90_000;
/** PKCS#8 DER prefix for a raw 32-byte Ed25519 private key. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type SolanaRpc = Rpc<SolanaRpcApi>;
export interface Lifetime {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

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

  private privateKey(source: SendSource): Uint8Array {
    if (source.kind === "deposit" && source.index === 0) throw new Error("deposit index 0 is the inventory account");
    return slip10Ed25519(this.seed, [44, 501, source.kind === "deposit" ? source.index : 0, 0]);
  }

  /** Public address, derived synchronously (no signer needed). */
  address(source: SendSource): Address {
    const key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, this.privateKey(source)]), format: "der", type: "pkcs8" });
    const spki = createPublicKey(key).export({ format: "der", type: "spki" });
    return address(base58Encode(Uint8Array.from(spki.subarray(spki.length - 32))));
  }

  /** Signer for transactions (WebCrypto Ed25519 key pair). */
  signer(source: SendSource): Promise<KeyPairSigner> {
    return createKeyPairSignerFromPrivateKeyBytes(this.privateKey(source));
  }
}

/**
 * SPL token hot wallet (USDT/USDC on Solana), built on @solana/kit.
 * Deposits land in the deposit owner's associated token account. When forwarding, the inventory
 * account pays the transaction fee (and the rent for the recipient's token account if missing),
 * so deposit addresses never need SOL.
 */
export class SplWallet implements ChainWallet {
  readonly chain = "SOL" as const;
  private mint: Address;

  constructor(
    readonly asset: AssetId,
    mint: string,
    private decimals: number,
    private keys: SolanaKeys,
    private rpc: SolanaRpc,
  ) {
    this.mint = address(mint);
  }

  static connect(url: string): SolanaRpc {
    return createSolanaRpc(url);
  }

  async depositAddress(index: number) {
    return { address: this.keys.address({ kind: "deposit", index }), index };
  }

  async inventoryAddress() {
    return this.keys.address({ kind: "inventory" });
  }

  private async ata(owner: Address): Promise<Address> {
    const [pda] = await findAssociatedTokenPda({ owner, mint: this.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    return pda;
  }

  /** Sum of all token accounts of `owner` for this mint. */
  private async tokenBalance(owner: Address, commitment: Commitment): Promise<bigint> {
    const r = await this.rpc
      .getTokenAccountsByOwner(owner, { mint: this.mint }, { encoding: "jsonParsed", commitment })
      .send();
    return r.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async getDeposit(addr: string): Promise<DepositInfo> {
    const owner = address(addr);
    const [seen, confirmed] = await Promise.all([this.tokenBalance(owner, "confirmed"), this.tokenBalance(owner, "finalized")]);
    return { seen, confirmed, txids: [] };
  }

  async inventoryBalance(): Promise<bigint> {
    return this.tokenBalance(this.keys.address({ kind: "inventory" }), "finalized");
  }

  async gasBalance(): Promise<Fee> {
    const r = await this.rpc.getBalance(this.keys.address({ kind: "inventory" }), { commitment: "confirmed" }).send();
    return { asset: "SOL", amount: BigInt(r.value) };
  }

  async estimateSendFee(memo: boolean): Promise<Fee> {
    if (memo) throw new Error("memo transfers are not supported on Solana");
    return { asset: "SOL", amount: BigInt(FEE_ESTIMATE_LAMPORTS) };
  }

  /**
   * Transfer from `source`'s associated token account to `to`'s (created idempotently),
   * with the inventory account as fee payer. Returns the message and the signed transaction (not sent).
   */
  async buildTransfer(source: KeyPairSigner, payer: KeyPairSigner, to: string, amount: bigint, lifetime: Lifetime) {
    const owner = address(to);
    const [sourceAta, destAta] = await Promise.all([this.ata(source.address), this.ata(owner)]);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions([
        getCreateAssociatedTokenIdempotentInstruction({ payer, ata: destAta, owner, mint: this.mint }),
        getTransferCheckedInstruction({
          source: sourceAta, mint: this.mint, destination: destAta, authority: source, amount, decimals: this.decimals,
        }),
      ], m),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    return { message, transaction, sourceAta, destAta };
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (req.memo) throw new Error("memo transfers are not supported on Solana");
    const payer = await this.keys.signer({ kind: "inventory" });
    // One signer object per address: kit refuses two distinct signers for the same account.
    const source = req.from.kind === "inventory" ? payer : await this.keys.signer(req.from);
    // Only the associated token account is spent; funds in other token accounts need manual handling.
    const bal = await this.rpc.getTokenAccountBalance(await this.ata(source.address), { commitment: "confirmed" }).send();
    const balance = BigInt(bal.value.amount);
    const amount = req.amount === "all" ? balance : req.amount;
    if (amount <= 0n) throw new Error("nothing to send");
    if (amount > balance) throw new Error(`insufficient ${this.asset} in the associated token account: have ${balance}, need ${amount}`);

    const { value: lifetime } = await this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const { transaction } = await this.buildTransfer(source, payer, req.to, amount, lifetime);
    const signature = await submitAndConfirm(this.rpc, transaction, lifetime.lastValidBlockHeight);
    return { txid: signature, amount, fee: BigInt(FEE_ESTIMATE_LAMPORTS) };
  }
}

type SignedTx = Awaited<ReturnType<typeof signTransactionMessageWithSigners>>;

/** Send a signed transaction and poll until confirmed; fail on a transaction error or once the blockhash has expired. */
async function submitAndConfirm(rpc: SolanaRpc, transaction: SignedTx, lastValidBlockHeight: bigint): Promise<string> {
  const signature = getSignatureFromTransaction(transaction);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value: [status] } = await rpc.getSignatureStatuses([signature]).send();
    if (status?.err) throw new Error(`solana transfer ${signature} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
    if (height > lastValidBlockHeight) throw new Error(`solana transfer ${signature} expired before confirmation`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`solana transfer ${signature} not confirmed after ${CONFIRM_TIMEOUT_MS / 1000}s`);
}

/**
 * Native SOL hot wallet. The inventory account pays the fee, so a deposit can be forwarded in full
 * (the emptied deposit account simply closes).
 */
export class SolWallet implements ChainWallet {
  readonly chain = "SOL" as const;
  readonly asset = "SOL" as const;

  constructor(
    private keys: SolanaKeys,
    private rpc: SolanaRpc,
  ) {}

  async depositAddress(index: number) {
    return { address: this.keys.address({ kind: "deposit", index }), index };
  }

  async inventoryAddress() {
    return this.keys.address({ kind: "inventory" });
  }

  private async lamports(owner: Address, commitment: Commitment): Promise<bigint> {
    return BigInt((await this.rpc.getBalance(owner, { commitment }).send()).value);
  }

  async getDeposit(addr: string): Promise<DepositInfo> {
    const owner = address(addr);
    const [seen, confirmed] = await Promise.all([this.lamports(owner, "confirmed"), this.lamports(owner, "finalized")]);
    return { seen, confirmed, txids: [] };
  }

  async inventoryBalance(): Promise<bigint> {
    return this.lamports(this.keys.address({ kind: "inventory" }), "finalized");
  }

  async estimateSendFee(memo: boolean): Promise<Fee> {
    if (memo) throw new Error("memo transfers are not supported on Solana");
    return { asset: "SOL", amount: BigInt(SOL_TRANSFER_FEE_LAMPORTS) };
  }

  /** System transfer from `source` to `to`, fee paid by `payer`. Signed, not sent. */
  async buildTransfer(source: KeyPairSigner, payer: KeyPairSigner, to: string, amount: bigint, lifetime: Lifetime) {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source, destination: address(to), amount })], m),
    );
    return { message, transaction: await signTransactionMessageWithSigners(message) };
  }

  async send(req: SendRequest): Promise<SendResult> {
    if (req.memo) throw new Error("memo transfers are not supported on Solana");
    const payer = await this.keys.signer({ kind: "inventory" });
    const source = req.from.kind === "inventory" ? payer : await this.keys.signer(req.from);
    const balance = await this.lamports(source.address, "confirmed");
    // The inventory pays its own fee when it is the source, so keep that much back.
    const reserve = req.from.kind === "inventory" ? BigInt(SOL_TRANSFER_FEE_LAMPORTS) : 0n;
    const amount = req.amount === "all" ? balance - reserve : req.amount;
    if (amount <= 0n) throw new Error("nothing to send");
    if (amount + reserve > balance) throw new Error(`insufficient SOL: have ${balance}, need ${amount + reserve}`);
    const { value: lifetime } = await this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const { transaction } = await this.buildTransfer(source, payer, req.to, amount, lifetime);
    const signature = await submitAndConfirm(this.rpc, transaction, lifetime.lastValidBlockHeight);
    return { txid: signature, amount, fee: BigInt(SOL_TRANSFER_FEE_LAMPORTS) };
  }
}
