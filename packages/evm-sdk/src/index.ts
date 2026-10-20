export * from "./external.js";
// core-sdk is external to this bundle, so esbuild cannot list its exports at build
// time. An `export *` from it that sits below the entry (external.ts) is emitted as a
// runtime copy onto an internal object, and the entry's real export list drops every
// name behind it: NoteStatus, PoseidonHashService, RPCInteractorBaseError... came out
// `undefined` from the built dist (ESM and CJS) while the src-based tests passed.
// At the entry itself the star stays a real re-export. test/built/reexports.test.ts
// checks the built output.
export * from "@privacy-pools-v2/core-sdk";
