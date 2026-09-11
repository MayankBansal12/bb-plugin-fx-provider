import type {
  BbPluginApi,
  PluginProviderDeclaration,
} from "@get-bb/plugin-sdk";

/**
 * Pin ask mode so fx forwards unresolved permission requests to BB even when
 * the host shell sets a permissive default. fx's own rules, session grants,
 * and tool admission still apply before a request reaches the client.
 */
const FX_ENV = { FX_PERMISSION_MODE: "ask" } as const;

/**
 * How BB launches fx. `fx acp` speaks the Agent Client Protocol, which the
 * SDK's shared ACP bridge already implements end to end, so this plugin
 * declares the launch and lets that bridge do the talking. host.ts normalizes
 * the order of fx's model config options before the shared bridge reads them.
 *
 * No `modelCli`: fx's own `fx models --json` omits models the account can
 * still select (the account default among them), while `session/new` returns
 * every one of them as a `model` config option. Leaving the model CLI out
 * makes the bridge discover models from the agent itself, which is the
 * complete list.
 *
 * No `reasoningCli` / `nativeReasoning`: fx 0.0.7 session configuration
 * reports `provider`, `model` and `mode`, with no reasoning option.
 *
 * No `permissionCli`: fx takes its permission mode from the environment, not
 * from a command-line flag, so the mode is pinned in `env` above.
 */
const FX_LAUNCH_SPEC = {
  displayName: "fx",
  command: "fx",
  args: ["acp"],
  env: FX_ENV,
} as const;

/** The provider BB lists in the picker. Exported for the declaration tests. */
export const fxProviderDeclaration: PluginProviderDeclaration = {
  id: "fx",
  displayName: "fx",
  // Grouped with the other ACP agents, which is what fx is and which bridge
  // runs it.
  family: "acp",
  // BB renders the monochrome SVG as a mask that follows the current theme.
  icon: "./assets/fx.svg",
  strings: {
    signInHint: "Run `fx login` on the machine to sign in.",
    expiredHint: "Your fx session expired. Run `fx login`, then reload.",
    installUrl: "https://fx.sh/",
  },
  experimental_bridgeOptions: {
    acpDialect: "generic",
    acpLaunchSpec: {
      ...FX_LAUNCH_SPEC,
      args: [...FX_LAUNCH_SPEC.args],
      env: { ...FX_ENV },
    },
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
    // Required static fallback only. The model catalog exposes effort choices
    // only when fx advertises them; catalog normalization removes invented choices.
    reasoningLevels: ["medium"],
  },
  composerActions: [],
};

/** Register the fx provider. Its implementation is the SDK's ACP bridge. */
export default function plugin(bb: BbPluginApi): void {
  bb.providers.register(fxProviderDeclaration);
}
