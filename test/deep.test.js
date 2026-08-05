import assert from "node:assert/strict"
import test from "node:test"

import { redactDeep, restoreDeep } from "../src/deep.js"
import { PlaceholderSession } from "../src/session.js"

const patterns = {
  keywords: [{ value: "sk-live-123", category: "TOKEN" }],
  regex: [{ pattern: "Bearer\\s+[A-Za-z0-9._-]+", flags: "i", category: "AUTH" }],
  exclude: new Set(),
}

test("redacts nested structured values without mutating the tool result", () => {
  const session = new PlaceholderSession({ secret: new Uint8Array(32).fill(7) })
  const original = {
    result: [{ token: "sk-live-123", nested: { authorization: "Bearer abc.def" } }],
    safe: "keep me",
  }

  const redacted = redactDeep(original, patterns, session)

  assert.equal(redacted.matches, 2)
  assert.equal(original.result[0].token, "sk-live-123")
  assert.match(redacted.value.result[0].token, /^__VG_TOKEN_[0-9a-f]{12}__$/)
  assert.match(redacted.value.result[0].nested.authorization, /^__VG_AUTH_[0-9a-f]{12}__$/)
  assert.equal(redacted.value.safe, "keep me")

  restoreDeep(redacted.value, session)
  assert.deepEqual(redacted.value, original)
})

test("preserves shared and circular references", () => {
  const session = new PlaceholderSession({ secret: new Uint8Array(32).fill(3) })
  const shared = { token: "sk-live-123" }
  const original = { first: shared, second: shared }
  original.self = original

  const redacted = redactDeep(original, patterns, session).value

  assert.notEqual(redacted, original)
  assert.equal(redacted.first, redacted.second)
  assert.equal(redacted.self, redacted)
  assert.match(redacted.first.token, /^__VG_TOKEN_[0-9a-f]{12}__$/)
})
