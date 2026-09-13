import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { budgetLimitPrompt } from "./prompts.js";
import { applyUsage } from "./state.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "./types.js";
import { parseSubagentUsageReceipt, receiptTokens } from "./subagent-usage.js";

export interface AccountingState {
  activeGoalId: string | null;
  lastAccountedAt: number | null;
  budgetWarningSentFor: string | null;
}

export interface AssistantUsage {
  input: number;
  output: number;
}

export interface AssistantTurnMessage {
  role: string;
  stopReason?: string;
  usage?: AssistantUsage;
}

export function createAccountingState(): AccountingState {
  return {
    activeGoalId: null,
    lastAccountedAt: null,
    budgetWarningSentFor: null,
  };
}

function usageChannelTokens(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

export function assistantTurnTokens(message: AssistantTurnMessage): number {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }
  return usageChannelTokens(message.usage.input) + usageChannelTokens(message.usage.output);
}

export function isAbortedAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

export function isToolUseAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

interface GoalAccountingDeps {
  getGoal: () => ThreadGoal | null;
  getAccounting: () => AccountingState;
  applyRuntimeAccountingTransition: (ctx: ExtensionContext, nextGoal: ThreadGoal, receiptId?: string) => void;
  sendMessage: ExtensionAPI["sendMessage"];
}

export function createGoalAccounting(deps: GoalAccountingDeps) {
  const clearActiveAccounting = (): void => {
    const accounting = deps.getAccounting();
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
  };

  const beginAccounting = (): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    if (!goal || goal.status !== "active") {
      accounting.activeGoalId = null;
      accounting.lastAccountedAt = null;
      return;
    }

    accounting.activeGoalId = goal.goalId;
    accounting.lastAccountedAt = Date.now();
  };

  const accountProgress = (
    ctx: ExtensionContext,
    allowBudgetSteering: boolean,
    completedTurnTokens = 0,
    accountBudgetLimited = false,
  ): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    const canAccount = goal?.status === "active" || (accountBudgetLimited && goal?.status === "budgetLimited");
    if (!goal || accounting.activeGoalId !== goal.goalId || !canAccount) {
      beginAccounting();
      return;
    }

    const now = Date.now();
    const elapsed = accounting.lastAccountedAt === null ? 0 : Math.floor((now - accounting.lastAccountedAt) / 1000);
    accounting.lastAccountedAt = now;

    const result = applyUsage(goal, completedTurnTokens, elapsed, {
      expectedGoalId: accounting.activeGoalId,
      accountBudgetLimited,
    });
    if (!result.changed || !result.goal) {
      return;
    }

    deps.applyRuntimeAccountingTransition(ctx, result.goal);

    if (allowBudgetSteering && result.crossedBudget && accounting.budgetWarningSentFor !== result.goal.goalId) {
      accounting.budgetWarningSentFor = result.goal.goalId;
      deps.sendMessage(
        {
          customType: CUSTOM_ENTRY_TYPE,
          content: budgetLimitPrompt(result.goal),
          display: false,
          details: { kind: "budget_limit", goalId: result.goal.goalId },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  };

  const accountSubagentUsage = (ctx: ExtensionContext, data: unknown): void => {
    const receipt = parseSubagentUsageReceipt(data);
    const goal = deps.getGoal();
    if (!receipt || receipt.sessionId !== ctx.sessionManager.getSessionId() ||
        !goal || receipt.goalId !== goal.goalId || !["active", "budgetLimited"].includes(goal.status)) return;
    const consumed = ctx.sessionManager.getBranch().some(entry =>
      entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE &&
      (entry.data as { kind?: string; receiptId?: string })?.kind === "usage" &&
      (entry.data as { receiptId?: string }).receiptId === receipt.receiptId);
    if (consumed) return;
    const result = applyUsage(goal, receiptTokens(receipt), 0, {
      expectedGoalId: receipt.goalId,
      accountBudgetLimited: true,
    });
    if (!result.changed || !result.goal) return;
    deps.applyRuntimeAccountingTransition(ctx, result.goal, receipt.receiptId);
    if (result.crossedBudget && deps.getAccounting().budgetWarningSentFor !== result.goal.goalId) {
      deps.getAccounting().budgetWarningSentFor = result.goal.goalId;
      deps.sendMessage({ customType: CUSTOM_ENTRY_TYPE, content: budgetLimitPrompt(result.goal), display: false,
        details: { kind: "budget_limit", goalId: result.goal.goalId } }, { triggerTurn: true, deliverAs: "steer" });
    }
  };

  return {
    clearActiveAccounting,
    beginAccounting,
    accountProgress,
    accountSubagentUsage,
  };
}
