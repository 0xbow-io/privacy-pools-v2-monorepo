# Swaps (PR #333) — User-Flow Matrix & SDK-Comprehension Check

- **Commit audited:** `7a0b764ebf9009f3f4fd0c2c62a05c65071f98a9`
- **Branch:** `review/swaps-333`
- **Lens:** Feature-completeness — does every conceivable swap flow have (a) a code path SDK→relayer→contract, and (b) a public, reachable SDK entry point?
- **Legend:** ✅ reachable · ⚠️ partial · ❌ missing-from-SDK (finding) · 🔵 documented-limitation

## Verdict

**DONE-WITH-GAPS.** Every core swap flow — withdraw-and-swap (same-chain + cross-chain), reshield, swap-and-deposit, and swap-status tracking — has a complete code path AND is reachable through the public SDK facade (`PoolSession`) and the barrel export (`packages/sdk/src/external.ts`). All three sessions and `LiFiSwapQuoteProvider` are exported and wired by `PoolSessionFactory`. **No ❌ (no real flow lacks an SDK path).** Findings are all ⚠️/🔵: (1) `SwapAndDepositParams` doc↔schema drift, (2) no slippage override on swap-and-deposit, (3) no self-submit (relayer-only) for withdraw-and-swap/reshield, (4) leg-1 bridge-refund stranding is a documented limitation only partially observable via `getSwapStatus`.

## Reachability spine (verified)

| Layer | Evidence |
|---|---|
| Facade methods present | `PoolSession.ts`: `prepareSwapQuote` L376, `relayWithdrawAndSwap` L389, `estimateReshieldAmount` L402, `prepareReshieldQuote` L415, `relayReshield` L428, `getSwapStatus` L441, `prepareSwapAndDeposit` L454, `executeSwapAndDeposit` L467, `swapAndDeposit` L480 |
| Public exports | `external.ts` L28-31: `PoolSessionWithdrawAndSwap`, `PoolSessionSwapDeposit`, `PoolSessionReshield`, `LiFiSwapQuoteProvider` (and `PoolSession` L4) |
| Factory wiring | `PoolSessionFactory.ts`: `withdrawAndSwap` L194, `reshield` L208, `swapDeposit` L223, `swapProvider: swapAndDepositQuoteProvider ?? swapQuoteProvider` L326 |
| Relayer endpoints | quote: `relayer/src/quote/quote.controller.ts:124` `@Post("swap")`; relay: `relayer/src/relay/relay.controller.ts:136` `@Post("relay-swap")`; SDK caller `RelayerInteractor.relaySwap` → `/v1/relay/{chainType}/{chainId}/relay-swap` (RelayerInteractor.ts:483+) |
| Contract entry | `packages/swaps/contracts/src/RelaySwaps.sol:201` `function execute(...)` |

`getSwapStatus` reachability is fully typed: `ISwapQuoteProvider` and `ISwapAndDepositQuoteProvider` both `extends ISwapProvider` (which declares `getSwapStatus`, `ISwapProvider.ts:22`), so the `?? swapQuoteProvider` fallback is valid and status tracking works whenever *either* LiFi provider is configured.

---

## User-Flow Matrix

### 1. Withdraw-and-swap — same-chain

| Flow | Code path | Reachable? | Evidence / Gap |
|---|---|---|---|
| ERC20 → ERC20 | `prepareSwapQuote` → `relayWithdrawAndSwap` → `/relay-swap` → `RelaySwaps.execute` | ✅ | Prepare `PoolSessionWithdrawAndSwap.ts:67`, relay `:241`. Contract ERC20 input path `RelaySwaps.sol:301-304` (approve→call→reset) |
| ERC20 → native | same | ✅ | Native output snapshot + delta enforced `RelaySwaps.sol:270-272, 309-311`; dust `_sweepDust` handles ETH `:344-347` |
| native → ERC20 | same | ✅ | Native input branch `RelaySwaps.sol:291-299` (`call{value:_swapAmount}`); no SDK token-type restriction — `tokenId`/`outputToken` pass straight through |
| Prepare + relay both reachable | — | ✅ | Both on facade (L376, L389), both exported via `PoolSessionWithdrawAndSwap` |

Same-chain `minOutputAmount` = LiFi `toAmountMin`, proof-bound and enforced by recipient balance-delta (`RelaySwaps.sol:307-316`); SDK validates the routing field (`assertSwapRouting`, WithdrawAndSwap `:505`).

### 2. Withdraw-and-swap — cross-chain (`toChainId` set)

| Requirement | Reachable + validated? | Evidence |
|---|---|---|
| `fallbackAddress` required | ✅ | Prepare throws if missing `WithdrawAndSwap.ts:90-95`; relay re-checks `:257-262` |
| `nativeGas` forbidden | ✅ | Prepare throws `:96-100`; routing assert forces `nativeGas==0` `:300-312`; on-chain `RelaySwaps_NativeGasWithoutRecipient` `RelaySwaps.sol:241-243`; relayer schema `evm.schemas.ts:143-148` + relay-time `evm.relay.service.ts:394-396` |
| routing `recipient == address(0)` | ✅ | Set `EMPTY_ADDRESS` when cross-chain `:105`; asserted at relay `:301`; real recipient only in proof-bound LiFi `toAddress` |
| `minOutputAmount == 0` on-chain | ✅ | Prepare uses `"0"` `:159`; relay throws on nonzero `:263-267`; on-chain `RelaySwaps_MinOutputWithoutRecipient` `:244-246`; `destinationMinOutputAmount` surfaced informationally (`PreparedSwapQuote`) |
| dustRecipient → relayer (not dest recipient) | ✅ | `:108-109` defaults to relayer address cross-chain |

### 3. Reshield (withdraw → swap → deposit back)

| Step | Code path | Reachable? | Evidence |
|---|---|---|---|
| estimate | `estimateReshieldAmount` → relayer prelim quote + LiFi `getSwapQuote` | ✅ | `PoolSessionReshield.ts:81`; facade L402. `vettingFeeBPS` read on-chain `:140`; noteValue≥min `:145-150` (`DepositBelowMinimum`) |
| prepare | `prepareReshieldQuote` → LiFi `getContractCallsQuote` + committed relay quote | ✅ | `:172`; facade L415 |
| relay | `relayReshield` → `/relay-swap` (same endpoint as w&s) → `RelaySwaps.execute` | ✅ | `:315`; facade L428 |
| deposit-target assertion | `depositResult.to == entrypoint` BEFORE any network call | ✅ | `:194-197` → `DepositTargetMismatch` |
| vettingFee correctness | `totalDepositCost == noteValue + on-chain vettingFee` stale-guard | ✅ | `:221-227` |
| zero-recipient invariants | recipient=0, minOutput=0, nativeGas=0 | ✅ | `assertReshieldRouting` `:540-596`; relayer + contract same guards as cross-chain |
| slippage protection | `Entrypoint.deposit()` reverts if swap output < noteValue+vettingFee (deposit embedded in proof-bound LiFi calldata) | ✅ | design; contract has no source-recipient check in this mode |

### 4. Swap-and-deposit (fresh external tokens → pool)

| Aspect | Finding | Evidence |
|---|---|---|
| Path | `prepareSwapAndDeposit` → LiFi `getContractCallsQuote` (deposit proof first) → self-submit via wallet | ✅ reachable | `PoolSessionSwapDeposit.ts:70`; facade L454/L467/L480 |
| Needs a relayer? | **No** — self-submitted (`executeSwapAndDeposit` submits LiFi tx via `entrypointInteractor.submitTransaction`) | ✅ | `:142-171`. This is the *only* swap flow that is NOT relayer-mediated |
| Approval safety | approves `fromToken` to LiFi `approvalAddress` (not entrypoint); `assertApprovalTx` guards spender | ✅ | `:189-207` |
| Cross-chain | Explicitly rejected (`fromChainId !== pool chainId` throws) | 🔵 documented-limitation | `:80-86` |
| **Param names** | Schema requires `{ fromChainId, inputToken, depositToken, depositAmount }` but `pool-session.md` documents `{ fromToken, toToken, depositAmount, fromAddress, fromChainId, toChainId }` | ⚠️ **FINDING D-1** | schema `schemas/PoolSessionSwapDeposit.ts:6-11`; impl destructures `inputToken`/`depositToken` `:78`; doc table pool-session.md L697-706 |
| **Result shape** | Doc lists `{ receipt, transactionRequest, approvalAddress, approvalAmount }`; impl returns `{ pendingNote, inputToken, estimatedInputAmount, …, approvalTx, transactionData, transactionTo, msgValue, estimatedDuration }` | ⚠️ (part of D-1) | impl `:122-134`; doc L708-716 |

### 5. Swap status tracking (`getSwapStatus`)

| Aspect | Finding | Evidence |
|---|---|---|
| Exposed on facade | ✅ | `PoolSession.ts:441` |
| Wired | ✅ whenever any LiFi provider configured | factory L326; both provider ifaces extend `ISwapProvider` |
| Async cross-chain usable | ✅ | polls LiFi `/status`, maps `NOT_FOUND/PENDING/DONE/FAILED` + substatus (incl. `REFUNDED`) `LiFiSwapQuoteProvider.ts:57-94, 270-298`; doc advises 5-10s polling |

### 6. Slippage defaults & override

| Flow | Default | Override reachable? | Evidence |
|---|---|---|---|
| Withdraw-and-swap same-chain | 0.5% | ✅ | `slippage?` param → `getSwapQuote` (`LiFiSwapQuoteProvider.ts:108-109`); prepare threads it `WithdrawAndSwap.ts:143` |
| Withdraw-and-swap cross-chain | 3% | ✅ | same default logic `:108`, `:150` |
| Reshield | 0.5%/3% | ✅ | `estimateReshieldAmount`/`prepareReshieldQuote` accept `slippage` `Reshield.ts:88,125,188,239` |
| **Swap-and-deposit** | 0.5% (forced same-chain) | ⚠️ **FINDING D-2** | `SwapAndDepositParamsSchema` has no `slippage`; `getSwapAndDepositQuote` call omits it (`SwapDeposit.ts:100-109`) → always provider default. User cannot override |

### 7. Failure flows

| Failure | Handled? | Surfaced to user? | Evidence |
|---|---|---|---|
| Swap reverts (leg 0, atomic) | ✅ | ✅ tx reverts | `RelaySwaps_SwapFailed` `RelaySwaps.sol:299,303`; funds never leave pool (`POOL.transact` inside same tx) |
| Quote expiry | ✅ | ✅ throws before proving | `assertFeeCommitmentLive` in `relayWithdrawAndSwap` `:317` / `relayReshield` `:366`; relayer re-checks (`RelayerInteractor.relaySwap` `:490`) |
| LiFi routes wrong token/chain | ✅ | ✅ `SwapQuoteMismatch` | `assertSwapQuoteMatchesRequest` before hashing `WithdrawAndSwap.ts:148`, `Reshield.ts:128,242` |
| Relayer tampers routing (recipient/fee/dust/target/approval/minOut/nativeGas) | ✅ | ✅ `InvalidTransactParams`/`RelayFeeExceedsMax` | field-by-field asserts `WithdrawAndSwap.ts:466-531`, `Reshield.ts:540-596`; proof-binding is primary |
| **Leg-1 bridge refund stranded on RelaySwaps (source chain)** | 🔵 **known limitation** | ⚠️ partial | Refund *observable* via `getSwapStatus` substatus `REFUNDED`, but funds land on `RelaySwaps` with **no rescue path** (dust sweep is delta-only). Admin rescue planned in a separate PR — `withdraw-and-swap.md` L165, taxonomy Leg 1 |

### 8. Self-submit (no relayer) swap — the BW-2 analog

| Flow | Self-submit path? | Finding |
|---|---|---|
| Swap-and-deposit | ✅ yes (`executeSwapAndDeposit`, wallet-submitted, no relayer) | reachable |
| Withdraw-and-swap | ❌ none — only `relayWithdrawAndSwap` | ⚠️ **FINDING B-1**: asymmetry vs plain withdraw (which has both `executeWithdraw` and `relayWithdraw`). No `executeWithdrawAndSwap`/`executeReshield`. The withdraw-and-swap/reshield design is relayer-only by construction (proof binds the relayer's `processorAddress`; the relayer's signed fee commitment `data` *is* the proof-bound routing). A user cannot self-submit these two flows. Not a missing *flow* (the flow is reachable via relay), but a missing *submission mode*. Document explicitly as relayer-only, or add a self-submit path if a no-relayer swap is intended to be supported. |

---

## Findings summary

| ID | Sev | Flow | Gap |
|---|---|---|---|
| **D-1** | Medium | Swap-and-deposit | `pool-session.md` documents wrong param names (`fromToken`/`toToken`/`fromAddress`/`toChainId`) and wrong result shape; real schema is `{ fromChainId, inputToken, depositToken, depositAmount }`. A user coding to the doc gets a Zod rejection. Fix the doc (or rename schema fields to match). |
| **D-2** | Low | Swap-and-deposit | No `slippage` override — `SwapAndDepositParamsSchema` omits it and the LiFi call always uses the 0.5% default. Add `slippage?` to the schema + thread it, or document the fixed default. |
| **B-1** | Low | Withdraw-and-swap / Reshield | No self-submit (relayer-only). By-design (proof binds relayer processor), but the relayer-only constraint is not stated as an explicit limitation the way swap-and-deposit's cross-chain block is. Document it. |
| **L-1** | Low (🔵) | Cross-chain leg 1 | Bridge refund strands funds on `RelaySwaps` with no rescue path; only partially observable via `getSwapStatus`. Already documented as a known limitation (rescue in a later PR). |

No ❌: every conceivable swap flow enumerated has a working code path and a reachable public SDK entry point.

## What I ran / verified
- `git rev-parse HEAD` → `7a0b764e…`; branch `review/swaps-333`.
- Traced each facade method to its delegate and confirmed export in `external.ts` and wiring in `PoolSessionFactory`.
- Read all three swap sessions, `LiFiSwapQuoteProvider`, `RelaySwaps.sol execute()` + errors, relayer quote/relay controllers + zero-recipient schema/relay re-validation.
- Cross-checked doc claims (native handling, cross-chain guards, slippage defaults) against source; found the swap-and-deposit doc↔schema drift (D-1) and slippage-override gap (D-2).
