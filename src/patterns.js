import { sanitizeCategory } from "./util.js"

/**
 * 将 Go 风格的 `(?i)` / `(?m)` 前缀做一个轻量兼容（仅处理“开头连续出现”的情况）。
 * @param {string} pattern
 * @param {string} flags
 */
function peelInlineFlags(pattern, flags) {
  let p = String(pattern ?? "")
  let f = String(flags ?? "")

  for (;;) {
    if (p.startsWith("(?i)")) {
      p = p.slice(4)
      if (!f.includes("i")) f += "i"
      continue
    }
    if (p.startsWith("(?m)")) {
      p = p.slice(4)
      if (!f.includes("m")) f += "m"
      continue
    }
    break
  }

  return { pattern: p, flags: f }
}

/**
 * Builtin detection rules (ported from VibeGuard with JS compatibility).
 * Goal: low config cost + broad coverage, not 100% precision.
 */
const BUILTIN = new Map([
  [
    "email",
    {
      pattern: String.raw`[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}`,
      flags: "i",
      category: "EMAIL",
    },
  ],
  [
    "china_phone",
    {
      pattern: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`,
      flags: "",
      category: "CHINA_PHONE",
    },
  ],
  [
    "china_id",
    {
      pattern: String.raw`(?<!\d)\d{17}[\dXx](?!\d)`,
      flags: "",
      category: "CHINA_ID",
    },
  ],
  [
    "uuid",
    {
      pattern: String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}`,
      flags: "",
      category: "UUID",
    },
  ],
  [
    "ipv4",
    {
      pattern: String.raw`(?:\d{1,3}\.){3}\d{1,3}`,
      flags: "",
      category: "IPV4",
    },
  ],
  [
    "mac",
    {
      pattern: String.raw`(?:[0-9a-f]{2}:){5}[0-9a-f]{2}`,
      flags: "i",
      category: "MAC",
    },
  ],
  // --- Additional builtins ---
  [
    "phone_us",
    {
      // US phone: (555) 123-4567, 555-123-4567, +1-555-123-4567
      // Requires at least one separator or parenthesized area code to avoid matching bare digit sequences
      pattern: String.raw`(?<!\d)(?:\+?1[-.\s])?\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)|(?<!\d)(?:\+?1[-.\s])?\d{3}[-.\s]\d{3}[-.\s]?\d{4}(?!\d)`,
      flags: "",
      category: "PHONE_US",
    },
  ],
  [
    "phone_intl",
    {
      // International: +44 20 7946 0958, +49-30-1234567, +33 1 23 45 67 89
      // Requires + prefix, country code 1-3 digits, then 7-14 additional digits with separators
      // Must contain at least one separator to avoid matching arbitrary digit strings
      pattern: String.raw`(?<!\d)\+[1-9]\d{0,2}[-.\s]\d(?:[-.\s]?\d){6,13}(?!\d)`,
      flags: "",
      category: "PHONE_INTL",
    },
  ],
  [
    "ssn",
    {
      // US Social Security Number: 123-45-6789
      pattern: String.raw`(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)`,
      flags: "",
      category: "SSN",
    },
  ],
  [
    "credit_card",
    {
      // Visa (4xxx), MC (51-55xx), Discover (6011/65xx): 16 digits with optional separators
      // Amex (34xx/37xx): 15 digits (4-6-5 grouping)
      pattern: String.raw`(?<!\d)(?:(?:4\d{3}|5[1-5]\d{2}|6(?:011|5\d{2}))[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}|3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5})(?!\d)`,
      flags: "",
      category: "CREDIT_CARD",
    },
  ],
  [
    "openai_key",
    {
      // OpenAI API keys: legacy sk-...T3BlbkFJ... and new sk-proj-... formats
      pattern: String.raw`sk-(?:proj-)?[A-Za-z0-9_-]{20,}`,
      flags: "",
      category: "OPENAI_KEY",
    },
  ],
  [
    "github_token",
    {
      pattern: String.raw`(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}`,
      flags: "",
      category: "GITHUB_TOKEN",
    },
  ],
  [
    "aws_access_key",
    {
      pattern: String.raw`AKIA[0-9A-Z]{16}`,
      flags: "",
      category: "AWS_ACCESS_KEY",
    },
  ],
  [
    "vault_token",
    {
      // HashiCorp Vault tokens: hvs.xxxxx or s.xxxxx
      pattern: String.raw`(?:hvs|s)\.[A-Za-z0-9]{24,}`,
      flags: "",
      category: "VAULT_TOKEN",
    },
  ],
  [
    "private_key_header",
    {
      pattern: String.raw`-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`,
      flags: "",
      category: "PRIVATE_KEY",
    },
  ],
  [
    "generic_bearer",
    {
      // Bearer tokens in Authorization headers
      pattern: String.raw`Bearer\s+[A-Za-z0-9\-._~+/]+=*`,
      flags: "i",
      category: "BEARER_TOKEN",
    },
  ],
  [
    "npm_token",
    {
      // npm access tokens: npm_XXXXXXXXXXXXXXXXXXXX (36+ alphanumeric)
      pattern: String.raw`npm_[A-Za-z0-9]{36,}`,
      flags: "",
      category: "NPM_TOKEN",
    },
  ],
  [
    "stripe_key",
    {
      // Stripe secret/publishable keys: sk_live_*, pk_live_*, sk_test_*, pk_test_*
      pattern: String.raw`[sp]k_(?:live|test)_[A-Za-z0-9]{20,}`,
      flags: "",
      category: "STRIPE_KEY",
    },
  ],
  [
    "slack_webhook",
    {
      // Slack incoming webhook URLs
      pattern: String.raw`https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+`,
      flags: "",
      category: "SLACK_WEBHOOK",
    },
  ],
  [
    "slack_token",
    {
      // Slack bot/user tokens: xoxb-*, xoxp-*, xoxs-*
      pattern: String.raw`xox[bps]-[0-9]+-[A-Za-z0-9-]+`,
      flags: "",
      category: "SLACK_TOKEN",
    },
  ],
])

export function buildPatternSet(patterns) {
  const raw = patterns && typeof patterns === "object" ? patterns : {}

  const keywords = Array.isArray(raw.keywords) ? raw.keywords : []
  const regex = Array.isArray(raw.regex) ? raw.regex : []
  const builtin = Array.isArray(raw.builtin) ? raw.builtin : []
  const exclude = Array.isArray(raw.exclude) ? raw.exclude : []

  const keywordRules = keywords
    .map((x) => {
      if (!x || typeof x !== "object") return null
      const value = String(x.value ?? "").trim()
      if (!value) return null
      const category = sanitizeCategory(x.category)
      return { value, category }
    })
    .filter(Boolean)

  const regexRules = []

  for (const x of regex) {
    if (!x || typeof x !== "object") continue
    const pattern = String(x.pattern ?? "").trim()
    if (!pattern) continue
    const category = sanitizeCategory(x.category)
    const flags = typeof x.flags === "string" ? x.flags : ""
    const peeled = peelInlineFlags(pattern, flags)
    const globalFlags = peeled.flags.includes("g") ? peeled.flags : `${peeled.flags}g`
    regexRules.push({
      pattern: peeled.pattern,
      flags: peeled.flags,
      category,
      compiled: new RegExp(peeled.pattern, globalFlags),
    })
  }

  for (const name of builtin) {
    const key = String(name ?? "").trim()
    if (!key) continue
    const rule = BUILTIN.get(key)
    if (!rule) continue
    const globalFlags = rule.flags.includes("g") ? rule.flags : `${rule.flags}g`
    regexRules.push({
      pattern: rule.pattern,
      flags: rule.flags,
      category: rule.category,
      compiled: new RegExp(rule.pattern, globalFlags),
    })
  }

  const excludeSet = new Set(exclude.map((x) => String(x ?? "")))

  return {
    keywords: keywordRules,
    regex: regexRules,
    exclude: excludeSet,
  }
}

