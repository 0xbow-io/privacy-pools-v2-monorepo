# Privacy Pools Relayer

## Configuration

The relayer reads its configuration from a JSON file. By default it looks for `relayer.config.json` in the package root. Override the path with the `CONFIG_PATH` environment variable:

```
CONFIG_PATH=/path/to/relayer.config.json pnpm start
```

### Config Format

```json
{
    "chains": {
        "evm": [
            {
                "id": 11155111,
                "name": "sepolia",
                "rpc_url": "http://localhost:8545",
                "entrypoint_contract": "0x25C6b05FBA111eE3995A9dd391D76548b7E276e4",
                "relay_contract": "0xe923f451751722118c321d2D7f64BB056a435718",
                "fee_receiver_address": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
                "signer_private_key": "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
                "flat_fee_amount": "21000",
                "relay_gas_cap_multiplier": 3,
                "native_currency": {
                    "name": "Ether",
                    "symbol": "ETH",
                    "decimals": 18
                },
                "supported_assets": [
                    {
                        "address": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                        "ticker": "ETH",
                        "quoter": "Native",
                        "fee_bps": "10",
                        "decimals": 18
                    },
                    {
                        "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                        "ticker": "USDC",
                        "quoter": "Cowswap",
                        "decimals": 6
                    }
                ]
            }
        ]
    }
}
```

### Field Reference

| Field | Required | Description |
|---|---|---|
| `chains.evm` | yes | Array of EVM chain configs |
| `id` | yes | Chain ID (e.g. `11155111` for Sepolia) |
| `name` | yes | Human-readable chain name |
| `rpc_url` | yes | RPC endpoint URL (overridden by `RPC_URL_EVM_<chainId>` env var) |
| `entrypoint_contract` | yes | Privacy Pools entrypoint contract address |
| `relay_contract` | yes | Privacy Pools relay contract address |
| `fee_receiver_address` | yes | Address that receives fees (overridden by `FEE_RECEIVER_ADDRESS_EVM_<chainId>`) |
| `signer_private_key` | yes | Relayer signing key (overridden by `SIGNER_PRIVATE_KEY_EVM_<chainId>`) |
| `flat_fee_amount` | no | Flat fee in wei, defaults to `21000` |
| `relay_gas_cap_multiplier` | no | Broadcast gas ceiling as a multiple of the gas each action is priced at (see `src/quote/evm/relay_gas_budget.ts`: 850k shielded transfer, 1.05M relay, 1.1M PPRouter yield withdraw, 1.75M RelaySwaps (+450k unwrap, +160k B2), 650k per relayBatch item; calibrated 2026-09-25 from on-chain gas with `scripts/relay-gas-samples.ts`). Before signing, the relayer estimates the transaction and refuses it with HTTP 400 (nothing sent, no gas spent) when the estimate exceeds `priced × multiplier`, otherwise sends with the estimate as the gas limit. Stops a recipient whose `receive()` burns gas from making the relayer pay the block limit for a fixed fee. Integer ≥ 1, defaults to `3`; env override `RELAY_GAS_CAP_MULTIPLIER_EVM_<chainId>` |
| `native_currency.name` | no | Defaults to `"Ether"` |
| `native_currency.symbol` | no | Defaults to `"ETH"` |
| `native_currency.decimals` | no | Defaults to `18` |
| `supported_assets[].address` | yes | ERC-20 address (`0xeeee...eeee` for native ETH) |
| `supported_assets[].ticker` | yes | Asset ticker symbol |
| `supported_assets[].quoter` | yes | Rate provider: `"Curve"`, `"Cowswap"`, `"Uniswap"`, or `"Mock"` (Mock requires `ALLOW_MOCK_RATE_PROVIDER=true`, see below). The native asset (`0xeeee...eeee`) and any `WETH`-ticker asset must use `"Native"` — they convert 1:1 into native gas cost and never reach a rate provider; `"Native"` on any other asset fails boot. The `WETH`-ticker match is case-insensitive (`weth`, `WETH`, `wETH` all match) |
| `supported_assets[].underlying` | with `"Underlying"` | ERC-4626 share tokens (ppUSDC over USDC, ppUSDT over USDT) use `"quoter": "Underlying"` plus the address of the configured asset they redeem into. Nothing trades the share, so the relayer quotes the underlying through *its* quoter and scales by the wrapper's live `previewRedeem(1 share)` (the same read `PPRouter.quoteWithdraw` makes). The underlying must be another entry of the same chain: a real quoter, or `Native` (WETH / the native sentinel, so a native-mode wrapper like ppETH prices as `previewRedeem(1 share)` worth of gas); another `Underlying` (a share over a share) fails boot. Fee commitments stay denominated in shares, which is what the yield proof binds |
| `supported_assets[].zap` | no (optional cross-check) | The wrapper's `PPYieldTokenZap`. Swaps of a yield share are relayed through `RelaySwaps.executeUnwrapped(…, zap)`, which redeems the shares into `underlying` before the swap. The authoritative zap is **derived on-chain at boot** by `YieldZapRegistry`, which reads `RelaySwaps.approvedZapList()` for every chain that configures an `"Underlying"` asset and matches each zap to its share via `zap.VAULT()`. Boot fails if a configured `"Underlying"` asset has no allowlisted zap, if this value disagrees with the on-chain one, or if the zap's `UNDERLYING()` disagrees with the asset's configured `underlying`. So `approveZap` must run before the relayer boots (or the relayer restarts) any yield chain; a `removeZap` after boot is not seen until restart. Forbidden on any non-`Underlying` quoter |
| `allowed_processors` | no | Allowlist of alternate `transact` processors a relay request may name via `processorAddress` (the yield `PPRouter`s, one per wrapper). Default empty: every yield withdrawal relay is rejected. A request with an allowlisted processor is routed to `PPRouter.withdrawToUnderlying(..., minUnderlyingOut)` instead of `PrivacyPoolRelay.relay` | Published verbatim on `/v1/details` as `processors`, and each router is read on-chain at boot (`VAULT()`, `UNDERLYING()`, `ZAP()`) into the `yield[]` discovery list; boot fails if a router's share isn't an `Underlying`-quoted asset here, or an `Underlying` asset has no router |
| `supported_assets[].decimals` | yes | Token decimals (e.g. `18` for ETH/WETH, `6` for USDC/USDT). Required — the fee conversion scales the native gas cost by `10^decimals` to reach the token's base units; a missing/wrong value mis-prices fees, so config parsing fails when it is absent |
| `supported_assets[].fee_bps` | no | Per-asset fee in basis points |

**Note on `supported_assets[].address` and rate providers:** each rate provider declares, in its own `rate_provider_description.json` (see [Rate Provider Chain Support](#rate-provider-chain-support) below), which `(chainType, chainId)` pairs it actually supports. An asset's `address` must be that asset's real contract address **on the chain this config entry is for** (`chains.evm[].id`) — `RateProviderBootValidator` checks every configured asset against its quoter's declared support at startup and refuses to boot the relayer if any asset/chain combination isn't covered. CowSwap currently supports mainnet, Gnosis Chain, Arbitrum One, Base, and Sepolia; Curve currently supports mainnet and Arbitrum One. The native asset and WETH carry `"quoter": "Native"` — an inert marker with no provider behind it, enforced by the same validator in both directions (native-treated assets must use it, nothing else may). For dust-rescue USD pricing of native dust, the chain's reference stablecoin's configured quoter is used instead.

### Environment Variable Overrides

Per-chain secrets can be set via environment variables, which take precedence over the config file.
The key is namespaced by **chain type** so an EVM chain and a Stellar chain sharing a numeric id do
not collide on the same variable. The form is `<NAME>_<CHAINTYPE>_<chainId>` where `<CHAINTYPE>` is
`EVM` or `STELLAR`:

- `RPC_URL_EVM_<chainId>` / `RPC_URL_STELLAR_<chainId>` — RPC endpoint
- `SIGNER_PRIVATE_KEY_EVM_<chainId>` (EVM) / `SIGNER_SECRET_KEY_STELLAR_<chainId>` (Stellar) — signing key
- `FEE_RECEIVER_ADDRESS_EVM_<chainId>` / `FEE_RECEIVER_ADDRESS_STELLAR_<chainId>` — fee receiver address

EVM-only overrides follow the same scheme: `MAX_SWAP_VALUE_WEI_EVM_<chainId>`,
`RELAY_GAS_CAP_MULTIPLIER_EVM_<chainId>`, `DUST_RESCUE_RECIPIENT_ADDRESS_EVM_<chainId>`.

### Operator Alerts

Alerts (`turbo`-level log records and records marked `alert: true`) are published to Pub/Sub and delivered to Telegram by the standalone `alert-dispatcher` service (see `docs/tech-design/relayer/alert-dispatcher.md`). Global environment variables:

- `RELAYER_ALERTS_PUBSUB_TOPIC` — topic to publish to; defaults to `relayer-alerts`
- `RELAYER_ALERTS_DISABLED` — set to `true` to disable alert publishing without a redeploy (logging is unaffected); alerts are also off under `NODE_ENV=test`

### CORS

Browser-origin allowlist for all HTTP routes, configured via the optional top-level `cors` section of `relayer.config.json`:

```json
"cors": {
    "origins": ["https://v2.privacypools.com"],
    "origin_patterns": ["^https://privacy-pools-website-v2-git-[a-z0-9-]+-0xbow\\.vercel\\.app$"]
}
```

`origins` are exact origin matches; `origin_patterns` are JS regex sources for origins not known in advance (per-branch preview deployments). Both are combined into one allowlist. Env vars override the config file, each replacing only its own dimension: `CORS_ORIGIN` (comma-separated exact origins) and `CORS_ORIGIN_PATTERN` (a **single** regex — never comma-split, since regexes may contain commas). A pattern that doesn't compile fails at startup, not at the first preflight.

With nothing configured anywhere the relayer allows all origins (`*`) — fine for local development, but production deployments must set a real allowlist: an open or catch-all CORS policy (e.g. `^https?://.*$`) lets any website call the signing and relay routes from a browser. Anchor patterns (`^...$`) and pin them to your project/team suffix.

### RPC Transport & Quote Deadline

The quote path bounds worst-case RPC latency instead of inheriting viem's silent defaults (10s timeout × 4 attempts per call — the source of 30-60s quote hangs whenever the provider degrades). All knobs are global (not per-chain) environment variables:

| Variable | Default | Description |
|---|---|---|
| `RPC_TIMEOUT_MS` | `2500` | Per-attempt timeout for RPC reads (`src/chain.service/evm.chain.service.ts`) |
| `RPC_RETRY_COUNT` | `1` | Retries per RPC read — with the timeout, caps a logical read at ~5s |
| `RPC_WRITE_TIMEOUT_MS` | `10000` | Timeout for RPC writes. Deliberately longer: aborting a broadcast early risks "timed out but landed" ambiguity |
| `QUOTE_DEADLINE_MS` | `8000` | Hard deadline on all quote routes (`src/quote/quote-deadline.interceptor.ts`). On breach the relayer logs and returns a clean, retryable **503** (`ServiceUnavailableException`) instead of hanging the client. Must stay comfortably below the perf suite's 9s budget (`packages/relayer/perf`) |
| `ASSET_CONFIG_TTL_MS` | `60000` | TTL of the `Entrypoint.assets()` config cache (`src/sdk/evm.contract.service.ts`), keyed `chainId:entrypoint:asset` |

Public viem clients are cached per `chainId:rpcUrl` with JSON-RPC batching (`batch: true`), so concurrent reads coalesce into one batch request and upstream HTTP connections stay warm. Wallet (signer) clients are deliberately **not** cached — signer/nonce-manager semantics stay untouched. Gas price is additionally cached in-memory for 15s per chain. A fully warm quote makes 0 RPC calls.

### Rate Provider Chain Support

Each rate provider ships a declarative `rate_provider_description.json` next to its implementation, listing every `(chainType, chainId)` pair it actually supports:

- `src/rate_provider/curve/rate_provider_description.json`
- `src/rate_provider/cowswap/rate_provider_description.json`
- `src/rate_provider/uniswap_v3/rate_provider_description.json` (the `Uniswap` quoter)
- `src/rate_provider/mock_sepolia/rate_provider_description.json`

`RateProviderBootValidator` (`src/rate_provider/rate_provider_boot_validator.ts`) reads these at startup and fails immediately if any asset in `relayer.config.json` names a `quoter` that doesn't declare support for that asset's chain — this is the primary gate against a misconfigured chain/asset silently reaching an unwired rate provider. `RateProviderService.quote()` re-checks the same thing per request as defense-in-depth.

Beyond declaring support, each provider needs to actually know *how* to price on a given chain:

- **CowSwap** (`src/rate_provider/cowswap/quote_obtention.ts`) — `ANCHOR_TOKEN_BY_CHAIN_ID` maps each supported chain to its verified WETH-equivalent anchor token (see `anchor_tokens.md` for how each address was independently verified). Already covers all 5 chains it declares support for.
- **Curve** (`src/rate_provider/curve/curve_quote_obtention.ts`) — `CURVE_CONFIG_BY_CHAIN_ID` maps each supported chain to its rate-provider oracle contract address, that chain's anchor token, and the chain's `historicLookbackBlocks` (see the historic rate validation below). Has mainnet (`1`) and Arbitrum One (`42161`) entries.
- **Uniswap** (`src/rate_provider/uniswap_v3/quote_obtention.ts`) — `UNISWAP_V3_POOLS` maps each supported chain to a list of on-chain-verified Uniswap V3-style pools, one per `(chain, input token)`, priced by a 15-minute TWAP (`observe([900, 0])`) against that chain's wrapped-native anchor. Covers Citrea mainnet (`4114`, JuiceSwap fork, WCBTC anchor), Citrea testnet (`5115`), Optimism (`10`, WETH anchor) and BNB Smart Chain (`56`, WBNB anchor; note BSC USDT/USDC are 18-decimal). A raw pool only prices the pair it was created for, so every new asset needs its own verified pool entry — see `pool_addresses.md` for the verification record of each.

#### Curve historic rate validation

Curve's oracle aggregates *spot* pool state, so a flash-manipulated pool produces a rate that would flow straight into fee math and collapse the relayer's gas-cost recovery in token terms (the fee is charged in tokens; the gas floor only holds in wei). To guard against this, every Curve quote re-reads the same oracle at a block `historicLookbackBlocks` back and **fails closed** if the two rates deviate by more than the threshold (default 10%). The chain itself serves as the persistent baseline — the relayer runs scale-to-zero, so an in-memory last-known-good cache would be empty on exactly the request an attacker times. (Deployments may also run warm, min-instances=1, where the in-memory TTL caches — gas price 15s, asset config 60s, see [RPC Transport & Quote Deadline](#rpc-transport--quote-deadline) — are effective; the fail-closed historic check above does not depend on either mode.)

Operational notes:

- The RPC for each chain must serve state `historicLookbackBlocks` back (mainnet: 50 blocks ≈ 10 min; Arbitrum: 100 blocks ≈ 25 s). Both defaults stay inside the ~128-block state window of a default non-archive full node.
- A newly listed asset has no historic baseline (the oracle returns a zero historic rate) and is refused until the oracle has priced it for at least the lookback window.
- This check catches *transient* manipulation only; a persistently wrong oracle (wrong address, wrong pool set) is indistinguishable from truth to a self-comparison and would need an independent witness source.

**To add a new chain to Curve or CowSwap:** add an entry to the relevant provider's `CURVE_CONFIG_BY_CHAIN_ID` / `ANCHOR_TOKEN_BY_CHAIN_ID` map (oracle/anchor address, independently verified on-chain — never reuse another chain's address), *and* add the chain to that provider's `rate_provider_description.json`. Missing either half fails closed: a chain missing from the description fails at boot before any traffic is served; a missing map entry throws explicitly the first time that chain is actually queried, rather than silently reusing another chain's oracle/anchor.

### Rate Provider Environment Variables

- Rate providers no longer use a separate RPC variable — each quote request resolves its RPC from the same `RPC_URL_EVM_<chainId>` (or `chains.evm[].rpc_url`) override used for every other operational call on that chain (see Environment Variable Overrides above). There is nothing further to configure here as long as every chain your config lists has a working `rpc_url`.
- `CURVE_RATE_MAX_DEVIATION_BPS` — overrides the historic-deviation threshold for Curve quotes (default `1000` = 10%; see "Curve historic rate validation" above). Raise only if a supported asset legitimately moves more than the default within the lookback window.
- `DISABLE_CURVE_HISTORIC_RATE_CHECK` — set to `"true"` to skip the historic self-comparison entirely (e.g. an RPC that cannot serve historic state). This removes the flash-manipulation guard — prefer fixing the RPC over disabling the check in production.
- `ALLOW_MOCK_RATE_PROVIDER` — must be set to `"true"` for the `Mock` rate provider (hardcoded 1:1 pricing) to be registered at all. Curve and CowSwap are always registered regardless of this flag. Without it, any asset configured with `quoter: "Mock"` fails at the first quote request instead of silently pricing fees off a fake rate. Intended for local/test use only — never set in production. This mirrors the analogous `IS_TEST_DEPLOYMENT` guard on the contracts side (`packages/swaps/contracts` — required to deploy `RelaySwaps` against a `MockPool`); both exist so a mocked component can never end up wired into a production deployment silently.

### Discovery: `/v1/details`

`GET /v1/details/evm/:chainId` (plus the all-EVM-chains `GET /v1/details`, and
`GET /v1/details/:chainType` for every chain of one type — e.g. `GET /v1/details/stellar`) is the
one place a client should take relayer addresses from instead of hand-copying them (minr #30 — a
wrong processor bound into a proof fails every relay of that note with `PoolVault_ProofContextMismatch`):

| field | meaning |
|---|---|
| `contracts.relay` | PrivacyPoolRelay — the `transact` processor for plain relayed withdrawals/transfers (`RelayerInfo.processorAddress`) |
| `contracts.relaySwaps` | RelaySwaps — the processor for withdraw-and-swap / reshield (absent when unsupported) |
| `relayerAddress` | the relayer's signer, `msg.sender` of every relay (`RelayerInfo.address`) |
| `processors` | `allowed_processors` verbatim — the PPRouters |
| `yield[]` | per router: `ppToken`, `underlying`, `router` (the processor to bind for a yield-share note), `zap`, decimals, `underlyingSymbol`; derived on-chain at boot (`YieldDiscoveryService`), `[]` on chains without routers |

The SDK consumes it through `RelayerInteractor.getChainDetails()` and `PoolSessionBuilder.withRelayerDetails()`.

### Preferred providers

For its available chains, the unit tests in `rate_provider.service.spec.ts`'s `Matrix (chainId x asset)` section show that Curve is qualitatively faster than CowSwap.

| Provider | Chain | Asset | Duration |
|---|---|---|---|
| Curve | mainnet (1) | USDT | 226ms |
| Curve | mainnet (1) | USDC | 252ms |
| CowSwap | mainnet (1) | USDC | 1363ms |
| CowSwap | mainnet (1) | USDT | 2550ms |
| CowSwap | mainnet (1) | DAI | 1739ms |
| Curve | Arbitrum One (42161) | USDC | 594ms |
| CowSwap | Arbitrum One (42161) | USDC | 3176ms |
| CowSwap | Gnosis Chain (100) | WXDAI | 1125ms |


## Testing

### Unit tests

- go to `packages/relayer/relayer/`, run `npx jest`. Notice a good JSON file describing results will be created by ctrf.
- Some tests require you to provide an actual RCP in the .env file, use the .env.example as model.
