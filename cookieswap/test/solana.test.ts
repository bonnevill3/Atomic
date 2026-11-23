import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  parseTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { address, type Blockhash, createSolanaRpc, getBase58Encoder, type SignatureBytes, verifySignature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { slip10Ed25519, SolanaKeys, SplWallet } from "../src/chains/solana";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const LIFETIME = { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 100n };

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

describe("SolanaKeys", () => {
  const keys = new SolanaKeys(MNEMONIC);

  it("sync address derivation matches the @solana/kit signer", async () => {
    for (const source of [{ kind: "inventory" as const }, { kind: "deposit" as const, index: 1 }, { kind: "deposit" as const, index: 42 }]) {
      expect(keys.address(source)).toBe((await keys.signer(source)).address);
    }
  });

  it("keeps index 0 for inventory and derives distinct deposit owners", () => {
    expect(() => keys.address({ kind: "deposit", index: 0 })).toThrow(/inventory/);
    const a = keys.address({ kind: "deposit", index: 1 });
    expect(a).not.toBe(keys.address({ kind: "deposit", index: 2 }));
    expect(a).not.toBe(keys.address({ kind: "inventory" }));
  });
});

describe("SplWallet (@solana/kit)", () => {
  const keys = new SolanaKeys(MNEMONIC);
  // buildTransfer does not touch the network; the RPC is never called here.
  const wallet = new SplWallet("USDC-SOL", USDC_MINT, 6, keys, createSolanaRpc("http://127.0.0.1:1"));
  const dest = address("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi");

  it("builds a transfer paid by inventory: create ATA (idempotent) + transferChecked, both signatures valid", async () => {
    const source = await keys.signer({ kind: "deposit", index: 3 });
    const payer = await keys.signer({ kind: "inventory" });
    const { message, transaction, sourceAta, destAta } = await wallet.buildTransfer(source, payer, dest, 1_234_567n, LIFETIME);

    const [expectedDestAta] = await findAssociatedTokenPda({ owner: dest, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [expectedSourceAta] = await findAssociatedTokenPda({ owner: source.address, mint: USDC_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(destAta).toBe(expectedDestAta);
    expect(sourceAta).toBe(expectedSourceAta);
    expect(message.feePayer.address).toBe(payer.address);

    const [createAta, transfer] = message.instructions;
    expect(createAta.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(createAta.accounts![0].address).toBe(payer.address);
    expect(createAta.accounts![1].address).toBe(destAta);
    expect(createAta.data![0]).toBe(1); // CreateIdempotent

    expect(transfer.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    const parsed = parseTransferCheckedInstruction(transfer as Parameters<typeof parseTransferCheckedInstruction>[0]);
    expect(parsed.data.amount).toBe(1_234_567n);
    expect(parsed.data.decimals).toBe(6);
    expect(parsed.accounts.source.address).toBe(sourceAta);
    expect(parsed.accounts.destination.address).toBe(destAta);
    expect(parsed.accounts.authority.address).toBe(source.address);

    expect(Object.keys(transaction.signatures).sort()).toEqual([payer.address, source.address].sort());
    for (const s of [payer, source]) {
      const sig = transaction.signatures[s.address] as SignatureBytes;
      expect(await verifySignature(s.keyPair.publicKey, sig, transaction.messageBytes)).toBe(true);
    }
  });

  it("uses a single signature when inventory sends its own tokens", async () => {
    const payer = await keys.signer({ kind: "inventory" });
    const { transaction } = await wallet.buildTransfer(payer, payer, dest, 5n, LIFETIME);
    expect(Object.keys(transaction.signatures)).toEqual([payer.address]);
  });

  it("deposit addresses are valid base58 public keys", async () => {
    const { address: a } = await wallet.depositAddress(9);
    expect(getBase58Encoder().encode(a)).toHaveLength(32);
  });

  it("reports the fee in SOL and refuses memos", async () => {
    expect((await wallet.estimateSendFee(false)).asset).toBe("SOL");
    await expect(wallet.send({ from: { kind: "deposit", index: 1 }, to: dest, amount: 1n, memo: "m" })).rejects.toThrow(/memo/);
  });
});
