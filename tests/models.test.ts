import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

const { loadFxModels } = await import("../src/bridge.js");

/**
 * `promisify(execFile)` calls the callback style, so the mock answers per
 * argv the way the real CLI does.
 */
function stubFx(responses: Record<string, string | Error>): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      const key = args.join(" ");
      const response = responses[key];
      if (response === undefined) {
        callback(new Error(`unexpected fx invocation: ${key}`));
        return;
      }
      if (response instanceof Error) {
        callback(response);
        return;
      }
      callback(null, { stdout: response, stderr: "" });
    },
  );
}

const CATALOG = JSON.stringify({
  kind: "models",
  ids: ["openai/gpt-5.4-nano", "zai/glm-4.7", "moonshotai/kimi-k2"],
});

describe("loadFxModels", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("offers the whole fx catalog in the picker", async () => {
    stubFx({
      "models --json": CATALOG,
      "status --json": JSON.stringify({ model: "zai/glm-4.7" }),
    });

    const result = await loadFxModels("/tmp");

    expect(result.models.map((model) => model.id)).toEqual([
      "openai/gpt-5.4-nano",
      "zai/glm-4.7",
      "moonshotai/kimi-k2",
    ]);
    // `selectedOnlyModels` is BB's hidden bucket; anything parked there is
    // invisible in the model selector.
    expect(result.selectedOnlyModels).toEqual([]);
  });

  it("keeps the account default selectable when `fx models` omits it", async () => {
    // Observed against fx 0.0.4: `fx status` reported zai/glm-5.2 while
    // `fx models` listed 156 ids without it.
    stubFx({
      "models --json": CATALOG,
      "status --json": JSON.stringify({ model: "zai/glm-5.2" }),
    });

    const result = await loadFxModels("/tmp");

    expect(result.models[0]).toMatchObject({ id: "zai/glm-5.2", isDefault: true });
    expect(result.models).toHaveLength(4);
    expect(result.models.filter((model) => model.isDefault)).toHaveLength(1);
  });

  it("falls back to the first catalog id when status is unavailable", async () => {
    stubFx({
      "models --json": CATALOG,
      "status --json": new Error("fx status failed"),
    });

    const result = await loadFxModels("/tmp");

    expect(result.models.filter((model) => model.isDefault)).toEqual([
      expect.objectContaining({ id: "openai/gpt-5.4-nano" }),
    ]);
  });

  it("labels models by vendor so the picker stays readable", async () => {
    stubFx({
      "models --json": JSON.stringify({
        ids: [
          "zai/glm-5.2",
          "openai/gpt-5.1-codex-max",
          "amazon/nova-pro",
          "kwaipilot/kat-coder-pro-v2",
        ],
      }),
      "status --json": JSON.stringify({ model: "zai/glm-5.2" }),
    });

    const result = await loadFxModels("/tmp");

    expect(result.models.map((model) => model.displayName)).toEqual([
      "Z.ai GLM 5.2",
      "OpenAI GPT 5.1 Codex Max",
      "Amazon Nova Pro",
      "Kwaipilot KAT Coder Pro V2",
    ]);
  });

  it("reports invalid CLI output instead of throwing a parser error", async () => {
    stubFx({ "models --json": "not json", "status --json": "{}" });

    await expect(loadFxModels("/tmp")).rejects.toThrow(
      "fx models --json returned invalid JSON output",
    );
  });

  it("rejects an empty catalog", async () => {
    stubFx({ "models --json": JSON.stringify({ ids: [] }), "status --json": "{}" });

    await expect(loadFxModels("/tmp")).rejects.toThrow(
      "fx models returned no available models",
    );
  });

  it("advertises no reasoning levels when fx exposes no reasoning option", async () => {
    stubFx({ "models --json": CATALOG, "status --json": "{}" });

    const result = await loadFxModels("/tmp");

    for (const model of result.models) {
      // BB renders a "Reasoning" picker section for any non-empty effort list
      // and shows only the level label, so advertising "medium" would claim a
      // setting this bridge never applies to fx. No levels = no control.
      expect(model.supportedReasoningEfforts).toEqual([]);
      // Required by BB's model schema even when nothing is advertised.
      expect(model.defaultReasoningEffort).toBe("medium");
    }
  });

  it("advertises only the reasoning levels fx actually declares", async () => {
    stubFx({ "models --json": CATALOG, "status --json": "{}" });
    const reasoning = {
      supportedReasoningEfforts: [
        { reasoningEffort: "low" as const, description: "Low" },
        { reasoningEffort: "high" as const, description: "High" },
      ],
      defaultReasoningEffort: "high" as const,
    };

    const result = await loadFxModels("/tmp", reasoning);

    expect(result.models[0]).toMatchObject({
      supportedReasoningEfforts: reasoning.supportedReasoningEfforts,
      defaultReasoningEffort: "high",
    });
  });
});
