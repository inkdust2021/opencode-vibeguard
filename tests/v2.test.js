import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin, { VibeGuardPrivacy, PLUGIN_ID, vibeguardSetup, vibeguardV2 } from "../src/index.js"

/**
 * OpenCode V2's plugin loader schema-validates the entrypoint and requires a
 * default export shaped as `{ id, setup | effect }`. A missing `default` fails
 * with `Missing key at ["default"]`; a function `default` fails with
 * `Expected object at ["default"]`. These tests pin that contract so it cannot
 * silently regress (the bug that made 0.1.0 a no-op on V2).
 */
test("V2: default export is an object definition with id + setup", () => {
  assert.equal(typeof plugin, "object")
  assert.ok(plugin, "default export must be present")
  assert.equal(typeof plugin.id, "string")
  assert.ok(plugin.id.length > 0)
  assert.equal(typeof plugin.setup, "function")
  assert.equal(plugin.id, PLUGIN_ID)
  assert.equal(plugin, vibeguardV2)
})

test("V1: named VibeGuardPrivacy export is preserved", () => {
  assert.equal(typeof VibeGuardPrivacy, "function")
})

/** Build a minimal fake of the V2 plugin Context for hook wiring. */
function makeFakeContext(directory) {
  const hooks = {}
  const register = (domain) => async (name, callback) => {
    hooks[`${domain}:${name}`] = callback
    return { dispose: async () => {} }
  }
  return {
    hooks,
    ctx: {
      location: { directory },
      session: { hook: register("session") },
      tool: { hook: register("tool") },
    },
  }
}

function withConfig(config, run) {
  const dir = mkdtempSync(join(tmpdir(), "vibeguard-"))
  const file = join(dir, "vibeguard.config.json")
  writeFileSync(file, JSON.stringify(config))
  const prev = process.env.OPENCODE_VIBEGUARD_CONFIG
  process.env.OPENCODE_VIBEGUARD_CONFIG = file
  try {
    return run(dir)
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_VIBEGUARD_CONFIG
    else process.env.OPENCODE_VIBEGUARD_CONFIG = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

test("V2: setup is a no-op when no config is found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibeguard-empty-"))
  const prev = process.env.OPENCODE_VIBEGUARD_CONFIG
  delete process.env.OPENCODE_VIBEGUARD_CONFIG
  try {
    const { ctx, hooks } = makeFakeContext(dir)
    const cleanup = await vibeguardSetup(ctx)
    assert.equal(cleanup, undefined)
    assert.deepEqual(Object.keys(hooks), [])
  } finally {
    if (prev !== undefined) process.env.OPENCODE_VIBEGUARD_CONFIG = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test("V2: context hook redacts text and tool parts, tool hook restores args", async () => {
  await withConfig(
    {
      enabled: true,
      placeholder_prefix: "__VG_",
      patterns: {
        keywords: [{ value: "SUPERSECRET-123", category: "API_KEY" }],
      },
    },
    async (dir) => {
      const { ctx, hooks } = makeFakeContext(dir)
      const cleanup = await vibeguardSetup(ctx)
      assert.equal(typeof cleanup, "function")
      assert.ok(hooks["session:context"])
      assert.ok(hooks["tool:execute.before"])

      const input = {
        sessionID: "ses_test",
        system: [{ type: "text", text: "system SUPERSECRET-123" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "key=SUPERSECRET-123" }] },
          {
            role: "assistant",
            content: [{ type: "tool-call", id: "t1", name: "bash", input: { command: "echo SUPERSECRET-123" } }],
          },
          {
            role: "tool",
            content: [
              { type: "tool-result", id: "t1", name: "bash", result: { type: "text", value: "SUPERSECRET-123" } },
            ],
          },
        ],
      }

      await hooks["session:context"](input)

      assert.doesNotMatch(input.system[0].text, /SUPERSECRET-123/)
      const redactedText = input.messages[0].content[0].text
      assert.doesNotMatch(redactedText, /SUPERSECRET-123/)
      assert.match(redactedText, /__VG_API_KEY_[a-f0-9]{12}__/)
      assert.doesNotMatch(JSON.stringify(input.messages[1].content[0].input), /SUPERSECRET-123/)
      assert.doesNotMatch(JSON.stringify(input.messages[2].content[0].result), /SUPERSECRET-123/)

      // The placeholder written into tool args must be restored to the real value.
      const toolInput = { sessionID: "ses_test", input: { command: redactedText } }
      await hooks["tool:execute.before"](toolInput)
      assert.equal(toolInput.input.command, "key=SUPERSECRET-123")

      await cleanup()
    },
  )
})
