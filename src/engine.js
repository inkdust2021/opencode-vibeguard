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
 * 对输入文本进行脱敏替换，返回替换后的文本与命中信息。
 * 设计与 VibeGuard 的 redact 引擎一致：处理重叠命中，确保不会把占位符切碎。
 * @param {string} input
 * @param {{ keywords: Array<{value:string,category:string}>, regex: Array<{pattern:string,flags:string,category:string}>, exclude: Set<string> }} patterns
 * @param {{ getOrCreatePlaceholder(original: string, category: string): string }} session
 */
export function redactText(input, patterns, session) {
  const text = String(input ?? "")
  if (!text) return { text, matches: [] }

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
    const baseFlags = String(rule.flags ?? "")
    const flags = baseFlags.includes("g") ? baseFlags : `${baseFlags}g`
    const re = new RegExp(rule.pattern, flags)
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

  if (found.length === 0) return { text, matches: [] }

  // 右侧优先；同起点优先更长，便于把左侧大范围命中拆掉
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

