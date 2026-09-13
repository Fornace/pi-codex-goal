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

test("agent_end, not agent_settled, drives deliberate per-run goal continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedCustomMessage(queued),
  });
  harness.sentMessages.length = 0;

  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });
  assert.equal(harness.sentMessages.length, 1);
});

test("agent end waits for idle before continuing active goals", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
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
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 30, output: 12 })],
    });

    assert.equal(harness.sentMessages.length, 0);
    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

test("completing a goal cancels a scheduled continuation before it is sent", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 30, output: 12 })],
    });
    assert.equal(harness.sentMessages.length, 0);

    await harness.runTool("update_goal", { status: "complete" });
    const completeSetEntries = harness.entries.filter((entry) => {
      return (
        entry.type === "custom" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        isGoalCustomEntry(entry.data) &&
        entry.data.kind === "set" &&
        entry.data.goal.status === "complete"
      );
    });
    assert.equal(completeSetEntries.length, 1);
    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("goal follow-up guard resets when custom-message continuations start", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it" });
  harness.sentMessages.length = 0;

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 30, output: 12 })],
  });
  assert.equal(harness.sentMessages.length, 1);
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const queuedMessage = {
    role: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    content: queued.message.content,
    display: false,
    details: queued.message.details,
    timestamp: 1,
  };
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("message_start", {
    type: "message_start",
    message: queuedMessage,
  });
  assert.equal(harness.abortCount, 0);
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 5, output: 6 })],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "continuation",
    goalId: goal?.goalId,
  });
});

test("auto-queued continuations use the compact prompt", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const commandStart = harness.sentMessages[0];
  assert.ok(commandStart);
  const startPrompt = String(commandStart.message.content);
  assert.match(startPrompt, /<untrusted_objective>/);

  harness.sentMessages.length = 0;
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: startPrompt,
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  const continuation = harness.sentMessages[0];
  assert.ok(continuation);
  const content = String(continuation.message.content);
  assert.match(content, /<pi_goal_continuation goal_id="/);
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.match(content, /get_goal/);
});

test("extension user continuation accepted before compaction suppresses duplicate compaction continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const queued = harness.sentMessages[0];
  assert.ok(queued);
  const content = String(queued.message.content);
  harness.sentMessages.length = 0;

  const results = await harness.emit("input", {
    type: "input",
    text: content,
    source: "extension",
    streamingBehavior: "followUp",
  });

  assert.deepEqual(results, [{ action: "continue" }]);
  await harness.emit("session_compact", sessionCompactEvent());

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("session compaction queues continuation for active goals after the compaction event unwinds", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const content = String(queued.message.content);
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: content,
      systemPrompt: "",
      systemPromptOptions: {},
    });
    await harness.emit("session_compact", sessionCompactEvent());

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    mock.timers.tick(1);
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

test("session compaction accelerates an existing idle retry after length stops", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
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
      message: assistantMessage("length", { input: 30, output: 12 }),
      toolResults: [],
    });
    assert.equal(harness.sentMessages.length, 0);

    harness.setIdle(true);
    harness.setPendingMessages(false);
    await harness.emit("session_compact", sessionCompactEvent());

    mock.timers.tick(1);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

test("session compaction continuation is cancelled if a host retry starts before the deferred check", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const content = String(queued.message.content);
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: content,
      systemPrompt: "",
      systemPromptOptions: {},
    });
    await harness.emit("session_compact", sessionCompactEvent());
    assert.equal(harness.sentMessages.length, 0);

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "host compact-and-retry prompt",
      systemPrompt: "",
      systemPromptOptions: {},
    });
    mock.timers.tick(1);
    assert.equal(harness.sentMessages.length, 0);

    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 1, output: 1 })],
    });
    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

test("repeated session_compact events before the deferred check queue at most one continuation", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const content = String(queued.message.content);
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: content,
      systemPrompt: "",
      systemPromptOptions: {},
    });
    for (let index = 0; index < 3; index += 1) {
      await harness.emit("session_compact", sessionCompactEvent({
        summary: `compact summary ${index}`,
        tokensBefore: 100 + index,
      }));
    }

    mock.timers.tick(1);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "active");
    assert.equal(harness.sentMessages.length, 1);
    assert.deepEqual(harness.sentMessages[0]?.message.details, {
      kind: "continuation",
      goalId: goal?.goalId,
    });
  } finally {
    mock.timers.reset();
  }
});

test("session shutdown cancels deferred session_compact continuations", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const queued = harness.sentMessages[0];
    assert.ok(queued);
    const content = String(queued.message.content);
    harness.sentMessages.length = 0;

    await harness.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: content,
      systemPrompt: "",
      systemPromptOptions: {},
    });
    await harness.emit("session_compact", sessionCompactEvent());
    await harness.emit("session_shutdown", sessionShutdownEvent());

    mock.timers.tick(1);
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});
