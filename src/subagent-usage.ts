import type { SessionEntryLike } from "./types.js";

export const SUBAGENT_USAGE_ENTRY = "subagent-usage-receipt";
export interface SubagentUsageReceipt {
  version: 1;
  sessionId: string;
  goalId: string;
  receiptId: string;
  handle: string;
  childSessionFile: string;
  at: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
const validChannel = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseSubagentUsageReceipt(data: unknown): SubagentUsageReceipt | null {
  if (!data || typeof data !== "object") return null;
  const receipt = data as SubagentUsageReceipt;
  const usage = receipt.usage;
  if (receipt.version !== 1 || typeof receipt.sessionId !== "string" ||
      typeof receipt.goalId !== "string" || !/^[a-f0-9]{64}$/.test(receipt.receiptId) ||
      typeof receipt.handle !== "string" || typeof receipt.childSessionFile !== "string" ||
      !Number.isSafeInteger(receipt.at) || receipt.at <= 0 || !usage ||
      !validChannel(usage.input) || !validChannel(usage.output) ||
      !validChannel(usage.cacheRead) || !validChannel(usage.cacheWrite)) return null;
  return receipt;
}

export function receiptFromEntry(entry: SessionEntryLike): SubagentUsageReceipt | null {
  return entry.type === "custom" && entry.customType === SUBAGENT_USAGE_ENTRY
    ? parseSubagentUsageReceipt(entry.data) : null;
}

export function receiptTokens(receipt: SubagentUsageReceipt): number {
  const total = receipt.usage.input + receipt.usage.output;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}
