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

test("aborted turns pause goals and do not queue continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", {
      input: 40,
      output: 2,
      cacheRead: 500,
      cacheWrite: 600,
      totalTokens: 1_142,
    }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "paused");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);
});

test("a new user-driven agent start leaves a paused goal paused", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "",
    systemPromptOptions: {},
  });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 10);
});

test("explicit brake survives session resume of an over-budget goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it" });
  await harness.runCommand("pause");
  const paused = harness.snapshot().goal;
  assert.ok(paused);
  assert.equal(paused.status, "paused");

  harness.entries.push({
    type: "custom",
    id: "entry-over-budget-paused",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(
      {
        ...paused,
        tokenBudget: 10,
        usage: { tokensUsed: 10, activeSeconds: paused.usage.activeSeconds },
      },
      "runtime",
    ),
  });
  harness.sentUserMessages.length = 0;

  await harness.emit("session_start", { type: "session_start", reason: "resume" });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentUserMessages.length, 0);
});

test("session resume prompt can reactivate a paused goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });
  harness.sentMessages.length = 0;

  await harness.emit("session_start", { type: "session_start", reason: "resume" });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const sentUserMessage = harness.sentUserMessages[0];
  assert.ok(sentUserMessage);
  assert.deepEqual(sentUserMessage.options, { deliverAs: "followUp" });
  const content = sentUserMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected session resume to send a user continuation prompt.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.match(content, /<pi_goal_continuation goal_id="/);
});

test("completed turns count input plus output and continue active goals", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = queuedCustomMessage(queued);
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", {
      input: 30,
      output: 12,
      cacheRead: 500,
      cacheWrite: 600,
      totalTokens: 1_142,
    }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0]?.message.customType, CUSTOM_ENTRY_TYPE);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});

test("tool-use turn ends do not queue continuation before tool execution finishes", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 10, output: 3 }),
    toolResults: [],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("successful budget-crossing turn clears stale recovery footer attention", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 500_000 });
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("stop", { input: 499_998, output: 3 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "budgetLimited");
  assert.equal(goal?.usage.tokensUsed, 500_003);
  assert.equal(harness.footerStatuses.at(-1), formatFooterStatus(goal));
  assert.match(harness.footerStatuses.at(-1) ?? "", /Goal unmet/);
  assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Goal recovery pending/);
});

test("budget crossing sends one hidden budget-limit steering message", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 500_000 });

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 499_998, output: 3 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "budgetLimited");
  assert.equal(goal?.usage.tokensUsed, 500_001);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "budget_limit",
    goalId: goal?.goalId,
  });

  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
  assert.equal(harness.sentMessages.length, 1);
});

test("replacement during an in-flight turn does not charge old tokens to the new goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("old goal");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.runCommand("new goal");
  const replacement = harness.snapshot().goal;
  assert.equal(replacement?.objective, "new goal");

  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", { input: 80, output: 20 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, replacement?.goalId);
  assert.equal(goal?.usage.tokensUsed, 0);
  assert.equal(harness.sentMessages.length, 1);
});

test("goal tools return Codex-shaped response details", async () => {
  const harness = createRuntimeHarness();
  const created = (await harness.runTool("create_goal", {
    objective: "ship it",
    token_budget: 500_000,
  })) as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

  assert.equal((created.details.goal as { objective?: string }).objective, "ship it");
  assert.equal((created.details.goal as { tokenBudget?: number }).tokenBudget, 500_000);
  assert.equal(created.details.remainingTokens, 500_000);
  assert.equal(created.details.completionBudgetReport, null);
  assert.deepEqual(JSON.parse(created.content[0]?.text ?? ""), {
    goal: created.details.goal,
    remainingTokens: 500_000,
    completionBudgetReport: null,
  });

  const completed = (await harness.runTool("update_goal", { status: "complete" })) as {
    details: Record<string, unknown>;
  };
  assert.match(String(completed.details.completionBudgetReport), /^Goal achieved\. Report final budget usage to the user:/);
});
