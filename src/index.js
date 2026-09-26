import { loadConfig } from "./config.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { redactText } from "./engine.js"
import { redactDeep, restoreDeep } from "./deep.js"
import { restoreText } from "./restore.js"
import { PLUGIN_ID, vibeguardSetup } from "./v2.js"

/**
 * OpenCode 插件入口（V1 + V2 双兼容）：
 * - `experimental.chat.messages.transform`：LLM 请求前对全部消息做脱敏（保证 provider 永远看不到真实值）
 * - `tool.execute.before`：工具执行前还原占位符（保证本机执行拿到真实值）
 *
 * 说明：为了降低误用风险，本插件在“找不到配置文件或 enabled=false”时为 no-op。
 */
export const VibeGuardPrivacy = async (ctx) => {
  const config = await loadConfig(ctx.directory)
  const debug = Boolean(process.env.OPENCODE_VIBEGUARD_DEBUG) || Boolean(config.debug)

  if (debug) {
    const from = config.loadedFrom ? config.loadedFrom : "未找到（插件将 no-op）"
    console.log(`[opencode-vibeguard] 配置：${from} enabled=${config.enabled}`)
  }

  if (!config.enabled) return {}

  const patterns = buildPatternSet(config.patterns)
  const sessions = new Map()

  const getSession = (sessionID) => {
    const key = String(sessionID ?? "")
    if (!key) return null
    const existing = sessions.get(key)
    if (existing) return existing
    const created = new PlaceholderSession({
      prefix: config.prefix,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
    })
    sessions.set(key, created)
    return created
  }

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const msgs = output?.messages
      if (!Array.isArray(msgs) || msgs.length === 0) return

      const sessionID = msgs[0]?.info?.sessionID ?? msgs[0]?.parts?.[0]?.sessionID
      const session = getSession(sessionID)
      if (!session) return

      session.cleanup()

      let changedTextParts = 0

      for (const msg of msgs) {
        const parts = Array.isArray(msg?.parts) ? msg.parts : []
        for (const part of parts) {
          if (!part) continue

          // 普通文本（用户/助手）
          if (part.type === "text") {
            if (part.ignored) continue
            if (!part.text || typeof part.text !== "string") continue
            const before = part.text
            const after = redactText(before, patterns, session).text
            if (after !== before) changedTextParts++
            part.text = after
            continue
          }

          // 推理文本（部分模型/配置会进入 prompt）
          if (part.type === "reasoning") {
            if (!part.text || typeof part.text !== "string") continue
            const before = part.text
            const after = redactText(before, patterns, session).text
            if (after !== before) changedTextParts++
            part.text = after
            continue
          }

          // 工具调用/输出：最常见的泄漏来源（例如读取 .env）
          if (part.type === "tool") {
            const state = part.state
            if (!state || typeof state !== "object") continue

            // 统一把工具输入也做深度脱敏：真实执行的 args 会包含明文（由 tool.execute.before 还原），
            // 如果不在这里再脱敏一次，后续回合会把明文 args 带给 LLM。
            if (state.input && typeof state.input === "object") {
              redactDeep(state.input, patterns, session)
            }

            if (state.status === "completed" && typeof state.output === "string") {
              const before = state.output
              const after = redactText(before, patterns, session).text
              if (after !== before) changedTextParts++
              state.output = after
              continue
            }
            if (state.status === "error" && typeof state.error === "string") {
              const before = state.error
              const after = redactText(before, patterns, session).text
              if (after !== before) changedTextParts++
              state.error = after
              continue
            }
            if (state.status === "pending" && typeof state.raw === "string") {
              const before = state.raw
              const after = redactText(before, patterns, session).text
              if (after !== before) changedTextParts++
              state.raw = after
              continue
            }
          }
        }
      }

      if (debug && changedTextParts > 0) {
        console.log(`[opencode-vibeguard] 本次请求前脱敏：已修改 ${changedTextParts} 处文本片段`)
      }
    },

    "experimental.text.complete": async (input, output) => {
      if (!output || typeof output !== "object") return
      if (typeof output.text !== "string" || !output.text) return
      const session = getSession(input?.sessionID)
      if (!session) return
      session.cleanup()
      const before = output.text
      const after = restoreText(before, session)
      output.text = after
      if (debug && after !== before) {
        console.log("[opencode-vibeguard] 本次响应完成后还原：已修改 1 处文本片段")
      }
    },

    "tool.execute.before": async (input, output) => {
      const session = getSession(input?.sessionID)
      if (!session) return
      session.cleanup()
      restoreDeep(output?.args, session)
    },
  }
}

/**
 * OpenCode V2 默认导出。
 *
 * OpenCode V2（>= 2.0.x）通过默认导出加载插件，要求它是 **对象** 且带
 * `id` 与 `setup`（或 `effect`）。仅导出函数（无论命名还是默认）都会被拒绝：
 *
 *   SchemaError(Missing key at ["default"])   // 完全没有 default
 *   SchemaError(Expected object at ["default"]) // default 是函数
 *
 * 这里导出 `{ id, setup }`，V2 走 `setup(ctx)`；V1 仍通过命名导出
 * `VibeGuardPrivacy` 工作（V1 加载器读取模块的命名导出）。
 */
export { PLUGIN_ID, vibeguardSetup }
export const vibeguardV2 = {
  id: PLUGIN_ID,
  setup: vibeguardSetup,
}
export default vibeguardV2
