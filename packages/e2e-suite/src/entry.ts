/**
 * The test entry every suite shares. `tsup.config.ts` builds this one file once per suite name, with
 * `__E2E_SUITE__` replaced by that name, into `dist/entries/<name>.js`; `defineChainVitestConfig` lists those
 * files as the chain's tests. The chain is injected by alias: the chain's vitest config points `@e2e/chain`
 * at its module, whose default export is its `defineChainE2E(...)` result.
 */
import chain from "@e2e/chain";

import type { SuiteName } from "./suites/names.js";
import { suites } from "./suites/index.js";

declare const __E2E_SUITE__: SuiteName;

suites[__E2E_SUITE__](chain);
