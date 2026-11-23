import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { slip10Ed25519, SolanaKeys, SplWallet } from "../src/chains/solana";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("SLIP-0010 ed25519", () => {
  // Official SLIP-0010 test vector 1 (seed 000102…0f)
  const seed = Uint8Array.from(Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"));
  it("m/0H", () => {
    expect(Buffer.from(slip10Ed25519(seed, [0])).toString("hex")).toBe("68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");
  });
  it("m/0H/1H/2H/2H/1000000000H", () => {
    expect(Buffer.from(slip10Ed25519(seed, [0, 1, 2, 2, 1000000000])).toString("hex"))
      .toBe("8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793");
  });
});

describe("SplWallet", () => {
  const keys = new SolanaKeys(MNEMONIC);
  // buildTransfer does not touch the network; the connection is never used here.
  const wallet = new SplWallet("USDC-SOL", USDC_MINT, 6, keys, new Connection("http://127.0.0.1:1"));

  it("keeps index 0 for inventory and derives distinct deposit owners", async () => {
    expect(() => keys.keypair({ kind: "deposit", index: 0 })).toThrow();
    const a = await wallet.depositAddress(1);
    const b = await wallet.depositAddress(2);
    expect(a.address).not.toBe(b.address);
    expect(a.address).not.toBe(await wallet.inventoryAddress());
  });

  it("builds a transfer paid by inventory: create ATA (idempotent) + transferChecked", () => {
    const source = keys.keypair({ kind: "deposit", index: 3 });
    const payer = keys.keypair({ kind: "inventory" });
    const dest = new PublicKey(Uint8Array.from(new Array(32).fill(7)));
    const tx = wallet.buildTransfer(source, payer, dest.toBase58(), 1_234_567n, "11111111111111111111111111111111");

    expect(tx.feePayer!.equals(payer.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.signatures.map((s) => s.publicKey.toBase58()).sort()).toEqual([payer.publicKey.toBase58(), source.publicKey.toBase58()].sort());

    const [createAta, transfer] = tx.instructions;
    const mint = new PublicKey(USDC_MINT);
    const destAta = getAssociatedTokenAddressSync(mint, dest, true);
    expect(createAta.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(createAta.keys[1].pubkey.equals(destAta)).toBe(true);
    expect(createAta.data[0]).toBe(1); // CreateIdempotent

    expect(transfer.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(transfer.data[0]).toBe(12); // TransferChecked
    expect(transfer.data.readBigUInt64LE(1)).toBe(1_234_567n);
    expect(transfer.data[9]).toBe(6); // decimals
    expect(transfer.keys[0].pubkey.equals(getAssociatedTokenAddressSync(mint, source.publicKey))).toBe(true);
    expect(transfer.keys[2].pubkey.equals(destAta)).toBe(true);
    expect(transfer.keys[3].pubkey.equals(source.publicKey)).toBe(true);
    expect(transfer.keys[3].isSigner).toBe(true);
  });

  it("reports the fee in SOL and refuses memos", async () => {
    expect((await wallet.estimateSendFee(false)).asset).toBe("SOL");
    await expect(wallet.send({ from: { kind: "deposit", index: 1 }, to: "x", amount: 1n, memo: "m" })).rejects.toThrow(/memo/);
  });
});
