#!/usr/bin/env node
/**
 * Generate realistic test secrets for AI model integration tests.
 *
 * These secrets are assembled at build time from random/fake components
 * so they never appear as literal strings in version-controlled source.
 * GitHub push protection scans source code, not runtime output.
 *
 * Output: test/.secrets.json (gitignored)
 *
 * The generated values are structurally valid (correct prefixes, lengths,
 * character sets) so the AI model recognizes them as real secrets — which
 * is the whole point of the integration tests.
 *
 * Usage:
 *   node scripts/generate-test-secrets.js
 *   # produces test/.secrets.json
 */

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const OUT_DIR = path.join(ROOT, "test")
const OUT_FILE = path.join(OUT_DIR, ".secrets.json")

// ---------------------------------------------------------------------------
// Generators — each produces a structurally valid but fake secret
// ---------------------------------------------------------------------------

/** Random string from a charset. */
function rand(len, charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") {
  const bytes = crypto.randomBytes(len)
  return Array.from(bytes, (b) => charset[b % charset.length]).join("")
}

/** GitHub Personal Access Token: ghp_ + 36 alphanum */
function makeGithubPAT() {
  return "ghp_" + rand(36)
}

/**
 * Stripe live secret key: sk_live_ + account ID + _ + random
 * Format: sk_live_<8 alphanum><14 mixed>00<8 alphanum>
 * Total length after prefix is ~50+ chars to look realistic.
 */
function makeStripeKey() {
  return "sk_live_" + rand(8) + rand(42)
}

/**
 * Slack incoming webhook URL.
 * Format: https://hooks.slack.com/services/T<9 alphanum>/B<9 alphanum>/<24 alphanum>
 */
function makeSlackWebhook() {
  return `https://hooks.slack.com/services/T${rand(9, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")}/B${rand(9, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")}/${rand(24)}`
}

/**
 * AWS secret access key: 40-char base64-ish string.
 * Uses the format from AWS docs but with random content.
 */
function makeAWSSecretKey() {
  // AWS secret keys are 40 chars, base64-alphabet + /
  return rand(40, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+")
}

/**
 * JWT (HS256 signed).
 * We build a real JWT structure so the AI recognizes the eyJ... pattern.
 */
function makeJWT() {
  const header = { alg: "HS256", typ: "JWT" }
  const payload = { sub: rand(10, "0123456789"), name: "Test User", iat: Math.floor(Date.now() / 1000) }
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url")
  const unsigned = b64url(header) + "." + b64url(payload)
  // Fake signature — 32 random bytes, base64url-encoded
  const sig = crypto.randomBytes(32).toString("base64url")
  return unsigned + "." + sig
}

/**
 * JDBC password: mix of printable ASCII (special chars make it harder for regex).
 */
function makeJDBCPassword() {
  return rand(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*")
}

/**
 * MongoDB password: alphanumeric with mixed case.
 */
function makeMongoPassword() {
  return rand(12)
}

// ---------------------------------------------------------------------------
// Build fixture
// ---------------------------------------------------------------------------

const secrets = {
  github_pat: makeGithubPAT(),
  stripe_key: makeStripeKey(),
  slack_webhook: makeSlackWebhook(),
  aws_secret_key: makeAWSSecretKey(),
  jwt: makeJWT(),
  jdbc_password: makeJDBCPassword(),
  mongo_password: makeMongoPassword(),
}

// Build the full text snippets the tests will use
const fixtures = {
  ...secrets,
  // Full text strings ready for detect() calls
  jdbc_text: `app.datasource.url=jdbc:postgresql://db.internal:5432/mydb?user=svc_account&password=${secrets.jdbc_password}`,
  mongo_text: `const client = new MongoClient("mongodb://admin:${secrets.mongo_password}@cluster0.abc123.mongodb.net/prod?retryWrites=true")`,
  github_text: `const config = { token: "${secrets.github_pat}" }`,
  slack_text: `Post deploy notifications to ${secrets.slack_webhook}`,
  aws_text: `export AWS_SECRET_ACCESS_KEY="${secrets.aws_secret_key}"`,
  jwt_text: `headers: { "Authorization": "Bearer ${secrets.jwt}" }`,
  stripe_text: JSON.stringify({
    payment: {
      provider: "stripe",
      secret: secrets.stripe_key,
    },
  }, null, 2),
}

// Write output
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(OUT_FILE, JSON.stringify(fixtures, null, 2) + "\n", "utf8")

console.log(`Generated ${Object.keys(secrets).length} test secrets → ${OUT_FILE}`)
