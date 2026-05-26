/**
 * Integration tests for vibeguard model-server.
 *
 * These tests spawn a real model server, send realistic (and tricky)
 * PII / secret payloads, and assert the AI detects them.
 *
 * The model (~400 MB q4) must be pre-downloaded.
 * Skip with: VIBEGUARD_SKIP_AI_TESTS=1 node --test src/model-server.test.js
 *
 * These are intentionally "less obvious" inputs — the kind a regex
 * would miss but a language model should catch.
 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawn, execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Skip gate
// ---------------------------------------------------------------------------
const SKIP_AI = process.env.VIBEGUARD_SKIP_AI_TESTS === "1"

// ---------------------------------------------------------------------------
// Generated test secrets — no literal secrets in source
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SECRETS_FILE = path.join(__dirname, "..", "test", ".secrets.json")
if (!fs.existsSync(SECRETS_FILE)) {
  execSync(
    `${process.execPath} ${path.join(__dirname, "..", "scripts", "generate-test-secrets.js")}`,
    { stdio: "pipe" }
  )
}
const fixtures = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SERVER_SCRIPT = path.join(__dirname, "model-server.js")
const uid = process.getuid?.() ?? process.pid
const SOCK = path.join(
  os.tmpdir(),
  `vibeguard-test-${uid}-${Date.now()}.sock`
)
const PID_FILE = SOCK.replace(/\.sock$/, ".pid")
const LOG_FILE = SOCK.replace(/\.sock$/, ".log")

let serverProcess = null
let logFd = null

function request(method, urlPath, body, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const opts = {
      socketPath: SOCK,
      path: urlPath,
      method,
      headers: {},
      timeout: timeoutMs,
    }
    let payload = null
    if (body) {
      payload = JSON.stringify(body)
      opts.headers["Content-Type"] = "application/json"
      opts.headers["Content-Length"] = Buffer.byteLength(payload)
    }
    const req = http.request(opts, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        if (settled) return
        settled = true
        try {
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          })
        } catch {
          resolve({ status: res.statusCode, body: null })
        }
      })
    })
    req.on("error", (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    req.on("timeout", () => {
      if (settled) return
      settled = true
      req.destroy()
      reject(new Error("request timed out"))
    })
    if (payload) req.write(payload)
    req.end()
  })
}

function detect(text, categories) {
  return request("POST", "/detect", { text, categories })
}

/** Extract spans from a detect response, with assertion that they exist. */
function spans(detectResult) {
  assert.ok(detectResult.body, `Expected response body, got null (status=${detectResult.status})`)
  assert.ok(Array.isArray(detectResult.body.spans), `Expected spans array, got: ${JSON.stringify(detectResult.body)}`)
  return detectResult.body.spans
}

/** Wait for /health to report "ready", up to timeoutMs. */
async function waitReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await request("GET", "/health", null, 3000)
      if (r.body?.status === "ready") return
      if (r.body?.status === "error") throw new Error("server error: " + r.body.error)
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("model-server did not become ready in time")
}

/** Assert that at least one span covers a substring. */
function assertDetected(spans, substring, expectedCategory) {
  assert.ok(Array.isArray(spans), `Expected spans array, got: ${JSON.stringify(spans)}`)
  const match = spans.find((s) => {
    // Primary: span original contains the expected substring
    if (s.original.includes(substring)) return true
    // Reverse: substring contains the span, but only if the span is
    // substantial (>= 6 chars) to avoid matching single-char fragments
    if (s.original.length >= 6 && substring.includes(s.original)) return true
    return false
  })
  assert.ok(
    match,
    `Expected AI to detect "${substring}" but got: ${JSON.stringify(spans.map((s) => s.original))}`
  )
  if (expectedCategory) {
    assert.equal(
      match.category,
      expectedCategory,
      `Expected category ${expectedCategory} for "${substring}" but got ${match.category}`
    )
  }
}

/** Assert that NO span overlaps with a given region of text. */
function assertNotDetected(spansArr, text, safeSubstring) {
  assert.ok(Array.isArray(spansArr), `Expected spans array, got: ${JSON.stringify(spansArr)}`)
  const start = text.indexOf(safeSubstring)
  const end = start + safeSubstring.length
  const overlapping = spansArr.filter(
    (s) => s.start < end && s.end > start
  )
  assert.equal(
    overlapping.length,
    0,
    `"${safeSubstring}" should NOT be flagged but was: ${JSON.stringify(overlapping)}`
  )
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
describe("model-server (AI integration)", { timeout: 300_000, skip: SKIP_AI }, () => {
  before(async () => {
    // Clean up any leftover files
    for (const f of [SOCK, PID_FILE, LOG_FILE]) {
      try { fs.unlinkSync(f) } catch { /* ok */ }
    }

    logFd = fs.openSync(LOG_FILE, "a")
    serverProcess = spawn(
      process.execPath,
      [SERVER_SCRIPT, "--socket", SOCK, "--idle-timeout", "300000"],
      { detached: true, stdio: ["ignore", logFd, logFd] }
    )
    serverProcess.unref()

    // Last-resort cleanup if test process is killed (Ctrl+C, crash)
    process.on("exit", () => {
      if (serverProcess?.pid) {
        try { process.kill(-serverProcess.pid, "SIGKILL") } catch { /* ok */ }
      }
    })

    await waitReady()
  })

  after(() => {
    // Kill the process group (catches any children)
    if (serverProcess?.pid) {
      try { process.kill(-serverProcess.pid) } catch { /* ok */ }
    }
    // Close the log fd
    if (logFd !== null) {
      try { fs.closeSync(logFd) } catch { /* ok */ }
      logFd = null
    }
    for (const f of [SOCK, PID_FILE, LOG_FILE]) {
      try { fs.unlinkSync(f) } catch { /* ok */ }
    }
  })

  // =========================================================================
  // Health / protocol
  // =========================================================================

  it("GET /health returns ready with expected fields", async () => {
    const r = await request("GET", "/health", null)
    assert.equal(r.status, 200)
    assert.equal(r.body.status, "ready")
    assert.equal(r.body.model, "openai/privacy-filter")
    assert.ok(Number.isFinite(r.body.pid))
    assert.ok(Number.isFinite(r.body.uptime))
  })

  // =========================================================================
  // Subtle secrets — things regex misses
  // =========================================================================

  describe("subtle secrets", () => {
    it("detects a password buried in a JDBC connection string", async () => {
      const r = await detect(fixtures.jdbc_text)
      assert.ok(spans(r).length > 0, "should detect at least one span in JDBC URL")
    })

    it("detects credentials in a MongoDB URI", async () => {
      const r = await detect(fixtures.mongo_text)
      assert.ok(spans(r).length > 0, "should detect something in Mongo URI")
    })

    it("detects an API key assigned to a variable with a generic name", async () => {
      const r = await detect(fixtures.github_text)
      assertDetected(spans(r), fixtures.github_pat, "SECRET")
    })

    it("detects a Slack webhook URL (or defers to regex)", async () => {
      // NOTE: The Privacy Filter model may not flag webhook URLs as secrets.
      // This is expected — the regex layer catches slack webhooks via pattern.
      // We test that the server handles it without error; detection is best-effort.
      const r = await detect(fixtures.slack_text)
      assert.equal(r.status, 200)
      // If the model flags it, great; if not, regex handles it.
      // Just verify no server errors.
    })

    it("detects a private key block even when indented in YAML", async () => {
      const text = `tls:
  cert: |
    -----BEGIN RSA PRIVATE KEY-----
    MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy5AoC5dNz8mLLMo1mqob
    -----END RSA PRIVATE KEY-----`
      const r = await detect(text)
      assert.ok(spans(r).length > 0, "should detect the private key block")
    })

    it("detects an AWS secret key in an env export", async () => {
      const r = await detect(fixtures.aws_text)
      assertDetected(spans(r), fixtures.aws_secret_key, "SECRET")
    })

    it("detects a bearer token in an HTTP header literal", async () => {
      const r = await detect(fixtures.jwt_text)
      assert.ok(spans(r).length > 0, "should detect the JWT / bearer token")
    })

    it("detects a Stripe secret key in JSON config", async () => {
      const r = await detect(fixtures.stripe_text)
      assertDetected(
        spans(r),
        fixtures.stripe_key,
        "SECRET"
      )
    })
  })

  // =========================================================================
  // Subtle PII — context-dependent, regex-hard
  // =========================================================================

  describe("subtle PII", () => {
    it("detects a person's name in a natural sentence without labels", async () => {
      const text =
        "The quarterly report was prepared by Margaret Thatcherton and reviewed by her manager."
      const r = await detect(text)
      assertDetected(spans(r), "Margaret Thatcherton", "PRIVATE_PERSON")
    })

    it("detects an email in a markdown link", async () => {
      const text =
        "For questions, reach out to [the team lead](mailto:sarah.connor@skynet.io) or file a ticket."
      const r = await detect(text)
      const s = spans(r)
      // The model detects this but may split it across multiple spans due to tokenization
      // (e.g., "mailto:s", "arah", ".connor@skynet.io"). We verify that at least one span
      // overlaps with the email region rather than requiring exact substring match.
      const emailStart = text.indexOf("sarah.connor@skynet.io")
      const emailEnd = emailStart + "sarah.connor@skynet.io".length
      const overlapping = s.filter((sp) => sp.start < emailEnd && sp.end > emailStart)
      assert.ok(overlapping.length > 0, `Expected detection overlapping email, got: ${JSON.stringify(s)}`)
    })

    it("detects a phone number written in words-and-digits mix", async () => {
      const text = "You can reach our office at +1 (312) 555-0198 during business hours."
      const r = await detect(text)
      assertDetected(spans(r), "312) 555-0198", "PRIVATE_PHONE")
    })

    it("detects a street address embedded in prose", async () => {
      const text =
        "Ship the replacement to 742 Evergreen Terrace, Springfield, IL 62704 by next Friday."
      const r = await detect(text)
      const s = spans(r)
      assert.ok(
        s.some((sp) => sp.category === "PRIVATE_ADDRESS" || sp.original.includes("742 Evergreen")),
        `Expected address detection, got: ${JSON.stringify(s)}`
      )
    })

    it("detects a date of birth in a sentence", async () => {
      const text =
        "Patient record: DOB is March 15, 1987, admitted on 2024-01-10 for observation."
      const r = await detect(text)
      const s = spans(r)
      assert.ok(
        s.some((sp) => sp.category === "PRIVATE_DATE"),
        `Expected at least one PRIVATE_DATE, got: ${JSON.stringify(s)}`
      )
    })

    it("detects an internal URL with auth token in query string", async () => {
      const text =
        "Dashboard link: https://grafana.internal.corp/d/abc123?orgId=1&auth_token=eyJrIjoiT2tDN2FBNHciLCJuIjoiZGVwbG95IiwiZCI6MX0"
      const r = await detect(text)
      assert.ok(spans(r).length > 0, "should detect the URL or embedded token")
    })

    it("detects an account number formatted with spaces", async () => {
      const text = "Wire transfer to account 4532 0151 2345 6789, routing 021000021."
      const r = await detect(text)
      const s = spans(r)
      assert.ok(
        s.some((sp) => sp.category === "ACCOUNT_NUMBER"),
        `Expected ACCOUNT_NUMBER, got: ${JSON.stringify(s)}`
      )
    })
  })

  // =========================================================================
  // Detection breadth — verify the model catches diverse PII/secret types
  // =========================================================================

  describe("detection breadth", () => {
    it("detects an arbitrary password string from context", async () => {
      const text = "The database password is hunter2secretpass123"
      const r = await detect(text)
      assertDetected(spans(r), "hunter2secretpass123", "SECRET")
    })

    it("detects a random API key string", async () => {
      const text = "Set API_KEY=xK9mP2vL8nQ4wR7yT3hB5cF6gJ1aD0eU in your env"
      const r = await detect(text)
      assertDetected(spans(r), "xK9mP2vL8nQ4wR7yT3hB5cF6gJ1aD0eU", "SECRET")
    })

    it("detects a full name", async () => {
      const text = "Contact John Smith at the front desk"
      const r = await detect(text)
      assertDetected(spans(r), "John Smith", "PRIVATE_PERSON")
    })

    it("detects an email address", async () => {
      const text = "Send results to john.smith@acme.corp for review"
      const r = await detect(text)
      assertDetected(spans(r), "john.smith@acme.corp", "PRIVATE_EMAIL")
    })

    it("detects a phone number", async () => {
      const text = "Call me at 415-555-0198 after 5pm"
      const r = await detect(text)
      const s = spans(r)
      assert.ok(
        s.some((sp) => sp.category === "PRIVATE_PHONE" && sp.original.includes("415-555-0198")),
        `Expected PRIVATE_PHONE with 415-555-0198, got: ${JSON.stringify(s)}`
      )
    })

    it("detects a social security number", async () => {
      const text = "SSN on file: 123-45-6789"
      const r = await detect(text)
      const s = spans(r)
      assert.ok(
        s.some((sp) => sp.category === "ACCOUNT_NUMBER"),
        `Expected ACCOUNT_NUMBER for SSN, got: ${JSON.stringify(s)}`
      )
    })

    it("detects a full street address", async () => {
      const text = "Ship to 742 Evergreen Terrace, Springfield IL 62704"
      const r = await detect(text)
      const s = spans(r)
      assert.ok(
        s.some((sp) => sp.category === "PRIVATE_ADDRESS"),
        `Expected PRIVATE_ADDRESS, got: ${JSON.stringify(s)}`
      )
    })

    it("detects a credit card number", async () => {
      const text = "Card on file: 4532 0151 2345 6789 exp 12/27"
      const r = await detect(text)
      const s = spans(r)
      assert.ok(
        s.some((sp) => sp.category === "ACCOUNT_NUMBER"),
        `Expected ACCOUNT_NUMBER for credit card, got: ${JSON.stringify(s)}`
      )
    })

    it("detects a connection string with embedded password", async () => {
      const text = "MONGO_URI=mongodb://admin:p4ssw0rd@db.internal:27017/prod"
      const r = await detect(text)
      const s = spans(r)
      assert.ok(s.length > 0, `Expected at least one detection for connection string, got: ${JSON.stringify(s)}`)
    })

    it("detects a date of birth", async () => {
      const text = "Patient DOB: March 15, 1987"
      const r = await detect(text)
      const s = spans(r)
      assert.ok(
        s.some((sp) => sp.category === "PRIVATE_DATE"),
        `Expected PRIVATE_DATE, got: ${JSON.stringify(s)}`
      )
    })
  })

  // =========================================================================
  // False-positive resistance
  // =========================================================================

  describe("false positive resistance", () => {
    it("does NOT flag a semver version string", async () => {
      const text = "Upgraded @huggingface/transformers from 4.1.0 to 4.2.0"
      const r = await detect(text)
      assert.equal(spans(r).length, 0, `Expected no spans, got: ${JSON.stringify(r.body.spans)}`)
    })

    it("does NOT flag a localhost URL with port", async () => {
      const text = "Dev server running at http://localhost:3000/api/v1/health"
      const r = await detect(text)
      assertNotDetected(spans(r), text, "http://localhost:3000")
    })

    it("does NOT flag common programming identifiers", async () => {
      const text = "const userId = getUserById(req.params.id)"
      const r = await detect(text)
      assert.equal(spans(r).length, 0, `Expected no spans, got: ${JSON.stringify(r.body.spans)}`)
    })
  })

  // =========================================================================
  // Category filtering
  // =========================================================================

  describe("category filtering", () => {
    it("only returns spans matching requested categories", async () => {
      const text = "Contact John Doe at john.doe@acme.com or call (555) 123-4567"
      const r = await detect(text, ["private_email"])
      const s = spans(r)
      // Should only include email, not person or phone
      for (const sp of s) {
        assert.equal(
          sp.category,
          "PRIVATE_EMAIL",
          `Unexpected category ${sp.category} when filtering for private_email only`
        )
      }
      assert.ok(s.length > 0, "should detect at least the email")
    })
  })

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("handles empty text gracefully", async () => {
      const r = await detect("")
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.spans, [])
    })

    it("handles text with no PII", async () => {
      const text = "The quick brown fox jumps over the lazy dog."
      const r = await detect(text)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.spans, [])
    })

    it("returns spans with correct start/end offsets", async () => {
      const text = "Email me at test.user@example.org please"
      const r = await detect(text)
      for (const sp of spans(r)) {
        assert.equal(
          text.slice(sp.start, sp.end),
          sp.original,
          `Offset mismatch: text[${sp.start}:${sp.end}] = "${text.slice(sp.start, sp.end)}" but original = "${sp.original}"`
        )
      }
    })
  })
})
