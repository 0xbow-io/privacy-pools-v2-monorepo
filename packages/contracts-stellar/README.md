# contracts-stellar

Vendored copy of the Privacy Pools V2 Soroban contracts, developed externally in
`0xbow-io/ppv2-stellar` and vendored into this monorepo (source, tests and deploy tooling)
so the stellar-sdk e2e suite is fully self-contained — no external checkout required.

**Synced from:** `ppv2-stellar@test/blend-testnet` (`60026bf`, 2026-08-25), plus
`tests/fixtures/` (real-proof fixtures the pool and utils tests load). Crates:

| Crate | Role |
|---|---|
| `pool` | Pool vault + entrypoint (deposit, `deposit_with_label`, transact, ragequit, roots, timestamps) |
| `keystore` | Auth-policy keystore |
| `asp-registry` | ASP roots + label registration |
| `relay` | `relay`, `relay_batch`, `register_and_relay` (immutable — no `upgrade`) |
| `yield-adapter` | Lending-venue seam (+ `MockVenue` under `testutils`) |
| `yield-blend-adapter` | Blend v2 adapter (`blend-contract-sdk` 2.25.0 pins the bytecode) |
| `yield-token` | Non-rebasing share wrapper (the shielded yield asset) |
| `yield-router` | `deposit_exact_shares` / `withdraw_to_underlying` (the pool processor for yield exits) |
| `soroban-v2-utils`, `types` | Poseidon, Groth16, LeanIMT, shared types |

This is not a live dependency; it can drift. To re-sync: re-copy upstream `contracts/` and
`tests/fixtures/`, then re-apply the local changes below.

### Local changes on top of upstream

- **`pool`: `note_data.len() > m`, not `!= m`** (`transact`), plus its test
  `test_transact_accepts_fewer_note_data_than_outputs`. Blind / out-of-band recipients publish
  no Note event, so core-sdk sends fewer `note_data` entries than outputs; mirrors EVM PoolVault.
  Not upstream as of the sync above.
- **`soroban-v2-utils`: non-canonical public signals rejected.** `groth16::verify_groth16` takes the
  raw `&Vec<U256>` signals and returns false for any signal ≥ the BN254 scalar field `r` before
  `Fr::from_u256` (which reduces mod `r`). Without it a proof for nullifier `N` also verified for
  `N + r`, `N + 2r`, … — up to 6 spends per note, since the pool keys nullifiers/commitments on the
  raw `U256`. Covers `deposit`, `transact` (hence relay and yield-router withdrawals) and `ragequit`;
  parity with EVM's generated verifiers (`checkField`).
- **`pool`: ungated withdrawals rejected.** `transact` with `processor_gated = false` and
  `amount_out > 0` fails with `UngatedWithdrawal` (35): the ungated context hashes 32 zero bytes
  instead of the processor, so anyone could resubmit the tx naming themselves as the paid processor.
  Ungated mode remains for internal transfers (`amount_out = 0`). EVM removed the permissionless path
  entirely (L-1).
- **`yield-router` / `yield-blend-adapter`: deposit auth no longer goes stale.**
  `deposit_exact_shares` transfers exactly `max_underlying_in` from the depositor to the router, mints
  with the router as payer (pre-authorizing `transfer(router, adapter, cost)`), deposits the shares and
  refunds `max_underlying_in − cost`; the depositor must therefore hold `max_underlying_in`.
  `supply(from, amount)` pulls `amount` into the adapter, then calls Blend `submit` with the adapter as
  `from` and `spender`, pre-authorizing Blend's `transfer(adapter, pool, amount)`. Previously the
  depositor signed `submit` with a rate-derived amount, so any `b_rate` move between simulation and
  inclusion failed with `auth: invalid_action`.
- **`Cargo.lock`** is resolved here (upstream does not track one). Resolve with current
  dependencies: with an older lock, `relay`'s
  `test_register_and_relay_rejects_a_mismatched_existing_key` aborts in the native test host
  instead of returning `RegistrationFailed` (test-host only; the WASM is unaffected).

## Prerequisites

- **Stable Rust** with the `wasm32v1-none` target (`rustup target add
  wasm32v1-none`) — confirmed working on stable; no nightly-only features in
  this source despite the upstream deployment docs listing "Rust
  nightly-2024-10" (that requirement predates `wasm32v1-none`'s
  stabilization).
- `stellar` CLI ≥ 22.8 (tested against 28.0.0).
- Docker, for the local standalone network (`stellar/quickstart`).

## Usage

```bash
# Build every crate to target/wasm32v1-none/release/*.wasm (CI-style size limit: 65,536 bytes each)
stellar contract build

# Start a local standalone network (idempotent — no-ops if already running)
./scripts/local-stellar.sh start

# Deploy + initialize + register all 27 circuit VKs + configure assets + verify, then the yield
# module (on local this first stands up a real Blend v2 protocol: scripts/blend/deploy-local-blend.mts)
node scripts/deploy/deploy-all.mts --network local --source ppv2-deployer

# Verify (includes the relay MAX_BATCH < pool root_history_size check, audit C-2)
node scripts/deploy/verify-deployment.mts --network local
node scripts/deploy/deploy-yield.mts --network local --verify-only
```

`scripts/deploy/ensureDeployed.mts` wraps all of the above into a single idempotent entry point —
what the stellar-sdk e2e suite calls; it also returns the yield deployments. A local deployment
that predates the USDC yield module gets it added in place (incremental `deploy-yield.mts`), not
redeployed.

Pool assets are set by `configure-assets.mts` from `scripts/config/assets.<network>.json` when that
file exists, else the shared `scripts/config/assets.json` (a network's own token addresses exist only
there). `assets.testnet.json` lists XLM plus the Blend testnet faucet's USDC, wETH and wBTC (issuer
`GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56`), each with its own `minDepositAmount` /
`maxRelayFee` in that asset's base units.

Deployment state is written to `scripts/deployments/<network>.json` (local is gitignored); the
yield modules under `yields` (one per underlying; an older single `yield` key is still read) and
local Blend in `local.blend.json`. Delete
`local.json` to force a full redeploy.

### Yield module

`deploy-yield.mts` validates before broadcasting (fee/offset bounds read from the contract
source, Blend pool active, underlying a reserve, deployer funded), deploys the Blend adapter, the
share token and the router, initializes them in order (adapter → token → router), registers the
share token as a pool asset, and reads everything back — every `initialize` is unauthenticated,
so the read-back is what catches a front-run. Share decimals = underlying decimals + offset (18
for XLM), so `exchange_rate` values one whole share sensibly. One module per underlying, and the
script is incremental: an underlying already recorded is re-verified, only missing ones are deployed.
Venue config: `local.blend.json` on local — ppXLM over native XLM and ppUSDC over the
deployer-issued USDC, so the e2e suite covers both a native and a token underlying — and
`scripts/config/yield.<network>.json` elsewhere, one object or an array (testnet: Blend's
`TestnetV2` pool — ppXLM, ppUSDC, ppwETH, ppwBTC over XLM and the Blend faucet's USDC, wETH, wBTC). A non-native underlying is recorded with its `classicAsset` (`CODE:ISSUER`).

Local Blend behaves like a live reserve: a pool nobody borrows from keeps `b_rate` at exactly 1.0,
which hides every rate-dependent path. So the pool's oracle is `test-contracts/mock-oracle` (a
local-only SEP-40 oracle pricing everything at 1.0), a USDC reserve is added as collateral, a
fresh `ppv2-blend-lender` supplies 5,000 XLM and the deployer borrows 4,500 XLM against USDC
(~90% utilisation); it also borrows 1,000 USDC so the USDC reserve accrues too (a pool reused from
before that change has no USDC borrower, so its USDC rate stays at 1.0 until redeployed with
`--force`). Interest then accrues every ledger, so `b_rate` is fractional and moves
between a quote and its execution. It stays near 1.0: `gulp` credits a donation to the backstop,
not to suppliers, so the rate cannot be jumped on a real-time chain. A `local.blend.json` without
an `oracle` (the old frozen-rate layout) is never reused. A fresh BLND code is minted per deploy
(its admin is handed to that deploy's emitter for good).

### Trustlines for a relayer (or any receiving) account

A classic asset (USDC, wETH, wBTC) can only be paid to an account holding a trustline to it, and
the relayer is paid its fee in the withdrawn asset — a yield share's fee in its underlying — so a
relayer's fee-receiver account needs one per classic asset the network uses:

```bash
# Signer from the stellar CLI's own variable (a secret key or an identity alias) — never an argument.
STELLAR_ACCOUNT=<secret or alias> node scripts/ops/add-trustlines.mts --account G... [--network testnet]
# Or print unsigned transactions to sign elsewhere:
node scripts/ops/add-trustlines.mts --account G... --build-only
```

The assets default to the network's classic tokens (its `assets.<network>.json` and the yield
modules' underlyings); `--asset CODE:ISSUER` (repeatable) names them explicitly. Existing trustlines
are skipped and every new one is read back from the chain, so a signer that is not `--account` is
reported as a failure.

## Fixes applied to the deploy tooling

Found by actually running the deploy pipeline end-to-end for the first time
(the upstream `scripts/deployments/` was empty — this tooling had
apparently never been fully exercised there):

1. **`utils.mts`'s `invokeContract`** joined CLI args into a raw shell
   string without quoting, so the `--vk` JSON argument (containing `{`,
   `"`, `:`) got mangled by `/bin/sh -c` before the `stellar` CLI ever saw
   it (`Invalid JSON in argument 'vk': key must be a string`). Fixed by
   single-quoting every arg token.
2. **`register-vks.mts`/`configure-assets.mts`** passed the deployer's raw
   address as the `--source-account` signing identity, instead of the CLI
   keystore alias (`--source ppv2-deployer`) — the CLI's local keystore is
   indexed by alias, so a bare address fails with `No sign with key
   provided`. Fixed to sign with the alias while still passing the address
   for the on-chain `--admin`/`--caller` contract parameters.
3. **`utils.mts`'s `WASM_DIR`** pointed at `target/wasm32-unknown-unknown/release`,
   which `stellar contract build` never actually produces (it builds to
   `target/wasm32v1-none/release`) — fixed to match the real build target.
4. **`utils.mts`'s `CIRCUITS_DIR`** pointed at `../v2-monorepo/packages/circuits/build`
   (a cross-repo sibling path) — collapsed to the same-repo sibling path
   `../circuits/build` now that both packages live in this monorepo.
