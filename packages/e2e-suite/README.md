# @privacy-pools-v2/e2e-suite

The chain-agnostic behavioural ladders every chain SDK (evm-sdk, stellar-sdk, …) must satisfy, run against a
real chain, a real relayer and the real HTTP mock ASP. A chain supplies a **driver** (funding, wallets, sessions,
a few chain reads); the suites hold every assertion and speak only core-sdk types and errors.

Dev/test tooling — private, never shipped. The coverage map for EVM lives in
`packages/evm-sdk/e2e/TEST_MATRIX.md`; the mock ASP it drives is `packages/mock-asp`.

## How a chain plugs in

vitest's `globalSetup` runs once in the main process and can only `provide()` serializable values; test files
run in forked workers. So a chain contributes three small things:

| Piece | Runs | What it does |
|---|---|---|
| `globalSetup` module — `defineChainGlobalSetup({ id, enabled, start })` from `@privacy-pools-v2/e2e-suite/setup` | main process, once | starts (or reuses) the node + deployed contracts, relayer and mock ASP (`startEvmMockAsp`, a Stellar adapter later); returns a serializable handle and a teardown for only what it started |
| `defineChainE2E({ name, enabled, unsupported, createDriver })` | each test file | declares the chain to the suites; `createDriver` runs in `beforeAll` and builds the driver from `injectHandle(id)` |
| the driver — `ChainE2EDriver` (+ the members of each supported capability) | each test file | everything chain-specific the suites call |

Import rule: a `globalSetup` module must import `@privacy-pools-v2/e2e-suite/setup` (no vitest runtime); test
files import the package root.

### Capabilities are opt-out

Every suite runs on every chain unless the chain lists the capability it lacks, with a reason:

```ts
export const stellarE2E = defineChainE2E({
  name: "stellar",
  enabled: process.env.STELLAR_E2E === "1",
  unsupported: { token: "no second test asset yet", keyRotation: "not implemented on Stellar" },
  createDriver: () => new StellarDriver(injectHandle("stellar-e2e")),
});
```

An opted-out suite/group renders as an explained `skip` in the report. Each capability owns the driver members its
suites use (`CapabilityMembers` in `src/core/driver.ts`), and the type of `createDriver` requires the members of every
capability **not** listed, so a chain cannot claim support and omit a hook — that is a compile error. A ladder
added to the suite later therefore reaches every chain; a chain that is not ready must opt out explicitly.

| Capability | Members the driver must provide | Suites/groups it gates |
|---|---|---|
| `relayer` | `relayerUrl`, `relayedSession`, `withdrawalQuote`, `rerouteFeeCommitment`, `sendUnrelatedTransaction` | relayed withdraw, batch withdraw, relayer faults |
| `registerAndWithdraw` | `verifyRelayedRegistration` | gasless register-and-withdraw, relayed-registration signing |
| `keyRotation` | `keysAtIndex` | revocable-key rotation and discovery |
| `token` | `tokenAsset`, `mint` | non-native token deposits / spends |
| `paymentRequests` | — | payment requests |
| `batchRelay` | — | batched withdrawal of several notes in one transaction |
| `yield` | `sessionWithoutYield`, `emptyAddress` | the yield suite as a whole |
| `yieldNative` | `nativeYield` (an `E2EYieldAsset`) | the yield ladder over the native coin (ETH via WETH, XLM) |
| `yieldToken` | `tokenYield` (an `E2EYieldAsset`) | the yield ladder over a non-native token (ERC-20, classic asset) |

Not a capability: a *behavioural* difference (a different revert reason, a chain-mechanics ladder such as ERC-20
allowances). Those are driver hooks (`revertReasons`, `tamper`) or chain-specific test files next to the chain SDK.

## Running the suites for a chain

A chain writes **no test files for the shared suites**. The package builds one test entry per suite
(`dist/entries/<name>.js`, from one `src/entry.ts` with the suite name baked in) and the chain's vitest config lists
them:

```ts
// packages/evm-sdk/e2e/vitest.config.ts
import { defineChainVitestConfig } from "@privacy-pools-v2/e2e-suite/vitest";

export default defineChainVitestConfig({
  chain: "e2e/chain.ts",                    // default export = its defineChainE2E(...); aliased as @e2e/chain
  globalSetup: "e2e/setup/global-setup.ts",
  include: ["e2e/ops/**/*.e2e.test.ts"],    // chain-specific files that stay in the SDK (optional)
});
```

`defineChainVitestConfig` also sets what a local node needs: `globalSetup`, `pool: forks`, by default one worker with
files one after another (`workers: n` runs n files at once — only when the chain gives every worker infrastructure of
its own, keyed by `VITEST_POOL_ID`, since files sharing a deployment race on its ASP and keystore roots; the EVM
chain does this with one lane per worker), and generous `testTimeout`/`hookTimeout` (real Groth16 proofs; node boot + deploy on
a first run; override with `testTimeout` / `hookTimeout`). One file per suite keeps a fresh worker between suites, a
report per suite, and single-suite runs:

```sh
pnpm test:e2e                       # everything: shared suites + the chain's own files
pnpm test:e2e:suite withdraw        # one suite; a substring of the file path (see below), infra torn down after
pnpm test:e2e:suite discovery ragequit
```

The argument is vitest's file filter, a substring of the path: `withdraw` matches the `withdraw` entry and any chain file
with that word in its name; use `entries/deposit` to avoid also matching a chain's `swap-deposit` file. Build first
(`pnpm --filter @privacy-pools-v2/e2e-suite build`, or `dev` to watch) — the entries are built files.

## Implementing a new chain — checklist

1. **globalSetup**: `defineChainGlobalSetup` with `start()` that boots the chain, deploys, starts the relayer and the
   chain's mock-ASP adapter (`packages/mock-asp`: an `AspRootPublisher` + optional `AspChainEventSource`), and returns
   `{ handle, stop }`. Honour the chain's opt-in env var so a bare `vitest run` stays inert.
2. **Driver**: implement `ChainE2EDriver`. Sessions must be built with the mock ASP's URL (`aspUrl`) so every spend goes
   through the real HTTP path. Express amounts as multiples of `assets.native.unit` (0.001 ETH on EVM; pick the chain's
   equivalent so a suite "20 units" is comfortably above the minimum deposit and the relayer fee).
3. **`chain.ts`**: `defineChainE2E` with `unsupported` for what you cannot do and the capability members for the rest;
   `export default` it.
4. **`vitest.config.ts`**: the `defineChainVitestConfig` call above, and a `test:e2e` / `test:e2e:suite` script.
5. Run one suite at a time first (`aspApproval`, `discovery` need the fewest capabilities), then the rest.
6. A rung that fails only on your chain is either a real adapter bug (fix the SDK) or a legitimate divergence —
   in which case add a driver hook or a capability, never an `if (chain === …)` in a suite.

## Adding a ladder

Add it to the suite that owns the operation (`src/suites/<op>.ts`), as a rung that calls the operation in the worst
state, asserts the *specific* failure, satisfies exactly one requirement and retries. Use `driver.*` for everything
chain-specific; keep test names verb-first; capture `driver.currentBlock()` in `beforeAll` and pass it as `fromBlock`
so scans do not grow as the shared chain grows; never depend on another file's notes or actors. If the ladder needs a
new chain hook, add it to `ChainE2EDriver` (or a capability's members) so every chain is forced to answer.

## Suites

A new suite = its file in `src/suites/`, its name in `src/suites/names.ts` (`SUITE_NAMES`) and its entry in the `suites`
registry (`suites/index.ts`, typed against the names so they cannot drift). The build and every chain's vitest config pick
it up from there.

| Suite | File | Capabilities |
|---|---|---|
| `aspHttp` | `aspHttp.ts` | — |
| `aspApproval` | `aspApproval.ts` | — |
| `keystore` | `keystore.ts` | groups: `registerAndWithdraw`, `keyRotation` |
| `deposit` | `deposit.ts` | group: `token` |
| `withdraw` | `withdraw.ts` | groups: `relayer`, `registerAndWithdraw` (+ a `token` rung) |
| `batchWithdraw` | `batchWithdraw.ts` | groups: `relayer` |
| `transfer` | `transfer.ts` | — |
| `discovery` | `discovery.ts` | — |
| `ragequit` | `ragequit.ts` | — |
| `paymentRequests` | `paymentRequests.ts` | `paymentRequests` |
| `relayerFaults` | `relayerFaults.ts` | `relayer`; group: `batchRelay` |
| `yield` | `yield.ts` | `yield`; the whole ladder once per `yieldNative` / `yieldToken`, relayed groups also `relayer` |

The yield ladder runs once per underlying kind because the two take different paths at both edges: a native deposit
is funded with the coin itself and pays out the bare coin (and its network fee comes out of the same balance, so the
spend is bounded rather than pinned), while a token needs an approval or a trustline and pays out as a token. An
`E2EYieldAsset` may also offer an `unreceivableRecipient` — an address that cannot take the payout (EVM: a contract
that rejects ETH; Stellar: an account without a trustline) — for the rung proving such a withdrawal fails and leaves
the note spendable; without one that rung is skipped.

Not yet shared, because they are LiFi/EVM-shaped and have no second implementation to design against: stealth
(ERC-5564), swap-and-deposit, withdraw-and-swap / reshield (same-chain and cross-chain) and the builder-config
validation. They stay in `packages/evm-sdk/e2e/ops`. Lift one when a second chain implements it: move the
suite here, put the fakes behind a new capability's members.

## Layout

```
src/core/      capabilities, the driver contract, defineChainE2E, describeSuite/need/itWith, helpers, globalSetup,
               RelayerProxy (fault-injecting proxy in front of a chain's live relayer)
src/suites/    one file per operation
src/setup.ts   the `/setup` entry (no vitest runtime import)
src/vitest.ts  the `/vitest` entry: `defineChainVitestConfig` (loaded by a chain's vitest.config.ts)
src/entry.ts   the one test entry, built once per suite name into dist/entries/
test/          unit tests for the framework itself (capability gating, member enforcement)
```
