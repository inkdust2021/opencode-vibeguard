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

Note: OpenCode tool calls are stored in the DB with the **real executed args/output**. Before each request, this plugin also redacts **historical tool inputs/outputs** to prevent plaintext from being sent upstream in later turns.

Placeholder format (aligned with VibeGuard):

- Prefix: `__VG_`
- Shape: `__VG_<CATEGORY>_<hash12>__` or `__VG_<CATEGORY>_<hash12>_<N>__`
- `hash12` is the first 12 hex chars of `HMAC-SHA256(session-random secret, original)`, stable within a session and irreversible to the provider

## Install / Use (local dev)

1. Put this plugin directory in your project (e.g. `./opencode-vibeguard/`).
2. Load it in your OpenCode config:

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
