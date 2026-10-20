# EVM SDK e2e — coverage matrix

Status (2026-09-25): **21 files (18 operations, 3 of them with an `.evm` companion), 245 tests, all passing in one `vitest run` (~22 min, infra started once).** Ten operations run the shared ladders from `@privacy-pools-v2/e2e-suite`.
This document replaces the earlier draft matrix; the tests are now the source of truth, and this file
maps them, records what they found, and lists what is deliberately not covered yet.

## How the suite works

Each file is a set of **ladders** for one operation. A ladder calls the operation in the worst state,
asserts the *specific* failure, satisfies exactly one requirement, and retries, ending on a success
assertion with balance / state / on-chain checks. Rung order follows the SDK's actual check order (for
a spend: note exists → note ACTIVE → keystore registered → amounts/params → on-chain state).

- **The chain-agnostic ladders are shared.** Eleven operations (marked † below) live in `@privacy-pools-v2/e2e-suite`
  (`packages/e2e-suite`) and have no file in `e2e/ops`: `e2e/vitest.config.ts` (`defineChainVitestConfig`) runs the
  suite's built entries alongside the EVM-only files. The suite holds every assertion and speaks only core-sdk
  types/errors; the EVM SDK supplies the chain-specific parts through a driver (`e2e/driver/EvmDriver.ts`, declared to
  the suite in `e2e/chain.ts`). A new chain implements a driver and gets the same ladders — see that package's README. EVM-only rungs of a shared operation sit in a companion file
  (`NN-name.evm.e2e.test.ts`); LiFi/EVM-shaped operations (yield, stealth, swaps, reshield,
  builder config) have not been lifted and stay entirely here.
- **One file per operation**, run in parallel — 4 workers by default (`EVM_E2E_WORKERS`; `1` runs them one after
  another). Files are independent: each creates its own fresh actors (random keys, own funding).
- **One lane per worker** (`e2e/lanes.ts`). Files can't share a chain: a proof must be built against the
  ASPRegistry's latest root (`PoolVault_InvalidASPRoot` otherwise), so another file's ASP approval landing mid-proof
  breaks it, the keystore root moves the same way, and mock ASP faults are global to its server. Each lane is its
  own anvil on port `8545 + lane` (all started from the same snapshot, so the contracts sit at the same addresses
  on every lane), its own mock ASP, and its own relayer on port `3210 + lane` (a relayer holds one RPC per chain
  id). A worker (`VITEST_POOL_ID`) runs its files one after another, so a lane is never used by two files at once.
- **Shared infrastructure, started once** by vitest `globalSetup` (`e2e/setup/global-setup.ts`, built with the suite's
  `defineChainGlobalSetup`), per lane: a
  plain anvil (Sepolia chain id, canonical Poseidon/Announcer code from `fixtures/canonical-code.json`;
  `EVM_E2E_FORK_URL` forks instead) with the deployed contracts, a relayer, and a mock ASP.
  Speed knobs: a fresh anvil starts from `e2e/deployments/anvil-state-<hash>.json` (`anvil --load-state`; the chain
  right after a deploy, keyed on the contracts and deploy script — lane 0 deploys and writes it when missing, the
  other lanes start from it; `EVM_E2E_SNAPSHOT=0` deploys from scratch on every lane); the relayers run `node dist/main`, rebuilding only when their sources
  are newer; sessions and the test client poll
  every 100 ms (`E2E_POLLING_INTERVAL_MS`) instead of viem's 4 s. Only serializable connection
  info crosses to the test workers (`provide`/`inject`).
- **The ASP is real HTTP.** Sessions are built with `aspUrl`, so every spend goes through
  `HttpASPDataProvider` → `HTTPClient` → `packages/mock-asp`'s server, which publishes roots to the
  on-chain `ASPRegistry`. Tests drive it through its `/admin` API (approve, revoke, hold back a root,
  inject faults) via `harness/asp.ts`.
- **Harness** (`e2e/harness/`): `actors` (random / signature-derived / unfunded accounts), `sessions`
  (self-submit, relayed, raw config, relayer client), `chain` (finality, balances, `fromBlock`
  capture), `asp` (re-exports the chain-agnostic `AspAdminClient` from `@privacy-pools-v2/mock-asp`), `context`
  (`inject` wrapper). The driver is a thin adapter over these.

Run: `pnpm --filter @privacy-pools-v2/evm-sdk test:e2e` (all, 4 workers; build `e2e-suite` first; `test:e2e:single` /
`test:e2e:parallel` pin 1 / 4 workers). Pass a substring of the file path to run single suites (`test:e2e withdraw`,
`keystore`, `13-stealth`, …).
The anvils + relayers a run started are torn down afterwards; `EVM_E2E_KEEP_ALIVE=1` leaves them up for re-runs
(a later run reuses them, chain state and all).

## Coverage by file

† = shared ladder from `@privacy-pools-v2/e2e-suite` (no file here); its EVM-only rungs, where any, are in the
`NN-name.evm` companion file named in the row. Test names of the shared rungs are chain-neutral (e.g. "token
deposit", not "ERC-20 deposit").

| File | Tests | Ladders |
|---|---|---|
| `00-config` | 10 | builder validation (unsupported chain, bad RPC url, short key, double `create()`, wrong wallet account / chain, no relayer); unreachable RPC; non-contract Entrypoint; missing circuits dir |
| `01-asp-http` † (+ `.evm`: empty snapshot at the deployment block, note-events 501) | 11 | roots published on-chain match the ASP; revoke shrinks the root and reports `rejected`; honest empty snapshot; note-events 501; entrypoint scoping; CORS preflight; admin fault state; a session discovers through `aspUrl` |
| `02-keystore` † | 26 | register (tamper refusal, unfunded fail → fund → same prepared txs succeed, viewing key published, idempotent repeat); partial registration + resume; relayed-registration signing and deadline guard; rotation (index discovery, gap limit, stale-key spend fails as a witness error, rehydrated session spends) |
| `03-deposit` † (+ `.evm`: approval / allowance / approval-tx tamper, deposit without approval) | 26 | validation (`InvalidDepositParams`, `AssetNotEnabled`, `BelowMinimumAmount`); unfunded native / zero-balance ERC-20 fail → fund → same prepared result succeeds; approval and deposit tx tamper refusal; allowance reuse; `depositFor` with/without recipient viewing key; own deposit discoverable with no registration |
| `04-swap-deposit` | 9 | native deposit composed through the mock LiFi Executor (`withSwapExecutor`); no provider; zero fallback / cross-chain w/o source chain; swap-quote provider failure; non-allow-listed router; unfunded → mint → success with router-reserve, surplus-refund and empty-executor accounting |
| `05-yield` † (+ `.evm`: one underlying approval + deposit tx, deposit without approval / without underlying reverts → mint → shielded) | 47 | the shared ladder runs twice — over ppyUSDC (ERC-20 `yUSDC`) and over ppWETH (native-mode `PPRouter`, deposits funded with ETH, payouts in ETH). Each: sizing/amount errors; budget sizing fits the quote; cap below quote; shield spends ≤ the cap (ETH: plus gas) and exactly the sized shares → ASP-approved ACTIVE; note valued at the live share rate; yield-withdraw parameter validation; ETH only: a withdrawal to a contract that rejects ETH fails and leaves the note spendable; **withdraw to underlying** self-submitted (within the slippage band, note SPENT) and relayed with the router as processor (expired / wrong-asset / wrong-amount commitments refused, relayer delivers ≥ the guaranteed floor) |
| `06-asp-approval` † | 8 | ASP down / 500 / malformed JSON / bad leaves / leaves ahead of the published root → spend refused, note untouched → ASP healthy → spend succeeds |
| `07-withdraw` † | 23 | unknown note; PENDING; approved-but-not-rescanned; **unregistered → `KeystoreNotRegistered`**; over-amount, wrong token, duplicate input, bad recipient; full withdraw; double spend (local + stale-session on-chain revert); relayed with/without fee headroom; gasless `registerAndWithdraw` (unregistered, 0 ETH) incl. expired deadline and already-registered |
| `08-batch-withdraw` † (+ `.evm`: `MAX_BATCH` matches the contract) | 8 | `MAX_BATCH` matches the contract; empty / PENDING-only selection; dust batch refused by the relayer quote; relayed two-item batch; self-submitted batch |
| `09-transfer` † | 10 | over-amount; unregistered recipient refused; transfer to a registered recipient (discovery, change note, recipient spends); out-of-band delivery (opt-in, secrets returned, scan finds nothing, import → ACTIVE → register → spend) |
| `10-discovery` † | 9 | own deposit without registration; right address / wrong viewing key finds nothing; idempotent rescan; scan from a later block; export/import round trip + owner mismatch; unreachable RPC; ASP snapshot down |
| `11-ragequit` † | 16 | unapproved note exits; **unregistered → `KeystoreNotRegistered`**; EXIT_PENDING → EXITED; repeat refusal and `allowUnconfirmedExit`; revoked-label note (withdraw fails, ragequit recovers); non-owner submission reverts on-chain |
| `12-swaps-reshield` | 9 | quote lies (wrong token, wrong chain, wrong recipient calldata); reshield estimate without provider / into a non-enabled asset; full withdraw-and-swap through the relayer |
| `13-stealth` | 13 | scheme/curve/announcer refusals, garbage announcement = non-match; derive → announce on the canonical ERC-5564 Announcer → read logs → scan → derived key controls the address and can spend |
| `14-payment-requests` † | 11 | request creation (bad token, slots); **zero-amount request is accepted (`it.fails`)**; expired request refused before spending; pay → recipient with no registration and no gas finds it by tag; a fresh session finds nothing, a session restored from an earlier export does; spend refused before registering (`KeystoreNotRegistered`), succeeds after |
| `15-reshield` | 8 | same-chain reshield: estimate, destination deposit; lying quotes (`DepositTargetMismatch`, `LiFiDepositCalldataNotFound`, `SwapQuoteMismatch`); relayed reshield leaves RelaySwaps at 0, source SPENT, headroom returns as an ACTIVE change note, the new note is PENDING then ACTIVE once the ASP approves it |
| `16-relayer-faults` † (shared `relayerFaults` suite) | 14 | a fault-injecting proxy in front of the real relayer: batch-quote faults (down / 500 / hang / non-JSON / already-expired → `RelayerRequestFailed`, `FeeCommitmentExpired`); a quote that lapses before use, signed routing paying another recipient, an inflated top-level `amountSent` (all refused locally, before proving); a nested `amountSent` mismatch left to the relayer (`RelayerRejected`); submission rejected; an unrelated tx hash returned as success (note stays ACTIVE, nothing persisted); the same note then spends once the relayer behaves |
| `17-reshield-crosschain` | 12 | destination is an ERC-20 (`MockRouter.swapERC20AndCall`); a plain native-coin destination deposit is refused with `NativeDestinationDepositUnsupported` (LiFi sends its guaranteed delivery as msg.value, so it can never land); unsupported destination chain and non-enabled destination asset; tampered destination deposit target; dust-rescue recipient conflict; stripped bridge calldata; wrong bridge token; sized in-contract gas swap (B2); relayed cross-chain reshield leaves RelaySwaps at 0 and the destination note is discoverable |

## Findings (behaviour the suite pinned that you may want to act on)

1. **Spend/ragequit without a keystore (fixed).** Was a generic `WitnessPreparationFailed` wrapping a
   Merkle `LeafNotFound`; now `KeystoreNotRegistered`, thrown before any leaves are fetched
   (`TransactOrchestrator.prepareTransact`, session owner; `prepareRageQuit`, note owner;
   register-and-withdraw exempt). A registered account with wrong/rotated keys still fails as
   `WitnessPreparationFailed` (asserted in `02-keystore`). Spec Guardian: EXTENSION, approved; docs synced.
2. **Same-session partial-registration resume (fixed).** After `registerKeystore({ includeViewingKey: false })`,
   calling `registerKeystore()` again in the same session submitted the viewing-key tx and then threw
   `AlreadyRegistered` from `KeystoreManager.markRegistered`. `executeRegisterKeystore` now marks the manager only
   when it is not already marked. Covered by `02-keystore` (regression) and unit tests.
3. **Verify-everything-before-signing-anything (fixed).** `executeDeposit` used to verify `depositTx` only after
   the approvals were mined (a tampered deposit tx was refused but a genuine allowance was already on-chain), and
   `executeRegisterKeystore` verified the viewing-key calldata only after `setAuthPolicy` was on-chain. Both now
   verify every transaction first. Covered by `03-deposit` (allowance stays `0`) and unit tests. Swap-and-deposit
   already behaved this way.
4. **Doc/code drift on cold start (fixed in the docs).** `user-flows.md` §1.3/§3.3, `pool-session.md` and
   `core-sdk-tech-design.md` said `prepareTransfer` silently downgrades to out-of-band delivery for an unregistered
   recipient; the code refuses with `RecipientViewingKeyUnregistered` unless `allowOutOfBandFallback: true`. The docs
   now match the code (`09-transfer` pins it).
5. **`prepareSwapAndDeposit` throws synchronously** when no provider is configured (the method returns a
   Promise), so `.catch()` never sees it. Pinned in `04-swap-deposit`.
6. **Provider errors are not wrapped.** The session propagates whatever the swap provider throws;
   `SwapAndDepositQuoteFailed` exists but only the aggregator-backed provider raises it.
7. **`ASPLeavesRootMismatch` is flattened.** The ASP client's provider aggregator reports it as
   `ASPUnavailable("All providers failed: … leaves root mismatch …")`, so callers can match only the message.
8. **The builder demands a relayer config or a `RelayerInteractor` override even for self-submit sessions.**
9. **`prepareSwapQuote` without a provider raises `InvalidTransactParams`**, while the session facade declares
   `SwapQuoteProviderBaseError` for the same condition.
10. **A dust batch never reaches the SDK's `InfeasibleBatchFee`:** the relayer's quote endpoint refuses first
    (HTTP 400 → `RelayerRequestFailed`), so that SDK check has no e2e coverage.
11. **A zero-amount payment request is accepted** (with the default five slots). Pinned with `it.fails` in
    `14-payment-requests`; it should probably be `InvalidPaymentRequestParams`.
12. Informational: payment-request notes are owned by the recipient's own address (not addressless), so they
    can be spent and ragequit like any other note once the recipient registers; a relayed yield withdrawal
    needs `amountOut` to equal the relayer-signed `amountSent` (gross shares including the fee).
13. Informational: the SDK validates a relayed withdrawal quote's top-level `amountSent` (what the proof commits
    to) but not the copy nested in `feeCommitment`; an inconsistent nested value is caught only by the relayer's
    signature check (`RelayerRejected`). No funds are at risk, since the proof binds the top-level amount. The
    yield relay path does validate the nested field.
14. Informational: ragequit can only be submitted by the note's owner (`PoolVault_InvalidOwnerAddress`);
    a relayed withdrawal must leave fee headroom in the note or it fails with `InsufficientTransactValue`.

## Not covered yet (and why)

- **Cross-chain reshield**: covered except `DestinationDepositUnaffordable` (needs Stargate-shaped calldata for the
  budget check to fire; unit-tested only), the yield-share *output* variant, and `RelayFeeExceedsMax` (needs the
  deployer key to lower a token's `maxRelayFee` on the shared Entrypoint).
- **Payment requests**: recipient-side expiry (not configurable through the builder), multi-slot exhaustion
  and contacts / targeted scan are not covered.
- **Relayer faults** are covered for quotes, submission and lying replies via the proxy; not covered: faults on
  transfer / swap / register-and-withdraw endpoints (same mechanism, just more rungs) and a *real* short quote
  TTL (the proxy rewrites `expiration`, which exercises the SDK's own check but not the relayer's).
- **Contract-level `BatchTooLarge`** via a direct `relayBatch` with dummy items (check runs before proof
  verification; not written), and the SDK-side `InfeasibleBatchFee` (finding 10).
- **`mock-asp` chain-served data**: `EvmAspEventSource` (real `note-events` / full event snapshot from chain
  logs) was not built; the EVM adapter serves an honestly empty snapshot through the deployment block and
  leaves note-events unimplemented, so discovery falls back to scanning the chain.
- Smaller rungs: `WalletNotAvailable` on relayed registration without a wallet, USDT-style zero-reset
  approvals, `purgePhantomNotes`.
- **Code coverage was not measured**: no coverage provider (`@vitest/coverage-v8`) is installed in the
  workspace; adding one is a dev-dependency/lockfile change.

## Adding a file

- **A ladder for an operation every chain has** goes in `packages/e2e-suite/src/suites/<op>.ts` (see that
  package's README, "Adding a ladder"); it then runs for every chain. Use `driver.*` for anything chain-specific and add
  a driver hook rather than a branch when the chain needs to answer something new.
- **An EVM-only ladder** is a new `e2e/ops/NN-name.e2e.test.ts` (or `NN-name.evm.e2e.test.ts` beside a shared
  suite); guard with `describe.skipIf(!EVM_E2E)`; build actors and sessions with the harness; call `captureFromBlock`
  in `beforeAll` and pass it as `fromBlock` so scans do not grow as the shared chain grows; call
  `ctx.asp.clearFaults()` in `afterEach` if the file injects ASP faults; keep test names verb-first. Never depend on
  another file's notes or actors.
