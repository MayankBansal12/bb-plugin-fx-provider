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

  constructor(options: AcpConnectionOptions, sessionId: string) {
    this.options = options;
    this.sessionId = sessionId;
  }

  request(method: string, params: unknown = {}, timeoutMs?: number): Promise<unknown> {
    this.calls.push({ method, params, timeoutMs });
    switch (method) {
      case "initialize":
        return Promise.resolve({ protocolVersion: 1 });
      case "session/new":
      case "session/resume":
        return Promise.resolve({ sessionId: this.sessionId });
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

describe("FX provider bridge", () => {
  let output: RpcMessage[];
  let connections: FakeAcpConnection[];
  let bridge: ReturnType<typeof createFxProviderBridge>;

  beforeEach(() => {
    output = [];
    connections = [];
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
          description: "FX model",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium" as const, description: "FX managed" },
          ],
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

  it("lists FX models through the canonical result shape", async () => {
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
        expect.objectContaining({
          method: "session/set_mode",
          params: expect.objectContaining({ modeId: "code" }),
        }),
      ]),
    );
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
      _meta: {
        "fx.modelResponseRecovery": {
          state: "active",
          attempt: 2,
          attemptLimit: 5,
          message: "The model returned 503; retrying.",
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

  it("resumes the requested FX session", async () => {
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

  it("maps FX cancellation to an interrupted turn", async () => {
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
});
