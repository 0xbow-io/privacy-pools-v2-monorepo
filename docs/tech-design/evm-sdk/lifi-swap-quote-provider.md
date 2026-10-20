# LiFiSwapQuoteProvider

Configuration and usage of the LiFi-backed swap quote provider.

## Overview

`LiFiSwapQuoteProvider` wraps the `@lifi/sdk` to provide swap quotes and swap-and-deposit quotes. It implements three interfaces:

| Interface | Methods | Used by |
|---|---|---|
| `ISwapQuoteProvider` | `getSwapQuote()` | `prepareSwapQuote()`, `estimateReshieldAmount()`, `estimateReshieldCrosschainAmount()`, integration tests |
| `ISwapAndDepositQuoteProvider` | `getSwapAndDepositQuote()` | `prepareReshieldQuote()`, `prepareReshieldCrosschainQuote()`, `prepareSwapAndDeposit()`; `estimateReshieldCrosschainAmount()` (route-guarantee probe, when configured) |
| `ISwapProvider` | `getSwapStatus()` | `getSwapStatus()` on PoolSession facade |

## Construction

```typescript
import { LiFiSwapQuoteProvider } from "@privacy-pools-v2/sdk";

const provider = new LiFiSwapQuoteProvider({
    integrator: "my-app",       // optional — identifier sent with LiFi API requests
    apiKey: "lifi-api-key",     // optional — for authenticated (higher rate limit) access
    apiUrl: "https://li.quest/v1", // optional — LiFi API base URL (default shown)
    fee: 0.003,                 // optional — fee percentage included in LiFi quotes
    allowBridges: ["across"],   // optional — bridges LiFi may use for CROSS-CHAIN quotes (see below)
});
```

| Config field | Type | Default | Description |
|---|---|---|---|
| `integrator` | `string?` | `DEFAULT_LIFI_INTEGRATOR` | Identifier sent with every LiFi API request. |
| `apiKey` | `string?` | none | LiFi API key for authenticated access. Without it, public rate limits apply. |
| `apiUrl` | `string?` | `https://li.quest/v1` | LiFi REST API base URL. Used for `getSwapStatus()` polling. |
| `fee` | `number?` | none | Fee percentage included in LiFi quotes (e.g. `0.003` = 0.3%). |
| `allowBridges` | `string[]?` | none (LiFi chooses) | LiFi bridge keys (e.g. `["across"]`, `["stargateV2"]`) forwarded as `allowBridges` on every **cross-chain** quote this provider makes — `getSwapQuote()` and `getSwapAndDepositQuote()` alike. Same-chain quotes are never restricted. An empty array is treated as unset. |

### Bridge allowlist (`allowBridges`, 2026-09-24)

Why it exists: a native-coin input cannot fund a bridge's own native fee the way B2 funds it for ERC-20 input (`RelaySwaps` rejects `swapValue > 0` on the native-input branch, `RelaySwaps_GasSwapNativeInput`). For cross-chain reshield (`prepareReshieldCrosschainQuote` / `estimateReshieldCrosschainAmount`), a route whose quoted `transactionValue` (the `msg.value` it needs) exceeds `netSwapAmount` — a fee stacked on top of `fromAmount`, e.g. Stargate's LayerZero fee — is **no longer refused outright (2026-10-09)**: the SDK re-quotes once with the bridged amount shrunk to fund the fee out of the budget, and only throws (`InvalidTransactParams`, "This route needs … wei of native msg.value") when that still doesn't fit or the fee would consume the whole amount; see [withdraw-and-swap.md](../core-sdk/withdraw-and-swap.md) §Cross-Chain Reshield. The refusal was never a blanket block on Stargate/native-fee routes in the first place — it only fires when a route actually needs more `msg.value` than `netSwapAmount` provides, so a route that already fits (or a chain pair with no native fee at all) is unaffected regardless of bridge choice. Across carries no native fee, so restricting such flows to `["across"]` is a direct way to steer clear of fee-stacked routes altogether — skipping the re-quote path and its (small) headroom cost — not a workaround callers need for every native-input route, nor the only lever available.

Scope and limits, so callers pick it deliberately:

- It is one list per provider instance, applied to every cross-chain quote regardless of chain pair or input token. A provider built with `["across"]` also keeps **ERC-20** inputs off Stargate, so the B2 gas-swap path is never exercised through that provider. Use a dedicated provider instance (sessions take providers per builder) when only native-input flows should be restricted.
- LiFi enforces the list strictly on `/quote` (a list nothing matches returns `404 No available quotes`), but only best-effort on `/quote/contractCalls`: measured 2026-09-24 (mainnet → BSC, mainnet → Optimism), `["hop"]`, `["stargate"]` and `["relay"]` all came back routed over Across without an error, and `["stargateV2"]` was honoured on the BSC route but not on the Optimism one. Treat the field as a routing preference, not a guarantee. The SDK's own pre-proof checks (the native-input `msg.value` refusal above, the destination-guarantee gate in `prepareReshieldCrosschainQuote`) remain the safety net.
- The cross-chain estimate (`estimateReshieldCrosschainAmount`, see `pool-session.md`) quotes through this provider's `getSwapQuote()` (plain `/quote`, strictly enforced), and prepare's quote goes through its `getSwapAndDepositQuote()` (`/quote/contractCalls`, best-effort). Both carry the configured list.

## Slippage

Slippage is configured **per-request**, not per-provider. Each quote request accepts an optional `slippage` parameter (0-1 range). If omitted, smart defaults apply:

| Swap type | Default slippage | Rationale |
|---|---|---|
| Same-chain (`fromChainId === toChainId`) | 0.5% (`0.005`) | DEX-only, low variance |
| Cross-chain (`fromChainId !== toChainId`) | 3% (`0.03`) | Bridge + DEX, higher variance |

These defaults are applied inside `LiFiSwapQuoteProvider` before calling the LiFi SDK. The `slippage` value flows through the SDK helper methods:

- `prepareSwapQuote({ slippage })` → `getSwapQuote({ slippage })`
- `estimateReshieldAmount({ slippage })` → `getSwapQuote({ slippage })`
- `estimateReshieldCrosschainAmount({ slippage })` → `getSwapQuote({ slippage })`, then `getSwapAndDepositQuote({ slippage })` for the route-guarantee probe (only when a `swapAndDepositQuoteProvider` is configured)
- `prepareReshieldQuote({ slippage })` → `getSwapAndDepositQuote({ slippage })`

LiFi uses slippage to compute `toAmountMin` (the minimum acceptable output after slippage). For same-chain swaps this value becomes the on-chain `minOutputAmount` enforced by the `RelaySwaps` contract. For cross-chain swaps the on-chain `minOutputAmount` is `0` and `toAmountMin` is surfaced as `PreparedSwapQuote.destinationMinOutputAmount` (informational) — it is enforced by LiFi's destination executor via the proof-bound calldata. For a cross-chain contractCalls quote, `toAmountMin` is also the amount LiFi encodes as the destination call's `fromAmount` — the budget our deposit must fit in — see `getSwapAndDepositQuote` below.

## Wiring into PoolSession

The provider is injected via `PoolSessionConfig` and flows through `PoolSessionFactory`:

```typescript
import { PoolSessionFactory, LiFiSwapQuoteProvider } from "@privacy-pools-v2/sdk";

const lifiProvider = new LiFiSwapQuoteProvider({ integrator: "my-app" });

const session = PoolSessionFactory.create({
    // ... other config ...
    swapQuoteProvider: lifiProvider,           // enables prepareSwapQuote(), estimateReshieldAmount()
    swapAndDepositQuoteProvider: lifiProvider,  // enables prepareReshieldQuote(), prepareSwapAndDeposit()
});
```

| Config field | Enables |
|---|---|
| `swapQuoteProvider` | `prepareSwapQuote()`, `estimateReshieldAmount()`, `estimateReshieldCrosschainAmount()` |
| `swapAndDepositQuoteProvider` | `prepareReshieldQuote()`, `prepareReshieldCrosschainQuote()`, `prepareSwapAndDeposit()`, `swapAndDeposit()`, `getSwapStatus()`. Also used, when present, by `estimateReshieldCrosschainAmount()` to probe the contractCalls route's guaranteed delivery and size the destination deposit under it (see [pool-session.md](pool-session.md) §Cross-Chain Reshield); without it the estimate falls back to the plain-quote sizing alone. |

Both fields are optional. Methods throw `InvalidTransactParams` if called without the required provider.

The `PoolSessionBuilder` also wires these providers via the fluent `withSwapQuoteProvider()` and `withSwapAndDepositQuoteProvider()` overrides, which are passed through to `PoolSessionFactory`.

## Quote Types

### `getSwapQuote(params)` — Standard swap

Used for withdraw-and-swap. Calls LiFi's `getQuote()` endpoint.

```typescript
const quote = await provider.getSwapQuote({
    fromChainId: 42161,                    // Arbitrum
    toChainId: 42161,                      // same-chain
    fromToken: USDC,
    toToken: USDT,
    fromAddress: RELAY_SWAPS_ADDRESS,      // processor initiates the swap
    toAddress: recipientAddress,           // output goes to recipient
    amount: netSwapAmount.toString(),      // amount after relayer fee
    amountType: "from",                    // fixed input
    slippage: 0.005,                       // optional, defaults apply
    denyExchanges: ["fly"],                // optional, excludes named LiFi tools from routing
});
// quote.transactionData — calldata for on-chain execution
// quote.toAmountMin — minimum output after slippage
// quote.approvalAddress — token approval target
// quote.transactionTo — swap target contract
// quote.fromTokenAddress / toTokenAddress / fromChainId / toChainId
//   — echo of what LiFi actually routed (see "Route Echo Fields")
```

`denyExchanges?: string[]` excludes named LiFi tools/exchanges from routing, passed through as `getSwapQuote()`'s own `denyExchanges` param on the underlying `@lifi/sdk` call. It exists because some LiFi tools embed a short transaction deadline directly in their swap calldata — e.g. `fly` — which can expire before this protocol's proof generation (~30-60s) plus relayer round-trip completes, causing an on-chain `ExpiredTransaction()` revert regardless of how fresh the quote was when requested. Since the deadline is baked into the proof-bound calldata (see "On-Chain Enforcement" below), there is no way to refresh it after the fact — the only fix is to steer the quote away from the offending tool up front. Confirmed via direct on-chain reproduction against `fly`; callers who hit `ExpiredTransaction()` reverts should pass the tool's name here.

### `getSwapAndDepositQuote(params)` — Swap + deposit (contractCalls)

Used for reshield. Calls LiFi's `getContractCallsQuote()` — swaps input token then calls `Entrypoint.deposit()` atomically.

```typescript
const quote = await provider.getSwapAndDepositQuote({
    fromChainId: 42161,
    toChainId: 42161,
    fromToken: USDC,
    toToken: USDT,
    fromAddress: RELAY_SWAPS_ADDRESS,
    depositAmount: totalDepositCost.toString(),  // noteValue + vettingFee
    depositCalldata: depositResult.callData,     // from prepareDeposit()
    poolAddress: depositResult.to,               // Entrypoint address
    slippage: 0.005,                             // optional
    denyExchanges: ["fly"],                      // optional, excludes named LiFi tools from routing
});
```

`denyExchanges?: string[]` on `SwapAndDepositQuoteRequest` mirrors the field on `SwapQuoteRequest` (see `getSwapQuote(params)` above) — it excludes named LiFi tools/exchanges from routing, passed through as `getContractCallsQuote()`'s own `denyExchanges` param on the underlying `@lifi/sdk` call. It exists for the same reason: some LiFi tools embed a short transaction deadline directly in their swap calldata — e.g. `fly` — which can expire before this protocol's proof generation (~30-60s) plus relayer round-trip completes, causing an on-chain `ExpiredTransaction()` revert. The reshield path (`prepareReshieldQuote()` → `getSwapAndDepositQuote()`) is proof-bound the same way the withdraw-and-swap path is, so it carries the identical exposure — the original 1.4.0 fix only threaded `denyExchanges` through `getSwapQuote()`/withdraw-and-swap, leaving this contractCalls path uncovered. Callers who hit `ExpiredTransaction()` reverts on the reshield path should pass the tool's name here.

**Result fields `toAmountMin` and `destinationCallAmount` (2026-09-24).** `SwapAndDepositQuoteResult` carries two optional output-token-unit figures besides `toAmount`: `toAmountMin` (LiFi's `estimate.toAmountMin`, the route's guaranteed delivery) and `destinationCallAmount` (the `fromAmount` of the `custom` step in `includedSteps` on the destination chain, i.e. the amount LiFi encoded for OUR destination contract call). Measured 2026-09-24 against li.quest on mainnet → Optimism / Base / Arbitrum / BSC, over both Across and Stargate: LiFi **ignores `contractCalls[].fromAmount`** (our `depositAmount`) and always encodes the route's guaranteed delivery — the last destination swap step's `toAmountMin`, or the bridge minimum when there is no destination swap — as the destination `SwapData.fromAmount`. For a native-coin call the Executor sends exactly that as `msg.value`; for an ERC-20 call it only sizes the approval (LiFi max-approves), so the call may pull up to the Executor's full balance. Either field may be absent when LiFi does not report it. The authoritative reading is off the built calldata: `decodeLiFiDestinationCallAmount(transactionData, depositCalldata)` (`utils/LiFiDestinationCall.ts`) locates the `(bytes32 transactionId, SwapData[] swaps, address receiver)` destination payload that embeds our calldata verbatim and returns that entry's `fromAmount` (`undefined` for a same-chain quote or an unrecognised layout). The pool sessions use it — falling back to `destinationCallAmount`, then to the Stargate `minAmountLD` decoder — as the destination deposit budget on every cross-chain route.

**Across fill headroom (2026-10-16).** LiFi builds an Across deposit whose `outputAmount` is the input minus exactly the fee Across suggested at quote time. A fill that also runs our pool deposit is gas-heavy, so when the filler prices it higher at fill time nobody fills, the deposit expires and Across refunds the source chain's RelaySwaps. For a cross-chain contract-calls quote whose bridge is Across, `getSwapAndDepositQuote` therefore leaves the filler `ACROSS_RELAYER_GAS_HEADROOM_BPS` (5,000, half the relayer gas fee LiFi quoted) on top of LiFi's price (`utils/LiFiAcrossHeadroom.ts`). On the direct layout the delivery, `toAmount` and `toAmountMin` shrink by at least that amount; with source swaps, rounding the multiplier down can make the reduction a few units larger. On the destination-swap layout the delivery is whatever LiFi quotes for the reduced input, so the reduction depends on that second quote; the combined quote is only accepted when it leaves the filler more than the first. When the deposit directly follows the bridge, `applyAcrossFillHeadroom` lowers `AcrossFacetV4`'s `outputAmount`, the `outputAmountMultiplier` the facet recomputes it from after source swaps, and our call's `SwapData.fromAmount`. When LiFi swaps on the destination first, the swap's amount is fixed in the aggregator's calldata, so the provider re-quotes the same request for the input less the headroom and `spliceAcrossFillHeadroom` combines the two: BridgeData and source swaps from the full quote, the Across leg and destination payload from the reduced one. A re-quote that does not match on bridge, router, tokens, receiver, refund address or fallback, or that gains the filler nothing, is refused with `SwapQuoteFailed` before anything is signed. Stargate and same-chain routes are unchanged; an Across quote neither path covers is left as LiFi built it, with a logged warning.

**Same-chain native deposits (2026-10-02).** A plain native `Entrypoint.deposit{value}` cannot go through `/quote/contractCalls`: LiFi's Executor would send the route's guaranteed delivery, never the exact cost, and LiFi now refuses to quote such a call at all (`422 Step simulation failed`) because it simulates it with that value. `PoolSessionSwapDeposit` therefore composes the transaction itself. It requests an ordinary exact-out quote (`getSwapQuote`, `amountType: "to"`, amount = note value + vetting fee) of the input token into the native coin, with LiFi's Executor as both `fromAddress` and `toAddress`, and requires `toAmountMin` to cover the cost. It then encodes one `Executor.swapAndExecute` (`ISwapChainAdapter.encodeSwapThenCall`) with two calls: LiFi's swap, its calldata, target and approval address unchanged, then the Entrypoint call sent exactly the cost. The user approves the Executor's ERC20Proxy (`LIFI_SWAP_EXECUTORS`), never the inner swap's approval address. The Executor returns leftover native coin and input token to the owner. The swap target, its approval address, the Executor and the proxy are all vetted against `RelaySwaps.approvedRouters`, and LiFi never receives the deposit calldata. Because the Executor runs arbitrary calls for anyone, the allowlist alone proves nothing about an Executor transaction: the session accepts exactly this composed `swapAndExecute`, fully decoded (`decodeSwapThenCall`) and pinned argument-by-argument at prepare and execute — the deposit call's value must equal the deposit cost (`callValue == depositMsgValue`), the transaction itself carries no native value (`msgValue == 0`), and the inner swap leg may not call, target or approve an Executor. The Executor is never an approval spender, and every other swap-and-deposit, reshield or withdraw-and-swap transaction that targets, approves or calls an Executor is rejected (`UnexpectedTransactionTarget`; see [pool-session.md](../core-sdk/pool-session.md) §Swap-executor screening). The screening utils `isLiFiExecutor(address, readErc20Proxy)` (known `LIFI_SWAP_EXECUTORS` on any chain, or a contract answering `erc20Proxy()` non-zero) and `isLiFiExecutorCall(data)` (`swapAndExecute` / `swapAndCompleteBridgeTokens` selector), plus `LIFI_EXECUTOR_SCREENING_ABI`, are exported from evm-sdk. The executor comes from `LIFI_SWAP_EXECUTORS[chainId]` unless the session sets one (`PoolSessionBuilder.withSwapExecutor({ executor, erc20Proxy })`, config `swapExecutor`), for chains the table does not list; it must answer `erc20Proxy()` like LiFi's Executor and both addresses must be on `approvedRouters`. Without an executor for the chain, or when the guarantee falls short, the session throws `NativeSwapDepositUnavailable`. Cross-chain native outputs stay refused (`NativeDestinationDepositUnsupported`).

**Native inputs and ERC-20 outputs in the composed call (2026-10-06, DEV-489).** The same composition now also serves a same-chain deposit whose contract-calls quote LiFi itself routes through its Executor, which it did in QA for a native-coin input (0.005 ETH into the mainnet USDT share pool, refused at the executor screening). That quote is discarded and the deposit composed as above, with two generalisations in `SwapThenCallParams`. `outputToken` names what the swap delivers and the call spends: the native coin (sent as the call's value, exactly the deposit's own value) or an ERC-20 (the deposit token, or a share's funding token), which the Executor's `LibSwap` max-approves to the deposit target before the call, the call itself carrying no value. A native input (`address(0)` in every Executor slot, decoded back to `NATIVE_ASSET_ADDRESS`) rides as the transaction's own value, which the Executor forwards whole to the swap, so the user approves nothing. Leftover output token returns to the owner through the Executor's `noLeftovers`. The original ERC-20-in, native-out encoding is unchanged byte for byte. Mainnet fork against the live Executor `0x2dfaDAB8…`: 0.01 ETH in, the deposit target pulled exactly the 10 USDT call amount, 16.87 USDT leftover went to the receiver, and the Executor's ETH and USDT balances were unchanged.

### `getSwapStatus(params)` — Transaction status tracking

Polls LiFi's REST API for swap execution status. Same-chain resolves immediately; cross-chain requires polling.

```typescript
const status = await provider.getSwapStatus({
    txHash: "0x...",
    fromChainId: 42161,
    toChainId: 10,          // Optimism
    bridge: "stargateV2",   // optional, speeds up lookup
});
// status.status: "NOT_FOUND" | "PENDING" | "DONE" | "FAILED" | "INVALID"
```

`INVALID` is LiFi's own verdict for an unrecognized or expired transfer, passed through
as-is (1.6.0) rather than folded into `NOT_FOUND` as it was before — unlike `NOT_FOUND`
(which may still resolve once indexing catches up), `INVALID` is unambiguously terminal
the moment LiFi returns it, so callers should treat the two differently rather than
retrying an `INVALID` transfer.

`getSwapStatus()` throws `SwapStatusFailed` on a non-OK HTTP response or a network-level
failure; the error carries a `retryable: boolean` (1.6.0) — `true` for a 429, a 404 (not
yet indexed, not necessarily gone), a 5xx, or any network-level throw, `false` for other
4xx responses — so a caller can distinguish "try again next poll" from "this request
itself was malformed."

## Route Echo Fields

Both `SwapQuoteResult` and `SwapAndDepositQuoteResult` carry four **required** echo fields:

| Field | Type | Description |
|---|---|---|
| `fromTokenAddress` | `Address` | Input token address LiFi actually routed. |
| `toTokenAddress` | `Address` | Output/deposit token address LiFi actually routed. |
| `fromChainId` | `number` | Source chain ID LiFi actually routed. |
| `toChainId` | `number` | Destination chain ID LiFi actually routed. |

They are populated from the LiFi step's `action` (`step.action.fromToken.address`, `step.action.toToken.address`, `step.action.fromChainId`, `step.action.toChainId`) in `extractSwapResult()` / `extractContractCallsResult()` — i.e. they reflect what the LiFi API **actually quoted**, not what was requested.

Purpose: the pool sessions (`prepareSwapQuote`, `estimateReshieldAmount`, `prepareReshieldQuote`) cross-check these echoes against the original request **before** hashing the calldata and throw `SwapQuoteMismatch(field, expected, actual)` on any divergence. Since the calldata hash is proof-bound, this guarantees a mis-routed quote can never be committed into a ZK proof.

## On-Chain Enforcement

For same-chain swaps, the `minOutputAmount` from LiFi's quote is enforced at two levels:

1. **Proof-bound**: Committed in `SwapRouting` struct → ABI-encoded into `transactParams.data` → bound into ZK proof context. Cannot be changed after proof generation.
2. **On-chain check**: `RelaySwaps.execute()` snapshots recipient's output token balance before and after the swap, reverts if `delta < minOutputAmount`.

When `recipient == address(0)` — the "no source-chain recipient" mode covering both reshield and cross-chain swaps — the on-chain `minOutputAmount` must be `0` (reverts with `RelaySwaps_MinOutputWithoutRecipient()` otherwise; `nativeGas` must likewise be `0`, reverting with `RelaySwaps_NativeGasWithoutRecipient()`). Output verification is delegated: reshield → LiFi → `Entrypoint.deposit()`, which reverts if the swap output is insufficient; cross-chain → LiFi's destination executor enforces `minAmountOut` from the proof-bound calldata.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.7.5 | 2026-10-07 — §Same-chain native deposits: the executor can be set per session (`PoolSessionBuilder.withSwapExecutor`, `PoolSessionConfig.swapExecutor`), overriding `LIFI_SWAP_EXECUTORS[chainId]` for both executor-composing sessions (swap-and-deposit and, since 1.7.3, same-chain reshield); needed for chains the table does not list (the EVM e2e runs a mock Executor on a Sepolia-id anvil). Numbered after 1.7.4 below, which this branch predates. |
| 1.7.4 | 2026-10-09 — §Bridge allowlist clarified: the native-input `msg.value` refusal it motivates was never a blanket block — only a route whose quoted `msg.value` exceeds `netSwapAmount` trips it — and, for cross-chain reshield, is no longer a hard refusal at all: `prepareReshieldCrosschainQuote` now funds a stacked-on-top bridge fee out of the budget instead; see [withdraw-and-swap.md](../core-sdk/withdraw-and-swap.md) §Cross-Chain Reshield. `allowBridges: ["across"]` remains a direct way to dodge fee-stacked routes (and their re-quote/headroom cost), not a workaround for an otherwise-unconditional block. No change to this provider's own code. |
| 1.7.3 | 2026-10-06 — DEV-489, §Native inputs and ERC-20 outputs in the composed call: a same-chain contract-calls quote that targets the Executor (LiFi's answer for a native-coin input) is discarded and the deposit composed by the session instead. `SwapThenCallParams` gains `outputToken`; a native input is sent as the transaction's value with no approval; an ERC-20 output is handed to the deposit call as an Executor approval. Screening pins `msgValue` to the native input amount (else 0) and the call's value per output kind. The original layout is unchanged byte for byte. |
| 1.7.2 | 2026-10-02 — Security fix, §Same-chain native deposits: the composed `Executor.swapAndExecute` is the only Executor transaction accepted, fully decoded with `callValue == depositMsgValue` and `msgValue == 0` pinned and an executor-free inner swap leg; the Executor is never an approval spender. New exported utils `isLiFiExecutor` / `isLiFiExecutorCall` and `LIFI_EXECUTOR_SCREENING_ABI`. `isLiFiExecutor` fails closed: only an `erc20Proxy()` revert or empty return (viem `ContractFunctionRevertedError` / `ExecutionRevertedError` / `ContractFunctionZeroDataError`, matched by name through `cause`) means "not an executor"; any other read failure is rethrown. `ContractReadError` now carries the underlying error as `cause`. |
| 1.7.1 | 2026-09-24 — `LiFiSwapQuoteProviderConfig.allowBridges?: string[]`: an optional LiFi bridge allowlist forwarded on every cross-chain `getSwapQuote()` / `getSwapAndDepositQuote()`, never on same-chain quotes, unset by default. New §Bridge allowlist documents the motivation (native-input flows cannot fund Stargate's LayerZero fee; `RelaySwaps_GasSwapNativeInput`), the provider-wide scope (also keeps ERC-20 inputs off Stargate / B2) and LiFi's measured enforcement (strict on `/quote`, best-effort on `/quote/contractCalls`). Numbered after 1.7.0 (`v2.0`, route-guarantee fields), which this branch predates. |
| 1.7.0 | 2026-09-24 — `SwapAndDepositQuoteResult` gains optional `toAmountMin` (LiFi `estimate.toAmountMin`) and `destinationCallAmount` (the `fromAmount` of LiFi's `custom` destination step). Documented the measured fact that LiFi ignores `contractCalls[].fromAmount` and encodes the route's guaranteed delivery as the destination call's `fromAmount` on every chain/bridge (native call: sent as `msg.value`; ERC-20 call: sizes the approval only). New util `decodeLiFiDestinationCallAmount()` (`utils/LiFiDestinationCall.ts`, exported from `utils`). `estimateReshieldCrosschainAmount()` now also calls `getSwapAndDepositQuote()` (route-guarantee probe) when a `swapAndDepositQuoteProvider` is configured. No wire-format change. |
| 1.6.0 | 2026-09-17 — finding #10, Problem C: `mapStatusResponse` no longer normalizes LiFi's `INVALID` status into `NOT_FOUND` — it's now its own `SwapStatus` value, since the two mean different things to a poller (dead vs. still-indexing). `getSwapStatus()`'s thrown `SwapStatusFailed` gained a `retryable: boolean` (429/404/5xx and network errors are retryable; other 4xx are not), so a caller can tell a transient upstream fault from a request-shape problem. |
| 1.5.0 | 2026-08-13 — Added `denyExchanges?: string[]` to `SwapAndDepositQuoteRequest`, threaded through `getSwapAndDepositQuote()` into the LiFi `getContractCallsQuote()` call. Closes the gap left by 1.4.0, which only covered the plain `getSwapQuote()`/withdraw-and-swap path — the reshield swap+deposit path (`prepareReshieldQuote()`) is equally exposed to the `fly` tool's `ExpiredTransaction()` failure mode and is proof-bound the same way. |
| 1.4.0 | 2026-08-13 — Added `denyExchanges?: string[]` to `SwapQuoteRequest`, threaded through `getSwapQuote()` into the LiFi `getQuote()` call's `baseParams`. Lets callers exclude specific LiFi tools by name — added because the `fly` tool embeds a transaction deadline in its calldata shorter than proof generation (~30-60s) plus relayer round-trip, causing a guaranteed on-chain `ExpiredTransaction()` revert; confirmed via direct on-chain reproduction. |
| 1.3.0 | 2026-07-07 — Route echo fields: `SwapQuoteResult` and `SwapAndDepositQuoteResult` gain required `fromTokenAddress`, `toTokenAddress`, `fromChainId`, `toChainId`, populated from LiFi's `step.action` in `extractSwapResult()` / `extractContractCallsResult()`. Pool sessions cross-check them against the request before hashing the calldata and throw `SwapQuoteMismatch` on divergence, so a mis-routed quote can never become proof-bound. |
| 1.2.0 | 2026-07-07 — Cross-chain enforcement model: on-chain `minOutputAmount` is `0` for cross-chain swaps (`toAmountMin` surfaced as informational `destinationMinOutputAmount`, enforced by LiFi's destination executor via proof-bound calldata). Zero-recipient mode requires `minOutputAmount == 0` and `nativeGas == 0` on-chain (`RelaySwaps_MinOutputWithoutRecipient` / `RelaySwaps_NativeGasWithoutRecipient`). `PoolSessionBuilder` now wires providers via `withSwapQuoteProvider()` / `withSwapAndDepositQuoteProvider()`. |
| 1.1.0 | 2026-07-07 — Added slippage defaults (0.5% same-chain, 3% cross-chain). Added `swapQuoteProvider` config field on `PoolSessionConfig`. Documented wiring through `PoolSessionFactory`. |
| 1.0.0 | Initial spec. `LiFiSwapQuoteProvider` wraps `@lifi/sdk` with SDK-native types. Implements `ISwapQuoteProvider`, `ISwapAndDepositQuoteProvider`, `ISwapProvider`. |
