import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { redactText, redactTextWithAI } from "./engine.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { restoreText } from "./restore.js"

describe("redactText (regex-only)", () => {
  it("redacts email addresses", () => {
    const patterns = buildPatternSet({ builtin: ["email"], exclude: ["example.com"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("Contact me at alice@corp.io for details", patterns, session)
    assert.ok(!result.text.includes("alice@corp.io"), "email should be redacted")
    assert.ok(result.text.includes("__VG_EMAIL_"), "should contain placeholder")
    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0].category, "EMAIL")
  })

  it("redacts keyword values", () => {
    const patterns = buildPatternSet({
      keywords: [{ value: "sk-abc123secret", category: "API_KEY" }],
    })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("Key is sk-abc123secret here", patterns, session)
    assert.ok(!result.text.includes("sk-abc123secret"))
    assert.ok(result.text.includes("__VG_API_KEY_"))
  })

  it("respects exclude list", () => {
    const patterns = buildPatternSet({
      builtin: ["email"],
      exclude: ["test@example.com"],
    })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("Email: test@example.com", patterns, session)
    assert.ok(result.text.includes("test@example.com"), "excluded email should remain")
  })

  it("handles overlapping spans correctly", () => {
    const patterns = buildPatternSet({
      keywords: [
        { value: "secret-key-abc", category: "KEY" },
        { value: "key-abc", category: "KEY_PART" },
      ],
    })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("Found secret-key-abc here", patterns, session)
    assert.ok(!result.text.includes("secret-key-abc"))
    assert.ok(!result.text.includes("key-abc"))
  })

  it("returns unchanged text when nothing matches", () => {
    const patterns = buildPatternSet({ builtin: ["email"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("Nothing sensitive here", patterns, session)
    assert.equal(result.text, "Nothing sensitive here")
    assert.equal(result.matches.length, 0)
  })
})

describe("new builtin patterns", () => {
  it("redacts US phone numbers", () => {
    const patterns = buildPatternSet({ builtin: ["phone_us"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("Call me at (555) 123-4567 please", patterns, session)
    assert.ok(!result.text.includes("(555) 123-4567"))
    assert.ok(result.text.includes("__VG_PHONE_US_"))
  })

  it("redacts SSNs", () => {
    const patterns = buildPatternSet({ builtin: ["ssn"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("SSN: 123-45-6789", patterns, session)
    assert.ok(!result.text.includes("123-45-6789"))
    assert.ok(result.text.includes("__VG_SSN_"))
  })

  it("redacts credit card numbers", () => {
    const patterns = buildPatternSet({ builtin: ["credit_card"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("Card: 4111-1111-1111-1111", patterns, session)
    assert.ok(!result.text.includes("4111-1111-1111-1111"))
    assert.ok(result.text.includes("__VG_CREDIT_CARD_"))
  })

  it("redacts Amex credit card numbers (15 digits)", () => {
    const patterns = buildPatternSet({ builtin: ["credit_card"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("Amex: 3782 822463 10005", patterns, session)
    assert.ok(!result.text.includes("3782 822463 10005"))
    assert.ok(result.text.includes("__VG_CREDIT_CARD_"))
  })

  it("redacts private key headers", () => {
    const patterns = buildPatternSet({ builtin: ["private_key_header"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("-----BEGIN RSA PRIVATE KEY-----\nfoo", patterns, session)
    assert.ok(!result.text.includes("-----BEGIN RSA PRIVATE KEY-----"))
    assert.ok(result.text.includes("__VG_PRIVATE_KEY_"))
  })

  it("redacts AWS access keys", () => {
    const patterns = buildPatternSet({ builtin: ["aws_access_key"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("key: AKIAIOSFODNN7EXAMPLE", patterns, session)
    assert.ok(!result.text.includes("AKIAIOSFODNN7EXAMPLE"))
    assert.ok(result.text.includes("__VG_AWS_ACCESS_KEY_"))
  })

  it("redacts bearer tokens", () => {
    const patterns = buildPatternSet({ builtin: ["generic_bearer"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.xyz", patterns, session)
    assert.ok(!result.text.includes("eyJhbGciOiJIUzI1NiJ9"))
    assert.ok(result.text.includes("__VG_BEARER_TOKEN_"))
  })

  it("redacts new-format OpenAI keys (sk-proj-)", () => {
    const patterns = buildPatternSet({ builtin: ["openai_key"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const result = redactText("key: sk-proj-abcdefghij1234567890klmnopqr", patterns, session)
    assert.ok(!result.text.includes("sk-proj-abcdefghij1234567890klmnopqr"))
    assert.ok(result.text.includes("__VG_OPENAI_KEY_"))
  })

  it("does not false-positive phone_us on bare digit sequences", () => {
    const patterns = buildPatternSet({ builtin: ["phone_us"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    // Timestamp-like and ID-like digit strings should NOT match
    const result = redactText("timestamp: 1715000000000 and id: 9876543", patterns, session)
    assert.equal(result.matches.length, 0, "bare digits should not match phone_us")
  })
})

describe("redactTextWithAI (graceful fallback)", () => {
  // Stub that simulates AI being unavailable (returns no spans)
  const noopDetect = async () => []

  it("falls back to regex-only when AI returns no spans", async () => {
    const patterns = buildPatternSet({ builtin: ["email"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })

    const aiConfig = {
      enabled: true,
      model: "openai/privacy-filter",
      dtype: "q4",
      device: "cpu",
      categories: [],
      silentFallback: true,
    }

    const result = await redactTextWithAI(
      "Email alice@corp.io from Alice Smith",
      patterns,
      session,
      aiConfig,
      false,
      noopDetect // inject stub — avoids real model download
    )

    // Email should be redacted by regex even when AI is unavailable
    assert.ok(!result.text.includes("alice@corp.io"))
    assert.ok(result.text.includes("__VG_EMAIL_"))
    // "Alice Smith" won't be redacted without AI, which is expected fallback
    assert.ok(result.text.includes("Alice Smith"))
  })

  it("merges AI spans with regex spans", async () => {
    const patterns = buildPatternSet({ builtin: ["email"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })

    const aiConfig = {
      enabled: true,
      model: "openai/privacy-filter",
      dtype: "q4",
      device: "cpu",
      categories: [],
      silentFallback: true,
    }

    // Simulate AI detecting "Alice Smith" as a person name
    const input = "Email alice@corp.io from Alice Smith"
    const nameStart = input.indexOf("Alice Smith")
    const fakeDetect = async () => [
      { start: nameStart, end: nameStart + 11, original: "Alice Smith", category: "PRIVATE_PERSON" },
    ]

    const result = await redactTextWithAI(input, patterns, session, aiConfig, false, fakeDetect)

    assert.ok(!result.text.includes("alice@corp.io"), "email should be redacted by regex")
    assert.ok(!result.text.includes("Alice Smith"), "name should be redacted by AI")
    assert.ok(result.text.includes("__VG_EMAIL_"))
    assert.ok(result.text.includes("__VG_PRIVATE_PERSON_"))
  })

  it("handles empty text", async () => {
    const patterns = buildPatternSet({ builtin: ["email"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const aiConfig = { enabled: true, model: "openai/privacy-filter", dtype: "q4", device: "cpu", categories: [], silentFallback: true }

    const result = await redactTextWithAI("", patterns, session, aiConfig, false, noopDetect)
    assert.equal(result.text, "")
    assert.equal(result.matches.length, 0)
  })
})

describe("PlaceholderSession", () => {
  it("produces stable placeholders for same input", () => {
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const ph1 = session.getOrCreatePlaceholder("secret123", "API_KEY")
    const ph2 = session.getOrCreatePlaceholder("secret123", "API_KEY")
    assert.equal(ph1, ph2)
  })

  it("supports bidirectional lookup", () => {
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const ph = session.getOrCreatePlaceholder("myvalue", "TEXT")
    assert.equal(session.lookup(ph), "myvalue")
    assert.equal(session.lookupReverse("myvalue"), ph)
  })
})

describe("restoreText", () => {
  it("restores placeholders to original values", () => {
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const ph = session.getOrCreatePlaceholder("alice@corp.io", "EMAIL")
    const restored = restoreText(`Contact ${ph} for details`, session)
    assert.equal(restored, "Contact alice@corp.io for details")
  })

  it("leaves unknown placeholders unchanged", () => {
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const text = "Some __VG_UNKNOWN_abcdef012345__ here"
    const restored = restoreText(text, session)
    assert.equal(restored, text)
  })
})

describe("{{preserve:...}} bypass markers", () => {
  it("does not redact content inside {{preserve:...}}", () => {
    const patterns = buildPatternSet({ builtin: ["email", "github_token"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const input = "Check {{preserve:ghp_abc123def456abc123def456abc123def456ab}} now"
    const result = redactText(input, patterns, session)
    // Markers stripped, content preserved verbatim
    assert.ok(result.text.includes("ghp_abc123def456abc123def456abc123def456ab"), "protected content should not be redacted")
    assert.ok(!result.text.includes("{{preserve:"), "markers should be stripped")
    assert.equal(result.matches.length, 0)
  })

  it("still redacts unprotected content alongside protected content", () => {
    const patterns = buildPatternSet({ builtin: ["email", "github_token"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const input = "Safe: {{preserve:ghp_abc123def456abc123def456abc123def456ab}} Unsafe: user@example.org"
    const result = redactText(input, patterns, session)
    // Token is protected
    assert.ok(result.text.includes("ghp_abc123def456abc123def456abc123def456ab"))
    // Email is NOT protected — should be redacted
    assert.ok(!result.text.includes("user@example.org"), "unprotected email should be redacted")
    assert.ok(result.text.includes("__VG_EMAIL_"))
  })

  it("handles multiple bypass markers", () => {
    const patterns = buildPatternSet({ builtin: ["email"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const input = "A: {{preserve:a@b.com}} B: {{preserve:c@d.com}} C: x@y.com"
    const result = redactText(input, patterns, session)
    assert.ok(result.text.includes("a@b.com"), "first protected email preserved")
    assert.ok(result.text.includes("c@d.com"), "second protected email preserved")
    assert.ok(!result.text.includes("x@y.com"), "unprotected email redacted")
  })

  it("works with redactTextWithAI", async () => {
    const patterns = buildPatternSet({ builtin: ["email"] })
    const session = new PlaceholderSession({ prefix: "__VG_" })
    const aiConfig = { enabled: true, model: "test", dtype: "q4", device: "cpu", categories: [], silentFallback: true }
    // AI detects a span overlapping the protected zone — should be filtered
    const fakeDetect = async (text) => {
      const idx = text.indexOf("safe@keep.com")
      if (idx >= 0) return [{ start: idx, end: idx + 13, original: "safe@keep.com", category: "PRIVATE_EMAIL" }]
      return []
    }
    const input = "Keep {{preserve:safe@keep.com}} but redact other@leak.com"
    const result = await redactTextWithAI(input, patterns, session, aiConfig, false, fakeDetect)
    assert.ok(result.text.includes("safe@keep.com"), "AI-detected span in protected zone should be filtered")
    assert.ok(!result.text.includes("other@leak.com"), "unprotected email should be redacted")
  })
})

describe("config normalizeAiConfig", async () => {
  // Import config module to test normalization
  const { loadConfig } = await import("./config.js")
  const { writeFileSync, unlinkSync, mkdirSync } = await import("node:fs")
  const { join } = await import("node:path")

  it("defaults ai to disabled", async () => {
    // Create a minimal config with enabled=false to override the real one.
    // The env override is added to the candidate list but global config still
    // gets checked too, so we provide a real file that wins first.
    const tmpDir = `/tmp/vibeguard-test-${Date.now()}`
    mkdirSync(tmpDir, { recursive: true })
    const tmpCfg = join(tmpDir, "vibeguard.config.json")
    writeFileSync(tmpCfg, JSON.stringify({ enabled: false }), "utf8")

    const prev = process.env.OPENCODE_VIBEGUARD_CONFIG
    process.env.OPENCODE_VIBEGUARD_CONFIG = tmpCfg
    try {
      const cfg = await loadConfig(tmpDir)
      assert.equal(cfg.ai.enabled, false)
      assert.equal(cfg.ai.model, "openai/privacy-filter")
      assert.equal(cfg.ai.dtype, "q4")
      assert.equal(cfg.ai.device, "cpu")
      assert.equal(cfg.ai.silentFallback, true)
      assert.deepEqual(cfg.ai.categories, [])
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_VIBEGUARD_CONFIG
      else process.env.OPENCODE_VIBEGUARD_CONFIG = prev
      try { unlinkSync(tmpCfg) } catch {}
    }
  })
})
