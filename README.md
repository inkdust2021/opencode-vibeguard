English | [中文](README-zh.md)

[![npm](https://img.shields.io/npm/v/opencode-vibeguard)](https://www.npmjs.com/package/opencode-vibeguard)
[![downloads](https://img.shields.io/npm/dm/opencode-vibeguard)](https://www.npmjs.com/package/opencode-vibeguard)
[![license](https://img.shields.io/github/license/inkdust2021/opencode-vibeguard)](LICENSE)
[![node](https://img.shields.io/node/v/opencode-vibeguard)](https://www.npmjs.com/package/opencode-vibeguard)

# opencode-vibeguard

Inspired by [VibeGuard](https://github.com/inkdust2021/VibeGuard).

![Screenshot](./screenshot.png)

An OpenCode plugin that:

- Replaces configured sensitive strings with placeholders **before requests are sent to the LLM provider** (the provider never sees plaintext)
- Restores placeholders back to the original text **after the model output completes** (more natural local display/persistence)
- Restores placeholders **before tool execution** (e.g. `bash` / `write` / `edit`) so local tools run with real values

Supports both OpenCode **V1** and **V2** (see [OpenCode V2 support](#opencode-v2-support)).

Note: OpenCode tool calls are stored in the DB with the **real executed args/output**. Before each request, this plugin also redacts **historical tool inputs/outputs** to prevent plaintext from being sent upstream in later turns.

Placeholder format (aligned with VibeGuard):

- Prefix: `__VG_`
- Shape: `__VG_<CATEGORY>_<hash12>__` or `__VG_<CATEGORY>_<hash12>_<N>__`
- `hash12` is the first 12 hex chars of `HMAC-SHA256(session-random secret, original)`, stable within a session and irreversible to the provider

## Install / Use (local dev)

1. Put this plugin directory in your project (e.g. `./opencode-vibeguard/`).
2. Load it in your OpenCode config.

OpenCode V2 resolves a **local directory** through `<dir>/server` (or `<dir>/index`)
and ignores `package.json` `main`/`exports`, so point the config at the directory:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file://./opencode-vibeguard"]
}
```

On OpenCode V1 you can reference the entry file directly:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file://./opencode-vibeguard/src/index.js"]
}
```

3. Put `vibeguard.config.json` in your project root (copy from `vibeguard.config.json.example`).

> Safety note: to avoid unexpected modifications, the plugin becomes a no-op if the config file is missing or `enabled=false`.

## Install / Use (npm)

Reference the package name in `opencode.json` (OpenCode will auto-install it on first use):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-vibeguard"]
}
```

You can also pin a version:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-vibeguard@0.1.0"]
}
```

Optional (manual) install via npm/pnpm/bun (useful for offline / reproducible setups):

```bash
npm i -D opencode-vibeguard
# or: pnpm add -D opencode-vibeguard
# or: bun add -d opencode-vibeguard
```

If you prefer to load from your local `node_modules`, use a `file://` plugin path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file://./node_modules/opencode-vibeguard/src/index.js"]
}
```

## OpenCode V2 support

OpenCode V2 (>= 2.0.x) loads plugins through the module's **default export** and
requires it to be an object with an `id` and a `setup` (or `effect`) function.
Older versions of this plugin only exposed a named export, so V2 rejected them
on every startup with:

```
PluginModule.LoadError: Plugin must export a default definition with an id and
an effect or setup function. (cause: SchemaError(Missing key at ["default"]))
```

The entrypoint now exports both:

```js
// V2 (default export — object shape is required; a bare function is rejected too)
export default { id: "opencode-vibeguard", setup }

// V1 (named export)
export const VibeGuardPrivacy = async (ctx) => { ... }
```

The V2 adapter (`src/v2.js`) maps the existing redaction engine onto the V2 hooks:

| Behaviour | V1 hook | V2 hook |
| --- | --- | --- |
| Redact before the model request | `experimental.chat.messages.transform` | `session.hook("context")` |
| Restore before tool execution | `tool.execute.before` | `tool.hook("execute.before")` |

### V2 known difference

V2 currently exposes no equivalent of the V1 `experimental.text.complete` hook,
so the *display/persistence* restore step is unavailable there. Secrets are still
never sent upstream (the request-side redaction and the pre-tool restore both
work), but placeholders may remain in the model's own echoed text on screen and
in the local database.

## Configuration

Config lookup order (first match wins):

1. Path specified by env var `OPENCODE_VIBEGUARD_CONFIG`
2. Project root: `./vibeguard.config.json`
3. Project `.opencode` dir: `./.opencode/vibeguard.config.json`
4. Global dir: `~/.config/opencode/vibeguard.config.json`

See `vibeguard.config.json.example` for an example.

## Tests

```bash
cd opencode-vibeguard
npm test
```

## Debug

Enable debug logs (will not print any plaintext secrets; only config path and replace counts):

```bash
OPENCODE_VIBEGUARD_DEBUG=1 opencode .
```

Or set in `vibeguard.config.json`:

```json
{ "debug": true }
```

## Known limitations

- During streaming (`text-delta`) the placeholder may briefly appear; it will be restored at `text-end`.
