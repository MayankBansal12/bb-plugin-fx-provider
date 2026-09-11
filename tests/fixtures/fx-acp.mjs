// A deterministic ACP peer for testing the plugin's shared-bridge wiring.
// It never calls a model or executes the tool described in a permission request.
// Fork is implemented to exercise the shared bridge's handshake capabilities;
// the plugin declaration independently disables forks for real fx sessions.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

let sessionId;
let model = "account-default";
const pending = new Map();
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const configOptions = () => [
  {
    // Real fx 0.0.7 returns this before the actual model, with the same category.
    id: "provider",
    name: "Provider",
    category: "model",
    type: "select",
    currentValue: "gateway",
    options: [{ value: "gateway", name: "Vercel AI Gateway" }],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "account-default", name: "Account default" },
      { value: "alternate", name: "Alternate" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "code", name: "Code" },
    ],
  },
];
const update = (text) =>
  send({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });

async function handle(message) {
  if (!message.method) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { fork: {} },
        },
        authMethods: [],
        agentInfo: { name: "fx-fixture", version: "1" },
      });
      break;
    case "session/new":
    case "session/load":
    case "session/fork":
      if (process.env.FX_PERMISSION_MODE !== "ask")
        throw new Error("FX_PERMISSION_MODE must be pinned to ask");
      sessionId =
        message.method === "session/load"
          ? message.params.sessionId
          : randomUUID();
      reply({ sessionId, configOptions: configOptions() });
      break;
    case "session/set_config_option":
      if (message.params.configId !== "model")
        throw new Error("Only model selection should be forwarded");
      model = message.params.value;
      reply({ configOptions: configOptions() });
      break;
    case "session/prompt": {
      const text = message.params.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text.includes("refuse")) {
        update("Fixture account rejection");
        reply({ stopReason: "refused" });
        break;
      }
      if (text.includes("request-permission")) {
        const id = randomUUID();
        const result = new Promise((resolve) => pending.set(id, resolve));
        send({
          id,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: {
              toolCallId: randomUUID(),
              title: "Fixture command",
              kind: "execute",
              status: "pending",
              rawInput: { command: "echo fixture" },
            },
            options: [
              { optionId: "yes", name: "Allow once", kind: "allow_once" },
              { optionId: "no", name: "Deny", kind: "reject_once" },
            ],
          },
        });
        const answer = await result;
        update(
          `permission:${answer.outcome?.optionId ?? answer.outcome?.outcome}`,
        );
      } else if (!text.includes("/noop")) {
        update(
          `model:${model}; permission-mode:${process.env.FX_PERMISSION_MODE}`,
        );
      }
      reply({ stopReason: "end_turn" });
      break;
    }
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined)
        send({
          id: message.id,
          error: { code: -32601, message: "Unknown method" },
        });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  void handle(JSON.parse(line)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
});
