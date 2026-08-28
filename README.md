# bb-plugin-fx

Run [fx](https://fx.sh/) as an agent provider inside BB.

<img width="600" height="380" alt="image" src="https://github.com/user-attachments/assets/f9eefc64-6604-4ad1-acf9-1be071d2712f" />

fx speaks the [Agent Client Protocol](https://agentclientprotocol.com), and BB
ships a first-party ACP bridge for exactly that case. So this plugin is a
declaration, not a protocol implementation: `server.ts` registers the provider
and says how to launch fx (`fx acp`), and `host.ts` re-exports BB's shared ACP
bridge, which owns the session, streaming, tool calls, permissions, and model
selection.

## Requirements

- BB 0.40 or newer (`bb.providers.register`, plugin SDK 0.4.21)
- fx available as `fx` on the host `PATH`
- An authenticated fx CLI (`fx login`)

Verify fx before installing:

```sh
fx status --json
```

## Install

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-fx-provider.git@v0.3.0 --yes
```

For local development:

```sh
npm install
npm run check
bb plugin install .
```

Reload after local changes:

```sh
bb plugin reload fx
```

The provider appears as **fx** in BB, using fx's own wordmark, grouped with
BB's other ACP agents.

### Models

The launch spec deliberately declares no `modelCli`. `fx models --json` omits
models the account can still select — on fx 0.0.6 the account default
(`zai/glm-5.2`) is the one id missing from that 158-id catalog — while ACP
`session/new` returns all 159 as a `model` config option, with the account
default as the current value. Leaving the model CLI out makes the shared bridge read the
catalog from the agent itself, which is the complete and correct list. BB
applies the selected model through `session/set_config_option` before a turn.

## Deliberate scope

- **Permissions are BB's.** The launch spec pins `FX_PERMISSION_MODE=ask` on
  the `fx acp` process, and the shared ACP bridge answers the
  `session/request_permission` requests that mode produces from BB's own
  permission mode (`approvalEnforcedBy: "runtime"`). Tool approval therefore
  follows the same rules and surfaces as every other ACP agent in BB, and the
  declaration advertises `accept-edits` and `full`. Left to its default,
  `FX_PERMISSION_MODE=auto`, fx resolves sensitive tool calls *itself* — it
  reviews each one and returns a failed tool result on a non-allow — so BB
  would never be asked and those two modes would be cosmetic. fx's configured
  rules, session grants, and tool admission still apply ahead of the ask. The
  mode is pinned rather than inherited so a stray `FX_PERMISSION_MODE=yolo` in
  the environment BB happens to run under cannot quietly disable fx's
  permission policy for every thread on the machine.
- `supportsNativeUserQuestion` is `false`. fx's native prompt is ACP
  `elicitation/create`, which the shared bridge does not surface in BB;
  claiming otherwise would suppress BB's own fallback.
- No reasoning control. fx 0.0.6 exposes no reasoning configuration — neither a
  CLI flag nor a `session/new` config option (it reports `provider`, `model`
  and `mode`, and nothing resembling reasoning or effort) — so the launch spec
  declares no `reasoningCli` or `nativeReasoning` and nothing forwards a
  reasoning value. The declaration keeps BB's required
  static `medium` fallback ladder, unused.
- `fork: "none"`. `fx acp` advertises `sessionCapabilities: { list, resume,
  close }` and no `session/fork`.
- fx also exposes its permission mode as a `mode` session config option
  (`code` → fx's `auto`, `ask` → `ask`), which the pinned environment seeds to
  `ask`. Setting it back to `code` mid-session does stop the
  `session/request_permission` requests, but BB's shared bridge only reads
  config options in the `model` and `thought_level` categories, so nothing in
  BB can flip it — the pin holds for every thread BB starts.
- Provider-side archive/rename, manual compaction, and service tiers are not
  advertised.
- Model discovery is `scope: "host"`: fx answers from the signed-in account,
  not from anything in the workspace, so one probe per machine serves every
  environment on it.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run check:managed
```

`npm run check` runs all four.

`npm test` loads the plugin into the SDK's fake plugin host, so the provider
declaration is validated by the same code the real server runs — a field the
current contract does not accept fails the test rather than the install. The
launch spec is additionally parsed with the SDK's own
`experimental_acpLaunchSpecSchema`, the strict schema the shared bridge reads
it with, so the plugin is checked against the bridge's contract instead of a
copy of it. The pinned launch environment is asserted explicitly: fx must be
launched in `ask`, never in `auto` or `yolo`.

`npm run build` produces the server, app, and host artifacts under `dist/` for
managed BB installs.

`npm run check:managed` reproduces a managed install. BB clones a `git:` plugin
and runs `npm install --omit=dev` before building it, so anything the build
resolves has to be a **production** dependency — which is why
`@get-bb/plugin-sdk` and `zod` are in `dependencies`. A developer checkout has
`devDependencies` installed too, so `npm run build` passes there even when the
managed install cannot resolve
`@get-bb/plugin-sdk/provider-bridge/acp` and the provider fails to load. The
check copies the working tree to a temp directory, installs with `--omit=dev`,
resolves each specifier the build needs, runs `bb plugin build`, and imports
the built `dist/host.js` to confirm it still exports the bridge. Moving either
dependency back under `devDependencies` fails it.

One consequence worth knowing: because npm installs peer dependencies by
default, promoting the SDK also pulls its *optional* peers — `better-sqlite3`
(native), `hono`, `cron-parser` — into the production install, which this
plugin needs neither to build nor to run. A managed install is ~37 MB rather
than the handful of kilobytes `zod` alone took. That is the price of the SDK
being resolvable at build time; there is no per-package way to decline an
optional peer, and the alternative is the install failing outright.

There are no bridge protocol tests any more, because there is no bridge in this
repository: BB's `@get-bb/plugin-sdk/provider-bridge/acp` owns that behavior and
tests it upstream.
