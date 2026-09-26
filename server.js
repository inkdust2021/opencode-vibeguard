/**
 * Local-directory entrypoint for OpenCode V2.
 *
 * When a plugin is configured as a local directory path, OpenCode V2 resolves
 * `<dir>/server` (or `<dir>/index`) and ignores package.json `main`/`exports`.
 * Published npm consumers keep resolving through package.json `exports`
 * (`./src/index.js`); this shim only serves local `plugin: ["/path/to/dir"]`
 * setups, so both entry paths expose the same dual V1 + V2 module.
 */
export { default } from "./src/index.js"
export * from "./src/index.js"
