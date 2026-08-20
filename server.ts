import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Register the FX provider. Its implementation lives in the host bridge. */
export default function plugin(bb: BbPluginApi): void {
  bb.agents.experimental_registerProvider({
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
}
