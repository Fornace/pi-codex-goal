import { createRuntimeHarness } from "./runtime-harness-core.js";
export { createRuntimeHarness };
import assert from "node:assert/strict";
import { mock } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import goalExtension, { __testHooks } from "../../src/index.js";
import { isContextOverflowError } from "../../src/recovery.js";
import { isGoalCustomEntry, reconstructGoal } from "../../src/state.js";
import {
  toQueuedGoalContextCarrier,
  type ActiveGoalQueuedDetails,
  type QueuedGoalContextCarrier,
  type QueuedGoalContextInput,
  type QueuedGoalUserContent,
} from "../../src/queued-goal-messages.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/types.js";

type EventHandler = (event: object, ctx: ExtensionContext) => unknown | Promise<unknown>;

function unsupportedHarnessMethod(name: string): never {
  throw new Error(`${name} is not implemented in this test harness.`);
}

export interface SentMessage {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}

export interface SentUserMessage {
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
  options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
}

type CompactionReason = "manual" | "threshold" | "overflow";

interface CompactionEventOptions {
  reason?: CompactionReason;
  willRetry?: boolean;
  summary?: string;
  tokensBefore?: number;
}

export function sessionBeforeCompactEvent(options: CompactionEventOptions = {}): object {
  return {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
    signal: new AbortController().signal,
  };
}

export function sessionCompactEvent(options: CompactionEventOptions = {}): object {
  const summary = options.summary ?? "compact summary";
  const tokensBefore = options.tokensBefore ?? 100;
  return {
    type: "session_compact",
    compactionEntry: {
      type: "compaction",
      id: "compaction-entry",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      summary,
      firstKeptEntryId: "entry-1",
      tokensBefore,
    },
    fromExtension: false,
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
  };
}

export function sessionShutdownEvent(
  reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit",
): object {
  return { type: "session_shutdown", reason };
}

export interface TestAssistantUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export function flushContinuationScheduler(): void {
  mock.timers.tick(__testHooks.continuationRetryMs);
}

export function fireProviderLimitAutoResume(): void {
  mock.timers.tick(__testHooks.providerLimitAutoResumeMs);
}

export function countGoalSetEntries(
  entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>,
  goalId?: string,
): number {
  return entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "set" &&
      (goalId === undefined || entry.data.goal.goalId === goalId)
    );
  }).length;
}

export function countGoalUsageEntries(
  entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>,
  goalId?: string,
): number {
  return entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "usage" &&
      (goalId === undefined || entry.data.goalId === goalId)
    );
  }).length;
}

export async function emitToolExecutionEnd(harness: ReturnType<typeof createRuntimeHarness>): Promise<void> {
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
}

export function queuedCustomMessage(sent: SentMessage, timestamp = 1): QueuedGoalContextCarrier {
  return {
    role: "custom",
    customType: sent.message.customType,
    content: sent.message.content,
    display: sent.message.display,
    details: sent.message.details,
    timestamp,
  };
}

export function goalCustomContextMessage(options: {
  content: string;
  details: ActiveGoalQueuedDetails | Record<string, unknown>;
  display?: boolean;
  timestamp: number;
}): QueuedGoalContextCarrier {
  return {
    role: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    content: options.content,
    display: options.display ?? false,
    details: options.details,
    timestamp: options.timestamp,
  };
}

export interface ProviderContextResult {
  messages: QueuedGoalContextCarrier[];
}

export type ProviderContextHandlerResult = ProviderContextResult | undefined;

function parseProviderContextHandlerResult(result: unknown): ProviderContextHandlerResult {
  if (result === undefined) {
    return undefined;
  }

  assert.ok(result && typeof result === "object", "Expected provider context handler result object.");
  const candidate = result as { messages?: unknown };
  assert.ok(Array.isArray(candidate.messages), "Expected provider context handler messages array.");

  const messages: QueuedGoalContextCarrier[] = [];
  for (const [index, message] of candidate.messages.entries()) {
    const carrier = toQueuedGoalContextCarrier(message as QueuedGoalContextInput);
    assert.ok(carrier, `Expected provider context message ${index} to include a numeric timestamp.`);
    messages.push(carrier);
  }

  return { messages };
}

export function requireProviderContextResult(
  results: ProviderContextHandlerResult[],
): ProviderContextResult {
  const result = results[0];
  if (result === undefined) {
    assert.fail("Expected provider context handler to return rewritten messages.");
  }
  return result;
}

export function providerContextMessageAt(
  result: ProviderContextResult,
  index: number,
): QueuedGoalContextCarrier {
  const message = result.messages[index];
  assert.ok(message, `Expected provider context message at index ${index}.`);
  return message;
}

export function goalUserContextMessage(text: string, timestamp = 1): QueuedGoalContextCarrier {
  const content: QueuedGoalUserContent = [{ type: "text", text }];
  return {
    role: "user",
    content,
    timestamp,
  };
}

export async function emitProviderContext(
  harness: RuntimeHarness,
  messages: QueuedGoalContextCarrier[],
): Promise<ProviderContextHandlerResult[]> {
  const results = await harness.emit("context", { type: "context", messages });
  return results.map(parseProviderContextHandlerResult);
}

export type RuntimeHarness = ReturnType<typeof createRuntimeHarness>;

export async function emitQueuedTurnThroughContext(
  harness: RuntimeHarness,
  messages: QueuedGoalContextCarrier[],
  turnIndex = 0,
): Promise<ProviderContextHandlerResult[]> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  for (const message of messages) {
    await harness.emit("message_start", { type: "message_start", message });
    await harness.emit("message_end", { type: "message_end", message });
  }
  const results = await harness.emit("context", { type: "context", messages });
  return results.map(parseProviderContextHandlerResult);
}

export function assistantMessage(
  stopReason: "stop" | "aborted" | "length" | "toolUse" | "error",
  usage: TestAssistantUsage,
  errorMessage?: string,
) {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead,
      cacheWrite,
      totalTokens: usage.totalTokens ?? usage.input + usage.output + cacheRead + cacheWrite,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: errorMessage ?? "provider error" } : {}),
    timestamp: 1,
  };
}

export async function emitPersistentAssistantError(
  harness: ReturnType<typeof createRuntimeHarness>,
  turnIndex: number,
  errorMessage: string,
): Promise<void> {
  const message = assistantMessage("error", { input: 1, output: 1 }, errorMessage);
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [message],
  });
  if (isContextOverflowError(errorMessage)) {
    harness.setHostOverflowRecoveryAttempted(true);
  }
}

export async function emitHostSessionCompact(
  harness: RuntimeHarness,
  options: CompactionEventOptions = {},
): Promise<void> {
  const eventOptions: CompactionEventOptions = { reason: "overflow", ...options };
  await harness.emit("session_before_compact", sessionBeforeCompactEvent(eventOptions));
  await harness.emit("session_compact", sessionCompactEvent(eventOptions));
}

export async function emitSilentContextOverflow(
  harness: RuntimeHarness,
  turnIndex: number,
  message: ReturnType<typeof assistantMessage>,
): Promise<void> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [message],
  });
  harness.setHostOverflowRecoveryAttempted(true);
}
