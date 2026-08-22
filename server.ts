import type { BbPluginApi } from "@get-bb/plugin-sdk";

/** Register the fx provider. Its implementation lives in the host bridge. */
export default function plugin(bb: BbPluginApi): void {
  bb.agents.experimental_registerProvider({
    id: "fx",
    displayName: "fx",
    // app.tsx registers the same mark as a theme-aware component, which BB
    // prefers over this file logo wherever it is available.
    icon: "./assets/fx.svg",
    capabilities: {
      supportsServiceTier: false,
      // fx's native ask-user-question is ACP `elicitation/create`, which this
      // bridge declines because it has no way to surface the prompt in BB.
      // Claiming otherwise would make BB suppress its own fallback.
      supportsNativeUserQuestion: false,
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
