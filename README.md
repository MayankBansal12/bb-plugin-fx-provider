# bb-plugin-fx

Run [fx](https://fx.sh/) as an agent provider inside BB.

<img width="600" height="380" alt="image" src="https://github.com/user-attachments/assets/f9eefc64-6604-4ad1-acf9-1be071d2712f" />


The plugin uses fx's Agent Client Protocol (`fx acp`) over stdio and translates
its sessions, streamed assistant text, tool calls, cancellation, and model
recovery updates into BB's provider bridge protocol. Each BB thread owns an
isolated fx subprocess. fx keeps its own durable session so a BB thread can be
resumed after the provider bridge restarts. If the fx process exits between
turns, the bridge warns in the thread and transparently resumes the durable fx
session on the next message.

## Requirements

- BB 0.39 or newer
- fx available as `fx` on the host `PATH`
- An authenticated fx CLI (`fx login`)

Verify fx before installing:

```sh
fx status --json
fx models --json
```

## Install

Install release v0.2.1 straight from GitHub:

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-fx-provider.git@v0.2.1 --yes
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

The provider appears as **fx** in BB, using fx's own wordmark.

### Models

The picker lists every model `fx models --json` reports. `fx status --json`
names the account default, and the bridge keeps that model selectable even when
`fx models` omits it — on fx 0.0.4 the account default (`zai/glm-5.2`) is not in
the 156-id public catalog, but the ACP session accepts it. BB sends the selected
model to fx through ACP's `session/set_config_option` before a turn; a model fx
rejects fails the turn rather than silently running on a different one.

## Deliberate scope

- The fx subprocess runs with `FX_PERMISSION_MODE=ask`, and the session is left
  in fx's default `ask` mode, so tool approval arrives over ACP
  `session/request_permission`. The bridge is the automatic reviewer BB
  advertises (`permissionModes: ["auto"]`, `approvalEnforcedBy: "provider"`) and
  automatically answers with fx's single-use allow option; BB does not show an
  interactive approval prompt for these requests. fx's `code` mode is
  deliberately not selected: its classifier denies `terminal.exec`
  non-interactively and redirects the model to an ask-user-question tool fx
  only offers in its own shell.
- `supportsNativeUserQuestion` is `false`. fx's native prompt is ACP
  `elicitation/create`, which this bridge declines because it has no BB surface
  to render it; claiming otherwise would suppress BB's own fallback.
- fx models advertise no supported reasoning levels. fx exposes no reasoning
  config option over ACP (`session/new` reports only `model` and `mode` on fx
  0.0.4), so BB shows no reasoning control and the bridge forwards no reasoning
  value. The provider declaration retains BB's required static `medium`
  fallback, but it is not applied to fx. If a future fx build reports a
  `thought_level` config option, the bridge surfaces and forwards those levels
  automatically.
- Forking, provider-side archive/rename, manual compaction, service tiers, and
  BB workflows are not advertised.
- fx's built-in retry loop is allowed to run without a bridge timeout. Recovery
  updates, including transient model 503s, appear as non-terminal BB warnings.
- fx ACP currently accepts text and embedded context, not image/audio input;
  attached file and image paths are passed as text for fx to inspect locally.

## Development

```sh
npm run typecheck
npm test
npm run build
```

`npm test` covers protocol negotiation, invalid requests, model catalog
assembly, identity ordering, session start/resume, streamed text, tool
lifecycle, permission answers, recovery events, cancellation, discard, and
release semantics. `npm run build` produces the server, app, and host artifacts
under `dist/` for managed BB installs.

Fixtures in `tests/` mirror payloads captured from a live `fx acp` 0.0.4
session — notably the `_meta.fx.modelResponseRecovery` shape. Re-capture them
against a real session rather than hand-writing new shapes.
