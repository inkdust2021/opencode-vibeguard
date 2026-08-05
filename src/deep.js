import { compilePolicy } from "flare-redact"

import { restoreText } from "./restore.js"

const deepRedactors = new WeakMap()

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildDetectors(patterns) {
  const detectors = []
  const categories = new Map()

  for (const [index, rule] of patterns.keywords.entries()) {
    const id = `vibeguard_keyword_${index}`
    detectors.push({
      id,
      label: rule.category,
      why: "Configured VibeGuard keyword.",
      pattern: new RegExp(escapeRegExp(rule.value), "g"),
      default: false,
      risk: "critical",
    })
    categories.set(id, rule.category)
  }

  for (const [index, rule] of patterns.regex.entries()) {
    const id = `vibeguard_regex_${index}`
    detectors.push({
      id,
      label: rule.category,
      why: "Configured VibeGuard regular expression.",
      pattern: new RegExp(rule.pattern, rule.flags),
      default: false,
      risk: "critical",
    })
    categories.set(id, rule.category)
  }

  return { detectors, categories }
}

function getDeepRedactor(patterns, session) {
  const cached = deepRedactors.get(session)
  if (cached) return cached

  const { detectors, categories } = buildDetectors(patterns)
  if (detectors.length === 0) {
    const noop = (value) => ({ value, matches: 0 })
    deepRedactors.set(session, noop)
    return noop
  }

  let matches = 0
  const policy = compilePolicy({
    custom: detectors,
    only: detectors.map((detector) => detector.id),
    allow: [...patterns.exclude],
    redactKeys: false,
    mask: ({ value, detector }) => {
      matches++
      return session.getOrCreatePlaceholder(value, categories.get(detector.id))
    },
  })

  const redact = (value) => {
    matches = 0
    const redacted = policy.redact(value)
    return { value: redacted, matches }
  }

  deepRedactors.set(session, redact)
  return redact
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 深度遍历工具参数对象，把所有字符串里的占位符还原为原值（原地修改）。
 * - 只遍历 Array / PlainObject
 * - 使用 WeakSet 避免循环引用导致爆栈
 * @param {unknown} value
 * @param {{ prefix: string, lookup(ph: string): string | undefined }} session
 */
export function restoreDeep(value, session) {
  const seen = new WeakSet()

  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i]
        if (typeof v === "string") node[i] = restoreText(v, session)
        if (v && typeof v === "object") walk(v)
      }
      return
    }

    if (!isPlainObject(node)) return

    for (const key of Object.keys(node)) {
      const v = node[key]
      if (typeof v === "string") node[key] = restoreText(v, session)
      if (v && typeof v === "object") walk(v)
    }
  }

  walk(value)
}

/**
 * 深度遍历结构化值，把所有字符串中的敏感内容替换为占位符。
 * Flare Redact 返回保持原型/共享引用/循环引用的安全副本，原值不被修改。
 * @param {unknown} value
 * @param {{ keywords: Array<{value:string,category:string}>, regex: Array<{pattern:string,flags:string,category:string}>, exclude: Set<string> }} patterns
 * @param {{ getOrCreatePlaceholder(original: string, category: string): string }} session
 */
export function redactDeep(value, patterns, session) {
  return getDeepRedactor(patterns, session)(value)
}
