import { restoreText } from "./restore.js"
import { redactText } from "./engine.js"

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
 * 只复制 Array / PlainObject，保持共享引用和循环引用，原值不被修改。
 * @param {unknown} value
 * @param {{ keywords: Array<{value:string,category:string}>, regex: Array<{pattern:string,flags:string,category:string}>, exclude: Set<string> }} patterns
 * @param {{ getOrCreatePlaceholder(original: string, category: string): string }} session
 */
export function redactDeep(value, patterns, session) {
  const seen = new WeakMap()
  let matches = 0

  const walk = (node) => {
    if (typeof node === "string") {
      const redacted = redactText(node, patterns, session)
      matches += redacted.matches.length
      return redacted.text
    }

    if (!node || typeof node !== "object") return node

    const cached = seen.get(node)
    if (cached) return cached

    if (Array.isArray(node)) {
      const out = new Array(node.length)
      seen.set(node, out)
      for (let i = 0; i < node.length; i++) {
        if (Object.prototype.hasOwnProperty.call(node, i)) out[i] = walk(node[i])
      }
      return out
    }

    if (!isPlainObject(node)) return node

    const out = Object.create(Object.getPrototypeOf(node))
    seen.set(node, out)
    for (const key of Object.keys(node)) out[key] = walk(node[key])
    return out
  }

  return { value: walk(value), matches }
}
