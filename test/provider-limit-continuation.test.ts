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

test("provider-limit pauses schedule auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");

    const paused = harness.snapshot().goal;
    assert.equal(paused?.status, "paused");
    assert.match(harness.footerStatuses.at(-1) ?? "", /Auto-resume will retry in about 5 minutes/);
    assert.equal(harness.sentUserMessages.length, 0);

    fireProviderLimitAutoResume();

    const resumed = harness.snapshot().goal;
    assert.equal(resumed?.goalId, paused?.goalId);
    assert.equal(resumed?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);
    const content = harness.sentUserMessages[0]?.content;
    assert.equal(typeof content, "string");
    assert.match(String(content), /<pi_goal_continuation goal_id="/);
    assert.doesNotMatch(String(content), /<untrusted_objective>/);
  } finally {
    mock.timers.reset();
  }
});

test("provider-limit auto-resume retries instead of resuming while busy", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    assert.match(harness.footerStatuses.at(-1) ?? "", /Auto-resume will retry/);

    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("non-limit non-retryable pauses do not schedule auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "invalid api key");
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    assert.doesNotMatch(harness.footerStatuses.at(-1) ?? "", /Auto-resume/);
  } finally {
    mock.timers.reset();
  }
});

test("manual resume clears provider-limit auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "insufficient_quota 429");
    await harness.runCommand("resume");
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);

    fireProviderLimitAutoResume();
    assert.equal(harness.sentUserMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("/goal resume cancel clears provider-limit auto-resume and leaves the goal paused", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "Monthly usage limit reached");
    await harness.runCommand("resume cancel");

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.footerStatuses.at(-1), "Goal needs attention (non-retryable provider error (Monthly usage limit reached)). Use /goal resume to continue.");
    assert.equal(harness.sentUserMessages.length, 0);
    fireProviderLimitAutoResume();
    assert.equal(harness.sentUserMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("user input and session shutdown clear provider-limit auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const userInputHarness = createRuntimeHarness();
    await userInputHarness.runCommand("ship it");
    userInputHarness.sentMessages.length = 0;
    await emitPersistentAssistantError(userInputHarness, 0, "available balance");
    await userInputHarness.emit("input", {
      type: "input",
      text: "I'll handle it",
      source: "user",
      streamingBehavior: "normal",
    });
    fireProviderLimitAutoResume();
    assert.equal(userInputHarness.snapshot().goal?.status, "paused");
    assert.equal(userInputHarness.sentUserMessages.length, 0);

    const shutdownHarness = createRuntimeHarness();
    await shutdownHarness.runCommand("ship it");
    shutdownHarness.sentMessages.length = 0;
    await emitPersistentAssistantError(shutdownHarness, 0, "quota exceeded");
    await shutdownHarness.emit("session_shutdown", sessionShutdownEvent());
    fireProviderLimitAutoResume();
    assert.equal(shutdownHarness.sentUserMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("a second provider-limit failure after auto-resume schedules one new retry", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "FreeUsageLimitError");
    fireProviderLimitAutoResume();
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);

    harness.sentUserMessages.length = 0;
    await emitPersistentAssistantError(harness, 1, "FreeUsageLimitError");
    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("assistant error turns do not immediately queue continuation", async () => {
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
    message: assistantMessage("error", { input: 30, output: 12 }, "websocket closed"),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);
});
