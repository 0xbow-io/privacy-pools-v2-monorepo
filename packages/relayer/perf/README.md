# Relayer Performance Suite

Measures and guards the relayer's quote-path performance:

- **RPC-efficiency tests** (`01-rpc-efficiency.perf.test.ts`) — deterministic
  assertions on how many JSON-RPC calls a quote costs, observed by an
  instrumented proxy between the relayer and anvil. These encode the
  optimization targets (caching, batching) and can't flake.
- **Fault-injection tests** (`02-fault-injection.perf.test.ts`) — the proxy
  simulates a sick RPC provider (hangs, 503s); the relayer must answer within
  `PERF_DEADLINE_BUDGET_MS` (default 9s) instead of stacking viem's default
  10s-timeout retries into 40s+ hangs.
- **Curve-path tests** (`03-curve-mainnet.perf.test.ts`) — a second anvil
  forks **mainnet** so chain-1 quotes run the real Curve rate-provider path
  (spot `get_aggregated_rate` + the 50-block historic self-comparison) via
  `relayer.perf.config.json` (the dev config with mainnet USDC/USDT flipped to
  the Curve quoter). Asserts a warm Curve quote costs exactly the 3 uncacheable
  Curve calls, that the fail-closed historic guard is never cached away, and
  that a hanging mainnet provider still answers inside the deadline budget.
- **Latency benchmark** (`latency-bench.mjs`) — warm p50/p90/p95 + RPC calls
  per quote, written to `results/bench.json`.

The optimization has landed (bounded RPC transports, client caching + batching,
gas/asset-config TTL caches, quote deadline): the strict run (`pnpm test`) is now
the green path, and a failure means a regression against those targets.
`PERF_BASELINE=1` records current behavior without failing. `baselines/` holds
both sides of the change for comparison:
`2026-08-22_pre-optimization_b2a37959.json` (fault-hang quote: 41080ms) and
`2026-08-22_rpc-optimization_d0d105f9.json` (5186ms; warm quotes: 0 RPC calls).
Note the app's own quote deadline (`QUOTE_DEADLINE_MS`, default 8s) deliberately
sits under the harness budget (`PERF_DEADLINE_BUDGET_MS`, 9s), so the relayer
503s before the test's stopwatch runs out.

## Stack

```
vitest / bench (host or tests container)
        │ HTTP
        ▼
relayer (Dockerfile.staging build)  ──RPC──▶  rpc-proxy (counts, faults)          ──▶  anvil (sepolia fork)
   localhost:3210                              localhost:8546
                                    ──RPC──▶  rpc-proxy-mainnet (counts, faults)  ──▶  anvil-mainnet (mainnet fork)
                                               localhost:8547
```

`ANVIL_FORK_URL_MAINNET` overrides the mainnet fork RPC (defaults to the
public endpoint). The first chain-1 quote on a fresh fork is slow while anvil
lazily pulls oracle state upstream — the Curve test file warms this up in its
`beforeAll` with raw JSON-RPC (client timeouts don't apply there).

**Archive caveat:** the fork pins a block, but mainnet keeps moving — once the
fork tip falls more than ~128 blocks (~25 min) behind the live head, the
historic-guard read leaves a pruned full node's state window and the public
endpoint starts rejecting it (`403 archive request`). For sessions longer than
that, either set `ANVIL_FORK_URL_MAINNET` to an archive-capable RPC (e.g. an
Alchemy URL) or recreate the fork:
`docker compose up -d --force-recreate anvil-mainnet rpc-proxy-mainnet`.

## Usage

```bash
pnpm stack:up                 # build + start anvil, rpc-proxy, relayer (docker)
pnpm test                     # strict run (post-optimization targets)
pnpm test:baseline            # record-only run (never fails; use pre-optimization)
pnpm bench                    # latency benchmark -> results/bench.json
pnpm bench:save -- --label pre-optimization   # snapshot results/ -> baselines/ (dated, git-stamped)
pnpm bench:compare            # diff current results/ vs newest baseline
pnpm stack:down
```

CI one-shot (tests run in a container like e2e): `pnpm docker`.

`ANVIL_FORK_URL` overrides the fork RPC (defaults to the public sepolia
endpoint); `FORK_BLOCK_NUMBER` pins the fork block (same default as e2e).

## Baselines

`baselines/` holds committed, dated snapshots named
`<date>_<label>_<gitsha>.json`, combining the bench summary and the
per-scenario RPC counts / fault-response times. `bench:compare` diffs RPC
counts exactly (regression = exit 1) and latencies as ±% — latency deltas are
only meaningful when both runs came from the same machine.

## Throttling caveat

The relayer's in-memory throttler allows 20 quotes/min per client IP. The
suite issues ~9 quotes per run and the bench defaults to 16 (1 cold + 15) —
running them back-to-back within one minute can 429. Space them out, or
`pnpm stack:restart-relayer` to reset the throttler between runs.
