/**
 * DEV-ONLY TOOLING — NOT SHIPPED SDK CODE.
 *
 * The standalone mock ASP moved to `packages/mock-asp` (chain-agnostic server + EVM adapter, see
 * docs/tech-design/mock-asp/mock-asp-tech-design.md). This file only forwards, so the existing
 * `npx tsx scripts/local-mock-asp/server.ts` workflow (same env vars, same :3001) keeps working.
 * Prefer: `pnpm --filter @privacy-pools-v2/mock-asp start:evm`.
 */
import "../../../mock-asp/src/cli/evm.js";
