import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  experimental_resolveProviderBridgeLaunch,
  experimental_runBridgeConformance,
  experimental_formatConformanceReport,
  type BridgeJsonRpcOutputMessage,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fxProviderDeclaration } from "../server.js";

function launchBridge(cwd: string) {
  const launch = experimental_resolveProviderBridgeLaunch({
    modulePath: fileURLToPath(new URL("../dist/host.js", import.meta.url)),
    pluginId: "fx",
    cwd,
    dataDir: join(cwd, "data"),
  });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    // The launch spec must override a permissive mode inherited from a host.
    env: { ...process.env, ...launch.env, FX_PERMISSION_MODE: "yolo" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: BridgeJsonRpcOutputMessage[] = [];
  let stderr = "";
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-8000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    messages.push(JSON.parse(line));
  });
  const send = (line: string) => {
    child.stdin.write(`${line}\n`);
  };
  let serial = 0;
  async function waitFor(
    predicate: (message: BridgeJsonRpcOutputMessage) => boolean,
  ) {
    for (let i = 0; i < 500; i++) {
      const found = messages.find(predicate);
      if (found) return found;
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Bridge exited: ${stderr}`);
      await delay(10);
    }
    throw new Error(
      `Bridge timed out: ${stderr}\n${JSON.stringify(messages).slice(-8000)}`,
    );
  }
  return {
    messages,
    send,
    waitFor,
    takeMessages: () => messages.splice(0),
    async request(method: string, params: unknown) {
      const id = ++serial;
      send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      const response = await waitFor(
        (message) => message.id === id && !message.method,
      );
      expect(
        response.error,
        `${method}: ${JSON.stringify(response.error)}`,
      ).toBeUndefined();
      return response.result;
    },
    async close() {
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

let cwd: string;
let bridge: ReturnType<typeof launchBridge>;
let providerOptions: Record<string, unknown>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "fx-bridge-test-"));
  const declared = fxProviderDeclaration.experimental_bridgeOptions!;
  providerOptions = {
    ...declared,
    acpLaunchSpec: {
      ...(declared.acpLaunchSpec as Record<string, unknown>),
      // Only substitute the executable; all plugin launch policy stays intact.
      command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/fx-acp.mjs", import.meta.url))],
    },
  };
  bridge = launchBridge(cwd);
});
afterEach(async () => {
  await bridge.close();
  rmSync(cwd, { recursive: true, force: true });
});

function options(full = false) {
  return {
    ...(full
      ? {
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        }
      : {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
        }),
    model: "alternate",
    providerOptions,
  };
}

it("passes the SDK's canonical bridge conformance suite", async () => {
  const report = await experimental_runBridgeConformance({
    transport: bridge,
    providerId: "fx",
    session: {
      cwd,
      options: options(),
      promptInput: [{ type: "text", text: "hello", mentions: [] }],
      zeroWorkPromptInput: [{ type: "text", text: "/noop", mentions: [] }],
    },
    timeoutMs: 5000,
  });
  expect(report.passed, experimental_formatConformanceReport(report)).toBe(
    true,
  );
  for (const id of [
    "handshake/initialize",
    "session/start-identity",
    "session/resume-identity",
    "turn/lifecycle",
    "events/schema-valid",
    "stop/release-not-interrupted",
  ]) {
    expect(report.results.find((result) => result.id === id)?.status, id).toBe(
      "pass",
    );
  }
}, 30_000);

it("discovers the account default from ACP session configuration", async () => {
  const result = await bridge.request("model/list", { cwd, providerOptions });
  expect(result).toMatchObject({
    models: expect.arrayContaining([
      expect.objectContaining({
        id: "account-default",
        isDefault: true,
        supportedReasoningEfforts: [],
      }),
      expect.objectContaining({
        id: "alternate",
        supportedReasoningEfforts: [],
      }),
    ]),
  });
});

it.each([
  { name: "deny", decision: "deny", expected: "no", full: false },
  { name: "allow once", decision: "allow_once", expected: "yes", full: false },
  { name: "full access", decision: null, expected: "yes", full: true },
])(
  "honors $name through the bundled bridge",
  async ({ decision, expected, full }) => {
    const initialized = await bridge.request("initialize", {
      client: { name: "fx-test", version: "1" },
      protocolVersion: 2,
      grammarVersions: [3, 3],
    });
    expect(initialized).toMatchObject({
      capabilities: { approvalEnforcedBy: "runtime" },
    });
    const started = (await bridge.request("thread/start", {
      threadId: "fx-test",
      cwd,
      instructionMode: "append",
      options: options(full),
    })) as { providerThreadId: string };
    await bridge.request("turn/start", {
      threadId: "fx-test",
      providerThreadId: started.providerThreadId,
      clientRequestId: "creq_abcdefghjk",
      options: options(full),
      input: [{ type: "text", text: "request-permission", mentions: [] }],
    });
    if (decision) {
      const approval = await bridge.waitFor(
        (message) => message.method === "interaction/request",
      );
      expect(approval.params).toMatchObject({ payload: { kind: "approval" } });
      bridge.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: approval.id,
          result: { decision, grantedPermissions: null },
        }),
      );
    }
    await bridge.waitFor(
      (message) =>
        message.method === "thread/delta" &&
        JSON.stringify(message.params).includes('"kind":"turn.boundary"') &&
        JSON.stringify(message.params).includes('"status":"completed"'),
    );
    expect(
      bridge.messages.filter(
        (message) => message.method === "interaction/request",
      ),
    ).toHaveLength(full ? 0 : 1);
    expect(JSON.stringify(bridge.messages)).toContain(`permission:${expected}`);
  },
);

it("preserves fx refusals and settles the turn without a protocol error", async () => {
  const started = (await bridge.request("thread/start", {
    threadId: "fx-refusal",
    cwd,
    instructionMode: "append",
    options: options(),
  })) as { providerThreadId: string };
  await bridge.request("turn/start", {
    threadId: "fx-refusal",
    providerThreadId: started.providerThreadId,
    clientRequestId: "creq_abcdefghjk",
    options: options(),
    input: [{ type: "text", text: "refuse", mentions: [] }],
  });
  await bridge.waitFor(
    (message) =>
      message.method === "thread/delta" &&
      JSON.stringify(message.params).includes('"kind":"turn.boundary"'),
  );
  const output = JSON.stringify(bridge.messages);
  expect(output).toContain("Fixture account rejection");
  expect(output).not.toContain('"kind":"provider.error"');
});

it.each([false, true])(
  "only offers and forwards reasoning advertised by fx (native: %s)",
  async (native) => {
    const spec = providerOptions.acpLaunchSpec as Record<string, unknown>;
    spec.env = {
      ...(spec.env as object),
      FX_FIXTURE_REASONING: native ? "1" : "0",
    };
    const catalog = await bridge.request("model/list", {
      cwd,
      providerOptions,
    });
    expect(catalog).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({
          id: "account-default",
          supportedReasoningEfforts: [],
        }),
        expect.objectContaining({
          id: "alternate",
          supportedReasoningEfforts: native
            ? ["low", "medium", "high"].map((reasoningEffort) =>
                expect.objectContaining({ reasoningEffort }),
              )
            : [],
        }),
      ]),
    });
    // A stored BB preference must not become an unsupported fx config request.
    const configured = { ...options(), reasoningLevel: "high" };
    const started = (await bridge.request("thread/start", {
      threadId: "fx-reasoning",
      cwd,
      instructionMode: "append",
      options: configured,
    })) as { providerThreadId: string };
    await bridge.request("turn/start", {
      threadId: "fx-reasoning",
      providerThreadId: started.providerThreadId,
      clientRequestId: "creq_abcdefghjk",
      options: configured,
      input: [{ type: "text", text: "report settings", mentions: [] }],
    });
    await bridge.waitFor(
      (message) =>
        message.method === "thread/delta" &&
        JSON.stringify(message.params).includes('"kind":"turn.boundary"'),
    );
    expect(JSON.stringify(bridge.messages)).toContain(
      `model:alternate; effort:${native ? "high" : "auto"}`,
    );
    expect(JSON.stringify(bridge.messages)).not.toContain(
      '"kind":"provider.error"',
    );
  },
);

it("preserves shared-bridge model request validation errors", async () => {
  bridge.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "bad-model-list",
      method: "model/list",
      params: { cwd: 42 },
    }),
  );
  const response = await bridge.waitFor(
    (message) => message.id === "bad-model-list",
  );
  expect(response.error).toMatchObject({ code: -32602 });
});
