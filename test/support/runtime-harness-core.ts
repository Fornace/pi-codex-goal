import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../src/index.js";
import { reconstructGoal } from "../../src/state.js";
import type { SentMessage, SentUserMessage } from "./runtime-harness.js";
type EventHandler = (event: object, ctx: ExtensionContext) => unknown | Promise<unknown>;
function unsupportedHarnessMethod(name: string): never { throw new Error(`${name} is not implemented in this test harness.`); }
export function createRuntimeHarness(options: {
  idle?: boolean;
  pendingMessages?: boolean;
  compactBehavior?: "success" | "error" | "unavailable";
  compactCompletion?: "immediate" | "manual";
  contextWindow?: number;
  contextUsage?: ReturnType<ExtensionContext["getContextUsage"]>;
} = {}) {
  const entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]> = [];
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: SentMessage[] = [];
  const sentUserMessages: SentUserMessage[] = [];
  const tools = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const compactCalls: Array<{
    customInstructions?: string;
    onComplete?: (result: {
      summary: string;
      tokensBefore: number;
      firstKeptEntryId: string;
    }) => void;
    onError?: (error: Error) => void;
  }> = [];
  const footerStatuses: Array<string | undefined> = [];
  const runtime = {
    abortCount: 0,
    idle: options.idle ?? true,
    pendingMessages: options.pendingMessages ?? false,
    compactBehavior: options.compactBehavior ?? "success",
    compactCompletion: options.compactCompletion ?? "immediate",
    contextUsage: options.contextUsage,
    hostOverflowRecoveryAttempted: false,
  };
  let commandHandler: ((args: string, ctx: ExtensionCommandContext) => void | Promise<void>) | null = null;
  let ctx: ExtensionCommandContext;
  let entryIndex = 0;

  const on = ((event: string, handler: EventHandler) => {
    const currentHandlers = handlers.get(event) ?? [];
    currentHandlers.push(handler);
    handlers.set(event, currentHandlers);
  }) as ExtensionAPI["on"];

  const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
    if (name === "goal") {
      commandHandler = options.handler;
    }
  };

  const pi: ExtensionAPI = {
    appendEntry(customType: string, data: unknown) {
      entries.push({
        type: "custom",
        id: `entry-${++entryIndex}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        customType,
        data,
      });
    },
    events: {
      emit() {},
      on() { return () => {}; },
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [],
    getAllTools: () => [],
    getCommands: () => [],
    getFlag: () => undefined,
    getSessionName: () => undefined,
    getThinkingLevel: () => "medium",
    on,
    registerCommand,
    registerEntryRenderer() {
      unsupportedHarnessMethod("pi.registerEntryRenderer");
    },
    registerFlag() {
      unsupportedHarnessMethod("pi.registerFlag");
    },
    registerMessageRenderer() {
      unsupportedHarnessMethod("pi.registerMessageRenderer");
    },
    registerMarkdownTransformer() {
      unsupportedHarnessMethod("pi.registerMarkdownTransformer");
    },
    registerProvider() {
      unsupportedHarnessMethod("pi.registerProvider");
    },
    registerShortcut() {},
    registerTool(tool) {
      tools.set(tool.name, (params) =>
        tool.execute(
          "tool-call",
          params as Parameters<typeof tool.execute>[1],
          undefined,
          undefined,
          ctx,
        ),
      );
    },
    sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content, options) {
      sentUserMessages.push({ content, options });
    },
    setActiveTools() {
      unsupportedHarnessMethod("pi.setActiveTools");
    },
    setLabel() {
      unsupportedHarnessMethod("pi.setLabel");
    },
    setModel: async () => false,
    setSessionName() {
      unsupportedHarnessMethod("pi.setSessionName");
    },
    setThinkingLevel() {
      unsupportedHarnessMethod("pi.setThinkingLevel");
    },
    unregisterProvider() {
      unsupportedHarnessMethod("pi.unregisterProvider");
    },
  };

  const sessionManager: ExtensionCommandContext["sessionManager"] = {
    buildContextEntries: () => entries,
    getBranch: () => entries,
    getCwd: () => "/tmp",
    getEntries: () => entries,
    getEntry: () => undefined,
    getHeader: () => null,
    getLabel: () => undefined,
    getLeafEntry: () => undefined,
    getLeafId: () => null,
    getSessionDir: () => "/tmp",
    getSessionFile: () => undefined,
    getSessionId: () => "session",
    getSessionName: () => undefined,
    getTree: () => [],
  };

  const ui: ExtensionCommandContext["ui"] = {
    addAutocompleteProvider() {},
    confirm: async () => true,
    custom: async () => {
      throw new Error("custom UI is not implemented in this test harness.");
    },
    editor: async () => undefined,
    getAllThemes: () => [],
    getEditorComponent: () => undefined,
    getEditorText: () => "",
    getTheme: () => undefined,
    getToolsExpanded: () => false,
    input: async () => undefined,
    notify() {},
    onTerminalInput: () => () => {},
    pasteToEditor() {},
    select: async () => undefined,
    setEditorComponent() {},
    setEditorText() {},
    setFooter() {},
    setHeader() {},
    setHiddenThinkingLabel() {},
    setStatus(_key, status) {
      footerStatuses.push(status);
    },
    setTheme: () => ({ success: false }),
    setTitle() {},
    setToolsExpanded() {},
    setWidget() {},
    setWorkingIndicator() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    theme: {} as ExtensionCommandContext["ui"]["theme"],
  };

  ctx = {
    abort() {
      runtime.abortCount += 1;
    },
    cwd: "/tmp",
    fork: async () => ({ cancelled: false }),
    getContextUsage: () => runtime.contextUsage,
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: ctx.cwd }),
    hasUI: true,
    compact(options) {
      const call: (typeof compactCalls)[number] = {};
      if (options?.customInstructions !== undefined) {
        call.customInstructions = options.customInstructions;
      }
      if (options?.onComplete) {
        call.onComplete = (result) => options.onComplete?.(result);
      }
      if (options?.onError) {
        call.onError = (error) => options.onError?.(error);
      }
      compactCalls.push(call);
      if (runtime.compactBehavior === "unavailable") {
        unsupportedHarnessMethod("ctx.compact");
      }
      if (runtime.compactBehavior === "error") {
        options?.onError?.(new Error("compaction failed"));
        return;
      }
      if (runtime.compactCompletion === "immediate") {
        options?.onComplete?.({
          summary: "compact summary",
          tokensBefore: 100,
          firstKeptEntryId: "entry-1",
        });
      }
    },
    hasPendingMessages: () => runtime.pendingMessages,
    isIdle: () => runtime.idle,
    isProjectTrusted: () => true,
    mode: "tui",
    model: undefined,
    scopedModels: [],
    modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
    navigateTree: async () => ({ cancelled: false }),
    newSession: async () => ({ cancelled: false }),
    reload: async () => {},
    sessionManager,
    shutdown() {},
    signal: undefined,
    switchSession: async () => ({ cancelled: false }),
    ui,
    waitForIdle: async () => {},
  } satisfies ExtensionCommandContext;

  if (options.contextWindow !== undefined) {
    ctx.model = {
      id: "test-model",
      provider: "test",
      contextWindow: options.contextWindow,
    } as ExtensionCommandContext["model"];
  }

  goalExtension(pi);

  function reloadExtension(): void {
    handlers.clear();
    goalExtension(pi);
  }

  async function reloadSession(reason: "startup" | "reload" | "resume" = "startup"): Promise<void> {
    reloadExtension();
    await emit("session_start", { type: "session_start", reason });
  }

  async function runCommand(args: string): Promise<void> {
    assert.ok(commandHandler);
    await commandHandler(args, ctx);
  }

  async function emit(event: string, payload: object): Promise<unknown[]> {
    if (event === "message_start") {
      const message = (payload as { message?: { role?: string } }).message;
      if (message?.role === "user") {
        runtime.hostOverflowRecoveryAttempted = false;
      }
    }
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(payload, ctx));
    }
    return results;
  }

  async function runTool(name: string, params: Record<string, unknown>) {
    const tool = tools.get(name);
    assert.ok(tool, `Expected tool ${name} to be registered.`);
    return tool(params);
  }

  return {
    compactCalls,
    footerStatuses,
    emit,
    entries,
    runCommand,
    runTool,
    reloadExtension,
    reloadSession,
    sentMessages,
    sentUserMessages,
    setIdle(idle: boolean) {
      runtime.idle = idle;
    },
    setPendingMessages(pendingMessages: boolean) {
      runtime.pendingMessages = pendingMessages;
    },
    setContextUsage(contextUsage: ReturnType<ExtensionContext["getContextUsage"]>) {
      runtime.contextUsage = contextUsage;
    },
    setContextWindow(contextWindow: number) {
      ctx.model = {
        id: "test-model",
        provider: "test",
        contextWindow,
      } as ExtensionCommandContext["model"];
    },
    get hostOverflowRecoveryAttempted() {
      return runtime.hostOverflowRecoveryAttempted;
    },
    setHostOverflowRecoveryAttempted(value: boolean) {
      runtime.hostOverflowRecoveryAttempted = value;
    },
    get abortCount() {
      return runtime.abortCount;
    },
    snapshot: () => reconstructGoal(entries),
  };
}

