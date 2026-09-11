# bb-plugin-fx

Run [fx](https://fx.sh/) as an agent provider inside BB, with model selection,
resumable sessions, and streamed replies and tool activity.

<img width="600" height="380" alt="fx provider in BB" src="https://github.com/user-attachments/assets/f9eefc64-6604-4ad1-acf9-1be071d2712f" />

## Requirements

- BB 0.42.1 or newer (plugin SDK 0.4.47).
- The fx CLI available as `fx` on each execution host's `PATH`.
- An authenticated fx account on that host: run `fx login`, then `fx status --json`.
- Model access, limits, and service charges depend on your fx account and model provider.

## Install this development version

Version 0.3.0 is in development and has no release tag yet. To review this branch:

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-fx-provider.git@chore/migrate-stable-provider-registration
```

For a local checkout:

```sh
npm ci
npm run check
bb plugin install .
```

After local changes, run `npm run build` and `bb plugin reload fx`.
The provider appears as **fx** in BB, grouped with the other ACP agents.
Its SVG mark follows the theme through BB's built-in provider icon rendering.

## How it works

`server.ts` registers the provider through `bb.providers.register` and declares
how to launch `fx acp`. `host.ts` uses the SDK's shared ACP bridge for sessions,
streaming, and approvals. A small child-process adapter puts fx's actual `model` config option
before its `provider` option: fx 0.0.7 marks both as category `model`, while the
shared bridge selects the first. It preserves the options and their values in
responses and updates. The adapter also translates fx's `refused` stop reason
to ACP's `refusal`, retaining the agent's rejection text. The plugin ships no
frontend bundle.

Models come from ACP session configuration. Earlier fx CLI versions omitted
selectable account defaults from `fx models --json`, so the launch spec leaves
out `modelCli` and lets the bridge query the agent. The bridge applies model
selection through ACP. The catalog is cached per host.

### Permissions

The launch spec pins `FX_PERMISSION_MODE=ask`, overriding an inherited `auto`
or `yolo` mode. The bridge sends fx's `session/request_permission` requests to
BB in `accept-edits` mode and allows them in `full` mode. BB's escalation policy
still applies. This is not a filesystem sandbox: fx's own configured rules,
session grants, and tool admission can decide a call before fx asks BB.

The plugin does not set fx's `mode` session option. It passes model selection
and any advertised reasoning-effort choices through the bridge. The fx CLI
owns credentials and service connections; the plugin stores no credentials of
its own and adds no telemetry.

### Supported scope

The provider supports session restore but does not advertise forks, manual
compaction, provider-side archive/rename, service tiers, or native user-question
UI. Reasoning controls appear only when the selected model exposes effort
choices over ACP. Released fx 0.0.7 and 0.0.8 do not expose these; upstream
[added model-specific ACP effort support](https://github.com/vercel-labs/fx/commit/32f3dc9ee07b9649ce10d6b24d1e30af0e20302a)
after those releases. fx can still use its own saved effort preference.

The required static `medium` capability is BB bookkeeping. Model discovery
runs the shared bridge in a short-lived subprocess and removes its synthetic
“agent-managed Medium” choice from the resulting catalog, including models
left unprobed at the discovery deadline. Actual effort choices, including a
real medium-only control, are preserved. When fx exposes no effort selector,
the shared bridge sends no effort value and fx keeps its own preference.

Registration uses the supported `bb.providers.register` API. The shared bridge
export and static launch options still use the SDK's published experimental
names; the plugin does not use the removed `bb.agents.experimental_registerProvider`
API or the removed `supportsWorkflows` capability.

## Development and validation

```sh
npm run typecheck
npm test
npm run check:managed
```

`npm run check` runs all three; `npm test` builds the artifacts first.
GitHub Actions runs the same checks on pull requests and pushes to `main`.

- Registration tests load the plugin into the SDK's fake host and validate the
  launch spec with the SDK's ACP schema.
- Bridge tests launch the actual `dist/host.js` through the public production
  bootstrap. A local ACP fixture exercises canonical conformance (including
  restore and streaming), model discovery, and permission allow/deny/full
  behavior, plus fx's refusal response. It also rejects any launch that loses `FX_PERMISSION_MODE=ask`.
  These tests need no account and do not claim to test the real fx CLI.
- `check:managed` builds a temporary copy with `npm install --omit=dev`, checks
  its server/host artifacts, and imports the host export. This catches missing
  production dependencies that a developer build would conceal.

Keep `@get-bb/plugin-sdk` in **dependencies**, pinned to the tested version.
BB bundles its `provider-bridge/acp` subpath from the plugin's own installation;
managed Git installs omit development dependencies. `zod` is also needed by
that bridge. The general `bb plugin types --check` advice to move the SDK to
devDependencies does not apply to provider bridges.

`PLUGIN_OVERVIEW.md` contains the marketplace description. Before publishing
0.3.0, validate this branch, merge it, and create a new immutable `v0.3.0` tag.
A later marketplace update must point at that release and include the overview
and required category. The older `^0.2.1` range does not include 0.3.0.

The marketplace icon source is `assets/fx-marketplace.svg`. It has a transparent
background so BB can tint it as an SVG mask. Vendor it into the marketplace
under a filename containing the first eight characters of its SHA-256 hash;
do not add an opaque background to the SVG.
