// Cross-package boundary: evm-sdk imports its chain-agnostic foundation through
// @privacy-pools-v2/core-sdk's PUBLIC surface (its own `index.ts`/`external.ts`), never by
// reaching into core-sdk's private `internal.ts` or a direct `core-sdk/src/...` path. This is a
// deliberate deviation from this package's own "always internal.ts" rule (see CLAUDE.md §1),
// which only governs INTRA-package imports — the dependency boundary between two packages goes
// through the dependency's published entry point instead, exactly like any other npm dependency.
export * from "@privacy-pools-v2/core-sdk";

export * from "./interfaces/index.js";
export * from "./types/index.js";
export * from "./services/index.js";
export * from "./schemas/index.js";
export * from "./constant/index.js";
export * from "./utils/index.js";
