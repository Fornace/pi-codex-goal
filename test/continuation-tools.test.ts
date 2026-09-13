import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { formatFooterStatus } from "../src/format.js";
import { isGoalCustomEntry, setEntry } from "../src/state.js";
import { CUSTOM_ENTRY_TYPE } from "../src/types.js";
import {
  assistantMessage,
  createRuntimeHarness,
  emitPersistentAssistantError,
  fireProviderLimitAutoResume,
  flushContinuationScheduler,
  goalUserContextMessage,
  queuedCustomMessage,
  sessionCompactEvent,
  sessionShutdownEvent,
} from "./support/runtime-harness.js";

async function finishQueuedCustomRun(
  harness: ReturnType<typeof createRuntimeHarness>,
  queued: NonNullable<(typeof harness.sentMessages)[number]>,
  toolNames: readonly string[],
): Promise<void> {
  await harness.emit("agent_start", { type: "agent_start" });

  const runMessages: object[] = [];
  let turnIndex = 0;

  // Pi emits turn_start before the initial custom message_start for triggerTurn custom prompts.
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedCustomMessage(queued),
  });

  if (toolNames.length > 0) {
    const toolUseMessage = {
      ...assistantMessage("toolUse", { input: 8, output: 2 }),
      content: toolNames.map((name, index) => ({
        type: "toolCall" as const,
        id: `tool-call-${index}`,
        name,
        arguments: {},
      })),
    };
    for (const [index, toolName] of toolNames.entries()) {
      await harness.emit("tool_execution_end", {
        type: "tool_execution_end",
        toolCallId: `tool-call-${index}`,
        toolName,
        args: {},
        result: {},
        isError: false,
      });
    }
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex,
      message: toolUseMessage,
      toolResults: [],
    });
    runMessages.push(toolUseMessage);
    turnIndex += 1;
    await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  }

  const stopMessage = assistantMessage("stop", { input: 10, output: 3 });
  runMessages.push(stopMessage);
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message: stopMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: runMessages,
  });
}

async function queueHiddenContinuation(
  harness: ReturnType<typeof createRuntimeHarness>,
): Promise<NonNullable<(typeof harness.sentMessages)[number]>> {
  await harness.runCommand("ship it");
  const commandStart = harness.sentMessages[0];
  assert.ok(commandStart);
  harness.sentMessages.length = 0;

  // command_start is not a hidden continuation; finishing it should queue one.
  await finishQueuedCustomRun(harness, commandStart, ["bash"]);
  const continuation = harness.sentMessages[0];
  assert.ok(continuation);
  assert.deepEqual(continuation.message.details, {
    kind: "continuation",
    goalId: harness.snapshot().goal?.goalId,
  });
  harness.sentMessages.length = 0;
  return continuation;
}

for (const toolName of ["get_goal", "pi__get_goal"] as const) {
  test(`hidden custom continuation that only calls ${toolName} does not infer a stall from tool names`, async () => {
    const harness = createRuntimeHarness();
    const continuation = await queueHiddenContinuation(harness);
    harness.footerStatuses.length = 0;

    await finishQueuedCustomRun(harness, continuation, [toolName]);

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
  });
}

test("hidden custom continuation with actionable tools still queues continuation", async () => {
  const harness = createRuntimeHarness();
  const continuation = await queueHiddenContinuation(harness);

  await finishQueuedCustomRun(harness, continuation, ["get_goal", "bash"]);

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});

test("user-driven get_goal-only run stays active and can continue", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("message_start", {
    type: "message_start",
    message: goalUserContextMessage("what is blocking the goal?"),
  });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 8, output: 2 }),
    toolResults: [],
  });
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "get_goal",
    args: {},
    result: {},
    isError: false,
  });
  const stopMessage = assistantMessage("stop", { input: 10, output: 3 });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: stopMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [stopMessage],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});
