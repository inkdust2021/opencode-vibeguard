import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { VibeGuardPrivacy } from "../src/index.js"

test("redacts structured MCP output and restores a later tool argument", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-vibeguard-"))
  t.after(() => rm(directory, { force: true, recursive: true }))

  await writeFile(
    path.join(directory, "vibeguard.config.json"),
    JSON.stringify({
      enabled: true,
      patterns: {
        keywords: [{ value: "sk-live-123", category: "TOKEN" }],
      },
    }),
  )

  const hooks = await VibeGuardPrivacy({ directory })
  const output = {
    messages: [
      {
        info: { sessionID: "session-1" },
        parts: [
          {
            type: "tool",
            state: {
              status: "completed",
              output: { data: [{ apiKey: "sk-live-123", safe: "visible" }] },
            },
          },
        ],
      },
    ],
  }

  await hooks["experimental.chat.messages.transform"]({}, output)

  const safeOutput = output.messages[0].parts[0].state.output
  assert.match(safeOutput.data[0].apiKey, /^__VG_TOKEN_[0-9a-f]{12}__$/)
  assert.equal(safeOutput.data[0].safe, "visible")

  const tool = { args: { apiKey: safeOutput.data[0].apiKey } }
  await hooks["tool.execute.before"]({ sessionID: "session-1" }, tool)
  assert.equal(tool.args.apiKey, "sk-live-123")
})
