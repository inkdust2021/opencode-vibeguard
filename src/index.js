import { loadConfig } from "./config.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { redactText, redactTextWithAI } from "./engine.js"
import { redactDeep, restoreDeep } from "./deep.js"
import { restoreText } from "./restore.js"

/**
 * OpenCode plugin entry point:
 * - `experimental.chat.messages.transform`: redact all messages before sending to LLM
 * - `tool.execute.before`: restore placeholders before local tool execution
 * - `experimental.text.complete`: restore placeholders in completed model output
 *
 * AI detection is opt-in via the `ai` config section. When AI is enabled but
 * @huggingface/transformers is not installed, falls back to regex/keyword only.
 */
export const VibeGuardPrivacy = async (ctx) => {
  const config = await loadConfig(ctx.directory)
  const debug = Boolean(process.env.OPENCODE_VIBEGUARD_DEBUG) || Boolean(config.debug)

  // Use OpenCode's structured logging instead of console.log to avoid
  // corrupting the TUI. Falls back to no-op if client.app.log is unavailable.
  const log = (level, message, extra) => {
    try {
      ctx.client?.app?.log({
        body: { service: "vibeguard", level, message, ...(extra ? { extra } : {}) },
      })
    } catch {
      /* swallow — never crash the plugin over logging */
    }
  }

  if (debug) {
    const from = config.loadedFrom ? config.loadedFrom : "not found (plugin will no-op)"
    log("debug", `Config: ${from} enabled=${config.enabled}`)
  }

  if (!config.enabled) return {}

  const patterns = buildPatternSet(config.patterns)
  const sessions = new Map()
  const sessionLastAccess = new Map() // track last access time for pruning
  const MAX_SESSIONS = 50 // prune oldest when exceeded
  const aiConfig = config.ai
  const useAI = aiConfig.enabled

  // Check AI availability at startup (non-blocking info)
  // Import ai-detect lazily to avoid pulling in Transformers.js when AI disabled
  if (useAI) {
    const { isAIAvailable, setLogger } = await import("./ai-detect.js")
    setLogger(log)
    const available = await isAIAvailable()
    if (available) {
      log("info", `AI detection enabled (model: ${aiConfig.model}, dtype: ${aiConfig.dtype}). Model will be downloaded on first use if not cached.`)
    } else {
      log("warn", "AI detection enabled in config but @huggingface/transformers is not installed. Falling back to regex/keyword detection only.")
    }
    // NOTE: We intentionally do NOT register process exit handlers for disposeAI().
    // The ONNX runtime (native N-API addon) crashes if dispose() is called during
    // process teardown. The OS reclaims all memory on exit anyway.
  }

  if (debug) {
    log("debug", `AI detection: ${useAI ? "enabled" : "disabled (opt-in via config)"}`)
    log("debug", `Regex patterns: ${patterns.keywords.length} keywords, ${patterns.regex.length} regex rules`)
  }

  const getSession = (sessionID) => {
    const key = String(sessionID ?? "")
    if (!key) return null
    const existing = sessions.get(key)
    if (existing) {
      sessionLastAccess.set(key, Date.now())
      return existing
    }
    // Prune oldest sessions if map is too large
    if (sessions.size >= MAX_SESSIONS) {
      let oldestKey = null
      let oldestTime = Infinity
      for (const [k, t] of sessionLastAccess) {
        if (t < oldestTime) {
          oldestTime = t
          oldestKey = k
        }
      }
      if (oldestKey) {
        sessions.delete(oldestKey)
        sessionLastAccess.delete(oldestKey)
      }
    }
    const created = new PlaceholderSession({
      prefix: config.prefix,
      ttlMs: config.ttlMs,
      maxMappings: config.maxMappings,
    })
    sessions.set(key, created)
    sessionLastAccess.set(key, Date.now())
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

      // Choose redaction function based on AI config
      const redactStr = useAI
        ? async (text) => {
            const result = await redactTextWithAI(text, patterns, session, aiConfig, debug)
            return result.text
          }
        : (text) => {
            return Promise.resolve(redactText(text, patterns, session).text)
          }

      for (const msg of msgs) {
        const parts = Array.isArray(msg?.parts) ? msg.parts : []
        for (const part of parts) {
          if (!part) continue

          // Plain text (user/assistant)
          if (part.type === "text") {
            if (part.ignored) continue
            if (!part.text || typeof part.text !== "string") continue
            const before = part.text
            const after = await redactStr(before)
            if (after !== before) changedTextParts++
            part.text = after
            continue
          }

          // Reasoning text
          if (part.type === "reasoning") {
            if (!part.text || typeof part.text !== "string") continue
            const before = part.text
            const after = await redactStr(before)
            if (after !== before) changedTextParts++
            part.text = after
            continue
          }

          // Tool calls/outputs: most common leak source (e.g., reading .env)
          if (part.type === "tool") {
            const state = part.state
            if (!state || typeof state !== "object") continue

            // Deep-redact tool inputs (args) so they don't leak in later turns.
            // Uses sync regex-only for deep object traversal; AI layer covers
            // text parts and tool output strings.
            if (state.input && typeof state.input === "object") {
              redactDeep(state.input, patterns, session)
            }

            if (state.status === "completed" && typeof state.output === "string") {
              const before = state.output
              const after = await redactStr(before)
              if (after !== before) changedTextParts++
              state.output = after
              continue
            }
            if (state.status === "error" && typeof state.error === "string") {
              const before = state.error
              const after = await redactStr(before)
              if (after !== before) changedTextParts++
              state.error = after
              continue
            }
            if (state.status === "pending" && typeof state.raw === "string") {
              const before = state.raw
              const after = await redactStr(before)
              if (after !== before) changedTextParts++
              state.raw = after
              continue
            }
          }
        }
      }

      if (debug && changedTextParts > 0) {
        log("debug", `Pre-request redaction: modified ${changedTextParts} text segment(s)`)
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
        log("debug", "Post-response restore: modified 1 text segment")
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
