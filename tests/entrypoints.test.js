import test from "node:test"
import assert from "node:assert/strict"

/**
 * OpenCode V2 resolves a local *directory* plugin through `<dir>/server` (or
 * `<dir>/index`) and ignores package.json `main`/`exports`. These shims must
 * therefore re-export the same dual V1 + V2 module as `src/index.js`.
 */
for (const entry of ["../server.js", "../index.js"]) {
  test(`local dir entry ${entry} re-exports the V2 default`, async () => {
    const mod = await import(entry)
    assert.equal(typeof mod.default, "object")
    assert.equal(typeof mod.default.id, "string")
    assert.equal(typeof mod.default.setup, "function")
    assert.equal(typeof mod.VibeGuardPrivacy, "function")
  })
}
