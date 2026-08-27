import type { BbPluginApi, PluginProviderDeclaration } from "@get-bb/plugin-sdk";

/**
 * How BB launches fx. `fx acp` speaks the Agent Client Protocol, which the
 * SDK's shared ACP bridge already implements end to end, so this plugin
 * declares the launch and lets that bridge do the talking (see host.ts).
 *
 * No `modelCli`: fx's own `fx models --json` omits models the account can
 * still select (the account default among them), while `session/new` returns
 * every one of them as a `model` config option. Leaving the model CLI out
 * makes the bridge discover models from the agent itself, which is the
 * complete list.
 *
 * No `reasoningCli` / `nativeReasoning`: fx 0.0.4 exposes no reasoning
 * configuration, on the command line or in its session config options.
 */
const FX_LAUNCH_SPEC = {
  displayName: "fx",
  command: "fx",
  args: ["acp"],
  env: {},
} as const;

/** The provider BB lists in the picker. Exported for the declaration tests. */
export const fxProviderDeclaration: PluginProviderDeclaration = {
  id: "fx",
  displayName: "fx",
  // Grouped with the other ACP agents, which is what fx is and which bridge
  // runs it.
  family: "acp",
  // app.tsx registers the same mark as a theme-aware component, which BB
  // prefers over this file logo wherever it is available.
  icon: "./assets/fx.svg",
  strings: {
    signInHint: "Run `fx login` on the machine to sign in.",
    expiredHint: "Your fx session expired. Run `fx login`, then reload.",
    installUrl: "https://fx.sh/",
  },
  experimental_bridgeOptions: {
    acpLaunchSpec: { ...FX_LAUNCH_SPEC, args: [...FX_LAUNCH_SPEC.args] },
  },
  // fx answers `model/list` from the signed-in account, not from anything in
  // the workspace, so one probe per machine serves every environment on it.
  models: { scope: "host" },
  // The shared ACP bridge answers the health probe for every agent it runs.
  // fx has no usage or installation reporting over ACP.
  maintenance: { health: true, usage: false, installation: false },
  capabilities: {
    supportsServiceTier: false,
    // fx's native ask-user-question is ACP `elicitation/create`, which the
    // shared bridge does not surface in BB. Claiming otherwise would make BB
    // suppress its own fallback.
    supportsNativeUserQuestion: false,
    // `fx acp` advertises `sessionCapabilities: { list, resume, close }` — no
    // `session/fork`.
    fork: "none",
    supportsManualCompaction: false,
    supportsThreadArchive: false,
    supportsThreadRename: false,
    permissionModes: ["accept-edits", "full"],
    // fx exposes no reasoning control, so this is BB's required static
    // fallback ladder and nothing forwards it.
    reasoningLevels: ["medium"],
  },
  composerActions: [],
};

/** Register the fx provider. Its implementation is the SDK's ACP bridge. */
export default function plugin(bb: BbPluginApi): void {
  bb.providers.register(fxProviderDeclaration);
}
