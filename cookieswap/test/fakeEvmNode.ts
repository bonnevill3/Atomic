import { decodeFunctionData, erc20Abi, type Hex, parseTransaction, recoverTransactionAddress } from "viem";

const hex = (n: bigint) => `0x${n.toString(16)}`;

/**
 * In-process EIP-1193 provider that behaves like an EVM node for one ERC-20 token:
 * it verifies signed raw transactions (sender recovery, nonce, gas * maxFee + value),
 * applies native and token transfers, mines instantly and serves receipts.
 */
export class FakeEvmNode {
  block = 100n;
  eth = new Map<string, bigint>();
  tok = new Map<string, bigint>();
  nonce = new Map<string, bigint>();
  receipts = new Map<string, unknown>();
  sent: { from: string; to: string; value: bigint; data?: Hex }[] = [];

  constructor(
    readonly token: string,
    readonly chainId = 1,
    readonly baseFee = 1_000_000_000n,
    readonly tip = 100_000_000n,
  ) {
    this.token = token.toLowerCase();
  }

  get = (m: Map<string, bigint>, a: string) => m.get(a.toLowerCase()) ?? 0n;
  set = (m: Map<string, bigint>, a: string, v: bigint) => m.set(a.toLowerCase(), v);

  async request({ method, params }: { method: string; params?: any[] }): Promise<any> {
    switch (method) {
      case "eth_chainId": return hex(BigInt(this.chainId));
      case "eth_blockNumber": return hex(this.block);
      case "eth_getBalance": return hex(this.get(this.eth, params![0]));
      case "eth_maxPriorityFeePerGas": return hex(this.tip);
      case "eth_getBlockByNumber":
        return { number: hex(this.block), baseFeePerGas: hex(this.baseFee), hash: `0x${"ab".repeat(32)}`, timestamp: "0x1", transactions: [] };
      case "eth_getTransactionCount": return hex(this.get(this.nonce, params![0]));
      case "eth_estimateGas": return hex(60_000n);
      case "eth_call": {
        const { to, data } = params![0];
        if (to.toLowerCase() !== this.token) throw new Error("unknown contract");
        const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
        if (functionName !== "balanceOf") throw new Error("unsupported call");
        return `0x${this.get(this.tok, args[0] as string).toString(16).padStart(64, "0")}`;
      }
      case "eth_sendRawTransaction": return this.apply(params![0]);
      case "eth_getTransactionReceipt": return this.receipts.get(params![0]) ?? null;
      default: throw new Error(`fake node: unsupported ${method}`);
    }
  }

  private async apply(raw: Hex) {
    const tx = parseTransaction(raw);
    if (tx.chainId !== this.chainId) throw new Error("wrong chain id");
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as any })).toLowerCase();
    if (BigInt(tx.nonce ?? 0) !== this.get(this.nonce, from)) throw new Error("nonce too low/high");
    if (this.get(this.eth, from) < tx.gas! * tx.maxFeePerGas! + (tx.value ?? 0n)) {
      throw new Error("insufficient funds for gas * price + value");
    }
    const isToken = tx.to!.toLowerCase() === this.token;
    const gasUsed = isToken ? 52_000n : 21_000n;
    let status = "0x1";
    this.set(this.eth, from, this.get(this.eth, from) - gasUsed * (this.baseFee + this.tip) - (tx.value ?? 0n));
    if (isToken) {
      const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
      const [to, amount] = args as [string, bigint];
      if (this.get(this.tok, from) < amount) status = "0x0";
      else {
        this.set(this.tok, from, this.get(this.tok, from) - amount);
        this.set(this.tok, to, this.get(this.tok, to) + amount);
      }
    } else this.set(this.eth, tx.to!, this.get(this.eth, tx.to!) + (tx.value ?? 0n));
    this.set(this.nonce, from, this.get(this.nonce, from) + 1n);
    this.sent.push({ from, to: tx.to!.toLowerCase(), value: tx.value ?? 0n, data: tx.data });
    this.block += 1n;
    const hash = `0x${this.sent.length.toString(16).padStart(64, "0")}` as Hex;
    this.receipts.set(hash, {
      transactionHash: hash, blockHash: `0x${"cd".repeat(32)}`, blockNumber: hex(this.block), status, from, to: tx.to,
      gasUsed: hex(gasUsed), cumulativeGasUsed: hex(gasUsed), effectiveGasPrice: hex(this.baseFee + this.tip), logs: [],
      logsBloom: `0x${"00".repeat(256)}`, transactionIndex: "0x0", type: "0x2", contractAddress: null,
    });
    return hash;
  }
}
