# funder

Sweeps the relayer's fee-receiver wallet into native gas and sends it to a recipient (normally the
relayer signer). Rust port of `v2-monorepo/packages/relayer/relayer/scripts/sweep-fees.sh`; same
env contract, same behavior.

Reads the **relayer's own config JSON** (`CONFIG_PATH`, same file and schema as the relayer's
`zConfig`) and applies the same per-chain env overrides (`RPC_URL_EVM_<id>`,
`FEE_RECEIVER_ADDRESS_EVM_<id>`). From `supported_assets`:

- native sentinel `0xeee…` and wrapped native → nothing until the unwrap step
- `quoter: "Underlying"` → PP yield share to redeem. A share is an ERC-4626 vault over an Aave V3
  aToken; everything is read on-chain (`asset()` → aToken → `UNDERLYING_ASSET_ADDRESS()` /
  `POOL()`), and the aToken's underlying must equal the config's `underlying`. No zap, RelaySwaps
  or relayer involved; the config's `zap` / `relay_swaps_contract` fields are ignored
- any other ERC-20 → swapped into wrapped native (a token with no pool is skipped with a warning)

Only fields the sweep needs are parsed; unknown fields and future quoter names are ignored. The
config never needs the signer key (prod keeps `0x…01` there and injects it via env). The run refuses
to sign unless the signer **is** the chain's resolved fee receiver. Routers/quoters per chain live
in `src/evm/dex.rs`, the one table the relayer config doesn't carry. Wrapped native (WETH/WBNB) is
the router's `WETH9()`; a config entry with `quoter: "Native"` must be that same token.

One run sweeps every selected chain concurrently (`CHAINS=all` or `evm:1,evm:56`); chains have
independent RPCs and nonces, so one fee-wallet key serves them all. A failing chain doesn't block
the others; the run ends with a per-chain summary and exits 1 if any chain failed. Per chain:

1. **Redeem** PP yield shares (ppETH/ppUSDC/ppUSDT): `vault.redeem(all, me, me)` → aTokens, then
   `Pool.withdraw(underlying, max, me)` → USDC/USDT/WETH. No quote or approve needed. aTokens
   already in the wallet (a run that died in between) are withdrawn too.
2. **Swap** the wallet's whole USDC/USDT balances for **native**, paid **straight to the recipient**
   (or to the fee wallet while it holds less than `KEEP_WEI` + this run's gas). Two venues:
   - **direct V3** (Uniswap V3 on mainnet, Optimism, Arbitrum, Base and Robinhood; PancakeSwap V3 on
     BSC; table in `src/evm/dex.rs`): best fee tier by on-chain
     QuoterV2, `minOut = quote - SLIPPAGE_BPS`, one router `multicall[exactInputSingle, unwrapWETH9(to)]`
   - **LI.FI** (`GET /quote`, no API key): the returned tx is only signed after checks: target and
     approval = LI.FI Diamond, no value, calldata decodes to a Diamond same-chain swap whose receiver
     is ours, first leg spends exactly our token/amount, last leg pays native; the guaranteed output
     is the calldata's `_minAmountOut`.

   `SWAP_VENUE=best` (default) takes the higher guaranteed output after gas; LI.FI is never taken
   below V3's floor, and never without a V3 quote to price it against. Any LI.FI failure (HTTP,
   checks, revert) falls back to V3. Today V3 wins at fee-sized amounts (LI.FI charges 0.25%);
   LI.FI wins on large ones (2M USDC). Dust whose output < `MIN_GAS_MULTIPLE` x gas is skipped.
3. **Unwrap** the wallet's whole WETH/WBNB balance.
4. **Send** native to `RECIPIENT`, leaving `KEEP_WEI` in the wallet for the next run's gas.

Every step reads live balances, so re-running finishes a run that died midway and is otherwise a
no-op.

## Usage

```sh
# dry run on every chain in the config: prints each plan and a lower-bound projection
CONFIG_PATH=relayer.config.json KEYSTORE_ACCOUNT=fees RECIPIENT=0x<relayer signer> cargo run --release
# broadcast on mainnet + BSC only, skipping a chain while its gas is high
CONFIG_PATH=relayer.config.json CHAINS=evm:1,evm:56 KEYSTORE_ACCOUNT=fees RECIPIENT=0x<relayer signer> \
  MAX_BASE_FEE_GWEI=2 MAX_BASE_FEE_GWEI_EVM_56=1 DRY_RUN=false cargo run --release
```

| Env / flag | Default | |
|---|---|---|
| `CONFIG_PATH` | — | relayer config JSON |
| `CHAINS` | `all` | `all` = every config chain with a DEX entry (others skipped with a warning), or `evm:1,evm:56`. Bare ids are rejected. `stellar:<id>` parses but isn't implemented |
| `RPC_URL_EVM_<id>` | config `rpc_url` | mainnet: prefer a private mempool (Flashbots Protect) |
| `MAX_SEND_USD` (`_EVM_<id>`) | unset | cap on the final native send, in USD (e.g. `100`), priced through the chain's USD stablecoin on the V3 quoter; the rest stays in the fee wallet for later runs. Swap output paid straight to the recipient is not capped. Can't be priced -> the chain fails, nothing sent uncapped. `none` per chain lifts a global cap |
| `MIN_RECIPIENT_BALANCE_USD` (`_EVM_<id>`) | unset | recipient balance floor in USD (e.g. `20`), priced like `MAX_SEND_USD`. Checked first: recipient at or above it -> the chain is done (`summary evm:<id>: ok, recipient ... holds ...`), no tx sent. Below it -> the normal sweep. Lets the job run on a frequent schedule and only sweep when the relayer signer runs low. Can't be priced -> the chain fails. `none` per chain lifts a global floor |
| `ALCHEMY_RPC_KEY` | unset | secret; one Alchemy key for every chain: `https://<host>.g.alchemy.com/v2/<key>` from the table in `src/evm/config.rs` (mainnet, BSC, OP, Arbitrum, Base, Robinhood, Citrea). `RPC_URL_EVM_<id>` still wins; chains not in the table keep the config URL. Each chain must be enabled on the Alchemy app |
| `FEE_RECEIVER_ADDRESS_EVM_<id>` | config `fee_receiver_address` | must equal the signer |
| `RECIPIENT` / `RECIPIENT_EVM_<id>` | — | per-chain wins; the fee wallet itself = convert only, keep proceeds |
| `KEYSTORE_ACCOUNT` (+ `KEYSTORE_PASSWORD`) / `PRIVATE_KEY` / `UNLOCKED_FROM` | — | fee-wallet signer, loaded once for all EVM chains; `UNLOCKED_FROM` is anvil-only |
| `KEEP_WEI` / `KEEP_WEI_EVM_<id>` | `5000000000000000` | gas reserve left in the wallet; must cover one ~360k-gas tx at `2 x base + tip` (warned at startup if not) |
| `MAX_BASE_FEE_GWEI` / `MAX_BASE_FEE_GWEI_EVM_<id>` | `5` | above it the chain is **skipped** (run still succeeds, WARN summary); `none` disables |
| `CHAIN_TIMEOUT_SECS` | `2700` | a chain still running after this is reported failed |
| `RUST_LOG` | `info,funder=debug` | funder's debug lines trace every RPC read, quote, gas estimate, nonce and tx hash (no secrets: RPC/API URLs are cut to the host). `info` for a quieter log. HTTP/RPC client crates are capped at `warn` regardless (their debug output carries RPC URLs) |
| `DRY_RUN` | `true` | `true`: read and print the plan only, send nothing. `false` (`0`/`no`): execute redeems, swaps, unwraps and the send. A leftover `SEND` variable (the old name) stops the run with an error |
| `ONLY` | all | share tickers to redeem, e.g. `ppUSDC,ppUSDT` |
| `TIP_WEI` | `100000000` | priority fee (max fee = 2x base + tip) |
| `SLIPPAGE_BPS` | `50` | max 300 |
| `MIN_GAS_MULTIPLE` (`_EVM_<id>`) | `5` | every tx must move at least this many times its expected gas cost: redeems, swaps (incl. the approve), the unwrap and the final send. Below it the step is skipped and the balance waits for a later run. `0` turns the gate off |
| `SWAP_VENUE` | `best` | `best` / `lifi` (LI.FI unless it fails or prices below V3's floor) / `v3` (no API) |
| `LIFI_API_URL` / `LIFI_INTEGRATOR` | `https://li.quest/v1` / `privacy-pools-v2` | |
| `LOG_FORMAT` | `text` | `json`: one Cloud Logging line per event, with `severity` and `span.chain` |

**Secrets.** RPC URLs (with provider keys) are redacted from every logged error down to
`scheme://host/<redacted>`; `PRIVATE_KEY` is parsed by funder and never echoed (a trailing newline
is tolerated); all errors, including config/startup ones, leave through the logger (JSON severity).

**Failure isolation.** Within a chain, one share or token failing (e.g. Aave short of liquidity,
or a config share funder can't handle: not Aave-backed, or an underlying it can't swap), or the
unwrap failing, doesn't stop the rest, the final send included: the sweep finishes and the chain
is then reported failed with each item's error. Across chains, one chain failing or hanging doesn't stop the others.

**Dust and griefing.** Redeems, swaps, unwraps and the final send all skip amounts worth < `MIN_GAS_MULTIPLE` x
their gas, and share balances that redeem to 0 are left alone, so dust sent to the public fee
wallet can't block a sweep or buy daily txs.

**Approvals.** Always exactly the amount being spent. Any allowance the LI.FI Diamond still holds
(a failed or killed attempt) is revoked before the next swap of that token.

**Gas limits.** Every contract call gets estimate + 30% (`call_gas_limit`): a bare estimate can
revert, e.g. a PP vault redeem whose fee-checkpoint write only happens once time has passed. LI.FI
swaps get at least LI.FI's own `gasLimit`: aggregator routes fool `eth_estimateGas`. A reverted tx
still uses its nonce, so a fallback goes out at the next one. Before sending, funder checks the
wallet covers `gas_limit x maxFee` and says so clearly if not. Delivery to the recipient is proven
from the receipt (for V3 the router's WETH `Withdrawal`, or its burn `Transfer` to 0x0 on aeWETH
chains like Arbitrum and Robinhood; `LiFiGenericSwapCompleted` for LI.FI), not from the
recipient's balance, which the busy relayer signer moves on its own. Router swaps carry a 30 min
deadline. RPC calls time out after 30 s and retry rate limits/transport errors; receipts are
polled by hash, so one failed poll doesn't fail a mined tx. Txs are signed locally, so their hash
is known before the broadcast: a broadcast that errors (a timed-out send the node took, retried
into "already known" / "nonce too low") counts as sent when the node has that hash.

**LI.FI caveat.** Large LI.FI routes include RFQ / oracle market-maker legs that must land soon
after the quote; if not, the tx reverts (~1-2M gas) and the V3 fallback runs. On mainnet, Flashbots
Protect as `RPC_URL_EVM_1` drops reverting txs instead of charging for them. LI.FI is only taken
when its guaranteed output beats V3's raw quote (not just V3's floor), and only if the wallet can
cover its gas limit upfront; a quote with any swap leg other than the first pulling tokens is
rejected. BSC swaps are sandwiched more than mainnet ones: a private RPC there (e.g. 48 Club /
bloXroute) is worth it.

**Nonces.** Meant for a dedicated wallet (the relayer's `FEE_RECEIVER_ADDRESS_EVM_<id>`). It still
refuses to start with in-flight txs and re-checks `pending == ours` before every send, so pointing
it at a shared key fails closed rather than replacing someone else's tx.

## Layout

Chain-neutral pipeline + one module per chain family, each behind a cargo feature:

```
src/
  main.rs            CLI, CHAINS selection, concurrent per-chain runs (tracing span per chain), summary
  config.rs          relayer config (serde), <NAME>_<FAMILY>_<id> env overrides, ChainRef/ChainSelection
  pipeline/          Family trait, sweep<F>(): collect → convert → forward; Settings, Step, Outcome
    mock.rs          in-memory family: pipeline unit tests, no chain
  evm/               feature "evm" (default): config schema, dex table, profile, steps, sender, math
```

A family implements `pipeline::Family` with its own `Address`/`Amount` types (EVM: `Address`/`U256`)
and owns collect (e.g. redeem shares) and convert (e.g. swap + unwrap). The pipeline owns the
shared rules: step order, dry-run projection (`start + gained - worst-case fees`), `keep` vs. the
family's `min_reserve`, the transfer fee reserve, and the recipient balance-delta check. Adding
Stellar = a `stellar/` module + feature + one `match` arm in `main.rs`.

## Tests

```sh
cargo test                                  # 56 unit tests: pipeline (mock family), config + per-chain overrides, CHAINS parsing, wei/gas math, asset classification, wrapped-native check
cargo clippy --all-targets --no-default-features   # family-less build still compiles
FORK_RPC_URL_1=... FORK_RPC_URL_56=... \
  cargo test --test fork -- --ignored       # 18 anvil-fork tests of the real binary (~10 min at 2 threads; more threads hit RPC/anvil startup timeouts)
```

Same tests against the shipped container (each funder run becomes `docker run --network host
<image>` with the fixture config mounted read-only at `/secrets/`; anvil stays on the host):

```sh
docker build --platform linux/amd64 -t funder:dev .
FUNDER_IMAGE=funder:dev FORK_RPC_URL_1=... FORK_RPC_URL_56=... cargo test --test fork -- --ignored
```

Unit tests + clippy (`-D warnings`, with and without the `evm` feature) on the image's own
toolchain: `docker build --target test .`

Fork tests use `tests/fixtures/relayer.config.json` (prod-shaped). `relayer.config.example.json`
there is a verbatim copy of the relayer repo's example and must keep parsing. Fork tests impersonate a plain fee wallet (`0x…Fee5`) that each
test seeds on its own fork: real pp shares (underlying supplied to the share's Aave pool, aTokens
deposited into the vault, as the zap does), loose stables from whales and WETH, so nothing depends on
what a live wallet holds. The prod relayer signer is only a recipient (it is a 7702-delegated EOA). Covered: dry run is read-only and its projection is a lower bound, full sweep
drains every fee asset (incl. aTokens: no withdraw dust) and keeps the reserve, resume from aTokens
parked by a half-finished run, re-run is a no-op, fresh wallet with a stale USDT
allowance → 7702 recipient, keep mode, custom reserve, dust gate, guards (missing/zero recipient,
slippage cap, bad reserve, wrong chain, signer != fee receiver, chain not in config, `evm:1` / `stellar:1` /
bare-id / unknown-family CHAINS, non-EVM recipient, in-flight tx),
BSC sweep, mainnet + BSC in one run, `CHAINS=all` with a dead chain (others still sweep, run fails,
JSON summary says which), gas ceiling (per-chain override wins, chain skipped, run ok), swaps paid
straight to the recipient, low fee wallet refilled first, LI.FI down → V3, 2M USDC picks LI.FI and
always delivers (LI.FI's RFQ legs often go stale on a fork, so its V3 fallback is what usually runs
there). LI.FI calldata itself is unit-tested against captured live quotes, incl. tampered ones and
extra deposit legs. Also: dust shares can't block a sweep, stale LI.FI allowance revoked, real
`PRIVATE_KEY` signing (with a trailing newline; malformed key not echoed), gas spike (default
ceiling skips; without it the wallet-can't-cover error is clean), dust gate on redeems/unwraps, `MIN_RECIPIENT_BALANCE_USD` (funded recipient: no sweep, run ok; empty: sweeps).

## Build

```sh
cargo build --release            # target/release/funder (~5 MB: LTO, opt-level "s", stripped, panic=abort)
cargo test                       # unit tests
cargo clippy --all-targets       # also: --no-default-features (family-less build must compile)
```

### Docker

```sh
docker build --platform linux/amd64 -t funder .   # ~29 MB image; ~2 min cold, deps cached after
```

- Build stage: `rust:1.90-bookworm` (pinned; alloy 1.x needs >= 1.88), `cargo build --release
  --locked` with BuildKit cache mounts for the registry and `target/`.
- Runtime: `gcr.io/distroless/cc-debian12:nonroot` (glibc + libgcc only; TLS is rustls with bundled
  roots, no OpenSSL / CA bundle needed), runs as non-root, `LOG_FORMAT=json` by default.
- Nothing secret is baked in; `.dockerignore` keeps `target/`, `.git` and any `.env` out of the
  build context.

Run it like the job will (config mounted read-only, key and RPCs from the environment):

```sh
docker run --rm \
  -v $PWD/relayer.config.json:/secrets/relayer.config.json:ro \
  -e CONFIG_PATH=/secrets/relayer.config.json \
  -e PRIVATE_KEY -e RPC_URL_EVM_1 -e RPC_URL_EVM_56 \
  -e FEE_RECEIVER_ADDRESS_EVM_1 -e FEE_RECEIVER_ADDRESS_EVM_56 \
  -e RECIPIENT=0x<relayer signer> -e CHAINS=all \
  funder                       # add -e DRY_RUN=false to execute
```

Cloud Run Job equivalents: `--set-secrets=/secrets/relayer.config.json=<config secret>:latest,PRIVATE_KEY=<key secret>:latest`,
`--set-env-vars=CONFIG_PATH=/secrets/relayer.config.json,CHAINS=all,RECIPIENT=...,DRY_RUN=false`,
`--tasks=1 --max-retries=0 --task-timeout=60m` (above `CHAIN_TIMEOUT_SECS`, 45 min).

**Trigger.** The job has no trigger of its own; run it on a Cloud Scheduler cron with
`MIN_RECIPIENT_BALANCE_USD` set on the job, so most runs end at the recipient check (after connecting, one balance
read and one quote per chain). The scheduler's service account needs `roles/run.invoker` on the job:

```sh
gcloud scheduler jobs create http funder-trigger \
  --location=<region> --schedule="*/30 * * * *" \
  --uri="https://run.googleapis.com/v2/projects/<project>/locations/<region>/jobs/<job>:run" \
  --http-method=POST --oauth-service-account-email=<scheduler-sa>@<project>.iam.gserviceaccount.com
gcloud run jobs add-iam-policy-binding <job> --region=<region> \
  --member=serviceAccount:<scheduler-sa>@<project>.iam.gserviceaccount.com --role=roles/run.invoker
gcloud run jobs update <job> --region=<region> --update-env-vars=MIN_RECIPIENT_BALANCE_USD=20
```

Keep the schedule interval above the job's real run time: a second execution while one is still
sweeping would race it on the fee wallet's nonce.

**LI.FI quota.** Keyless LI.FI quotes are rate-limited per IP; a daily run (a few quotes per chain)
is far below it, but repeated fork-test runs can exhaust it ("Rate limit exceeded, retry in N
minutes"). funder then just uses V3 (WARN line per token). For CI, run fork tests with
`SWAP_VENUE=v3`.

## Local build note

`.cargo/config.toml` links with the system linker because this machine's rustup `rust-lld` wrapper
points at a garbage-collected nix-store path. Harmless elsewhere (the Docker build uses it too, with
Debian's gcc); drop it once rustup is fixed.
Pinned to alloy 1.x (MSRV 1.88); alloy 2.x needs Rust ≥ 1.94.1.

## Not yet

- Fee-receiver == relayer-signer guard (funder can't see the relayer signer key; needs a
  `RELAYER_SIGNER_ADDRESS_EVM_<id>` or similar).
- Stuck-tx replacement (fee bump at the same nonce); today a stuck tx makes later runs wait.
- Lazy per-chain config parsing: one malformed `chains.evm[]` entry still fails the whole run.

- Citrea (JuiceSwap router `0x565e…3cF8` / QuoterV2 `0x428f…8425` work, but its pools are thin
  and some are mispriced: needs a price-sanity guard before it can be swept unattended).
- Robinhood LI.FI (it runs its own Diamond `0xB477…`; Robinhood swaps are direct V3 only).
- Fork tests for OP / Arbitrum / Base / Robinhood (verified by live dry runs only).
- Stellar family (`stellar/`: trustlines, path payments, account reserve as `min_reserve`).
- GCP deploy workflow (the job and its Scheduler trigger are set up by hand, see "Trigger").
