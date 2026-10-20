# Testing Guide

## Version History
| Version | Date | Notes |
|---|---|---|
| 1.4.1 | 2026-10-15 | `packages/contracts` integration bullet: the deploy scripts deploy the verifiers with `vm.deployCode` from compiled artifacts; the GPL verifier sources are imported through the `verifiers/` remapping only by `src/verifiers/VerifierArtifacts.sol`. No test-surface change. |
| 1.4.0 | 2026-10-07 | `packages/evm-sdk` e2e: a plain local anvil instead of a Sepolia fork (no network access needed), a post-deploy snapshot, keep-alive opt-in (`EVM_E2E_KEEP_ALIVE=1`; infra is torn down by default), and test files run in parallel (4 workers by default, `EVM_E2E_WORKERS`), each worker on its own lane: an anvil started from the snapshot, a relayer and a mock ASP. |
| 1.3.0 | 2026-10-01 | Added the `packages/stellar-sdk` e2e bullet (`STELLAR_E2E=1`, local quickstart node + `contracts-stellar` deploy incl. local Blend v2 and the yield module) and the shared `packages/e2e-suite` conformance ladders it runs (new `yield` suite/capability, relayed-transfer rung, Stellar now covering `batchRelay`, `registerAndWithdraw` and `yield`). |
| 1.2.0 | 2026-09-24 | Documented the `packages/evm-sdk` per-operation e2e suite (`e2e/ops`, shared `globalSetup` infra, HTTP mock ASP from the new `packages/mock-asp`) and the new `packages/mock-asp` package's unit tests. |
| 1.1.0 | 2026-09-16 | Updated the `packages/sdk` section for the `core-sdk`/`evm-sdk`/`stellar-sdk` package split — each has its own `pnpm test` (typecheck + vitest). No change to any other package's section. |
| 1.0.0 | 2026-07-08 | Created during the v2.0 audit to resolve the dangling reference in `FEATURE_BEST_PRACTICES.md` §C and give auditors a single map of the test surface. |

This is the map an auditor (or contributor) needs to know **what is tested, how, and how to run it**
per package. Conventions themselves live in each package's `CLAUDE.md`; this guide covers the
cross-cutting testing bar and the real-proof-vs-mock distinction that the security posture depends on.

## The real-proof bar (most important)
The protocol's safety rests on Groth16 proofs. A test that uses a **mock verifier** proves the
plumbing, not the cryptography. For each user-facing flow there must exist at least one test that goes
through a **real Groth16 proof against the deployed `src/` contracts**. Mock-proof unit tests are for
breadth (error paths, access control, boundaries); real-proof integration tests are for the end-to-end
guarantee. When reading a "green suite," confirm which kind each test is — see
`agents/output/feature-check/USER_FLOW_MATRIX.md` for the per-flow classification.

> Pitfall observed in this codebase: real-proof integration tests that import **vendored copies** of a
> contract (`test/integration/helpers/**`) instead of `src/`. Those can drift from the deployed source
> and give false confidence. A real-proof test must exercise `src/`.

## `packages/contracts` — Foundry
- **Frameworks & selection.** `forge`. Tests are selected by contract-name substring:
  `pnpm test:unit` → `--match-contract Unit`; `pnpm test:integration` → `--match-contract Integration`;
  `pnpm test:invariant:ci` / `:campaign` → `--match-contract Invariant`.
  A test contract whose name lacks the selector substring **is silently never run** — verify new
  suites are actually selected.
- **Unit** (`test/unit/*`): mock verifiers (`test/unit/helpers/ProofUtils.sol`, `vm.mockCall`), one
  BTT `.tree` per suite (`bulloak check` in CI), `test_<Fn>_<Condition>` naming, `bound()` over
  `vm.assume`, `stdstore` for state setup, `vm.mockCall`+`vm.expectCall` for dependencies.
- **Integration** (`test/integration/*`): real Groth16 proofs via FFI + snarkjs
  (`test/helpers/ProofGenerator.sol` → `test/helper/*.mjs`), verifiers deployed by the deploy
  scripts with `vm.deployCode` from the artifacts that `src/verifiers/VerifierArtifacts.sol` compiles out of
  `../circuits/build/` (through the `verifiers/` remapping). Most fork mainnet/Sepolia —
  they need an archive RPC.
- **Invariant** (`test/invariant/*`): handler-based property suite over the real PoolVault with real
  proofs; profiles `invariant-ci` (smoke) and `invariant-campaign` (24h).
- **Run:** `forge build`; `forge test`; fork tests need `MAINNET_RPC` (+`SEPOLIA_RPC`) in
  `packages/contracts/.env` (git-ignored). Pinned mainnet fork block is in `IntegrationBase.t.sol`.
- **Quality:** `forge coverage` (informational — no CI gate), `slither-mutate` (manual mutation
  testing, per `packages/contracts/CLAUDE.md`), `solhint` + `bulloak check` in CI.

## `packages/core-sdk`, `packages/evm-sdk`, `packages/stellar-sdk` — vitest
The former monolithic `packages/sdk` is split into three packages, each with its own `pnpm test` =
`pnpm typecheck && vitest run`. `it()` starts with a **verb**, never `"should"`.
- **`packages/core-sdk`** — chain-agnostic services and sessions. Unit tests in `test/unit/**`.
- **`packages/evm-sdk`** — EVM concrete implementations (crypto, proving, relayer, chain adapters,
  stealth, yield). Unit tests in `test/unit/**` (incl. `test/unit/stealth/`), integration in
  `test/services/*.integration.test.ts`, fixtures in `test/fixtures/**`.
- **`packages/stellar-sdk`** — Stellar/Soroban concrete implementations. Unit tests in `test/unit/**`,
  integration in `test/services/**`.
- **`packages/evm-sdk` e2e (`e2e/`, local anvil — not in the default `pnpm test`).** `EVM_E2E=1 pnpm --filter @privacy-pools-v2/evm-sdk test:e2e` runs one test file per product operation in `e2e/ops/` (`00-config` … `17-reshield-crosschain`). Each file is a set of *ladders*: call the operation in the worst state, assert the specific failure, satisfy one requirement, retry, and finish on a success assertion. Files are independent — each creates its own fresh actors — and run in parallel, 4 workers by default (`EVM_E2E_WORKERS`; `1` runs them one after another; the `test:e2e:single` / `test:e2e:parallel` scripts pin 1 / 4). Infrastructure is started **once** per run by vitest `globalSetup` (`e2e/setup/global-setup.ts`): per worker a *lane* of its own (`e2e/lanes.ts`) — a plain anvil holding the deployed contracts (`EVM_E2E_FORK_URL` forks instead), a local relayer and a mock ASP — since files sharing a chain would race on its latest ASP root and keystore root. Every anvil starts from the same post-deploy snapshot (`e2e/deployments/anvil-state-<hash>.json`, written by the first deploy; `EVM_E2E_SNAPSHOT=0` deploys from scratch). Sessions reach the ASP over real HTTP (`aspUrl` → `HttpASPDataProvider`). Run a single file with `… test:e2e e2e/ops/07-withdraw.e2e.test.ts`. Needs `forge`/`anvil` and built circuit artifacts. The anvils and relayers a run started are torn down after it (`EVM_E2E_KEEP_ALIVE=1` leaves them running, for a later run to reuse); `EVM_E2E_RELAYER_WATCH=1` starts the relayer in `nest --watch` mode instead of the default one-shot start. See `packages/evm-sdk/e2e/TEST_MATRIX.md` for the per-file coverage and known findings.
- **`packages/e2e-suite`** — the chain-agnostic conformance ladders every chain SDK runs against a real chain, a real relayer and the HTTP mock ASP (see its README). A chain supplies a driver and opts out of capabilities it lacks, with a reason. Suites include deposit, transfer (incl. a relayed-transfer rung), withdraw, batch withdraw (`batchRelay`), keystore / register-and-withdraw (`registerAndWithdraw`, driver member `drainedNativeBalance`: 0 on EVM, the base reserve on Stellar) and **`yield`** (driver members `yieldOf`, `sessionWithoutYield`, `yieldShare`, `yieldUnderlying`, `emptyAddress`, `fundUnderlying`, `yieldWithdrawalQuote`, `relayYieldWithdrawal`).
- **`packages/stellar-sdk` e2e (`e2e/`, local Stellar node — not in the default `pnpm test`).** `pnpm --filter @privacy-pools-v2/stellar-sdk test:e2e` (sets `STELLAR_E2E=1`; `test:e2e:suite` also tears down) runs the shared `e2e-suite` ladders against Stellar. `globalSetup` starts (or reuses) the local quickstart node (`packages/contracts-stellar/scripts/local-stellar.sh`, docker, RPC on `localhost:8000`) and deploys/initializes the contracts via `contracts-stellar/scripts/deploy/ensureDeployed.mts`, plus a local relayer and the mock ASP. The **yield** suite needs the yield module on the network: run `node scripts/blend/deploy-local-blend.mts` (real Blend v2 protocol + an XLM reserve, writes `scripts/deployments/local.blend.json`) and then `node scripts/deploy/deploy-yield.mts --network local` in `packages/contracts-stellar`; without it `yield` is reported as an explained skip. Stellar supports `batchRelay`, `registerAndWithdraw` and `yield`; `paymentRequests` is opted out (EVM-address-shaped service). `STELLAR_E2E_KEEP_ALIVE=0` tears the relayer down, `STELLAR_E2E_RELAYER_WATCH=1` runs it in watch mode, `STELLAR_E2E_NETWORK=testnet` points read-only at the testnet deployment (no second test asset there). Needs the `stellar` CLI, docker and built circuit artifacts.
- **`packages/mock-asp`** — the mock Association Set Provider the e2e uses (chain-agnostic HTTP server + EVM adapter; spec: `docs/tech-design/mock-asp/`). Unit tests (`pnpm --filter @privacy-pools-v2/mock-asp test`, no chain needed) drive the real `HttpASPDataProvider` + `HTTPClient` against the in-process server: every endpoint, every fault mode, scoping, CORS, and root/leaf consistency against an independent Poseidon/Merkle computation.
- **Real proofs:** a few integration tests (mainly in `packages/evm-sdk`) generate real Groth16
  witnesses/proofs (snarkjs + `.wasm`/`.zkey`), gated behind `describe.skipIf(!existsSync(...))` on
  the circuit artifacts, and the `scripts/e2e-yield/*` live-fork E2Es (env-gated, outside the default
  suite). Everything else uses a mock prover.

## `packages/relayer` — jest
- `pnpm test` = `jest` (`rootDir: src`, `*.spec.ts`, `jest-mock-extended` mocks). In-process,
  no live HTTP. Validation flows: pipe → zod schema → service → chain service.
- **E2E:** `packages/relayer/e2e` is a separate vitest package running against a docker-compose'd anvil
  + live relayer with real proofs (`relayer-e2e.yml`, not in the default `pnpm test`).

## `packages/circuits` — mocha
- `pnpm --filter circuits test` runs constraint + benchmark tests; CI also runs `circomspect` and a
  verifier-drift gate (`git diff --exit-code` on the generated `groth16_verifier.sol`).

## Per-function bar (from `CLAUDE.md`)
Every function: happy path · one test per error/revert/`@throws` · access control · boundaries
(0, 1, MAX-1, MAX). Test order: happy → errors → access control → boundaries → edge cases.
Fix a failing test by running it in isolation first (`--match-test` / `-t`), confirm, then the suite —
don't re-run the whole suite after every change.
