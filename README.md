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
models the account can still select — on fx 0.0.4 the account default
(`zai/glm-5.2`) is missing from that 156-id catalog — while ACP `session/new`
returns all 157 as a `model` config option, with the account default as the
current value. Leaving the model CLI out makes the shared bridge read the
catalog from the agent itself, which is the complete and correct list. BB
applies the selected model through `session/set_config_option` before a turn.

## Deliberate scope

- **Permissions are BB's.** The shared ACP bridge answers fx's
  `session/request_permission` from BB's own permission mode
  (`approvalEnforcedBy: "runtime"`), so tool approval follows the same rules
  and surfaces as every other ACP agent in BB. The declaration advertises
  `accept-edits` and `full`.
- `supportsNativeUserQuestion` is `false`. fx's native prompt is ACP
  `elicitation/create`, which the shared bridge does not surface in BB;
  claiming otherwise would suppress BB's own fallback.
- No reasoning control. fx 0.0.4 exposes no reasoning configuration — neither a
  CLI flag nor a `session/new` config option (it reports only `model` and
  `mode`) — so the launch spec declares no `reasoningCli` or `nativeReasoning`
  and nothing forwards a reasoning value. The declaration keeps BB's required
  static `medium` fallback ladder, unused.
- `fork: "none"`. `fx acp` advertises `sessionCapabilities: { list, resume,
  close }` and no `session/fork`.
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
```

`npm test` loads the plugin into the SDK's fake plugin host, so the provider
declaration is validated by the same code the real server runs — a field the
current contract does not accept fails the test rather than the install.
`npm run build` produces the server, app, and host artifacts under `dist/` for
managed BB installs.

There are no bridge protocol tests any more, because there is no bridge in this
repository: BB's `@get-bb/plugin-sdk/provider-bridge/acp` owns that behavior and
tests it upstream.
