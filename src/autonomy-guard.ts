import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { continuationGoalIdFromPrompt } from "./prompts.js";
import { CUSTOM_ENTRY_TYPE } from "./types.js";

const ENTRY = "goal-autonomy-guard";
const TOKEN_LIMIT = 8_000_000;
const CONTINUATION_LIMIT = 64;
type Guard = { version: 1; paused: boolean; reason: string; continuations: number; resetAfter?: string | undefined };

/** Independent of owner goal budgets. Resets require an explicit command, never a model tool. */
export function createAutonomyGuard(pi: ExtensionAPI, deps: {
  active: () => boolean;
  pause: (ctx: ExtensionContext, reason: string) => void;
  clear: () => void;
}) {
  let context: ExtensionContext | undefined;
  let state: Guard = { version: 1, paused: false, reason: "", continuations: 0 };
  let mechanical: { state: string; reason: string } | undefined;
  const save = () => pi.appendEntry(ENTRY, { ...state });
  const pause = (ctx: ExtensionContext, reason: string) => {
    deps.clear();
    if (!state.paused) {
      state = { ...state, paused: true, reason };
      save();
      ctx.ui.notify(`Goal autonomy paused: ${reason}. Use /goal-guard reset, then /goal resume.`, "warning");
    }
    deps.pause(ctx, state.reason);
  };
  const load = (ctx: ExtensionContext) => {
    context = ctx;
    state = { version: 1, paused: false, reason: "", continuations: 0 };
    mechanical = undefined;
    // Full append history prevents /tree from refunding the independent allowance.
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY) {
        const value = entry.data as Guard;
        state = value?.version === 1 && typeof value.paused === "boolean" &&
          typeof value.reason === "string" && Number.isSafeInteger(value.continuations) && value.continuations >= 0 &&
          (value.resetAfter === undefined || typeof value.resetAfter === "string")
          ? value : { version: 1, paused: true, reason: "Invalid autonomy record", continuations: 0 };
      }
    }
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "mantice-spend-guard") {
        const value = entry.data as { version?: number; state?: string; reason?: string };
        mechanical = value?.version === 1 && ["ready", "compacting", "paused"].includes(value.state ?? "") && typeof value.reason === "string"
          ? { state: value.state!, reason: value.reason } : { state: "paused", reason: "Invalid Mantice guard record" };
      }
    }
  };
  const tokens = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getEntries();
    const start = state.resetAfter ? entries.findIndex(e => e.id === state.resetAfter) + 1 : 0;
    if (state.resetAfter && start === 0) return Infinity;
    let total = 0;
    for (const entry of entries.slice(start)) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const n = entry.message.usage?.[key] ?? 0;
        if (!Number.isFinite(n) || n < 0) return Infinity;
        total += n;
      }
    }
    return total;
  };
  const allowed = (ctx = context): boolean => {
    if (!ctx) return false;
    if (mechanical?.state === "compacting") { deps.clear(); return false; }
    if (mechanical?.state === "paused") pause(ctx, `Mantice guard: ${mechanical.reason}`);
    if (tokens(ctx) >= TOKEN_LIMIT) pause(ctx, `Cache-inclusive allowance reached (${TOKEN_LIMIT} tokens)`);
    if (state.continuations > CONTINUATION_LIMIT) pause(ctx, `Continuation allowance reached (${CONTINUATION_LIMIT})`);
    if (state.paused) { deps.pause(ctx, state.reason); return false; }
    return true;
  };
  pi.events.on("mantice:spend-guard", (data: unknown) => {
    const event = data as { sessionId?: string; state?: string; reason?: string };
    if (!context || event.sessionId !== context.sessionManager.getSessionId()) return;
    mechanical = { state: event.state ?? "paused", reason: event.reason ?? "Invalid guard event" };
    if (mechanical.state !== "ready") deps.clear();
    if (mechanical.state === "paused") pause(context, `Mantice guard: ${mechanical.reason}`);
  });
  pi.events.on("subagent:guard-paused", (data: unknown) => {
    if (context) pause(context, `Child guard: ${(data as { reason: string }).reason}`);
  });
  pi.on("session_start", (_event, ctx) => { load(ctx); });
  pi.on("session_tree", (_event, ctx) => { load(ctx); });
  pi.on("message_end", (event, ctx) => {
    if (!deps.active() || event.message.role !== "assistant") return;
    if (["error", "aborted"].includes(event.message.stopReason)) pause(ctx, `Assistant ${event.message.stopReason}`);
    allowed(ctx);
  });
  pi.on("turn_end", (_event, ctx) => { allowed(ctx); });
  pi.on("agent_end", (_event, ctx) => { allowed(ctx); });
  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    const text = message.role === "user" && typeof message.content === "string" ? message.content : "";
    const queued = (message.role === "custom" && message.customType === CUSTOM_ENTRY_TYPE) || continuationGoalIdFromPrompt(text) !== null;
    if (queued && !allowed(ctx)) ctx.abort();
  });
  pi.registerCommand("goal-guard", {
    description: "Goal autonomy status, pause, or explicit allowance reset",
    async handler(args, ctx) {
      if (args.trim() === "pause") { pause(ctx, "Explicit brake"); ctx.abort(); return; }
      if (args.trim() === "reset") {
        if (!ctx.isIdle()) { ctx.ui.notify("Wait for idle before resetting goal autonomy.", "warning"); return; }
        if (mechanical && mechanical.state !== "ready") {
          ctx.ui.notify(`Mantice guard ${mechanical.state}: ${mechanical.reason}`, "warning"); return;
        }
        const entries = ctx.sessionManager.getEntries();
        state = { version: 1, paused: false, reason: "", continuations: 0, resetAfter: entries.at(-1)?.id };
        save();
      }
      ctx.ui.notify(`Goal autonomy ${state.paused ? "paused: " + state.reason : "ready"}. ${tokens(ctx)}/${TOKEN_LIMIT} tokens, ${state.continuations}/${CONTINUATION_LIMIT} continuations.`);
    },
  });
  return {
    bind(ctx: ExtensionContext) { if (!context) load(ctx); },
    allowed,
    reserve(ctx?: ExtensionContext) {
      if (!allowed(ctx)) return false;
      if (state.continuations >= CONTINUATION_LIMIT) {
        if (ctx ?? context) pause((ctx ?? context)!, `Continuation allowance reached (${CONTINUATION_LIMIT})`);
        return false;
      }
      state.continuations++;
      save();
      return true;
    },
    brake(reason: string) { if (context) pause(context, reason); },
  };
}
