#!/usr/bin/env node
/**
 * Pre-download the Privacy Filter model so it's cached locally before runtime.
 * Runs automatically via `npm install` (postinstall).
 *
 * If @huggingface/transformers isn't installed or the download fails,
 * this script exits 0 (success) so it never breaks `npm install`.
 */

const MODEL = process.env.VIBEGUARD_AI_MODEL || "openai/privacy-filter"
const DTYPE = process.env.VIBEGUARD_AI_DTYPE || "q4"

async function main() {
  let transformers
  try {
    transformers = await import("@huggingface/transformers")
  } catch {
    // transformers not installed (optionalDependency) — nothing to download
    return
  }

  console.log(`[vibeguard] Downloading AI model: ${MODEL} (dtype=${DTYPE})...`)
  console.log("[vibeguard] This is a one-time download (~400MB for q4). Please wait.")

  const start = Date.now()
  try {
    const pipe = await transformers.pipeline("token-classification", MODEL, {
      dtype: DTYPE,
      device: "cpu",
    })
    // Dispose immediately — we only needed to trigger the download/cache
    if (typeof pipe.dispose === "function") await pipe.dispose()
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`[vibeguard] Model downloaded and cached successfully (${elapsed}s).`)
  } catch (err) {
    console.log(`[vibeguard] Model download failed: ${err.message}`)
    console.log("[vibeguard] The model will be downloaded on first use instead.")
  }
}

main().catch(() => {})
