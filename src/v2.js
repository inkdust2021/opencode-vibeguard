import { loadConfig } from "./config.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { redactText } from "./engine.js"
import { redactDeep, restoreDeep } from "./deep.js"

/**
 * OpenCode V2 适配层。
 *
 * OpenCode V2（>= 2.0.x）通过 **默认导出** 加载插件，且要求默认导出是一个对象：
 *
 *   export default { id, setup }   // setup 或 effect 二选一
 *
 * 而 0.1.0 的入口只导出了命名函数 `VibeGuardPrivacy`，没有 `default`，
 * 因此 V2 每次加载都会失败（provider 永远拿不到脱敏后的内容）：
 *
 *   PluginModule.LoadError: Plugin must export a default definition with an id
 *   and an effect or setup function.
 *   (cause: SchemaError(Missing key at ["default"]))
 *
 * 注意：仅仅 `export default VibeGuardPrivacy` 是不够的——V2 的 schema 要求
 * 默认导出是对象（函数会报 `Expected object at ["default"]`）。因此这里导出一个
 * 形如 `{ id, setup }` 的对象。
 *
 * 本文件把与 V1 完全相同的脱敏引擎接到 V2 的 hook 面上：
 *
 * - `session.hook("context")`      请求前脱敏（对应 V1 `experimental.chat.messages.transform`）
 * - `tool.hook("execute.before")`  工具执行前还原占位符（对应 V1 `tool.execute.before`）
 *
 * 已知差异：V2 目前没有等价于 V1 `experimental.text.complete` 的钩子，
 * 因此“响应完成后还原展示文本”这一步在 V2 下无法实现（详见 README）。
 */
export const PLUGIN_ID = "opencode-vibeguard"

function isObject(value) {
  return Boolean(value) && typeof value === "object"
}

/**
 * 对 V2 消息内容分片做原地脱敏。
 *
 * V2 的 message.content 是 tagged union：
 * text | media | tool-call | tool-result | reasoning | compaction | effort。
 * 只有可能承载自由文本/密钥的分片需要处理。
 */
function redactContentPart(part, patterns, session) {
  if (!isObject(part)) return
  switch (part.type) {
    case "text":
    case "reasoning":
    case "compaction":
      if (typeof part.text === "string") {
        part.text = redactText(part.text, patterns, session).text
      }
      break
    case "tool-call":
      // 工具入参是最常见的泄漏来源（例如读取 .env）。
      if (isObject(part.input)) redactDeep(part.input, patterns, session)
      break
    case "tool-result":
      // 历史工具输出会在后续回合重新发给模型。
      if (isObject(part.result)) redactDeep(part.result, patterns, session)
      break
    default:
      break
  }
}

/**
 * V2 setup 入口，行为与 V1 保持一致：找不到配置或 enabled=false 时为 no-op。
 *
 * @param {import("@opencode/plugin").Context} ctx
 */
export async function vibeguardSetup(ctx) {
  const directory = ctx?.location?.directory ?? process.cwd()
  const config = await loadConfig(directory)
  const debug = Boolean(process.env.OPENCODE_VIBEGUARD_DEBUG) || Boolean(config.debug)

  if (debug) {
    const from = config.loadedFrom ? config.loadedFrom : "未找到（插件将 no-op）"
    console.log(`[opencode-vibeguard] 配置：${from} enabled=${config.enabled}`)
  }

  if (!config.enabled) return

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

  const registrations = []

  // 请求前脱敏：system + 全部消息分片。
  registrations.push(
    await ctx.session.hook("context", (input) => {
      const session = getSession(input?.sessionID)
      if (!session) return
      session.cleanup()

      if (Array.isArray(input.system)) {
        for (const part of input.system) {
          if (isObject(part) && typeof part.text === "string") {
            part.text = redactText(part.text, patterns, session).text
          }
        }
      }

      if (Array.isArray(input.messages)) {
        for (const message of input.messages) {
          if (!isObject(message) || !Array.isArray(message.content)) continue
          for (const part of message.content) redactContentPart(part, patterns, session)
        }
      }
    }),
  )

  // 工具执行前还原：保证本机拿到真实值。
  registrations.push(
    await ctx.tool.hook("execute.before", (input) => {
      const session = getSession(input?.sessionID)
      if (!session) return
      session.cleanup()
      restoreDeep(input?.input, session)
    }),
  )

  // V2 在卸载/销毁时调用返回的 cleanup。
  return async () => {
    for (const registration of registrations) {
      try {
        await registration?.dispose?.()
      } catch {
        // 尽力而为
      }
    }
  }
}

/** V2 插件定义（默认导出契约）。 */
export const vibeguardV2 = {
  id: PLUGIN_ID,
  setup: vibeguardSetup,
}
