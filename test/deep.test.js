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

test("uses the same overlap behavior as text redaction", () => {
  const session = new PlaceholderSession({ secret: new Uint8Array(32).fill(5) })
  const patternsWithOverlap = {
    keywords: [
      { value: "abcd", category: "FIRST" },
      { value: "cdef", category: "SECOND" },
    ],
    regex: [],
    exclude: new Set(),
  }

  const redacted = redactDeep({ value: "abcdef" }, patternsWithOverlap, session).value

  assert.match(redacted.value, /^__VG_FIRST_[0-9a-f]{12}____VG_SECOND_[0-9a-f]{12}__$/)
  restoreDeep(redacted, session)
  assert.equal(redacted.value, "abcdef")
})

test("handles structured strings larger than the third-party default limit", () => {
  const session = new PlaceholderSession({ secret: new Uint8Array(32).fill(6) })
  const largeValue = `${"x".repeat(16 * 1024 * 1024)}sk-live-123`

  const redacted = redactDeep({ value: largeValue }, patterns, session).value

  assert.match(redacted.value, /__VG_TOKEN_[0-9a-f]{12}__$/)
  assert.equal(redacted.value.length, largeValue.length - "sk-live-123".length + 25)
})

test("keeps redaction and restoration limited to arrays and plain objects", () => {
  const session = new PlaceholderSession({ secret: new Uint8Array(32).fill(8) })
  const original = new Map([["token", "sk-live-123"]])

  const redacted = redactDeep(original, patterns, session).value

  assert.equal(redacted, original)
  assert.equal(redacted.get("token"), "sk-live-123")
  restoreDeep(redacted, session)
  assert.equal(redacted.get("token"), "sk-live-123")
})
