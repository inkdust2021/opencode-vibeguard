import test from "node:test"
import assert from "node:assert/strict"

import { PlaceholderSession } from "../src/session.js"
import { restoreDeep } from "../src/deep.js"

const session = () => new PlaceholderSession({ prefix: "__VG_", ttlMs: 1000, maxMappings: 100 })

test("restoreDeep restores known placeholders in nested tool args", () => {
  const s = session()
  const ph = s.getOrCreatePlaceholder("s3cret-value", "EMAIL")
  const args = { command: `user: ${ph}`, list: [ph] }
  restoreDeep(args, s)
  assert.deepEqual(args, { command: "user: s3cret-value", list: ["s3cret-value"] })
})

test("restoreDeep refuses to run with a placeholder it can't restore", () => {
  const s = session()
  const stale = s.generatePlaceholder("s3cret-value", "EMAIL")
  assert.throws(() => restoreDeep({ content: `user: ${stale}` }, s), /refusing to run the tool/)
})

test("a mapping in use doesn't expire", (t) => {
  t.mock.timers.enable({ apis: ["Date"] })
  const s = session()
  const ph = s.getOrCreatePlaceholder("s3cret-value", "EMAIL")
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(600) // 3 s in total, TTL is 1 s: only kept alive by being seen again
    s.cleanup()
    assert.equal(s.getOrCreatePlaceholder("s3cret-value", "EMAIL"), ph)
    s.cleanup()
    assert.equal(s.lookup(ph), "s3cret-value")
  }
  t.mock.timers.tick(1500) // unused for longer than the TTL: gone
  s.cleanup()
  assert.equal(s.lookup(ph), undefined)
})
