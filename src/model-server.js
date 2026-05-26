#!/usr/bin/env node
/**
 * vibeguard-model-server — shared Privacy Filter inference daemon.
 *
 * Runs as a standalone process, serves token-classification inference
 * over a Unix domain socket so multiple OpenCode instances share one
 * model copy in RAM (~400MB q4).
 *
 * Lifecycle:
 *   - Spawned automatically by ai-detect.js on first detectWithAI() call.
 *   - Exits cleanly after IDLE_TIMEOUT_MS of no requests (default 20min).
 *   - Signal handlers (SIGINT/SIGTERM) clean up socket + pid file.
 *
 * Usage (manual):
 *   node src/model-server.js --model openai/privacy-filter --dtype q4 --device cpu
 *
 * Protocol (HTTP over Unix socket):
 *   POST /detect   {text, categories?}  → {spans: [{start,end,original,category}]}
 *   GET  /health                         → {status,pid,uptime,model,dtype,device}
 */

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// CLI args / env
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback
}

const MODEL = getArg("model", process.env.VIBEGUARD_MODEL || "openai/privacy-filter")
const DTYPE = getArg("dtype", process.env.VIBEGUARD_DTYPE || "q4")
const DEVICE = getArg("device", process.env.VIBEGUARD_DEVICE || "cpu")
const IDLE_TIMEOUT_MS = Number(
  getArg("idle-timeout", process.env.VIBEGUARD_IDLE_TIMEOUT_MS || "1200000")
) // 20 min

if (!Number.isFinite(IDLE_TIMEOUT_MS) || IDLE_TIMEOUT_MS <= 0) {
  process.stderr.write(`Invalid idle-timeout: ${IDLE_TIMEOUT_MS}. Must be a positive number (ms).\n`)
  process.exit(1)
}
const SOCKET_PATH = getArg(
  "socket",
  process.env.VIBEGUARD_SOCKET || defaultSocketPath()
)
const PID_PATH = SOCKET_PATH.endsWith(".sock")
  ? SOCKET_PATH.replace(/\.sock$/, ".pid")
  : SOCKET_PATH + ".pid"
const LOG_PATH = SOCKET_PATH.endsWith(".sock")
  ? SOCKET_PATH.replace(/\.sock$/, ".log")
  : SOCKET_PATH + ".log"
const MAX_BODY_BYTES = 1_048_576 // 1 MB
const MAX_QUEUE = 50
const REQUEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function defaultSocketPath() {
  const dir = process.env.TMPDIR || os.tmpdir() || "/tmp"
  const uid = process.getuid?.() ?? process.pid
  return path.join(dir, `vibeguard-${uid}.sock`)
}

function log(msg) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  // Write to stderr only — the spawner redirects stderr to the log file.
  // appendFileSync was causing doubled lines when stderr was already redirected.
  process.stderr.write(line)
}

// ---------------------------------------------------------------------------
// Model loading (moved from ai-detect.js)
// ---------------------------------------------------------------------------
const LABEL_TO_CATEGORY = {
  // openai/privacy-filter labels
  private_person: "PRIVATE_PERSON",
  private_address: "PRIVATE_ADDRESS",
  private_email: "PRIVATE_EMAIL",
  private_phone: "PRIVATE_PHONE",
  private_url: "PRIVATE_URL",
  private_date: "PRIVATE_DATE",
  account_number: "ACCOUNT_NUMBER",
  secret: "SECRET",
  // broadfield-dev/bert-small labels (BIO prefix already stripped)
  email: "PRIVATE_EMAIL",
  telephonenum: "PRIVATE_PHONE",
  givenname: "PRIVATE_PERSON",
  surname: "PRIVATE_PERSON",
  username: "PRIVATE_PERSON",
  street: "PRIVATE_ADDRESS",
  city: "PRIVATE_ADDRESS",
  buildingnum: "PRIVATE_ADDRESS",
  zipcode: "PRIVATE_ADDRESS",
  creditcardnumber: "ACCOUNT_NUMBER",
  accountnum: "ACCOUNT_NUMBER",
  socialnum: "ACCOUNT_NUMBER",
  idcardnum: "ACCOUNT_NUMBER",
  driverlicensenum: "ACCOUNT_NUMBER",
  taxnum: "ACCOUNT_NUMBER",
  dateofbirth: "PRIVATE_DATE",
  password: "SECRET",
}

let _pipeline = null
let _loadError = null
let _loading = null

async function loadPipeline() {
  if (_pipeline) return _pipeline
  if (_loading) return _loading
  _loading = (async () => {
    log(`Loading model: ${MODEL} (dtype=${DTYPE}, device=${DEVICE})`)
    const start = Date.now()
    try {
      const transformers = await import("@huggingface/transformers")
      // Limit thread count to prevent CPU-spinning when idle.
      // onnxruntime-node uses native threads (not WASM), controlled via
      // session_options. The wasm.numThreads setting alone does nothing
      // for the native backend. Default is all CPU cores → 100%+ CPU idle.
      if (transformers.env?.backends?.onnx?.wasm) {
        transformers.env.backends.onnx.wasm.numThreads = 2
      }
      _pipeline = await transformers.pipeline("token-classification", MODEL, {
        dtype: DTYPE,
        device: DEVICE,
        session_options: {
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
        },
      })
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      log(`Model loaded successfully (${elapsed}s)`)
      _loadError = null
      return _pipeline
    } catch (err) {
      _loadError = err.message
      log(`Model load failed: ${err.message}`)
      _pipeline = null
      return null
    } finally {
      _loading = null
    }
  })()
  return _loading
}

// ---------------------------------------------------------------------------
// Inference (serialized queue)
// ---------------------------------------------------------------------------
let _inferring = false
let _requestCount = 0
const _queue = []

function enqueueInference(text, categories) {
  return new Promise((resolve, reject) => {
    if (_queue.length >= MAX_QUEUE) {
      reject(new Error("Queue full"))
      return
    }
    _queue.push({ text, categories, resolve, reject })
    drainQueue()
  })
}

async function drainQueue() {
  if (_inferring || _queue.length === 0) return
  _inferring = true
  const job = _queue.shift()
  let settled = false

  // Per-request timeout
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true
      job.reject(new Error("Inference timed out"))
    }
  }, REQUEST_TIMEOUT_MS)

  try {
    const spans = await runInference(job.text, job.categories)
    clearTimeout(timer)
    if (!settled) {
      settled = true
      job.resolve(spans)
    }
  } catch (err) {
    clearTimeout(timer)
    if (!settled) {
      settled = true
      job.reject(err)
    }
  } finally {
    _inferring = false
    // Process next in queue — use setImmediate to avoid recursive stack buildup
    if (_queue.length > 0) setImmediate(drainQueue)
  }
}

async function runInference(text, categories) {
  const pipe = _pipeline
  if (!pipe) return []

  const entities = await pipe(text, { aggregation_strategy: "simple" })
  if (!Array.isArray(entities) || entities.length === 0) return []

  const allowedCategories =
    Array.isArray(categories) && categories.length > 0
      ? new Set(categories.map((c) => c.toLowerCase()))
      : null

  const spans = []
  // cursor tracks search position in text to handle repeated words correctly
  let cursor = 0

  for (const entity of entities) {
    if (!entity || typeof entity !== "object") continue
    const rawLabel = String(entity.entity_group ?? entity.entity ?? "").toLowerCase()
    const label = rawLabel.replace(/^[bi]-/, "")
    if (!label || label === "o") continue
    if (allowedCategories && !allowedCategories.has(label)) continue

    let start = Number(entity.start)
    let end = Number(entity.end)

    // Transformers.js may not return start/end character offsets (unlike Python).
    // If missing, locate the span by matching the word field against the source text.
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      const word = String(entity.word ?? "").trim()
      if (!word) continue
      const idx = text.indexOf(word, cursor)
      if (idx === -1) continue // word not found — skip
      start = idx
      end = idx + word.length
    }

    if (end > text.length) continue

    const original = text.slice(start, end)
    const category = LABEL_TO_CATEGORY[label] ?? label.toUpperCase()
    spans.push({ start, end, original, category })
    cursor = end // advance cursor past this span
  }
  return spans
}

// ---------------------------------------------------------------------------
// Idle timeout + socket watchdog
// ---------------------------------------------------------------------------
let _idleTimer = null
let _socketWatcher = null
const startedAt = Date.now()

function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => {
    log(`Idle for ${IDLE_TIMEOUT_MS / 60_000}min, shutting down.`)
    shutdown()
  }, IDLE_TIMEOUT_MS)
  // Don't let the timer keep the process alive if everything else is done
  if (_idleTimer.unref) _idleTimer.unref()
}

/**
 * Watch the socket file for deletion. If it disappears (another instance's
 * cleanupStaleFiles, OS cleanup, manual rm), this server is orphaned and
 * can never receive requests again — exit immediately.
 * The client (ai-detect.js) will spawn a fresh server on next detect() call.
 */
function startSocketWatchdog() {
  try {
    // Resolve symlinks — macOS $TMPDIR is often a symlink to /private/tmp
    const watchDir = fs.realpathSync(path.dirname(SOCKET_PATH))
    const socketBase = path.basename(SOCKET_PATH)
    let debounceTimer = null

    _socketWatcher = fs.watch(watchDir, (eventType, filename) => {
      if (filename !== socketBase) return
      // Debounce to avoid false positives from atomic rename operations
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        if (!fs.existsSync(SOCKET_PATH)) {
          log("Socket file deleted externally — exiting orphaned server.")
          shutdown()
        }
      }, 150)
      if (debounceTimer.unref) debounceTimer.unref()
    })
    _socketWatcher.unref()
  } catch {
    // fs.watch not supported or dir doesn't exist — not fatal, idle timeout
    // will still clean up eventually
  }
}

// ---------------------------------------------------------------------------
// Memory watchdog — kill if RSS exceeds cap (ONNX runtime leaks over time)
// ---------------------------------------------------------------------------
const MAX_RSS_MB = parseInt(process.env.VIBEGUARD_MAX_RSS_MB || "1500", 10)
let _memoryWatchdog = null

function startMemoryWatchdog() {
  _memoryWatchdog = setInterval(() => {
    const rssMB = process.memoryUsage.rss() / 1024 / 1024
    if (rssMB > MAX_RSS_MB) {
      log(`RSS ${rssMB.toFixed(0)}MB exceeds cap ${MAX_RSS_MB}MB — restarting.`)
      shutdown()
    }
  }, 30_000) // check every 30s
  if (_memoryWatchdog.unref) _memoryWatchdog.unref()
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  resetIdleTimer()

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    const status = _pipeline ? "ready" : _loading ? "loading" : _loadError ? "error" : "loading"
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        status,
        pid: process.pid,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        model: MODEL,
        dtype: DTYPE,
        device: DEVICE,
        error: _loadError || undefined,
        queueLength: _queue.length,
        requestCount: _requestCount,
      })
    )
    return
  }

  // Detect endpoint
  if (req.method === "POST" && req.url === "/detect") {
    // Read body with size limit
    const chunks = []
    let bodySize = 0
    let aborted = false

    req.on("data", (chunk) => {
      if (aborted) return
      bodySize += chunk.length
      if (bodySize > MAX_BODY_BYTES) {
        aborted = true
        res.writeHead(413, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Request body too large" }))
        req.destroy()
      } else {
        chunks.push(chunk)
      }
    })

    req.on("error", () => {
      aborted = true
    })

    req.on("end", async () => {
      if (aborted) return

      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Invalid JSON" }))
        return
      }

      const { text, categories, requestedModel } = body

      // Model mismatch check
      if (requestedModel && requestedModel !== MODEL) {
        res.writeHead(409, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: "model mismatch",
            loaded: MODEL,
            requested: requestedModel,
          })
        )
        return
      }

      if (!text || typeof text !== "string") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ spans: [] }))
        return
      }

      if (!_pipeline) {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            error: _loadError || "Model still loading",
            status: _loading ? "loading" : "error",
          })
        )
        return
      }

      try {
        // NEVER log text — it contains the sensitive data we're protecting
        const spans = await enqueueInference(text, categories)
        _requestCount++
        log(`detect #${_requestCount}: ${spans.length} span(s) found`)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ spans }))
      } catch (err) {
        if (err.message === "Queue full") {
          res.writeHead(503, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Server overloaded", spans: [] }))
        } else {
          // Inference error — return empty spans (client falls back to regex)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ spans: [], error: err.message }))
        }
      }
    })
    return
  }

  // Unknown route
  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: "Not found" }))
})

// ---------------------------------------------------------------------------
// Startup & shutdown
// ---------------------------------------------------------------------------
function cleanupFiles() {
  try {
    fs.unlinkSync(SOCKET_PATH)
  } catch {
    /* may not exist */
  }
  try {
    fs.unlinkSync(PID_PATH)
  } catch {
    /* may not exist */
  }
}

function shutdown() {
  if (_idleTimer) clearTimeout(_idleTimer)
  if (_socketWatcher) { try { _socketWatcher.close() } catch { /* ok */ } }
  // Reject all queued jobs so their HTTP handlers can respond
  while (_queue.length > 0) {
    const job = _queue.shift()
    job.reject(new Error("Server shutting down"))
  }
  server.close(() => {
    cleanupFiles()
    log(`Shutdown complete. Served ${_requestCount} detect request(s).`)
    process.exit(0)
  })
  // Force exit if server.close hangs (non-zero = abnormal)
  setTimeout(() => {
    cleanupFiles()
    process.exit(1)
  }, 3000).unref()
}

// Clean up stale socket if it exists (only if the owner process is dead)
try {
  const staleSocket = fs.existsSync(SOCKET_PATH)
  if (staleSocket) {
    let ownerAlive = false
    try {
      const pidStr = fs.readFileSync(PID_PATH, "utf8").trim()
      const pid = Number(pidStr)
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          ownerAlive = true
        } catch { /* dead */ }
      }
    } catch { /* no pid file */ }
    if (!ownerAlive) {
      fs.unlinkSync(SOCKET_PATH)
      try { fs.unlinkSync(PID_PATH) } catch { /* ok */ }
    }
  }
} catch {
  /* ok if not found */
}

// Signal handlers for clean shutdown
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.on("uncaughtException", (err) => {
  log(`Uncaught exception: ${err.message}`)
  // After uncaught exception, synchronous cleanup + exit is safest
  cleanupFiles()
  process.exit(1)
})

// Set restrictive umask before socket creation so the socket is never
// world-accessible (avoids TOCTOU race between listen() and chmod).
const prevUmask = process.umask(0o177) // creates files as 0o600
server.listen(SOCKET_PATH, () => {
  process.umask(prevUmask) // restore original umask
  try {
    fs.chmodSync(SOCKET_PATH, 0o600)
  } catch {
    /* belt-and-suspenders — umask already handled it */
  }
  // Write PID file only after socket is bound (avoids race with other instances)
  fs.writeFileSync(PID_PATH, String(process.pid), "utf8")

  log(`Server listening on ${SOCKET_PATH} (pid=${process.pid})`)
  log(`Model: ${MODEL}, dtype: ${DTYPE}, device: ${DEVICE}`)
  log(`Idle timeout: ${IDLE_TIMEOUT_MS / 60_000}min`)

  // Start idle timer + socket watchdog + memory watchdog
  resetIdleTimer()
  startSocketWatchdog()
  startMemoryWatchdog()

  // Begin loading the model (async, non-blocking)
  loadPipeline()
})
