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
  runBridgeRequest,
  skillsConfigureParamsSchema,
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
  type PromptInput,
  type ProviderBridgeDefinition,
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
  instructions?: string;
  sentInstructionFingerprint?: string;
  activeTurn?: FxTurn;
  releasing: boolean;
  lastRecoveryState?: string;
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

function statusValue(value: unknown): string {
  return typeof value === "string" ? value : "pending";
}

function formatModelName(id: string): string {
  if (id === DEFAULT_FX_MODEL) return "GLM 5.2";
  const model = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return model
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => (/^(?:gpt|glm|qwen|kimi)$/iu.test(part) ? part.toUpperCase() : part))
    .join(" ");
}

function availableModel(id: string, isDefault: boolean): AvailableModel {
  return {
    id,
    model: id,
    displayName: formatModelName(id),
    description: `Available through FX (${id}).`,
    supportedReasoningEfforts: [
      {
        reasoningEffort: "medium",
        description: "Reasoning is managed by FX and the selected model.",
      },
    ],
    defaultReasoningEffort: "medium",
    isDefault,
  };
}

export async function loadFxModels(cwd?: string): Promise<ModelCatalogResult> {
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
  const modelsPayload = asRecord(JSON.parse(modelsResult.stdout));
  const ids = Array.isArray(modelsPayload?.ids)
    ? modelsPayload.ids.filter((id): id is string => typeof id === "string")
    : [];
  if (ids.length === 0) {
    throw new Error("fx models returned no available models");
  }
  const statusPayload = statusResult
    ? asRecord(JSON.parse(statusResult.stdout))
    : undefined;
  const configuredDefault = stringValue(statusPayload?.model);
  const defaultId =
    (configuredDefault && ids.includes(configuredDefault) && configuredDefault) ||
    (ids.includes(DEFAULT_FX_MODEL) ? DEFAULT_FX_MODEL : ids[0]);
  const models = ids.map((id) => availableModel(id, id === defaultId));
  const primary = models.find((model) => model.isDefault) ?? models[0];
  return {
    models: [primary],
    selectedOnlyModels: models.filter((model) => model.id !== primary.id),
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
  ): void {
    if (turn.settled || session.releasing) return;
    turn.settled = true;
    completeAgentMessage(session, turn);
    for (const tool of turn.tools.values()) {
      completeTool(
        session,
        turn,
        tool,
        status === "interrupted" ? "interrupted" : "failed",
      );
    }
    if (status === "failed" && message) {
      emit(session, {
        type: "provider/error",
        threadId: session.threadId,
        providerThreadId: session.providerThreadId,
        message,
        errorInfo: {
          category: "unknown",
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
      title: stringValue(update.title) ?? "FX tool",
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
        title: "FX tool",
        kind: "other",
      });
      tool = turn.tools.get(callId);
    }
    if (!tool || tool.completed) return;
    tool.result = extractToolResult(update) ?? tool.result;
    const status = statusValue(update.status);
    if (status === "completed" || status === "failed") {
      completeTool(session, turn, tool, status);
      return;
    }
    emit(session, {
      type: "item/toolCall/progress",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      itemId: tool.id,
      message: tool.title,
    });
  }

  function handleRecoveryUpdate(
    session: FxSession,
    update: Record<string, unknown>,
  ): void {
    const meta = asRecord(update._meta);
    const recovery = asRecord(meta?.["fx.modelResponseRecovery"]);
    const state = stringValue(recovery?.state);
    if (!state || state === session.lastRecoveryState) return;
    session.lastRecoveryState = state;
    const message = stringValue(recovery?.message);
    const attempt = recovery?.attempt;
    const attemptLimit = recovery?.attemptLimit;
    const attemptText =
      typeof attempt === "number" && typeof attemptLimit === "number"
        ? ` (attempt ${attempt}/${attemptLimit})`
        : "";
    emit(session, {
      type: "provider/warning",
      threadId: session.threadId,
      providerThreadId: session.providerThreadId,
      category: "general",
      summary:
        state === "recovered"
          ? "FX model response recovered"
          : `FX is recovering the model response${attemptText}`,
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
      return { outcome: { outcome: "selected", optionId: "reject_once" } };
    }
    if (request.method === "elicitation/create") {
      return { action: "cancel" };
    }
    throw new Error(`Unsupported FX ACP client request: ${request.method}`);
  }

  function handleAcpExit(session: FxSession, error: Error): void {
    if (session.releasing) return;
    const turn = session.activeTurn;
    if (turn) finishTurn(session, turn, "failed", error.message);
    sessionsByThreadId.delete(session.threadId);
    sessionsByProviderThreadId.delete(session.providerThreadId);
  }

  async function configureSession(
    session: FxSession,
    options: BridgeExecutionOptions,
  ): Promise<void> {
    const requestedModel = options.model;
    if (requestedModel && requestedModel !== session.model) {
      await session.connection.request("session/set_config_option", {
        sessionId: session.providerThreadId,
        configId: "model",
        value: requestedModel,
      });
      session.model = requestedModel;
    }
    await session.connection.request("session/set_mode", {
      sessionId: session.providerThreadId,
      modeId: "code",
    });
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
        clientInfo: { name: "bb-plugin-fx", version: "0.1.0" },
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
        releasing: false,
      };
      sessionRef = session;
      await configureSession(session, params.options);
      sessionsByThreadId.set(session.threadId, session);
      sessionsByProviderThreadId.set(session.providerThreadId, session);
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

  async function runTurn(session: FxSession, params: TurnStartParams): Promise<void> {
    const turn = createTurn(params.clientRequestId);
    session.activeTurn = turn;
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
          finishTurn(session, turn, "failed", "FX reached the model output limit");
          break;
        case "max_model_turns":
          finishTurn(session, turn, "failed", "FX reached its model turn limit");
          break;
        case "refused":
          finishTurn(session, turn, "failed", "The FX model refused the request");
          break;
        default:
          finishTurn(session, turn, "failed", `FX stopped: ${stopReason}`);
      }
    } catch (error) {
      if (!session.releasing) {
        finishTurn(session, turn, "failed", errorMessage(error));
      }
    }
  }

  async function releaseSession(session: FxSession): Promise<void> {
    session.releasing = true;
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
      finishTurn(session, turn, "interrupted", "FX cancellation timed out");
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
        const session = sessionsByThreadId.get(params.threadId);
        if (!session || session.providerThreadId !== params.providerThreadId) {
          sendError(request.id, BRIDGE_JSON_RPC_ERRORS.SESSION_NOT_RESTORABLE, "No active FX session");
          return;
        }
        if (session.activeTurn) {
          sendError(request.id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, "An FX turn is already active");
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
          sendError(request.id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, "No active FX turn to steer");
          return;
        }
        sendError(
          request.id,
          BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          "FX ACP does not support steering an active prompt; interrupt and send a new turn",
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
