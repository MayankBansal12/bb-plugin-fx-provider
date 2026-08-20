# bb-plugin-fx

Run [FX](https://fx.sh/) as an agent provider inside BB.

The plugin uses FX's Agent Client Protocol (`fx acp`) over stdio and translates
its sessions, streamed assistant text, tool calls, cancellation, and model
recovery updates into BB's provider bridge protocol. Each BB thread owns an
isolated FX subprocess. FX keeps its own durable session so a BB thread can be
resumed after the provider bridge restarts.

## Requirements

- BB 0.39 or newer
- FX available as `fx` on the host `PATH`
- An authenticated FX CLI (`fx login`)

Verify FX before installing:

```sh
fx status --json
fx models --json
```

## Install

```sh
npm install
npm run check
bb plugin install .
```

Reload after local changes:

```sh
bb plugin reload fx
```

The provider appears as **FX** in BB. Model discovery follows the authenticated
FX account; the model selected by `fx status --json` is the default. BB sends
the selected model to FX through ACP's `session/set_config_option` before a
turn. The tested default is `zai/glm-5.2`.

## Deliberate scope

- Permission mode is `auto`, enforced by FX's own automatic reviewer.
- Reasoning is exposed as `medium` because FX/model configuration owns the
  underlying reasoning behavior.
- Forking, provider-side archive/rename, manual compaction, service tiers, and
  BB workflows are not advertised.
- FX's built-in retry loop is allowed to run without a bridge timeout. Recovery
  updates, including transient model 503s, appear as non-terminal BB warnings.
- FX ACP currently accepts text and embedded context, not image/audio input;
  attached file and image paths are passed as text for FX to inspect locally.

## Development

```sh
npm run typecheck
npm test
npm run build
```

`npm test` covers protocol negotiation, invalid requests, model results,
identity ordering, session start/resume, streamed text, tool lifecycle,
recovery events, cancellation, and release semantics. `npm run build` produces
the server and host artifacts under `dist/` for managed BB installs.
