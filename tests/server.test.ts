import { describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

describe("FX provider registration", () => {
  it("declares only capabilities implemented by the bridge", () => {
    const register = vi.fn();
    plugin({
      agents: { experimental_registerProvider: register },
    } as never);

    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith({
      id: "fx",
      displayName: "FX",
      icon: "Zap",
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: true,
        fork: "none",
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        supportsWorkflows: false,
        permissionModes: ["auto"],
        reasoningLevels: ["medium"],
      },
      composerActions: [],
    });
  });
});
