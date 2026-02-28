import { getPlaceholderRegex } from "./session.js"

/**
 * 还原字符串中的占位符；若占位符不在映射表中，则保持原样。
 * @param {string} input
 * @param {{ prefix: string, lookup(ph: string): string | undefined }} session
 */
export function restoreText(input, session) {
  const text = String(input ?? "")
  if (!text) return text
  const re = getPlaceholderRegex(session.prefix)
  return text.replace(re, (ph) => session.lookup(ph) ?? ph)
}

