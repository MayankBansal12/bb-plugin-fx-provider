import { experimental_acpLaunchSpecSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { fxProviderDeclaration } from "../server.js";

function register() {
  const { bb, harness } = createFakePluginHost({ pluginId: "fx" });
  plugin(bb);
  return harness.registrations.providerRegistrations;
}

/** The `acpLaunchSpec` as the shared ACP bridge receives it from BB. */
function registeredLaunchSpec(): Record<string, unknown> {
  const [registration] = register();
  const options = registration?.experimental_bridgeOptions as
    | { acpLaunchSpec?: Record<string, unknown> }
    | undefined;
  expect(options?.acpLaunchSpec).toBeDefined();
  return options!.acpLaunchSpec!;
}

describe("fx provider registration", () => {
  it("registers exactly one provider through the supported API", () => {
    const registrations = register();

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.id).toBe("fx");
  });

  it("declares fx as an ACP agent BB launches with `fx acp`", () => {
    const [registration] = register();

    expect(registration?.family).toBe("acp");
    expect(registration?.experimental_bridgeOptions).toEqual({
      acpLaunchSpec: {
        displayName: "fx",
        command: "fx",
        args: ["acp"],
        env: { FX_PERMISSION_MODE: "ask" },
      },
    });
  });

  it("declares only capabilities the shared ACP bridge implements for fx", () => {
    const [registration] = register();

    expect(registration?.capabilities).toEqual({
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["medium"],
    });
  });

  it("probes models once per host and answers only the health request", () => {
    const [registration] = register();

    expect(registration?.models).toEqual({ scope: "host" });
    expect(registration?.maintenance).toEqual({
      health: true,
      usage: false,
      installation: false,
    });
  });

  it("leaves model discovery to the agent rather than to `fx models`", () => {
    // `fx models --json` omits models the account can still select, so the
    // launch spec deliberately carries no `modelCli` and the bridge reads the
    // catalog from the agent's own session config options.
    const launchSpec = (
      fxProviderDeclaration.experimental_bridgeOptions as {
        acpLaunchSpec: Record<string, unknown>;
      }
    ).acpLaunchSpec;

    expect(launchSpec).not.toHaveProperty("modelCli");
    expect(launchSpec).not.toHaveProperty("reasoningCli");
    expect(launchSpec).not.toHaveProperty("nativeReasoning");
  });

  it("uses no experimental registration or bridge-authoring API", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "fx" });
    expect(() => plugin(bb)).not.toThrow();
    expect(harness.registrations.providerRegistrations).toHaveLength(1);
  });
});

describe("pinned launch environment", () => {
  // fx reads its permission mode from the environment and defaults to `auto`,
  // which decides sensitive tool calls inside fx instead of asking the client.
  // BB can only enforce `accept-edits` / `full` if fx asks, so the mode is
  // pinned on the launch spec rather than inherited from whatever shell BB
  // happens to run under.
  it("pins fx's permission mode to `ask` so BB decides sensitive tool calls", () => {
    expect(registeredLaunchSpec().env).toEqual({ FX_PERMISSION_MODE: "ask" });
  });

  it("never launches fx in a mode that bypasses BB's approval", () => {
    const env = registeredLaunchSpec().env as Record<string, string>;

    // `auto` self-approves inside fx; `yolo` disables fx's permission policy
    // outright. Either one silently detaches BB's permission mode from what
    // the agent actually does.
    expect(env.FX_PERMISSION_MODE).not.toBe("auto");
    expect(env.FX_PERMISSION_MODE).not.toBe("yolo");
  });

  it("hands BB an environment nothing downstream can rewrite", () => {
    // The declaration spreads a fresh copy of the module constant and BB
    // freezes what it registers, so neither the plugin nor a later caller can
    // downgrade the mode between registration and launch.
    const env = registeredLaunchSpec().env as Record<string, string>;

    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      env.FX_PERMISSION_MODE = "yolo";
    }).toThrow();
    expect(registeredLaunchSpec().env).toEqual({ FX_PERMISSION_MODE: "ask" });
  });
});

describe("launch spec contract", () => {
  // The SDK publishes the schema the shared ACP bridge parses the launch spec
  // with, so the plugin is checked against the bridge's own contract rather
  // than against a copy of it: an unknown key or a wrong-typed field fails
  // here instead of at launch (the schema is strict).
  it("satisfies the SDK's exported ACP launch spec schema", () => {
    const result = experimental_acpLaunchSpecSchema.safeParse(
      registeredLaunchSpec(),
    );

    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("survives the schema with the pinned environment intact", () => {
    const parsed = experimental_acpLaunchSpecSchema.parse(
      registeredLaunchSpec(),
    );

    expect(parsed).toMatchObject({
      command: "fx",
      args: ["acp"],
      displayName: "fx",
      env: { FX_PERMISSION_MODE: "ask" },
    });
  });

  it("rejects a launch spec that drops the pinned environment", () => {
    // Guards the assertion above: the schema is doing real work, so a
    // regression in the spec cannot pass by making the schema vacuous.
    const broken = { ...registeredLaunchSpec(), env: { MODE: 1 } };

    expect(experimental_acpLaunchSpecSchema.safeParse(broken).success).toBe(
      false,
    );
  });
});
