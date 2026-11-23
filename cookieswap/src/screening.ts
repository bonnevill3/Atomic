import { readFileSync } from "node:fs";
import type { ChainId } from "./assets";

export interface ScreeningInput {
  chain: ChainId;
  depositTxids: string[];
  recipient: string;
  refundAddress: string;
}

export interface ScreeningResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Hook for deposit/address screening (sanctions lists, analytics providers).
 * Runs after the deposit is confirmed and before anything is executed; a blocked order is refunded.
 */
export interface Screening {
  check(input: ScreeningInput): Promise<ScreeningResult>;
}

/** Local denylist (one address per line, '#' comments). Plug a real provider in behind the same interface. */
export class DenylistScreening implements Screening {
  private deny: Set<string>;

  constructor(file?: string) {
    const lines = file ? readFileSync(file, "utf8").split("\n") : [];
    this.deny = new Set(lines.map((l) => l.replace(/#.*/, "").trim().toLowerCase()).filter(Boolean));
  }

  async check(input: ScreeningInput): Promise<ScreeningResult> {
    for (const a of [input.recipient, input.refundAddress]) {
      if (this.deny.has(a.toLowerCase())) return { allowed: false, reason: "address is on the denylist" };
    }
    return { allowed: true };
  }
}
