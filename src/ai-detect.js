/**
 * AI-based PII/secret detection — thin HTTP client.
 *
 * Instead of loading the ~400MB ONNX model in-process, this module
 * talks to a shared model-server daemon over a Unix domain socket.
 * Multiple OpenCode instances share one model copy in RAM.
 *
 * On first call, if the server isn't running, this module spawns it
 * as a detached background process and waits for it to become ready.
 *
 * The detectWithAI() signature is unchanged — engine.js and index.js
 * don't need to know about the server.
 */

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { spawn, execFileSync } from "node:child_process"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** How long to wait for the server to become ready (model download + load). */
const SERVER_READY_TIMEOUT_MS = 180_000 // 3 min (model may need downloading)

/** Interval between health polls when waiting for server readiness. */
const HEALTH_POLL_MS = 500

/** Per-request timeout for /detect calls. */
const REQUEST_TIMEOUT_MS = 30_000

/** Cooldown after server spawn failure before retrying. */
const SPAWN_COOLDOWN_MS = 60_000

/** Idle timeout passed to the server (20 min). */
const IDLE_TIMEOUT_MS = 20 * 60_000

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let _log = () => {} // no-op; set via setLogger()
let _serverReady = false // true once health check confirmed ready
let _spawnFailedAt = 0 // timestamp of last spawn failure
let _socketPath = null // resolved lazily

/**
 * Set the logger function. Called from index.js.
 * @param {Function} logFn - (level, message) => void
 */
export function setLogger(logFn) {
  if (typeof logFn === "function") _log = logFn
}

// ---------------------------------------------------------------------------
// Socket path
// ---------------------------------------------------------------------------
function getSocketPath() {
  if (_socketPath) return _socketPath
  const dir = process.env.TMPDIR || os.tmpdir() || "/tmp"
  const uid = process.getuid?.() ?? process.pid
  _socketPath = path.join(dir, `vibeguard-${uid}.sock`)
  return _socketPath
}

function getLockPath() {
  return getSocketPath().replace(/\.sock$/, ".lock")
}

function getPidPath() {
  return getSocketPath().replace(/\.sock$/, ".pid")
}

function getLogPath() {
  return getSocketPath().replace(/\.sock$/, ".log")
}

// ---------------------------------------------------------------------------
// HTTP helpers (over Unix socket)
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request to the model server over Unix socket.
 * Returns parsed JSON body or null on failure.
 */
function serverRequest(method, urlPath, body, timeoutMs) {
  return new Promise((resolve) => {
    const socketPath = getSocketPath()
    const opts = {
      socketPath,
      path: urlPath,
      method,
      headers: {},
      timeout: timeoutMs,
    }

    let payload = null
    if (body) {
      payload = JSON.stringify(body)
      opts.headers["Content-Type"] = "application/json"
      opts.headers["Content-Length"] = Buffer.byteLength(payload)
    }

    const req = http.request(opts, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
        } catch {
          resolve(null)
        }
      })
    })

    req.on("error", () => resolve(null))
    req.on("timeout", () => {
      req.destroy()
      resolve(null)
    })

    if (payload) req.write(payload)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Server spawn lock (O_EXCL atomic create + PID validation)
// ---------------------------------------------------------------------------

/**
 * Acquire a spawn lock using atomic file creation (O_EXCL).
 * Returns true if lock was acquired, false if another process holds it.
 *
 * The lockfile contains the PID of the holder. If the holder is dead
 * (stale lock), we remove it and retry once.
 */
function tryLock() {
  const lockPath = getLockPath()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — atomic create-or-fail
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY)
      // Write our PID so others can check liveness
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return true
    } catch (err) {
      if (err.code !== "EEXIST") return false
      // Lock file exists — check if holder is alive
      try {
        const holderPid = Number(fs.readFileSync(lockPath, "utf8").trim())
        if (Number.isFinite(holderPid) && holderPid > 0 && isProcessAlive(holderPid)) {
          return false // holder is alive, lock is valid
        }
      } catch {
        /* can't read — try to remove */
      }
      // Holder is dead or file unreadable — remove stale lock and retry
      try { fs.unlinkSync(lockPath) } catch { /* ok */ }
    }
  }
  return false
}

function releaseLock() {
  try {
    fs.unlinkSync(getLockPath())
  } catch {
    /* ignore */
  }
}

/**
 * Check if a process with the given PID is alive.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0) // signal 0 = existence check
    return true
  } catch {
    return false
  }
}

/**
 * Check if the server is running by reading PID file + socket existence.
 */
function isServerRunning() {
  const pidPath = getPidPath()
  const socketPath = getSocketPath()
  try {
    if (!fs.existsSync(socketPath)) return false
    const pidStr = fs.readFileSync(pidPath, "utf8").trim()
    const pid = Number(pidStr)
    if (!Number.isFinite(pid) || pid <= 0) return false
    return isProcessAlive(pid)
  } catch {
    return false
  }
}

/**
 * Clean up stale socket/pid/lock files left by a crashed server.
 */
function cleanupStaleFiles() {
  for (const f of [getSocketPath(), getPidPath(), getLockPath()]) {
    try { fs.unlinkSync(f) } catch { /* ok */ }
  }
}

/**
 * Find a Node.js binary suitable for running the model server.
 *
 * process.execPath is NOT reliable — when running inside OpenCode (Bun),
 * it points to the opencode binary, not Node. So we resolve explicitly:
 *   1. $NODE_BIN env var (explicit override)
 *   2. `which node` (PATH lookup)
 *   3. process.execPath (last resort — only works if host IS Node)
 */
function findNodeBin() {
  // Explicit override
  if (process.env.NODE_BIN) return process.env.NODE_BIN

  // PATH lookup — works for nvm, fnm, brew, system node
  try {
    const resolved = execFileSync("which", ["node"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim()
    if (resolved && fs.existsSync(resolved)) return resolved
  } catch { /* which failed — continue */ }

  // Last resort: only valid if the host runtime IS Node (not Bun/Deno/opencode)
  const execName = path.basename(process.execPath).toLowerCase()
  if (execName === "node" || execName.startsWith("node")) {
    return process.execPath
  }

  return null
}

/**
 * Spawn the model server as a detached background process.
 */
function spawnServer(aiConfig) {
  const serverScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "model-server.js"
  )

  const model = aiConfig.model || "openai/privacy-filter"
  const dtype = aiConfig.dtype || "q4"
  const device = aiConfig.device || "cpu"

  const nodeBin = findNodeBin()
  if (!nodeBin) {
    _log("error", "Cannot find Node.js binary. Install Node.js or set NODE_BIN env var.")
    return null
  }

  const logPath = getLogPath()
  let logFd = null
  let stdout, stderr
  try {
    logFd = fs.openSync(logPath, "a")
    stdout = logFd
    stderr = logFd
  } catch {
    stdout = "ignore"
    stderr = "ignore"
  }

  try {
    const child = spawn(
      nodeBin,
      [
        serverScript,
        "--model",
        model,
        "--dtype",
        dtype,
        "--device",
        device,
        "--socket",
        getSocketPath(),
        "--idle-timeout",
        String(IDLE_TIMEOUT_MS),
      ],
      {
        detached: true,
        stdio: ["ignore", stdout, stderr],
        env: { ...process.env },
      }
    )

    child.unref()
    _log("info", `Spawned model server (pid=${child.pid}, node=${nodeBin}, model=${model}, dtype=${dtype})`)
    return child.pid
  } catch (err) {
    _log("error", `spawn() failed: ${err.message}`)
    return null
  } finally {
    // Close the log fd in the parent — the child inherited a dup.
    // In a finally block so it's closed even if spawn() throws.
    if (logFd !== null) {
      try { fs.closeSync(logFd) } catch { /* ok */ }
    }
  }
}

/**
 * Ensure the server is running. Spawn if needed, wait for readiness.
 * Uses a lockfile to prevent multiple simultaneous spawns.
 * Returns true if server is ready, false if unavailable.
 */
async function ensureServer(aiConfig, debug) {
  // Fast path: already confirmed ready
  if (_serverReady) {
    // Quick health check to confirm it's still alive
    const h = await serverRequest("GET", "/health", null, 2000)
    if (h?.status === "ready") return true
    // Server died — reset and try to respawn
    _serverReady = false
  }

  // Cooldown after spawn failure
  if (_spawnFailedAt > 0) {
    const elapsed = Date.now() - _spawnFailedAt
    if (elapsed < SPAWN_COOLDOWN_MS) return false
    _spawnFailedAt = 0
  }

  // Check if server is already running (maybe another instance spawned it)
  if (isServerRunning()) {
    return await waitForReady(aiConfig, debug)
  }

  // Need to spawn — acquire lock to prevent races
  const gotLock = tryLock()
  if (!gotLock) {
    // Couldn't acquire lock — another instance is spawning. Just wait.
    return await waitForReady(aiConfig, debug)
  }

  try {
    // Double-check after acquiring lock (another instance may have won)
    if (isServerRunning()) {
      return await waitForReady(aiConfig, debug)
    }

    // Re-read config before spawning — if ai.enabled is false, bail out.
    // This lets users disable AI without restarting opencode sessions.
    try {
      const cfgPath = path.join(os.homedir(), ".config", "opencode", "vibeguard.config.json")
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      if (cfg?.ai?.enabled === false) {
        if (debug) _log("info", "AI disabled in config — not spawning server")
        return false
      }
    } catch { /* config unreadable — proceed with spawn */ }

    // Clean up any stale files from a crashed server
    cleanupStaleFiles()

    // Spawn the server
    const pid = spawnServer(aiConfig)
    if (!pid) {
      _spawnFailedAt = Date.now()
      _log("error", "Failed to spawn model server")
      return false
    }

    // Wait for server to become ready
    return await waitForReady(aiConfig, debug)
  } finally {
    releaseLock()
  }
}

/**
 * Poll /health until the server reports "ready" or we time out.
 * Bails early on server error or consecutive connection failures.
 */
async function waitForReady(aiConfig, debug) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  let lastStatus = ""
  let consecutiveFailures = 0

  while (Date.now() < deadline) {
    const h = await serverRequest("GET", "/health", null, 5000)

    if (h?.status === "ready") {
      // Verify model matches
      const expected = aiConfig.model || "openai/privacy-filter"
      if (h.model && h.model !== expected) {
        _log("warn", `Server loaded model "${h.model}" but config expects "${expected}". Using regex-only.`)
        // Set cooldown so we don't hot-loop re-checking on every call
        _spawnFailedAt = Date.now()
        return false
      }
      _serverReady = true
      if (debug) _log("info", "Model server ready")
      return true
    }

    if (h?.status === "error") {
      _log("error", `Model server error: ${h.error || "unknown"}`)
      _spawnFailedAt = Date.now()
      return false
    }

    if (h?.status === "loading") {
      consecutiveFailures = 0
      if (lastStatus !== "loading" && debug) {
        _log("info", "Model server is loading the model, waiting...")
      }
      lastStatus = "loading"
    } else {
      // null response = connection refused / server not up yet
      consecutiveFailures++
      // If we get 10+ consecutive connection failures after the server
      // should have started, it's probably dead — bail early
      if (consecutiveFailures >= 10) {
        _log("warn", "Model server not responding after multiple attempts. Using regex-only.")
        _spawnFailedAt = Date.now()
        return false
      }
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
  }

  _log("warn", "Timed out waiting for model server. Using regex-only.")
  _spawnFailedAt = Date.now()
  return false
}

// ---------------------------------------------------------------------------
// Public API (signature unchanged from original)
// ---------------------------------------------------------------------------

/**
 * Detect PII/secrets in text using the Privacy Filter model.
 *
 * Sends the text to the shared model server for inference.
 * If the server isn't running, spawns it and waits for readiness.
 * If anything fails, returns [] (regex-only fallback).
 *
 * @param {string} text - Input text to scan
 * @param {object} aiConfig - AI configuration from vibeguard config
 * @param {boolean} debug - Enable debug logging
 * @returns {Promise<Array<{ start: number, end: number, original: string, category: string }>>}
 */
export async function detectWithAI(text, aiConfig, debug) {
  if (!text || typeof text !== "string" || text.length === 0) return []

  const ready = await ensureServer(aiConfig, debug)
  if (!ready) return []

  try {
    const result = await serverRequest("POST", "/detect", {
      text,
      categories: aiConfig.categories,
      requestedModel: aiConfig.model || "openai/privacy-filter",
    }, REQUEST_TIMEOUT_MS)

    if (!result) {
      // Connection failed — server may have died
      _serverReady = false
      return []
    }

    if (result.error && !result.spans) {
      // Server-side error (503, 409, etc.)
      if (debug || !aiConfig.silentFallback) {
        _log("warn", `Server error: ${result.error}`)
      }
      return []
    }

    const spans = Array.isArray(result.spans) ? result.spans : []

    if (debug && spans.length > 0) {
      _log("debug", `AI detected ${spans.length} span(s): ${spans.map((s) => s.category).join(", ")}`)
    }

    return spans
  } catch (err) {
    if (!aiConfig.silentFallback || debug) {
      _log("error", `AI detection error: ${err.message}, falling back to regex-only`)
    }
    _serverReady = false
    return []
  }
}

/**
 * Dispose — no-op. The server manages its own lifecycle (idle timeout).
 */
export async function disposeAI() {
  // Server exits on its own after 20min of inactivity.
  // Calling dispose from the plugin process would kill the shared
  // server for all other OpenCode instances. So this is intentionally a no-op.
}

/**
 * Check if AI detection is potentially available.
 * Returns true if the server is running OR if we can spawn one
 * (i.e. @huggingface/transformers is installed).
 */
export async function isAIAvailable() {
  // Fast check: is the server already running?
  if (isServerRunning()) return true

  // Can we spawn? Check if transformers is installed (without loading it).
  try {
    // import.meta.resolve does path resolution only — doesn't execute the module
    if (import.meta.resolve) {
      import.meta.resolve("@huggingface/transformers")
      return true
    }
    // Fallback for runtimes that don't support import.meta.resolve:
    // use createRequire to do a path-only resolution (no module loading)
    const require = createRequire(import.meta.url)
    require.resolve("@huggingface/transformers")
    return true
  } catch {
    return false
  }
}
