import {
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  threadEventNotificationSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createFxProviderBridge,
  type FxBridgeDependencies,
} from "../src/bridge.js";
import type {
  AcpConnection,
  AcpConnectionOptions,
} from "../src/acp-client.js";

interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeAcpConnection implements AcpConnection {
  readonly calls: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
  readonly prompt = deferred<unknown>();
  readonly options: AcpConnectionOptions;
  readonly sessionId: string;
  closed = false;
  /** ACP methods this fake should reject, keyed by method name. */
  static failMethods = new Set<string>();
  /** Extra `session/new`/`session/resume` result fields, e.g. `configOptions`. */
  static newSessionResult: Record<string, unknown> = {};

  constructor(options: AcpConnectionOptions, sessionId: string) {
    this.options = options;
    this.sessionId = sessionId;
  }

  request(method: string, params: unknown = {}, timeoutMs?: number): Promise<unknown> {
    this.calls.push({ method, params, timeoutMs });
    if (FakeAcpConnection.failMethods.has(method)) {
      return Promise.reject(new Error(`fx rejected ${method}`));
    }
    switch (method) {
      case "initialize":
        return Promise.resolve({ protocolVersion: 1 });
      case "session/new":
      case "session/resume":
        return Promise.resolve({
          sessionId: this.sessionId,
          ...FakeAcpConnection.newSessionResult,
        });
      case "session/prompt":
        return this.prompt.promise;
      default:
        return Promise.resolve(null);
    }
  }

  notify(method: string, params: unknown = {}): void {
    this.calls.push({ method, params });
  }

  close(): Promise<void> {
    this.closed = true;
    this.prompt.resolve({ stopReason: "cancelled" });
    return Promise.resolve();
  }

  update(update: Record<string, unknown>): void {
    this.options.onNotification({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: this.sessionId, update },
    });
  }
}

const executionOptions = {
  model: "zai/glm-5.2",
  reasoningLevel: "medium" as const,
  permissionMode: "auto" as const,
  permissionScope: "workspace" as const,
  permissionEscalation: "ask" as const,
  approvalReviewer: "automatic" as const,
  instructions: "Keep changes minimal.",
};

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("fx provider bridge", () => {
  let output: RpcMessage[];
  let connections: FakeAcpConnection[];
  let bridge: ReturnType<typeof createFxProviderBridge>;

  beforeEach(() => {
    output = [];
    connections = [];
    FakeAcpConnection.failMethods = new Set();
    FakeAcpConnection.newSessionResult = {};
    const dependencies: FxBridgeDependencies = {
      write(line) {
        output.push(JSON.parse(line.trim()) as RpcMessage);
      },
      async createConnection(options) {
        const connection = new FakeAcpConnection(
          options,
          `fx-session-${connections.length + 1}`,
        );
        connections.push(connection);
        return connection;
      },
      async loadModels() {
        const model = {
          id: "zai/glm-5.2",
          model: "zai/glm-5.2",
          displayName: "GLM 5.2",
          description: "fx model",
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium" as const,
          isDefault: true,
        };
        return { models: [model], selectedOnlyModels: [] };
      },
    };
    bridge = createFxProviderBridge(dependencies);
  });

  function send(id: number, method: string, params: unknown): void {
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  async function initialize(): Promise<void> {
    send(1, "initialize", {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      client: { name: "test", version: "1" },
    });
    await tick();
    output = [];
  }

  async function startThread(threadId = "thread-1"): Promise<FakeAcpConnection> {
    send(2, "thread/start", {
      cwd: "/tmp",
      instructionMode: "append",
      options: executionOptions,
      threadId,
    });
    await tick();
    await tick();
    return connections.at(-1)!;
  }

  it("negotiates the canonical protocol and rejects unknown methods", async () => {
    send(1, "initialize", {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      client: { name: "test", version: "1" },
    });
    await tick();
    expect(output[0]?.result).toEqual({
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

    send(2, "unknown/method", {});
    await tick();
    expect(output.at(-1)?.error?.code).toBe(-32601);
  });

  it("returns INVALID_PARAMS for malformed canonical requests", async () => {
    await initialize();
    send(2, "thread/start", { threadId: "missing-fields" });
    await tick();
    expect(output[0]?.error?.code).toBe(-32602);
  });

  it("lists fx models through the canonical result shape", async () => {
    await initialize();
    send(2, "model/list", { cwd: "/tmp" });
    await tick();
    expect(output[0]?.result).toMatchObject({
      models: [{ id: "zai/glm-5.2", isDefault: true }],
      selectedOnlyModels: [],
    });
  });

  it("establishes identity before start resolves and configures GLM 5.2", async () => {
    await initialize();
    const connection = await startThread();
    const identityIndex = output.findIndex(
      (message) =>
        message.method === "thread/event" &&
        (message.params?.event as { type?: string })?.type === "thread/identity",
    );
    const responseIndex = output.findIndex((message) => message.id === 2);
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(responseIndex).toBeGreaterThan(identityIndex);
    expect(connection.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "initialize" }),
        expect.objectContaining({ method: "session/new" }),
        expect.objectContaining({
          method: "session/set_config_option",
          params: expect.objectContaining({
            configId: "model",
            value: "zai/glm-5.2",
          }),
        }),
      ]),
    );
    // fx's "code" mode routes approvals to its own auto-mode classifier, which
    // cannot escalate over ACP and denies every shell command. The session must
    // stay in the default "ask" mode so approvals reach this bridge.
    expect(
      connection.calls.some((call) => call.method === "session/set_mode"),
    ).toBe(false);
    expect(connection.options.env.FX_PERMISSION_MODE).toBe("ask");
  });

  it("derives reasoning support from fx's config report and forwards the level", async () => {
    await initialize();
    // fx reports a `thought_level` config option; the bridge must surface the
    // levels it actually declares and forward the selected one at turn start.
    FakeAcpConnection.newSessionResult = {
      configOptions: [
        {
          id: "thought_level",
          category: "thought_level",
          currentValue: "high",
          options: [
            { value: "none", name: "None" },
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
          ],
        },
      ],
    };
    const connection = await startThread();
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Say hello" }],
      options: { ...executionOptions, reasoningLevel: "high" },
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    await tick();
    expect(
      connection.calls.some(
        (call) =>
          call.method === "session/set_config_option" &&
          call.params !== undefined &&
          (call.params as { configId?: string }).configId === "thought_level" &&
          (call.params as { value?: string }).value === "high",
      ),
    ).toBe(true);
  });

  it("stays on the agent-managed fallback when fx exposes no reasoning option", async () => {
    await initialize();
    const connection = await startThread();
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Say hello" }],
      options: { ...executionOptions, reasoningLevel: "high" },
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    await tick();
    // No reasoning config option → the bridge must not fabricate a set_config
    // call for a level fx does not understand.
    expect(
      connection.calls.some(
        (call) =>
          call.method === "session/set_config_option" &&
          call.params !== undefined &&
          (call.params as { configId?: string }).configId !== "model",
      ),
    ).toBe(false);
  });

  it("translates streamed messages, tools, recovery, and completion", async () => {
    await initialize();
    const connection = await startThread();
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Say hello" }],
      options: executionOptions,
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();

    connection.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    });
    connection.update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read package.json",
      kind: "read",
      status: "pending",
    });
    connection.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "read ok" } },
      ],
    });
    connection.update({
      sessionUpdate: "session_info_update",
      // Shape copied from a live `fx acp` 0.0.4 session.
      _meta: {
        fx: {
          modelResponseRecovery: {
            state: "active",
            kind: "auto_retry",
            cause: "provider_unavailable",
            attempt: 2,
            attemptLimit: 5,
            message: "The model returned 503; retrying.",
          },
        },
      },
    });
    connection.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " again." },
    });
    connection.prompt.resolve({ stopReason: "end_turn" });
    await tick();

    const notifications = output.filter(
      (message) => message.method === "thread/event",
    );
    for (const notification of notifications) {
      const parsed = threadEventNotificationSchema.safeParse(notification.params);
      expect(
        parsed.success,
        parsed.success ? undefined : JSON.stringify(parsed.error.issues, null, 2),
      ).toBe(true);
    }
    const types = notifications.map(
      (message) => (message.params?.event as { type: string }).type,
    );
    expect(types).toEqual([
      "turn/input/accepted",
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "item/started",
      "item/toolCall/progress",
      "item/completed",
      "provider/warning",
      "item/started",
      "item/agentMessage/delta",
      "item/completed",
      "turn/completed",
    ]);
    expect(connection.calls.at(-1)).toMatchObject({
      method: "session/prompt",
      timeoutMs: 0,
    });
    expect(JSON.stringify(connection.calls.at(-1)?.params)).toContain(
      "Keep changes minimal.",
    );
  });

  it("resumes the requested fx session", async () => {
    await initialize();
    send(2, "thread/resume", {
      cwd: "/tmp",
      instructionMode: "append",
      options: executionOptions,
      providerThreadId: "existing-fx-session",
      threadId: "thread-1",
    });
    await tick();
    await tick();
    expect(connections[0]?.calls).toContainEqual(
      expect.objectContaining({
        method: "session/resume",
        params: expect.objectContaining({ sessionId: "existing-fx-session" }),
      }),
    );
  });

  it("releases without fabricating terminal turn events", async () => {
    await initialize();
    const connection = await startThread();
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Wait" }],
      options: executionOptions,
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    output = [];
    send(4, "thread/stop", {
      activeTurnId: "active",
      intent: "release",
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    expect(connection.closed).toBe(true);
    expect(output.filter((message) => message.method === "thread/event")).toEqual([]);
    expect(output.at(-1)?.result).toEqual({ ok: true });
  });

  it("maps fx cancellation to an interrupted turn", async () => {
    await initialize();
    const connection = await startThread();
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Wait" }],
      options: executionOptions,
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    send(4, "thread/stop", {
      activeTurnId: "active",
      intent: "interrupt",
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    connection.prompt.resolve({ stopReason: "cancelled" });
    await tick();
    await tick();
    await tick();
    const completed = output.find(
      (message) =>
        message.method === "thread/event" &&
        (message.params?.event as { type?: string })?.type === "turn/completed",
    );
    expect(
      completed?.params?.event,
      JSON.stringify(output, null, 2),
    ).toMatchObject({ status: "interrupted" });
    expect(output.find((message) => message.id === 4)?.result).toEqual({ ok: true });
  });

  it("approves permission requests with the single-use allow option", async () => {
    await initialize();
    const connection = await startThread();
    const outcome = connection.options.onRequest?.({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: connection.sessionId,
        options: [
          { optionId: "always", kind: "allow_always" },
          { optionId: "once", kind: "allow_once" },
          { optionId: "no-thanks", kind: "reject_once" },
        ],
      },
    });
    expect(outcome).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
  });

  it("falls back to a broader allow option when no single-use one is offered", async () => {
    await initialize();
    const connection = await startThread();
    const outcome = connection.options.onRequest?.({
      jsonrpc: "2.0",
      id: 8,
      method: "session/request_permission",
      params: {
        sessionId: connection.sessionId,
        options: [
          { optionId: "always", kind: "allow_always" },
          { optionId: "no-thanks", kind: "reject_once" },
        ],
      },
    });
    expect(outcome).toEqual({
      outcome: { outcome: "selected", optionId: "always" },
    });
  });

  it("cancels permission requests that offer no allow option", async () => {
    await initialize();
    const connection = await startThread();
    const outcome = connection.options.onRequest?.({
      jsonrpc: "2.0",
      id: 9,
      method: "session/request_permission",
      params: {
        sessionId: connection.sessionId,
        options: [{ optionId: "no-thanks", kind: "reject_once" }],
      },
    });
    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("marks unfinished tools interrupted when a turn completes successfully", async () => {
    await initialize();
    const connection = await startThread();
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Go" }],
      options: executionOptions,
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    connection.update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-never-finished",
      title: "Stuck tool",
      kind: "execute",
      status: "pending",
    });
    connection.prompt.resolve({ stopReason: "end_turn" });
    await tick();
    const toolCompletions = output.filter(
      (message) =>
        message.method === "thread/event" &&
        (message.params?.event as { type?: string })?.type ===
          "item/completed" &&
        ((message.params?.event as { item?: { type?: string } })?.item
          ?.type === "toolCall"),
    );
    expect(toolCompletions).toHaveLength(1);
    expect(toolCompletions[0]?.params?.event).toMatchObject({
      item: { status: "interrupted" },
    });
  });

  it("resumes the durable fx session transparently after a process crash", async () => {
    await initialize();
    await initialize();
    const crashed = await startThread();
    crashed.options.onExit(new Error("fx acp exited with code 1"));
    await tick();
    const warning = output.find(
      (message) =>
        message.method === "thread/event" &&
        (message.params?.event as { type?: string })?.type ===
          "provider/warning",
    );
    expect(warning?.params?.event).toMatchObject({
      summary: "The fx process exited unexpectedly.",
    });

    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Hello again" }],
      options: executionOptions,
      providerThreadId: crashed.sessionId,
      threadId: "thread-1",
    });
    await tick();
    await tick();

    expect(connections).toHaveLength(2);
    const replacement = connections[1]!;
    expect(replacement.closed).toBe(false);
    expect(replacement.calls).toContainEqual(
      expect.objectContaining({
        method: "session/resume",
        params: expect.objectContaining({ sessionId: crashed.sessionId }),
      }),
    );
    expect(output.find((message) => message.id === 3)?.result).toEqual({
      threadId: "thread-1",
    });
  });

  it("does not auto-resume after an explicit release", async () => {
    await initialize();
    const released = await startThread();
    send(3, "thread/stop", {
      activeTurnId: "active",
      intent: "release",
      providerThreadId: released.sessionId,
      threadId: "thread-1",
    });
    await tick();
    output = [];
    send(4, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Hello?" }],
      options: executionOptions,
      providerThreadId: released.sessionId,
      threadId: "thread-1",
    });
    await tick();
    await tick();
    expect(connections).toHaveLength(1);
    expect(output.find((message) => message.id === 4)?.error?.code).toBeDefined();
  });

  it("releases the fx process when BB discards the thread", async () => {
    await initialize();
    const connection = await startThread();
    output = [];
    send(3, "thread/discard", {
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    expect(output.find((message) => message.id === 3)?.result).toEqual({ ok: true });
    expect(connection.closed).toBe(true);

    // A discarded thread must not be resurrected by the crash-recovery path.
    output = [];
    send(4, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Still there?" }],
      options: executionOptions,
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    await tick();
    expect(connections).toHaveLength(1);
    expect(output.find((message) => message.id === 4)?.error?.code).toBeDefined();
  });

  it("reports fx recovery detail instead of a bare refusal", async () => {
    await initialize();
    const connection = await startThread();
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Go" }],
      options: executionOptions,
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    connection.update({
      sessionUpdate: "session_info_update",
      _meta: {
        fx: {
          modelResponseRecovery: {
            state: "paused",
            kind: "terminal_provider_error",
            cause: "provider_unavailable",
            attempt: 10,
            attemptLimit: 10,
            message: "Provider unavailable · HTTP 503 · recover later",
          },
        },
      },
    });
    // fx answers a terminal provider failure with `refused`, the same stop
    // reason it uses for a genuine model refusal.
    connection.prompt.resolve({ stopReason: "refused" });
    await tick();

    const completed = output.find(
      (message) =>
        (message.params?.event as { type?: string })?.type === "turn/completed",
    );
    expect(completed?.params?.event).toMatchObject({
      status: "failed",
      error: {
        message:
          "fx could not complete the turn: Provider unavailable · HTTP 503 · recover later",
      },
    });
    const providerError = output.find(
      (message) =>
        (message.params?.event as { type?: string })?.type === "provider/error",
    );
    expect(providerError?.params?.event).toMatchObject({
      errorInfo: { category: "overloaded" },
    });
  });

  it("emits a warning for every fx retry attempt", async () => {
    await initialize();
    const connection = await startThread();
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Go" }],
      options: executionOptions,
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    for (const attempt of [1, 2, 3]) {
      connection.update({
        sessionUpdate: "session_info_update",
        _meta: {
          fx: {
            modelResponseRecovery: {
              state: "active",
              cause: "provider_unavailable",
              attempt,
              attemptLimit: 10,
              message: `retrying request · attempt ${attempt}/10`,
            },
          },
        },
      });
    }
    connection.prompt.resolve({ stopReason: "end_turn" });
    await tick();

    const warnings = output.filter(
      (message) =>
        (message.params?.event as { type?: string })?.type === "provider/warning",
    );
    expect(warnings).toHaveLength(3);
    expect(warnings[2]?.params?.event).toMatchObject({
      summary: "fx is recovering the model response (attempt 3/10)",
    });
  });

  it("fails the turn when fx rejects the selected model", async () => {
    await initialize();
    const connection = await startThread();
    FakeAcpConnection.failMethods = new Set(["session/set_config_option"]);
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Go" }],
      options: { ...executionOptions, model: "vendor/not-real" },
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    await tick();

    const completed = output.find(
      (message) =>
        (message.params?.event as { type?: string })?.type === "turn/completed",
    );
    expect(completed?.params?.event).toMatchObject({
      status: "failed",
      error: {
        message: 'fx rejected the model "vendor/not-real": fx rejected session/set_config_option',
      },
    });
  });

  it("does not restack an unchanged tool progress line", async () => {
    await initialize();
    const connection = await startThread();
    output = [];
    send(3, "turn/start", {
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "Go" }],
      options: executionOptions,
      providerThreadId: connection.sessionId,
      threadId: "thread-1",
    });
    await tick();
    connection.update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Using terminal",
      kind: "execute",
      status: "pending",
    });
    // fx streams one update per output chunk, all carrying the same title.
    for (let index = 0; index < 3; index += 1) {
      connection.update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "in_progress",
      });
    }
    connection.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Running tests",
      status: "in_progress",
    });
    connection.prompt.resolve({ stopReason: "end_turn" });
    await tick();

    const progress = output
      .filter(
        (message) =>
          (message.params?.event as { type?: string })?.type ===
          "item/toolCall/progress",
      )
      .map((message) => (message.params?.event as { message: string }).message);
    expect(progress).toEqual(["Using terminal", "Running tests"]);
  });
});
