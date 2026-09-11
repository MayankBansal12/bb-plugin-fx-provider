import { expect, it } from "vitest";
import { normalizeFxModelCatalog } from "../src/model-catalog.js";

it("removes synthetic fallback efforts from primary and selected-only models", () => {
  const model = {
    id: "unprobed-model",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      {
        reasoningEffort: "medium",
        description: "Reasoning effort is managed by the connected ACP agent.",
      },
    ],
  };
  const expected = { ...model, supportedReasoningEfforts: [] };
  expect(
    normalizeFxModelCatalog({ models: [model], selectedOnlyModels: [model] }),
  ).toEqual({ models: [expected], selectedOnlyModels: [expected] });
  expect(model.supportedReasoningEfforts).toHaveLength(1);
});

it.each([
  { supportedReasoningEfforts: [] },
  {
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Medium" },
    ],
  },
  {
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "high", description: "High" },
    ],
  },
])(
  "preserves real model effort metadata: %j",
  ({ supportedReasoningEfforts }) => {
    const result = { models: [{ id: "model", supportedReasoningEfforts }] };
    expect(normalizeFxModelCatalog(result)).toEqual(result);
  },
);
