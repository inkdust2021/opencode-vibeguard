// ai-detect.js is imported lazily in redactTextWithAI() to avoid pulling in
// Transformers.js infrastructure when AI detection is disabled.
let _detectWithAI = null

// ---------------------------------------------------------------------------
// {{preserve:...}} bypass markers
// ---------------------------------------------------------------------------
const PRESERVE_RE = /\{\{preserve:([\s\S]*?)\}\}/g

/**
 * Strip {{preserve:...}} markers from text and return protected character ranges.
 * The inner content is kept verbatim; only the markers are removed.
 * Returns { text: strippedText, protectedRanges: [{start, end}] }
 */
function stripProtectedZones(input) {
  const protectedRanges = []
  let out = ""
  let lastEnd = 0
  let offset = 0 // tracks how much shorter `out` is vs `input`

  PRESERVE_RE.lastIndex = 0
  for (const m of input.matchAll(PRESERVE_RE)) {
    const matchStart = m.index
    const inner = m[1]
    // Copy text before this marker
    out += input.slice(lastEnd, matchStart)
    // The inner content starts at this position in the output
    const innerStart = out.length
    out += inner
    const innerEnd = out.length
    protectedRanges.push({ start: innerStart, end: innerEnd })
    lastEnd = matchStart + m[0].length
  }
  out += input.slice(lastEnd)

  return { text: out, protectedRanges }
}

/**
 * Check if a span overlaps any protected range.
 */
function isProtected(span, protectedRanges) {
  for (const zone of protectedRanges) {
    // Any overlap means protected
    if (span.start < zone.end && span.end > zone.start) return true
    if (zone.start >= span.end) break // ranges are sorted
  }
  return false
}

function subtractCovered(start, end, covered) {
  if (start >= end) return []
  const out = []
  let cur = start
  for (const c of covered) {
    if (c.end <= cur) continue
    if (c.start >= end) break
    if (c.start > cur) out.push({ start: cur, end: Math.min(c.start, end) })
    if (c.end >= end) {
      cur = end
      break
    }
    cur = Math.max(cur, c.end)
  }
  if (cur < end) out.push({ start: cur, end })
  return out
}

function insertCovered(covered, span) {
  if (span.start >= span.end) return covered
  let i = 0
  for (; i < covered.length; i++) {
    if (covered[i].start > span.start) break
  }
  covered.splice(i, 0, span)
  if (covered.length <= 1) return covered

  const merged = []
  for (const c of covered) {
    const last = merged.at(-1)
    if (!last) {
      merged.push(c)
      continue
    }
    if (c.start <= last.end) {
      if (c.end > last.end) last.end = c.end
      continue
    }
    merged.push(c)
  }
  return merged
}

/**
 * Collect regex/keyword spans from the given text (synchronous, fast).
 * Shared by both redactText and redactTextWithAI.
 */
function findRegexSpans(text, patterns) {
  const found = []

  for (const rule of patterns.keywords) {
    const needle = rule.value
    if (!needle) continue
    let idx = 0
    for (;;) {
      const pos = text.indexOf(needle, idx)
      if (pos === -1) break
      const start = pos
      const end = pos + needle.length
      const original = text.slice(start, end)
      idx = end
      if (patterns.exclude.has(original)) continue
      found.push({ start, end, original, category: rule.category })
    }
  }

  for (const rule of patterns.regex) {
    // Use pre-compiled regex if available, otherwise compile on the fly
    const re = rule.compiled
      ? (rule.compiled.lastIndex = 0, rule.compiled)
      : new RegExp(rule.pattern, (rule.flags ?? "").includes("g") ? rule.flags : `${rule.flags ?? ""}g`)
    for (const m of text.matchAll(re)) {
      if (!m[0]) continue
      const start = m.index ?? -1
      if (start < 0) continue
      const end = start + m[0].length
      const original = text.slice(start, end)
      if (patterns.exclude.has(original)) continue
      found.push({ start, end, original, category: rule.category })
    }
  }

  return found
}

/**
 * Given a set of found spans, resolve overlaps and apply placeholder replacements.
 * Shared by both sync and async redaction paths.
 */
function applySpans(text, found, session) {
  if (found.length === 0) return { text, matches: [] }

  // Right-first; same start -> prefer longer span
  found.sort((a, b) => {
    if (a.start !== b.start) return b.start - a.start
    return b.end - a.end
  })

  const planned = []
  let covered = []
  for (const m of found) {
    const segments = subtractCovered(m.start, m.end, covered)
    for (const seg of segments) {
      if (seg.start < 0 || seg.end > text.length || seg.start >= seg.end) continue
      planned.push({
        start: seg.start,
        end: seg.end,
        original: text.slice(seg.start, seg.end),
        category: m.category,
      })
      covered = insertCovered(covered, seg)
    }
  }

  planned.sort((a, b) => b.start - a.start)

  let out = text
  for (const m of planned) {
    const placeholder = session.getOrCreatePlaceholder(m.original, m.category)
    out = out.slice(0, m.start) + placeholder + out.slice(m.end)
    m.placeholder = placeholder
  }

  return { text: out, matches: planned }
}

/**
 * Redact text using regex/keyword patterns only (synchronous, fast).
 * Supports {{preserve:...}} bypass markers — wrapped content is never redacted.
 * Returns { text, matches }.
 */
export function redactText(input, patterns, session) {
  const raw = String(input ?? "")
  if (!raw) return { text: raw, matches: [] }

  // Strip bypass markers and get protected zones
  const { text, protectedRanges } = stripProtectedZones(raw)
  if (!text) return { text, matches: [] }

  let found = findRegexSpans(text, patterns)

  // Filter out spans that overlap protected zones
  if (protectedRanges.length > 0) {
    found = found.filter((span) => !isProtected(span, protectedRanges))
  }

  return applySpans(text, found, session)
}

/**
 * Redact text using both regex/keyword patterns AND the AI Privacy Filter.
 * Async because the AI inference is async. The hook awaits this before
 * proceeding, so redaction is guaranteed complete before the LLM sees the text.
 * Supports {{preserve:...}} bypass markers — wrapped content is never redacted.
 *
 * @param {string} input
 * @param {object} patterns
 * @param {object} session
 * @param {object} aiConfig
 * @param {boolean} debug
 * @param {Function} [_detectFn] - Optional override for detectWithAI (testing only)
 */
export async function redactTextWithAI(input, patterns, session, aiConfig, debug, _detectFn) {
  const raw = String(input ?? "")
  if (!raw) return { text: raw, matches: [] }

  // Strip bypass markers and get protected zones
  const { text, protectedRanges } = stripProtectedZones(raw)
  if (!text) return { text, matches: [] }

  // 1. Regex/keyword detection (fast, synchronous)
  let found = findRegexSpans(text, patterns)

  // 2. AI-based detection (async, local model inference)
  const detect = _detectFn ?? await getDetectWithAI()
  const aiSpans = await detect(text, aiConfig, debug)
  for (const span of aiSpans) {
    if (patterns.exclude.has(span.original)) continue
    found.push(span)
  }

  // 3. Filter out spans that overlap protected zones
  if (protectedRanges.length > 0) {
    found = found.filter((span) => !isProtected(span, protectedRanges))
  }

  return applySpans(text, found, session)
}

/** Lazily resolve the real detectWithAI function from ai-detect.js */
async function getDetectWithAI() {
  if (!_detectWithAI) {
    const mod = await import("./ai-detect.js")
    _detectWithAI = mod.detectWithAI
  }
  return _detectWithAI
}
