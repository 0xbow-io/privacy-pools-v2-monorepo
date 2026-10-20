// `@privacy-pools-v2/e2e-suite/setup` — for `globalSetup` modules, which run in vitest's main process and
// therefore must not import the package root (it imports vitest's runtime, which needs a worker).
export * from "./core/globalSetup.js";
