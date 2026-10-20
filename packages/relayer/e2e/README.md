# E2E Tests

## Local Setup

Two things are needed before proof-related e2e tests can run locally:

### 1. SDK (`@privacy-pools-v2/evm-sdk`)

The SDK is declared as a `workspace:*` dependency in `package.json`, so it resolves automatically via the pnpm workspace. Just run `pnpm install` from the repo root and the SDK will be linked locally — no tarball build required.

### 2. Circuit Artifacts

Place the following circuits in `packages/relayer/e2e/circuit-artifacts/`:

- `deposit/`
- `transact_1x1/`
- `transact_1x2/`

Each directory needs the WASM and zkey files (e.g. `deposit_js/deposit.wasm`, `groth16_pkey.zkey`, `groth16_vkey.json`).

Sources:
- Copy from `v2-monorepo/packages/circuits/build/` after building circuits
- Or extract from the `circuit-artifacts-*.tar.gz` attached to a v2-monorepo pre-release

## Running

```bash
# Run all e2e tests in Docker (anvil fork + relayer + tests)
pnpm --filter e2e docker

# Run specific test suites
pnpm --filter e2e test:quote
pnpm --filter e2e test:details
```

## CI

The GitHub Actions workflow (`.github/workflows/e2e.yaml`) automatically fetches circuit artifacts from v2-monorepo pre-releases. The SDK is resolved via the pnpm workspace and does not need separate installation in CI.
