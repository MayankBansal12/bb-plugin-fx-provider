import { expect, it } from "vitest";
import { normalizeFxConfigOptions, normalizeFxMessage } from "../src/fx-acp.js";

it.each(["result", "params"])(
  "puts the actual model first in ACP %s configOptions",
  (key) => {
    const provider = {
      id: "provider",
      category: "model",
      currentValue: "gateway",
    };
    const model = {
      id: "model",
      category: "model",
      currentValue: "account-default",
    };
    const mode = { id: "mode", category: "mode", currentValue: "ask" };
    const payload = { configOptions: [provider, model, mode] };
    const message = { jsonrpc: "2.0", [key]: payload };
    expect(normalizeFxConfigOptions(message)).toEqual({
      jsonrpc: "2.0",
      [key]: { configOptions: [model, provider, mode] },
    });
    expect(payload.configOptions).toEqual([provider, model, mode]);
  },
);

it("preserves unrelated ACP traffic and options without a model", () => {
  for (const message of [
    null,
    { id: 1, result: {} },
    { params: { configOptions: [{ id: "mode" }] } },
    {
      method: "session/request_permission",
      params: { options: [{ kind: "reject_once" }] },
    },
  ]) {
    expect(normalizeFxConfigOptions(message)).toEqual(message);
  }
});

it("translates fx's refusal alias without discarding the response", () => {
  const response = {
    jsonrpc: "2.0",
    id: 3,
    result: { stopReason: "refused", usage: { inputTokens: 1 } },
  };
  expect(normalizeFxMessage(response)).toEqual({
    ...response,
    result: { ...response.result, stopReason: "refusal" },
  });
  expect(response.result.stopReason).toBe("refused");
});

it("leaves unknown stop reasons and tool payloads for the bridge to validate", () => {
  for (const value of [
    { id: 1, result: { stopReason: "future-reason" } },
    { params: { rawOutput: { stopReason: "refused" } } },
  ]) {
    expect(normalizeFxMessage(value)).toEqual(value);
  }
});
