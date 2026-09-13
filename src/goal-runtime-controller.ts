import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createAutonomyGuard } from "./autonomy-guard.js";
import { registerGoalCommand } from "./commands.js";
import { createContinuationScheduler } from "./continuation-scheduler.js";
import { createGoalAccounting } from "./goal-accounting.js";
import { createGoalPersistence } from "./goal-persistence.js";
import {
  createGoalRuntimeEventHandlers,
  type GoalRuntimeEventHandlers,
} from "./goal-runtime-event-handlers.js";
import { registerGoalRuntimeEvents } from "./goal-runtime-events.js";
import { createGoalRuntimeState } from "./goal-runtime-state.js";
import { createGoalRuntimeStatus, type StatusContext } from "./goal-runtime-status.js";
import { createGoalStateController } from "./goal-state-controller.js";
import { createProviderLimitAutoResumeScheduler } from "./provider-limit-auto-resume.js";
import { compactContinuationPrompt } from "./prompts.js";
import { createGoalRecoveryRuntime } from "./recovery-runtime.js";
import {
  clearActiveHostOverflowRecovery,
  goalStartTurnStrategy,
  resetRecoveryMachine,
  setRecoveryPausedAttention,
  type GoalStartTurnStrategy,
} from "./recovery-machine.js";
import { goalWithLiveUsage, updateGoalStatus } from "./state.js";
import { registerGoalTools } from "./tools.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";

export interface GoalRuntimeController extends GoalRuntimeEventHandlers {
  getGoalForDisplay(): ThreadGoal | null;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  clearGoal(source: GoalEntrySource, ctx: ExtensionContext): void;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): GoalResult;
  cancelProviderLimitAutoResume(goalId: string, ctx: StatusContext): void;
  resumeGoalWithContinuation(goalId: string, source: GoalEntrySource, ctx: StatusContext): GoalResult;
}

export function createGoalRuntimeController(pi: ExtensionAPI): GoalRuntimeController {
  const runtimeState = createGoalRuntimeState();
  const persistence = createGoalPersistence({ pi });
  const autonomy = createAutonomyGuard(pi, {
    active: () => persistence.getGoal()?.status === "active",
    pause: (ctx, reason) => stateController.pauseForRecovery(ctx, reason),
    clear: () => {
      continuation.clearContinuationState();
      continuation.clearPostCompactContinuationFallback();
      providerLimitAutoResume.clear();
    },
  });

  const clearActiveAccounting = (): void => {
    runtimeState.accounting.activeGoalId = null;
    runtimeState.accounting.lastAccountedAt = null;
  };

  const resetErrorRecovery = (): void => {
    resetRecoveryMachine(runtimeState.recoveryState);
  };

  const goalForDisplay = () =>
    goalWithLiveUsage(
      persistence.getGoal(),
      runtimeState.accounting.activeGoalId,
      runtimeState.accounting.lastAccountedAt,
    );

  let autoResumeContext: ExtensionContext | null = null;
  let runtimeContext: ExtensionContext | null = null;
  const providerLimitAutoResume = createProviderLimitAutoResumeScheduler({
    onTimer(goalId) {
      if (!autoResumeContext || !autoResumeContext.isIdle() || autoResumeContext.hasPendingMessages()) {
        return false;
      }
      resumeGoalWithContinuation(goalId, "runtime", autoResumeContext);
      return true;
    },
  });

  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    getRecoveryAttention: () => runtimeState.recoveryState.attention,
    isProviderLimitAutoResumeScheduled: providerLimitAutoResume.isScheduledFor,
  });

  const continuation = createContinuationScheduler({
    pi,
    getGoal: () => persistence.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    staleQueuedWorkGuard: runtimeState.staleQueuedWorkGuard,
    getCurrentTurnIndex: () => runtimeState.currentTurnIndex,
    getAgentRunSequence: () => runtimeState.agentRunSequence,
    canContinue: autonomy.allowed,
    reserveContinuation: autonomy.reserve,
  });

  const stateController = createGoalStateController({
    pi,
    persistence,
    getRecoveryState: () => runtimeState.recoveryState,
    transitionEffectHandlers: {
      clearContinuation: continuation.clearContinuationState,
      clearActiveAccounting,
      resetRecovery: resetErrorRecovery,
      clearBudgetWarning: () => {
        runtimeState.accounting.budgetWarningSentFor = null;
      },
      clearHostOverflowRecovery: () => {
        clearActiveHostOverflowRecovery(runtimeState.recoveryState);
      },
      setRecoveryPausedAttention: (reason: string) => {
        setRecoveryPausedAttention(runtimeState.recoveryState, reason);
      },
      markContinuationQueued: continuation.markContinuationQueued,
      stopStatusRefresh: () => status.stopStatusRefresh(),
    },
    refreshUi: (ctx) => status.refreshUi(ctx),
  });

  const goalAccounting = createGoalAccounting({
    getGoal: () => stateController.getGoal(),
    getAccounting: () => runtimeState.accounting,
    applyRuntimeAccountingTransition(ctx, nextGoal, receiptId) {
      const request = receiptId
        ? { kind: "runtime_accounting" as const, nextGoal, receiptId }
        : { kind: "runtime_accounting" as const, nextGoal };
      stateController.applyGoalTransition(request, ctx);
    },
    sendMessage: pi.sendMessage.bind(pi),
  });
  pi.events.on("subagent:usage", data => {
    if (runtimeContext) goalAccounting.accountSubagentUsage(runtimeContext, data);
  });

  const recoveryRuntime = createGoalRecoveryRuntime({
    getGoal: () => stateController.getGoal(),
    getRecoveryState: () => runtimeState.recoveryState,
    clearContinuationState: continuation.clearContinuationState,
    pauseGoalForRecovery(ctx, recoveryReason) {
      stateController.pauseForRecovery(ctx, recoveryReason);
    },
    refreshUi: status.refreshUi,
    maybeContinue: continuation.maybeContinue,
    scheduleProviderLimitAutoResume(goalId, ctx) {
      autoResumeContext = ctx;
      providerLimitAutoResume.schedule(goalId);
      status.refreshUi(ctx);
    },
  });

  const resumeGoalWithContinuation = (
    goalId: string,
    _source: GoalEntrySource,
    ctx: StatusContext,
  ): GoalResult => {
    const result = updateGoalStatus(stateController.getGoal(), "active");
    if (!result.ok || !result.goal || result.goal.goalId !== goalId) {
      return result;
    }
    if (!autonomy.reserve()) {
      return { ok: false, message: "Goal autonomy blocked. Inspect /goal-guard status.", goal: stateController.getGoal() };
    }
    providerLimitAutoResume.clear();
    stateController.resumePausedGoal(ctx);
    const resumedGoal = stateController.getGoal();
    if (resumedGoal?.status === "active" && resumedGoal.goalId === goalId) {
      pi.sendUserMessage(compactContinuationPrompt(resumedGoal), { deliverAs: "followUp" });
    }
    return result;
  };

  const eventHandlers = createGoalRuntimeEventHandlers({
    pi,
    runtimeState,
    stateController,
    continuation,
    goalAccounting,
    recoveryRuntime,
    status,
    providerLimitAutoResume,
    clearActiveAccounting,
    resetErrorRecovery,
    resumeGoalWithContinuation,
  });

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    providerLimitAutoResume.clear();
    goalAccounting.accountProgress(ctx, false, 0, true);
    return stateController.completeGoal(source, ctx);
  };

  return {
    ...eventHandlers,
    getGoalForDisplay: goalForDisplay,
    getGoalStartTurnStrategy: () => goalStartTurnStrategy(runtimeState.recoveryState.phase),
    onSessionStart(event, ctx) {
      runtimeContext = ctx;
      return eventHandlers.onSessionStart(event, ctx);
    },
    onSessionTree(event, ctx) {
      runtimeContext = ctx;
      return eventHandlers.onSessionTree(event, ctx);
    },
    async onSessionShutdown(event, ctx) {
      try { return await eventHandlers.onSessionShutdown(event, ctx); }
      finally { runtimeContext = null; }
    },
    setGoal(nextGoal, source, ctx) {
      autonomy.bind(ctx);
      if (source === "command" && nextGoal.status === "paused") autonomy.brake("Explicit goal pause");
      providerLimitAutoResume.clear();
      providerLimitAutoResume.clear();
      stateController.applyGoalTransition({ kind: "set", nextGoal, source }, ctx);
    },
    clearGoal(source, ctx) {
      providerLimitAutoResume.clear();
      stateController.applyGoalTransition({ kind: "clear", source }, ctx);
    },
    cancelProviderLimitAutoResume(_goalId, ctx) {
      autonomy.brake("Explicit resume cancellation");
      providerLimitAutoResume.clear();
      status.refreshUi(ctx);
    },
    completeGoal,
    resumeGoalWithContinuation,
  };
}

export function registerGoalRuntimeController(pi: ExtensionAPI): void {
  const controller = createGoalRuntimeController(pi);
  registerGoalTools(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    setGoal: controller.setGoal.bind(controller),
    completeGoal: controller.completeGoal.bind(controller),
  });
  registerGoalCommand(pi, {
    getGoal: () => controller.getGoalForDisplay(),
    getGoalStartTurnStrategy: controller.getGoalStartTurnStrategy.bind(controller),
    setGoal: controller.setGoal.bind(controller),
    clearGoal: controller.clearGoal.bind(controller),
    cancelProviderLimitAutoResume: controller.cancelProviderLimitAutoResume.bind(controller),
    resumeGoalWithContinuation: controller.resumeGoalWithContinuation.bind(controller),
  });
  registerGoalRuntimeEvents(pi, controller);
}
