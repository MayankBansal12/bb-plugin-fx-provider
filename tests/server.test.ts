import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { fxProviderDeclaration } from "../server.js";

function register() {
  const { bb, harness } = createFakePluginHost({ pluginId: "fx" });
  plugin(bb);
  return harness.registrations.providerRegistrations;
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
        env: {},
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
