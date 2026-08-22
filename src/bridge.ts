import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  bridgeRequestEnvelopeSchema,
  buildShellEnvOverrides,
  createBridgeIo,
  createBridgeLineHandler,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  reasoningLevelValues,
  runBridgeRequest,
  skillsConfigureParamsSchema,
  threadDiscardParamsSchema,
  threadResumeParamsSchema,
  threadScope,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnScope,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  withoutBridgeRuntimeEnv,
  type AvailableModel,
  type BridgeExecutionOptions,
  type ModelReasoningEffort,
  type PromptInput,
  type ProviderBridgeDefinition,
  type ProviderErrorCategory,
  type ReasoningLevel,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  createFxAcpConnection,
  type AcpConnection,
  type AcpConnectionFactory,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./acp-client.js";

const execFileAsync = promisify(execFile);
const DEFAULT_FX_MODEL = "zai/glm-5.2";
const FX_COMMAND_TIMEOUT_MS = 30_000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 10_000;

type ThreadStartParams = z.infer<typeof threadStartParamsSchema>;
type ThreadResumeParams = z.infer<typeof threadResumeParamsSchema>;
type ThreadStopParams = z.infer<typeof threadStopParamsSchema>;
type ThreadDiscardParams = z.infer<typeof threadDiscardParamsSchema>;
type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
type TurnSteerParams = z.infer<typeof turnSteerParamsSchema>;
type SkillsConfigureParams = z.infer<typeof skillsConfigureParamsSchema>;
type OptionalScope<T> = T extends { scope: ThreadEvent["scope"] }
  ? Omit<T, "scope"> & { scope?: ThreadEvent["scope"] }
  : T;
type UnscopedThreadEvent = OptionalScope<ThreadEvent>;

interface ModelCatalogResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

interface FxToolItem {
  id: string;
  title: string;
  kind: string;
  result?: string;
  completed: boolean;
  /** Last progress line emitted, so repeats are not re-sent to the timeline. */
  lastProgress?: string;
}

interface FxTurn {
  id: string;
  clientRequestId: string;
  currentAgentItemId?: string;
  currentAgentText: string;
  tools: Map<string, FxToolItem>;
  settled: boolean;
  resolveSettled(): void;
  settledPromise: Promise<void>;
}

interface FxSession {
  threadId: string;
  providerThreadId: string;
  connection: AcpConnection;
  cwd: string;
  model?: string;
  /** fx's reasoning config option, when it reports one, for turn-time forwarding. */
  reasoningConfig?: FxReasoningConfig;
  instructions?: string;
  sentInstructionFingerprint?: string;
  activeTurn?: FxTurn;
  releasing: boolean;
  lastRecoveryState?: string;
  lastRecoveryMessage?: string;
  lastRecoveryCause?: string;
}

export interface FxBridgeDependencies {
  createConnection?: AcpConnectionFactory;
  loadModels?: (cwd?: string) => Promise<ModelCatalogResult>;
  write?: (line: string) => void;
}

interface BridgeNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJsonOutput(stdout: string, command: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(stdout)) ?? {};
  } catch {
    throw new Error(`fx ${command} returned invalid JSON output`);
  }
}

function statusValue(value: unknown): string {
  return typeof value === "string" ? value : "pending";
}

/**
 * Vendor labels for the `vendor/model` ids fx reports. fx exposes well over a
 * hundred models, so the picker keeps the vendor: the bare model segment is
 * ambiguous ("nova-pro", "command-a") once the slug is dropped. Unknown
 * vendors fall back to title case rather than a guessed brand spelling.
 */
const FX_VENDOR_LABELS = new Map<string, string>([
  ["alibaba", "Alibaba"],
  ["amazon", "Amazon"],
  ["anthropic", "Anthropic"],
  ["bytedance", "ByteDance"],
  ["cohere", "Cohere"],
  ["deepseek", "DeepSeek"],
  ["google", "Google"],
  ["meta", "Meta"],
  ["minimax", "MiniMax"],
  ["mistral", "Mistral"],
  ["moonshotai", "Moonshot AI"],
  ["nvidia", "NVIDIA"],
  ["openai", "OpenAI"],
  ["perplexity", "Perplexity"],
  ["tencent", "Tencent"],
  ["zai", "Z.ai"],
]);

/** Slug segments that read as acronyms rather than words. */
const FX_MODEL_ACRONYMS = new Set([
  "glm",
  "gpt",
  "hy",
  "kat",
  "mt2",
  "oss",
  "vl",
]);

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (FX_MODEL_ACRONYMS.has(lower)) return lower.toUpperCase();
      if (/^[\d.]/u.test(part)) return part;
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function formatModelName(id: string): string {
  const separator = id.indexOf("/");
  if (separator < 0) return titleCaseSlug(id);
  const vendor = id.slice(0, separator);
  const model = id.slice(separator + 1);
  const vendorLabel = FX_VENDOR_LABELS.get(vendor) ?? titleCaseSlug(vendor);
  return `${vendorLabel} ${titleCaseSlug(model)}`;
}

/**
 * Reasoning support is derived from fx's own ACP config report rather than
 * hardcoded. fx exposes the levels it understands as a config option in the
 * `session/new` result, which this bridge reads and forwards back on turn
 * start. When fx reports no reasoning config option (the case for fx 0.0.4,
 * whose only config options are `model` and `mode`) no levels are advertised:
 * BB renders a "Reasoning" section in the picker for any non-empty effort
 * list, and it shows only the level label, so advertising a "medium" level
 * would misrepresent a setting this bridge never applies. BB's schema still
 * requires `defaultReasoningEffort` on every model, so "medium" is kept there
 * (BB also sends `reasoningLevel` on turn start by default), but that value is
 * ignored while fx reports no reasoning option.
 */
interface ReasoningSupport {
  supportedReasoningEfforts: ModelReasoningEffort[];
  defaultReasoningEffort: ReasoningLevel;
}

/** Map the value strings an ACP agent emits to BB reasoning levels. */
const ACP_REASONING_LEVEL_BY_VALUE: Record<string, ReasoningLevel> = {
  none: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  ultracode: "ultracode",
  max: "max",
  ultra: "ultra",
};

/** Candidate agent values to try for a chosen BB level, best fit first. */
const ACP_REASONING_VALUE_CANDIDATES_BY_LEVEL: Record<
  ReasoningLevel,
  string[]
> = {
  none: ["none"],
  low: ["low", "minimal"],
  medium: ["medium"],
  high: ["high"],
  xhigh: ["xhigh"],
  ultracode: ["ultracode", "xhigh"],
  max: ["max", "xhigh"],
  ultra: ["ultra"],
};

interface FxReasoningConfig {
  id: string;
  currentValue?: string;
  values: Set<string>;
  options: Array<{ value: string; name?: string }>;
}

function findFxReasoningConfig(configOptions: unknown): FxReasoningConfig | undefined {
  const options = Array.isArray(configOptions) ? configOptions : [];
  for (const entry of options) {
    const option = asRecord(entry);
    if (!option) continue;
    // The ACP convention for the reasoning option is `category: "thought_level"`.
    // Accept the common `reasoning_effort` config id as well; a declared option
    // is authoritative even when this bridge cannot map its values.
    if (
      stringValue(option.category) !== "thought_level" &&
      stringValue(option.id) !== "reasoning_effort" &&
      stringValue(option.id) !== "reasoning"
    ) {
      continue;
    }
    const id = stringValue(option.id);
    if (!id) continue;
    const valueOptions = Array.isArray(option.options) ? option.options : [];
    const normalized: FxReasoningConfig["options"] = [];
    const values = new Set<string>();
    for (const valueEntry of valueOptions) {
      const valueRecord = asRecord(valueEntry);
      const value = stringValue(valueRecord?.value);
      if (value === undefined) continue;
      values.add(value);
      normalized.push({
        value,
        ...(stringValue(valueRecord?.name) === undefined
          ? {}
          : { name: stringValue(valueRecord?.name) }),
      });
    }
    return {
      id,
      currentValue: stringValue(option.currentValue),
      values,
      options: normalized,
    };
  }
  return undefined;
}

function buildFxReasoningSupport(
  configOptions: unknown,
): ReasoningSupport {
  const reasoningConfig = findFxReasoningConfig(configOptions);
  if (!reasoningConfig) {
    // No reasoning option reported: advertise no levels so BB shows no
    // reasoning control. `defaultReasoningEffort` is schema-required.
    return {
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
    };
  }
  const supportedReasoningEfforts: ModelReasoningEffort[] = [];
  const seen = new Set<ReasoningLevel>();
  for (const option of reasoningConfig.options) {
    const level = ACP_REASONING_LEVEL_BY_VALUE[option.value];
    if (level === undefined || seen.has(level)) continue;
    seen.add(level);
    supportedReasoningEfforts.push({
      reasoningEffort: level,
      description: option.name ?? option.value,
    });
  }
  if (supportedReasoningEfforts.length === 0) {
    // A declared option is authoritative: advertise nothing rather than a
    // fabricated level the agent does not actually understand.
    return { supportedReasoningEfforts: [], defaultReasoningEffort: "medium" };
  }
  supportedReasoningEfforts.sort(
    (a, b) =>
      reasoningLevelValues.indexOf(a.reasoningEffort) -
      reasoningLevelValues.indexOf(b.reasoningEffort),
  );
  const currentLevel =
    reasoningConfig.currentValue === undefined
      ? undefined
      : ACP_REASONING_LEVEL_BY_VALUE[reasoningConfig.currentValue];
  const levels = supportedReasoningEfforts.map((effort) => effort.reasoningEffort);
  return {
    supportedReasoningEfforts,
    defaultReasoningEffort:
      currentLevel !== undefined && levels.includes(currentLevel)
        ? currentLevel
        : supportedReasoningEfforts[0].reasoningEffort,
  };
}

function availableModel(
  id: string,
  isDefault: boolean,
  reasoning: ReasoningSupport,
): AvailableModel {
  return {
    id,
    model: id,
    displayName: formatModelName(id),
    description: `Available through fx (${id}).`,
    ...reasoning,
    isDefault,
  };
}

export async function loadFxModels(
  cwd?: string,
  reasoning: ReasoningSupport = buildFxReasoningSupport(undefined),
): Promise<ModelCatalogResult> {
  const commandOptions = {
    cwd,
    env: withoutBridgeRuntimeEnv(process.env),
    timeout: FX_COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  };
  const [modelsResult, statusResult] = await Promise.all([
    execFileAsync("fx", ["models", "--json"], commandOptions),
    execFileAsync("fx", ["status", "--json"], commandOptions).catch(() => null),
  ]);
  const modelsPayload = parseJsonOutput(modelsResult.stdout, "models --json");
  const ids = Array.isArray(modelsPayload?.ids)
    ? modelsPayload.ids.filter((id): id is string => typeof id === "string")
    : [];
  if (ids.length === 0) {
    throw new Error("fx models returned no available models");
  }
  const statusPayload = statusResult
    ? parseJsonOutput(statusResult.stdout, "status --json")
    : undefined;
  const configuredDefault = stringValue(statusPayload?.model);
  // `fx status` can report a model that `fx models` omits (the account default
  // is not always in the public catalog), but fx's ACP session still accepts
  // it. Keep it selectable instead of silently falling back to a stranger.
  const catalogIds =
    configuredDefault && !ids.includes(configuredDefault)
      ? [configuredDefault, ...ids]
      : ids;
  const defaultId =
    (configuredDefault && catalogIds.includes(configuredDefault) && configuredDefault) ||
    (catalogIds.includes(DEFAULT_FX_MODEL) ? DEFAULT_FX_MODEL : catalogIds[0]);
  // Every fx model is user-selectable, so the whole catalog belongs in
  // `models`. `selectedOnlyModels` is BB's hidden bucket for entries that must
  // resolve when already selected but must not be offered in the picker.
  return {
    models: catalogIds.map((id) => availableModel(id, id === defaultId, reasoning)),
    selectedOnlyModels: [],
  };
}

function promptInputToText(input: readonly PromptInput[]): string {
  return input
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "localFile":
          return `[Attached file: ${part.path}]`;
        case "localImage":
          return `[Attached image path: ${part.path}]`;
        case "image":
          return `[Attached image URL: ${part.url}]`;
      }
    })
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createTurn(clientRequestId: string): FxTurn {
  let resolveSettled!: () => void;
  const settledPromise = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return {
    id: `fx-turn-${randomUUID()}`,
    clientRequestId,
    currentAgentText: "",
    tools: new Map(),
    settled: false,
    resolveSettled,
    settledPromise,
  };
}

function requestSchema(method: string): z.ZodType | undefined {
  switch (method) {
    case "initialize":
      return initializeParamsSchema;
    case "model/list":
      return modelListParamsSchema;
    case "thread/start":
      return threadStartParamsSchema;
    case "thread/resume":
      return threadResumeParamsSchema;
    case "thread/stop":
      return threadStopParamsSchema;
    case "thread/discard":
      return threadDiscardParamsSchema;
    case "turn/start":
      return turnStartParamsSchema;
    case "turn/steer":
      return turnSteerParamsSchema;
    case "skills/configure":
      return skillsConfigureParamsSchema;
    default:
      return undefined;
  }
}

export function createFxProviderBridge(
  dependencies: FxBridgeDependencies = {},
): ProviderBridgeDefinition {
  const createConnection = dependencies.createConnection ?? createFxAcpConnection;
  const loadModels = dependencies.loadModels ?? loadFxModels;
  const sessionsByThreadId = new Map<string, FxSession>();
  const sessionsByProviderThreadId = new Map<string, FxSession>();
  const recoverableSessions = new Map<
    string,
    { providerThreadId: string; cwd: string }
  >();
  let skillRoots: SkillsConfigureParams["roots"] = [];
  let initialized = false;

  const { send, sendResult, sendError } = createBridgeIo<BridgeNotification>({
    write: dependencies.write,
  });

  function sendThreadEvent(session: FxSession, event: ThreadEvent): void {
    send({
      jsonrpc: "2.0",
      method: BRIDGE_NOTIFICATION_METHODS.threadEvent,
      params: { threadId: session.threadId, event },
    });
  }

  function emit(
    session: FxSession,
    event: UnscopedThreadEvent,
    scope = session.activeTurn ? turnScope(session.activeTurn.id) : threadScope(),
  ): void {
    sendThreadEvent(session, { ...event, scope } as ThreadEvent);
  }

  function completeAgentMessage(session: FxSession, turn: FxTurn): void {
    if (!turn.currentAgentItemId) return;
    emit(session, {
      type: "item/completed",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      item: {
        type: "agentMessage",
        id: turn.currentAgentItemId,
        text: turn.currentAgentText,
      },
    });
    turn.currentAgentItemId = undefined;
    turn.currentAgentText = "";
  }

  function completeTool(
    session: FxSession,
    turn: FxTurn,
    tool: FxToolItem,
    status: "completed" | "failed" | "interrupted",
  ): void {
    if (tool.completed) return;
    tool.completed = true;
    emit(session, {
      type: "item/completed",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      item: {
        type: "toolCall",
        id: tool.id,
        tool: `fx.${tool.kind}`,
        status,
        ...(tool.result === undefined ? {} : { result: tool.result }),
      },
    });
  }

  function finishTurn(
    session: FxSession,
    turn: FxTurn,
    status: "completed" | "failed" | "interrupted",
    message?: string,
    category: ProviderErrorCategory = "unknown",
  ): void {
    if (turn.settled || session.releasing) return;
    turn.settled = true;
    completeAgentMessage(session, turn);
    for (const tool of turn.tools.values()) {
      completeTool(
        session,
        turn,
        tool,
        status === "failed" ? "failed" : "interrupted",
      );
    }
    if (status === "failed" && message) {
      emit(session, {
        type: "provider/error",
        threadId: session.threadId,
        providerThreadId: session.providerThreadId,
        message,
        errorInfo: {
          category,
          httpStatusCode: null,
          providerCode: null,
        },
        willRetry: false,
      });
    }
    emit(session, {
      type: "turn/completed",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      status,
      ...(message ? { error: { message } } : {}),
    });
    if (session.activeTurn === turn) session.activeTurn = undefined;
    turn.resolveSettled();
  }

  function handleAgentMessage(session: FxSession, text: string): void {
    const turn = session.activeTurn;
    if (!turn || turn.settled || !text) return;
    if (!turn.currentAgentItemId) {
      turn.currentAgentItemId = `fx-message-${randomUUID()}`;
      turn.currentAgentText = "";
      emit(session, {
        type: "item/started",
        threadId: session.threadId,
        providerThreadId: session.providerThreadId,
        item: {
          type: "agentMessage",
          id: turn.currentAgentItemId,
          text: "",
        },
      });
    }
    turn.currentAgentText += text;
    emit(session, {
      type: "item/agentMessage/delta",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      itemId: turn.currentAgentItemId,
      delta: text,
    });
  }

  function handleToolCall(
    session: FxSession,
    update: Record<string, unknown>,
  ): void {
    const turn = session.activeTurn;
    const callId = stringValue(update.toolCallId);
    if (!turn || turn.settled || !callId) return;
    completeAgentMessage(session, turn);
    const existing = turn.tools.get(callId);
    if (existing) return;
    const tool: FxToolItem = {
      id: `fx-tool-${randomUUID()}`,
      title: stringValue(update.title) ?? "fx tool",
      kind: stringValue(update.kind) ?? "other",
      completed: false,
    };
    turn.tools.set(callId, tool);
    emit(session, {
      type: "item/started",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      item: {
        type: "toolCall",
        id: tool.id,
        tool: `fx.${tool.kind}`,
        status: "pending",
      },
    });
    emitToolProgress(session, tool);
  }

  /**
   * fx re-sends `tool_call_update` for each chunk of a running tool, and its
   * title rarely changes. Emitting every one would stack identical progress
   * lines in the timeline, so only a changed message is forwarded.
   */
  function emitToolProgress(session: FxSession, tool: FxToolItem): void {
    if (tool.lastProgress === tool.title) return;
    tool.lastProgress = tool.title;
    emit(session, {
      type: "item/toolCall/progress",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      itemId: tool.id,
      message: tool.title,
    });
  }

  function extractToolResult(update: Record<string, unknown>): string | undefined {
    const content = update.content;
    if (!Array.isArray(content)) return undefined;
    const text = content.flatMap((entry) => {
      const block = asRecord(entry);
      const nested = asRecord(block?.content);
      const value = stringValue(nested?.text);
      return value ? [value] : [];
    });
    return text.length > 0 ? text.join("\n") : undefined;
  }

  function handleToolUpdate(
    session: FxSession,
    update: Record<string, unknown>,
  ): void {
    const turn = session.activeTurn;
    const callId = stringValue(update.toolCallId);
    if (!turn || turn.settled || !callId) return;
    let tool = turn.tools.get(callId);
    if (!tool) {
      handleToolCall(session, {
        toolCallId: callId,
        title: "fx tool",
        kind: "other",
      });
      tool = turn.tools.get(callId);
    }
    if (!tool || tool.completed) return;
    tool.result = extractToolResult(update) ?? tool.result;
    tool.title = stringValue(update.title) ?? tool.title;
    const status = statusValue(update.status);
    if (status === "completed" || status === "failed") {
      completeTool(session, turn, tool, status);
      return;
    }
    emitToolProgress(session, tool);
  }

  /**
   * fx nests its recovery payload as `_meta.fx.modelResponseRecovery`. Older
   * builds used a flat `"fx.modelResponseRecovery"` key, so accept both rather
   * than silently dropping every retry notice.
   */
  function readRecovery(
    update: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const meta = asRecord(update._meta);
    if (!meta) return undefined;
    return (
      asRecord(asRecord(meta.fx)?.modelResponseRecovery) ??
      asRecord(meta["fx.modelResponseRecovery"])
    );
  }

  function handleRecoveryUpdate(
    session: FxSession,
    update: Record<string, unknown>,
  ): void {
    const recovery = readRecovery(update);
    const state = stringValue(recovery?.state);
    if (!state) return;
    const message = stringValue(recovery?.message);
    session.lastRecoveryMessage = message;
    session.lastRecoveryCause = stringValue(recovery?.cause);
    // fx repeats `active` for every retry attempt. Keep emitting those so a
    // long backoff is visible, but never repeat a settled state.
    if (state === session.lastRecoveryState && state !== "active") return;
    session.lastRecoveryState = state;
    const attempt = recovery?.attempt;
    const attemptLimit = recovery?.attemptLimit;
    const attemptText =
      typeof attempt === "number" && typeof attemptLimit === "number"
        ? ` (attempt ${attempt}/${attemptLimit})`
        : "";
    const summary =
      state === "recovered"
        ? "fx model response recovered"
        : state === "paused"
          ? `fx paused after failing to reach the model${attemptText}`
          : `fx is recovering the model response${attemptText}`;
    emit(session, {
      type: "provider/warning",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      category: "general",
      summary,
      ...(message ? { details: message } : {}),
    });
  }

  function handleAcpNotification(
    session: FxSession,
    notification: JsonRpcNotification,
  ): void {
    if (notification.method !== "session/update") return;
    const params = asRecord(notification.params);
    if (stringValue(params?.sessionId) !== session.providerThreadId) return;
    const update = asRecord(params?.update);
    if (!update) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = asRecord(update.content);
        const text = stringValue(content?.text);
        if (text) handleAgentMessage(session, text);
        return;
      }
      case "tool_call":
        handleToolCall(session, update);
        return;
      case "tool_call_update":
        handleToolUpdate(session, update);
        return;
      case "session_info_update":
        handleRecoveryUpdate(session, update);
        return;
      default:
        return;
    }
  }

  function handleAcpRequest(request: JsonRpcRequest): unknown {
    if (request.method === "session/request_permission") {
      // BB advertises exactly one permission mode, `auto`, and tells the
      // runtime that approvals are `approvalEnforcedBy: "provider"` — so the
      // bridge *is* the automatic reviewer, and there is no BB surface that
      // could put this prompt in front of a person. Declining instead would
      // deny every file mutation and every shell command, which is the whole
      // agent. Prefer the single-use option so nothing is granted for longer
      // than the call that asked for it.
      const params = asRecord(request.params);
      const options = Array.isArray(params?.options) ? params.options : [];
      const kinds = options.map((option) => asRecord(option));
      const allowOption =
        kinds.find((option) => stringValue(option?.kind) === "allow_once") ??
        kinds.find((option) => stringValue(option?.kind)?.startsWith("allow"));
      const optionId = stringValue(allowOption?.optionId);
      if (optionId) {
        return { outcome: { outcome: "selected", optionId } };
      }
      // No allow option offered: cancelling leaves fx to report the blocked
      // action in the transcript rather than inventing an outcome.
      return { outcome: { outcome: "cancelled" } };
    }
    if (request.method === "elicitation/create") {
      return { action: "cancel" };
    }
    throw new Error(`Unsupported fx ACP client request: ${request.method}`);
  }

  function handleAcpExit(session: FxSession, error: Error): void {
    if (session.releasing) return;
    recoverableSessions.set(session.threadId, {
      providerThreadId: session.providerThreadId,
      cwd: session.cwd,
    });
    const turn = session.activeTurn;
    if (turn) finishTurn(session, turn, "failed", error.message);
    emit(
      session,
      {
        type: "provider/warning",
        threadId: session.threadId,
        providerThreadId: session.providerThreadId,
        category: "general",
        summary: "The fx process exited unexpectedly.",
        ...(error.message ? { details: error.message } : {}),
      },
      threadScope(),
    );
    sessionsByThreadId.delete(session.threadId);
    sessionsByProviderThreadId.delete(session.providerThreadId);
  }

  async function configureSession(
    session: FxSession,
    options: BridgeExecutionOptions,
  ): Promise<void> {
    const requestedModel = options.model;
    if (requestedModel && requestedModel !== session.model) {
      try {
        await session.connection.request("session/set_config_option", {
          sessionId: session.providerThreadId,
          configId: "model",
          value: requestedModel,
        });
      } catch (error) {
        // Fail loudly: silently running a turn on a different model than the
        // one the picker shows is worse than refusing the turn.
        throw new Error(
          `fx rejected the model "${requestedModel}": ${errorMessage(error)}`,
        );
      }
      session.model = requestedModel;
    }
    // Forward the user's chosen reasoning level only when fx actually reports a
    // reasoning config option. fx (0.0.4) exposes none — it manages reasoning
    // per model — and the catalog advertises no levels in that case, so this
    // is a no-op there.
    const requestedReasoning = options.reasoningLevel;
    const reasoningConfig = session.reasoningConfig;
    if (requestedReasoning && reasoningConfig && reasoningConfig.values.size > 0) {
      const value = (ACP_REASONING_VALUE_CANDIDATES_BY_LEVEL[requestedReasoning] ?? []).find(
        (candidate) => reasoningConfig.values.has(candidate),
      );
      if (value !== undefined) {
        try {
          await session.connection.request("session/set_config_option", {
            sessionId: session.providerThreadId,
            configId: reasoningConfig.id,
            value,
          });
        } catch (error) {
          throw new Error(
            `fx rejected reasoning level "${requestedReasoning}": ${errorMessage(error)}`,
          );
        }
      }
    }
    // Deliberately no `session/set_mode`. fx's "code" mode hands tool approval
    // to fx's own auto-mode classifier, which has no way to escalate over ACP:
    // it denies `terminal.exec` outright ("Permission denied by auto mode
    // classifier") and tells the model to fall back to `ask_user_question`,
    // which fx only offers in its interactive shell. Leaving the session in its
    // default "ask" mode is what routes approvals through
    // `session/request_permission`, where this bridge answers them.
    session.instructions = options.instructions;
  }

  async function createSession(
    kind: "start" | "resume",
    params: ThreadStartParams | ThreadResumeParams,
  ): Promise<FxSession> {
    const previous = sessionsByThreadId.get(params.threadId);
    if (previous) {
      previous.releasing = true;
      sessionsByThreadId.delete(previous.threadId);
      sessionsByProviderThreadId.delete(previous.providerThreadId);
      void previous.connection.close();
    }

    let sessionRef: FxSession | undefined;
    const env = {
      ...withoutBridgeRuntimeEnv(process.env),
      ...buildShellEnvOverrides(params.options.envVars),
      NO_COLOR: "1",
      // Pin the permission mode rather than inheriting whatever `fx
      // permissions` last persisted. `ask` is the only mode that routes tool
      // approval through ACP `session/request_permission`; under `auto` fx's
      // classifier denies non-interactively, and `yolo` would skip fx's own
      // sandboxing. See the note in configureSession.
      FX_PERMISSION_MODE: "ask",
    };
    const connection = await createConnection({
      cwd: params.cwd,
      env,
      onNotification(notification) {
        if (sessionRef) handleAcpNotification(sessionRef, notification);
      },
      onExit(error) {
        if (sessionRef) handleAcpExit(sessionRef, error);
      },
      onRequest: handleAcpRequest,
    });

    try {
      await connection.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "bb-plugin-fx", version: "0.2.0" },
      });
      const result = asRecord(
        await connection.request(
          kind === "start" ? "session/new" : "session/resume",
          kind === "start"
            ? { cwd: params.cwd, mcpServers: [] }
            : {
                sessionId: (params as ThreadResumeParams).providerThreadId,
                cwd: params.cwd,
                mcpServers: [],
              },
        ),
      );
      const providerThreadId =
        kind === "resume"
          ? stringValue(result?.sessionId) ??
            (params as ThreadResumeParams).providerThreadId
          : stringValue(result?.sessionId);
      if (!providerThreadId) {
        throw new Error("fx acp did not return a sessionId");
      }
      const session: FxSession = {
        threadId: params.threadId,
        providerThreadId,
        connection,
        cwd: params.cwd,
        reasoningConfig: findFxReasoningConfig(result?.configOptions),
        releasing: false,
      };
      sessionRef = session;
      await configureSession(session, params.options);
      sessionsByThreadId.set(session.threadId, session);
      sessionsByProviderThreadId.set(session.providerThreadId, session);
      recoverableSessions.set(session.threadId, {
        providerThreadId: session.providerThreadId,
        cwd: session.cwd,
      });
      return session;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  function instructionPrefix(session: FxSession): string {
    const rootText = skillRoots
      .map((root) => {
        const skills = root.skills
          .map(
            (skill) =>
              `- ${skill.name}: ${skill.description} (${root.path})`,
          )
          .join("\n");
        return skills || `- Skill root ${root.id}: ${root.path}`;
      })
      .join("\n");
    const sections = [session.instructions, rootText].filter(
      (value): value is string => Boolean(value?.trim()),
    );
    if (sections.length === 0) return "";
    const fingerprint = sections.join("\n\n");
    if (session.sentInstructionFingerprint === fingerprint) return "";
    session.sentInstructionFingerprint = fingerprint;
    return `<bb_instructions>\n${fingerprint}\n</bb_instructions>\n\n`;
  }

  const RECOVERY_CAUSE_CATEGORIES: Record<string, ProviderErrorCategory> = {
    provider_unavailable: "overloaded",
    rate_limited: "rate-limit",
    context_length_exceeded: "context-window-exceeded",
    unauthorized: "unauthorized",
  };

  function describeRefusal(session: FxSession): {
    message: string;
    category: ProviderErrorCategory;
  } {
    const cause = session.lastRecoveryCause;
    const category: ProviderErrorCategory =
      (cause === undefined ? undefined : RECOVERY_CAUSE_CATEGORIES[cause]) ??
      "unknown";
    if (session.lastRecoveryState === "paused" && session.lastRecoveryMessage) {
      return { message: `fx could not complete the turn: ${session.lastRecoveryMessage}`, category };
    }
    return {
      message:
        "fx ended the turn without a response. Check the thread for fx's own error output.",
      category,
    };
  }

  async function runTurn(session: FxSession, params: TurnStartParams): Promise<void> {
    const turn = createTurn(params.clientRequestId);
    session.activeTurn = turn;
    // Recovery state is per-turn: a fresh prompt must be able to re-report the
    // same state the previous turn ended on.
    session.lastRecoveryState = undefined;
    session.lastRecoveryMessage = undefined;
    session.lastRecoveryCause = undefined;
    emit(session, {
      type: "turn/input/accepted",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      clientRequestId: params.clientRequestId,
      scope: turnScope(turn.id),
    });
    emit(session, {
      type: "turn/started",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
    });

    try {
      await configureSession(session, params.options);
      const text = `${instructionPrefix(session)}${promptInputToText(params.input)}`.trim();
      const result = asRecord(
        await session.connection.request(
          "session/prompt",
          {
            sessionId: session.providerThreadId,
            prompt: [{ type: "text", text: text || "Continue." }],
          },
          0,
        ),
      );
      if (session.releasing || turn.settled) return;
      const stopReason = stringValue(result?.stopReason) ?? "end_turn";
      switch (stopReason) {
        case "end_turn":
          finishTurn(session, turn, "completed");
          break;
        case "cancelled":
          finishTurn(session, turn, "interrupted");
          break;
        case "max_output_tokens":
          finishTurn(
            session,
            turn,
            "failed",
            "fx reached the model output limit",
            "max-output-tokens",
          );
          break;
        case "max_model_turns":
          finishTurn(
            session,
            turn,
            "failed",
            "fx reached its model turn limit",
            "max-turns",
          );
          break;
        case "refused": {
          // fx returns `refused` for any terminal turn failure, not just a
          // model refusal — an exhausted 503 retry loop and a billing rejection
          // both land here. Prefer the recovery detail it already reported.
          const { message, category } = describeRefusal(session);
          finishTurn(session, turn, "failed", message, category);
          break;
        }
        default:
          finishTurn(session, turn, "failed", `fx stopped: ${stopReason}`);
      }
    } catch (error) {
      if (!session.releasing) {
        finishTurn(session, turn, "failed", errorMessage(error));
      }
    }
  }

  async function releaseSession(session: FxSession): Promise<void> {
    session.releasing = true;
    recoverableSessions.delete(session.threadId);
    sessionsByThreadId.delete(session.threadId);
    sessionsByProviderThreadId.delete(session.providerThreadId);
    try {
      await session.connection.request(
        "session/close",
        { sessionId: session.providerThreadId },
        2_000,
      );
    } catch {
      // Closing the process is authoritative; session/close is best effort.
    }
    await session.connection.close();
  }

  async function interruptSession(session: FxSession): Promise<void> {
    const turn = session.activeTurn;
    if (!turn) return;
    try {
      await session.connection.request(
        "session/cancel",
        { sessionId: session.providerThreadId },
        5_000,
      );
    } catch {
      session.connection.notify("session/cancel", {
        sessionId: session.providerThreadId,
      });
    }
    const settled = await Promise.race([
      turn.settledPromise.then(() => true),
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), INTERRUPT_SETTLE_TIMEOUT_MS),
      ),
    ]);
    if (!settled && !turn.settled) {
      finishTurn(session, turn, "interrupted", "fx cancellation timed out");
    }
  }

  async function closeAllSessions(): Promise<void> {
    await Promise.all(
      [...sessionsByThreadId.values()].map((session) => releaseSession(session)),
    );
  }

  async function handleRequest(request: {
    id: string | number;
    method: string;
    params: unknown;
  }): Promise<void> {
    switch (request.method) {
      case "initialize": {
        const params = request.params as z.infer<typeof initializeParamsSchema>;
        if (params.protocolVersion !== PROVIDER_BRIDGE_PROTOCOL_VERSION) {
          sendError(
            request.id,
            BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
            `Unsupported provider bridge protocol ${params.protocolVersion}`,
          );
          return;
        }
        initialized = true;
        sendResult(request.id, {
          protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
          capabilities: {
            approvalEnforcedBy: "provider",
            fork: "none",
            sessionRestore: true,
            threadArchive: false,
            threadGoalClear: false,
            threadRename: false,
          },
        });
        return;
      }
      case "model/list": {
        const params = request.params as z.infer<typeof modelListParamsSchema>;
        sendResult(request.id, await loadModels(params.cwd));
        return;
      }
      case "thread/start":
      case "thread/resume": {
        const params = request.params as ThreadStartParams | ThreadResumeParams;
        const session = await createSession(
          request.method === "thread/start" ? "start" : "resume",
          params,
        );
        emit(
          session,
          {
            type: "thread/identity",
            threadId: session.threadId,
            providerThreadId: session.providerThreadId,
          },
          threadScope(),
        );
        sendResult(request.id, {
          providerThreadId: session.providerThreadId,
          sessionRestorable: true,
        });
        return;
      }
      case "turn/start": {
        const params = request.params as TurnStartParams;
        let session = sessionsByThreadId.get(params.threadId);
        if (!session || session.providerThreadId !== params.providerThreadId) {
          const recoverable = recoverableSessions.get(params.threadId);
          if (recoverable?.providerThreadId === params.providerThreadId) {
            session = await createSession(
              "resume",
              {
                threadId: params.threadId,
                cwd: recoverable.cwd,
                instructionMode: "append",
                options: params.options,
                providerThreadId: params.providerThreadId,
              } as ThreadResumeParams,
            );
          }
        }
        if (!session) {
          sendError(request.id, BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE, "No active fx session");
          return;
        }
        if (session.activeTurn) {
          sendError(request.id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "An fx turn is already active");
          return;
        }
        void runTurn(session, params);
        sendResult(request.id, { threadId: params.threadId });
        return;
      }
      case "turn/steer": {
        const params = request.params as TurnSteerParams;
        const session = sessionsByThreadId.get(params.threadId);
        if (!session?.activeTurn) {
          sendError(request.id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "No active fx turn to steer");
          return;
        }
        sendError(
          request.id,
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          "fx ACP does not support steering an active prompt; interrupt and send a new turn",
        );
        return;
      }
      case "thread/stop": {
        const params = request.params as ThreadStopParams;
        const session =
          sessionsByThreadId.get(params.threadId) ??
          sessionsByProviderThreadId.get(params.providerThreadId);
        if (session) {
          if (params.intent === "release") await releaseSession(session);
          else await interruptSession(session);
        }
        sendResult(request.id, { ok: true });
        return;
      }
      case "thread/discard": {
        // BB sends discard for every deleted thread, ungated by capability.
        // Without it the fx subprocess for that thread would outlive it.
        const params = request.params as ThreadDiscardParams;
        const session =
          sessionsByThreadId.get(params.threadId) ??
          sessionsByProviderThreadId.get(params.providerThreadId);
        recoverableSessions.delete(params.threadId);
        if (session) await releaseSession(session);
        sendResult(request.id, { ok: true });
        return;
      }
      case "skills/configure": {
        const params = request.params as SkillsConfigureParams;
        skillRoots = params.roots;
        sendResult(request.id, { ok: true });
        return;
      }
    }
  }

  function handleParsedMessage(parsed: unknown): void {
    const envelope = bridgeRequestEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) return;
    const { id, method } = envelope.data;
    const schema = requestSchema(method);
    if (!schema) {
      sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `Unknown method "${method}"`,
      );
      return;
    }
    if (!initialized && method !== "initialize") {
      sendError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "Bridge is not initialized");
      return;
    }
    const params = schema.safeParse(envelope.data.params ?? {});
    if (!params.success) {
      sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `Invalid params for "${method}": ${z.prettifyError(params.error)}`,
      );
      return;
    }
    runBridgeRequest({
      request: { id, method, params: params.data },
      handleRequest,
      sendError,
    });
  }

  const handleLine = createBridgeLineHandler({ handleParsedMessage });
  return {
    handleLine,
    onClose: () => void closeAllSessions(),
    onSigterm: () => void closeAllSessions(),
    onSigint: () => void closeAllSessions(),
  };
}

export const experimental_providerBridge = experimental_defineProviderBridge(
  createFxProviderBridge(),
);
