# SDK — Aave-Yield (ppUSDC) Sessions

**Status:** EXTENSION (not part of the original SDK tech design; added for the ppUSDC yield module).
**Spec Guardian classification:** the base `sdk-tech-design.md` does not mention yield, ppUSDC, the
`PPRouter`, ERC-4626 wrappers, or Aave. This document is the spec for that added surface.

**Scope (2026-10-01).** The yield sessions are now **chain-agnostic and live in `packages/core-sdk`**
(`PoolSessionYieldDeposit` / `PoolSessionYieldWithdraw` / `PoolSessionYieldEarned`, the
`IYieldTokenInteractor` / `IYieldRouterInteractor` / `IYieldRouterCodec` seams, the
`YieldDeploymentConfig` / `YieldQuote` / `PreparedYield*` types and the sizing constants). This
document describes **EVM's implementation** on top of them: the Aave/ERC-4626 venue, the
`PPRouter` ABI re-encode, ERC-20 approval planning and the swap-flow integration. The Stellar
(Blend v2) implementation is specified in [stellar-sdk/yield-sessions.md](../stellar-sdk/yield-sessions.md).

## Purpose

Let the SDK drive the Aave-yield asset (ppUSDC) end to end. The privacy pool shields ppUSDC
*shares*; the user holds/withdraws the *underlying* (USDC). The combined `PPRouter` bridges the two:

- **Deposit:** USDC → (`PPRouter.depositExactShares`) → wrap to ppUSDC + shield into the pool.
- **Withdraw:** shielded ppUSDC → (`PPRouter.withdrawToUnderlying`) → unwrap to USDC → recipient.
- **Direct exit:** ppUSDC → (`PPYieldToken.redeem`) → aUSDC (the always-available exit that never
  calls Aave; use after a ragequit unshields the note).

The core insight both flows rely on: a yield deposit/withdraw is a **standard** SDK deposit/transact
proof re-targeted at the router. The SDK builds the normal proof (targeting `Entrypoint.deposit` /
`PoolVault.transact`); the yield session decodes that calldata and re-encodes it as the matching
router call. Because the proof context (`keccak(noteData)` for deposit; the bound `PayoutRouting`
for withdraw) is unchanged, the proof stays valid — the router only adds the wrap/unwrap and a
slippage bound.

That insight is chain-neutral, so the sessions that apply it are core-sdk's. The chain-specific half
is the `IYieldRouterCodec`: core builds the standard share-token deposit / transact and hands the
built transaction to the codec, which lifts the proof and arguments out and re-encodes them at the
router (`encodeDepositExactShares`, `encodeWithdrawToUnderlying`) and plans any funding step
(`planDepositFunding`). On EVM that codec is `EvmYieldRouterCodec` (ABI decode/encode, `nativeMode`
routing to `depositExactSharesNative`, ERC-20 approval planning).

## Components

| Component | Kind | Responsibility |
|---|---|---|
| `PoolSessionYieldDeposit` / `PoolSessionYieldWithdraw` / `PoolSessionYieldEarned` (core-sdk) | sessions | The chain-agnostic flows below, generic over `TTx`/`TAddress` with EVM defaults; `IPoolSessionYieldDeposit` / `IPoolSessionYieldWithdraw` interfaces and helpers `defaultMaxUnderlyingIn`, `ppmHeadroom`, `inferVettingFeeBps`, `noteTimestamp` live there too. |
| `EvmPoolSessionYieldDeposit` / `EvmPoolSessionYieldWithdraw` / `EvmPoolSessionYieldEarned` | EVM subclasses (`EvmYieldSessions.ts`) | Configure the core sessions from an EVM `YieldDeployment` (`toYieldDeploymentConfig` maps `ppRouter`/`ppUSDC`/`ppUSDCDecimals` onto core's `router`/`shareToken`/`shareDecimals`), wiring `EvmYieldRouterCodec`, `EvmPayoutRoutingCodec`, `EvmAddressEqualityComparator` and `EMPTY_ADDRESS`. The old evm-sdk `PoolSessionYield*` classes and `IPoolSessionYield*` interfaces are removed (now core). |
| `EvmYieldRouterCodec` | `IYieldRouterCodec` | `Entrypoint.deposit` calldata → `depositExactShares` (or `depositExactSharesNative` in `nativeMode`); `PoolVault.transact` calldata → `withdrawToUnderlying`; `planDepositFunding` = `[approve(router, 0)?, approve(router, cap)]` (none in native mode, for executor funding, or when the allowance already covers the cap). |
| `PPYieldTokenInteractor` | contract interactor (read + encode) | `IPPYieldTokenInteractor extends IYieldTokenInteractor<Address>`: `exchangeRate` / `previewDeposit` / `previewRedeem` reads; plus the EVM-only `encodeRedeem` (direct aUSDC exit). |
| `PPRouterInteractor` | contract interactor (read) | `IPPRouterInteractor = IYieldRouterInteractor<Address>`: `quote` (deposit sizing) / `quoteWithdraw` (withdraw sizing) / `supplyBufferUnits` (the zap's constant `ZAP_SUPPLY_BUFFER_UNITS` = 2). |
| `constant/Yield.ts` (evm-sdk) | constants | ABIs, `YieldDeployment` map + `LOCAL_FORK_YIELD_DEPLOYMENT`, `ZAP_SUPPLY_BUFFER_UNITS`, helpers (`CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM` is core-sdk's `constant/common.ts`). `YIELD_BPS_DENOMINATOR`, `WITHDRAW_SLIPPAGE_BPS`, `YIELD_PPM_DENOMINATOR` and `DEPOSIT_RATE_HEADROOM_PPM` moved to core-sdk's `constant/Yield.ts` (re-exported). |
| `errors/Yield.ts` | errors | `YieldSessionBaseError` + `UnexpectedDepositCalldata` / `UnexpectedWithdrawCalldata` / `InvalidYieldAmount`. |
| `utils/YieldSwapOutput.ts` | helpers | The router as the **final leg of a swap-shaped flow**: `yieldDepositTargetFor` (share → configured target), `yieldDepositFundingToken` (underlying, or the native coin for a native-mode router), `prepareYieldSwapDeposit` (size shares from a delivered budget, encode `depositExactShares` / `depositExactSharesNative`, no wallet approvals), `assertYieldDepositMatches` (target = the configured router, calldata decodes to the share note, cap = budget, native value only in native mode). |

## Deposit flow

1. Size the shares. From a mint principal: `sharesForUnderlying(usdc)` = `previewDeposit(usdc)`
   exactly (no discount: the shares are the fixed leg of `depositExactShares`, so a discount here
   is an under-deposit, not a protection). From an all-in budget ("deposit 100 USDC"):
   `sizeSharesForBudget(budget)` → `{ shares, underlyingNeeded, maxUnderlyingIn: budget, headroom }`,
   which reserves `DEPOSIT_RATE_HEADROOM_PPM` of the budget for the rate to move and fits the
   router's full price (value + vetting-fee shares, plus `router.supplyBufferUnits()` — on EVM the zap's `ZAP_SUPPLY_BUFFER_UNITS`) inside
   the rest. The headroom starts aging at sizing: it has to cover proof generation, the wallet
   prompts, the approval confirmation and the deposit inclusion; if the budget no longer fits at
   `prepareYieldDeposit`, size and prepare again.
2. `prepareYieldDeposit({ value, maxUnderlyingIn?, recipient? })` takes `value` as exact shares — a positive
   `bigint` in the share token's smallest unit, so `sizeSharesForBudget(...).shares` /
   `sharesForUnderlying(...)` pass straight through (`<= 0` → `InvalidYieldAmount`;
   it is hex-encoded internally for the base deposit). It builds the standard ppUSDC deposit proof
   (`tokenId = ppUSDC`), binds `maxUnderlyingIn` (the caller's, else `quote(value).underlyingNeeded` +
   `DEPOSIT_RATE_HEADROOM_PPM`, floored at one unit — `defaultMaxUnderlyingIn`), then hands the built
   deposit to `EvmYieldRouterCodec.encodeDepositExactShares` (decodes `(proof, noteData, aspCiphertext)`
   from the `Entrypoint.deposit` calldata, re-encodes `depositExactShares`) and
   `planDepositFunding` (the USDC→router approvals for the cap). Returns `approvalTxs` / `approvalTx` +
   `depositTx` plus the `pendingNote`. A caller cap below the quote is refused with `InvalidYieldAmount`.
3. Submit every `approvalTxs` entry in order (a zero reset precedes the approval when the router still holds a residual allowance — mainnet USDT reverts otherwise; vuln-mining #28), then `depositTx`; persist `pendingNote` once mined. A deposit that outlives
   its cap reverts with `PPRouter_SlippageExceeded`: re-quote and retry.

## Withdraw flow

1. `prepareYieldWithdraw({ inputCommitments, amount, amountOut, recipient, feeAmount?, ... })` takes
   `amount` / `amountOut` / `feeAmount` as `bigint` raw shares (`amountOut <= 0`, a negative `feeAmount`, or
   `feeAmount > amountOut` → `InvalidYieldAmount`; `feeAmount` defaults to `0n`; hex-encoded
   internally for the base transact), then builds the standard transact proof with the router bound as `processorAddress` and a `PayoutRouting`
   (`recipient`, `feeRecipient`, `feeAmount`, `nativeGas`) bound as `transactParams`.
2. `EvmYieldRouterCodec.encodeWithdrawToUnderlying` decodes `(proof, transactParams, noteData)` from the
   `PoolVault.transact` calldata and re-encodes as `withdrawToUnderlying`, with `minUnderlyingOut = quoteWithdraw(recipientShares) ×
   (1 − slippageBps)` where `recipientShares = amountOut − feeAmount`.
3. Returns the single `withdrawTx` (value = `nativeGas`) plus `changePendingNotes` / `spentNotes`.

The recipient slippage floor (`minUnderlyingOut`) is a router parameter, **not** bound in the proof
(inherited limitation, cf. contracts finding I-5); the session sets it from an honest quote and the
caller may override `slippageBps`.

## Deliberate deviations

- **`bigint` public API, not `Hex`.** SDK coding standard #5 says public values are `Hex`. The yield
  surface uses `bigint` for numeric amounts, matching the batch-withdraw feature's precedent
  (`computeBatchItemFee(args): bigint`) rather than rule #5. Since 1.2 the yield params are `bigint`
  raw shares throughout: `YieldDepositParams.value` and the withdraw params' `amount` / `amountOut`
  (plus `YieldWithdrawParams.feeAmount`), hex-encoded internally before the base sessions. `Hex` is
  still used where the base sessions' outputs already speak it (`pendingNote.value`,
  `minUnderlyingOut`); the relayer fee commitment's `feeAmount` / `amountSent` stay decimal strings
  (wire format).

## Relayed withdrawals

Supported by design, no extra API: `withdrawToUnderlying` can be called by anyone (the payout is
bound in the proof and `minUnderlyingOut` floors the recipient leg), so the produced `withdrawTx` is
broadcastable by a third party. To relay, set `feeRecipient` to the relayer and `feeAmount` to its
fee (in ppUSDC shares) — the router pays that leg to the relayer and the recipient leg excludes it.
The user's protection holds regardless of who submits.

Typed relay integration (F-1): `PoolSessionYieldWithdraw.prepareYieldWithdrawRelay({ amount, amountOut, ..., signedFeeCommitment })`
(`amount` / `amountOut` as `bigint` shares)
returns a `WithdrawalRelayParams` carrying `processorAddress = PPRouter` and `minUnderlyingOut` (Hex,
sized from `quoteWithdraw`) instead of a self-submit `withdrawTx`. `RelayerInteractor.relayWithdrawal`
forwards those two optional fields; the relayer routes a request with `processorAddress` set to
`PPRouter.withdrawToUnderlying(..., minUnderlyingOut)` (allowlisted processor). This closes the earlier
gap where the SDK could not reach the relayer's yield-withdraw path.
Before proving, the (core) session checks the commitment's `amountSent == amountOut` and
`feeAmount <= amountOut`, then decodes the relayer's routing with the chain's
`payoutRoutingCodec.decode` and runs `assertDecodedPayoutRoutingMatchesQuote` (recipient = the
caller's, fee = the committed fee, native-gas presence = `extraGas`) — the same theft guard every
relayed withdrawal uses, so a relayer cannot redirect the payout through a routing it signed.

Relayer side (2026-09-04): the fee quote the SDK requests for `asset = ppUSDC` is priced by the
relayer's `"Underlying"` quoter alias — the share entry in `relayer.config.json` names its
`underlying` (USDC), the relayer quotes USDC through USDC's own provider and scales by the
wrapper's live `previewRedeem(1 share)` (the same read `PPRouter.quoteWithdraw` makes), so the
committed `feeAmount` is in shares and tracks accrued yield. The router must be listed in that
chain's `allowed_processors` or the relay request is rejected. This withdraw path does not need
RelaySwaps: a chain with `"Underlying"` assets but no `relay_swaps_contract` boots (2026-10-14 —
`YieldZapRegistry` warns and skips it instead of failing boot) and relays its shares through the
router as above; only yield swaps are off there (see next section).

## Spending a yield note through a RelaySwaps swap flow (unwrap)

A yield note can be spent through `PoolSession.prepareSwapQuote` / `relayWithdrawAndSwap`
(same-chain withdraw-and-swap, 2026-09-05) **and** through
`PoolSessionReshieldCrosschain.prepareReshieldCrosschainQuote` / `relayReshieldCrosschain`
(cross-chain reshield, 2026-09-10) when the relayer's processor is a RelaySwaps whose
`approvedZaps` allowlist contains the wrapper's `PPYieldTokenZap` (`executeUnwrapped(…, zap)`
redeems the withdrawn shares into their underlying before the swap; see
`docs/tech-design/future-ideas/relayswaps-yield-unwrap.md`). The relayer derives the zap it
passes on-chain from `RelaySwaps.approvedZapList()` at boot (`YieldZapRegistry`). On a chain
with yield assets but no `relay_swaps_contract` (2026-10-14: Optimism, Base, Arbitrum, until
RelaySwaps is deployed there) the registry warns and skips the chain, so this path is
unavailable: `quoteSwap` / `relaySwap` return 400 "Swaps not supported for chain X" and
`/v1/details` reports `swapsSupported: false`. Plain relayed withdrawals of the share through its
`PPRouter` are unaffected.

The session is configured with `yieldWrappers` (the factory derives them from
`yieldDeployment`/`yieldDeployments`), each pairing a `YieldDeployment` with a
`PPYieldTokenInteractor` bound to the **source** chain (where the spent share note lives). For
a spent `tokenId` that matches a wrapper's `ppUSDC`:

- reads `RelaySwaps.approvedZaps(zap)` on the relayer's `processorAddress` first and rejects an
  un-allowlisted (or unconfigured) zap — before any relayer commitment;
- quotes the relayer on the **share** (fee in shares, proof-bound, `maxRelayFee` in shares);
- quotes LiFi on the **underlying** for what the net shares `previewRedeem` to — the same read
  the processor's zap performs on-chain. The share rate only rises between quote and execution
  under Aave accrual, so the difference surfaces as dust to `dustRecipient`, never a shortfall;
- checks the LiFi budget / dust bounds in **underlying** units (cross-chain: against
  `previewRedeem(gross − committedFee)`, and the B2 gas swap runs on the underlying too);
- returns `swapInputToken` (= the underlying) on the prepared quote; `dustAmount` /
  `netSwapAmount` are in that unit while `netAmount` (the relay leg) stays in shares.

The relay leg and the proof are unchanged: `netAmount` is in shares and the commitment asset
is the share. Same-chain `PoolSessionReshield` (2026-09-10, PR-3) is yield-aware too — the same
pattern with no bridge, no B2, no Stargate budget: `estimateReshieldAmount` /
`prepareReshieldQuote` quote LiFi on the underlying and check `assertLifiBudget` /
`dustAmount` in underlying units. The deposit side — landing *as* a pp-share from a swap-shaped flow — is covered by the next section.

## Landing as a share: swap-deposit and reshield into a wrapper (2026-09-18)

Every swap-shaped flow (`PoolSessionSwapDeposit`, `PoolSessionReshield`, `PoolSessionReshieldCrosschain`)
used to end in a plain `Entrypoint.deposit(outputToken)`, so a share could never be the output: the swap
buys the underlying, and turning underlying into a shielded share is `PPRouter.depositExactShares`. A
share is now a valid `depositToken` / `outputToken` whenever the session has a matching yield target:

1. **Target lookup.** `PoolSessionFactory` passes every configured wrapper (`session.yields`, each
   tagged with its `chainId`) to the swap sessions as `yieldDepositTargets`; a cross-chain reshield
   takes `destinationYieldDepositTargets` (the DESTINATION session's yields, `PoolSessionBuilder
   .withDestinationYieldDepositTargets()`). A target from another chain fails construction
   (`InvalidPoolSessionConfig`), so a source-chain router can never be encoded for a destination deposit.
2. **Funding token.** LiFi swaps into the wrapper's funding token: the underlying, or the native coin
   when `YieldDeployment.nativeMode` is set (ppETH's router). The share itself never trades.
3. **Sizing.** `prepareYieldSwapDeposit(target, budget)` → `sizeSharesForBudget(budget, headroom)`:
   shares are sized so the router's `underlyingNeeded` (value + vetting-fee shares + zap buffer) fits
   under the budget minus a rate headroom — `DEPOSIT_RATE_HEADROOM_PPM` (1 ppm) for the atomic
   same-chain paths, `CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM` (500 ppm) after a bridge, since an
   Aave-backed share appreciates ~1 ppm every 10–15 minutes and a leg takes minutes. The spend cap
   stays the FULL budget (`maxUnderlyingIn`, or `msg.value` in native mode); the surplus returns as dust.
   Cross-chain (2026-09-24): the budget LiFi actually hands the router is the route's guaranteed
   delivery (`toAmountMin`), not the requested cap — for an ERC-20 router that sizes the Executor's
   approval, for a native-mode router LiFi sends it as `msg.value` and the router treats it as the
   cap, pulling `underlyingNeeded` and refunding the rest. The SDK gates on that guarantee before
   signing: `prepareReshieldCrosschainQuote` / cross-chain `prepareSwapAndDeposit` compare
   `totalDepositCost` (funding-token units) with `decodeLiFiDestinationCallAmount(...)` and throw
   `DestinationDepositUnaffordable` when it does not fit, with `affordableNoteValue` re-sized via
   `sizeSharesForBudget(destBudget × (1 − 100 bps), CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM)`; the
   cross-chain estimate probes the route and sizes under the guarantee up front. A plain native
   `Entrypoint.deposit{value}` is refused cross-chain (`NativeDestinationDepositUnsupported`) since it
   needs an exact `msg.value`; the native-mode router is exempt precisely because its value is a cap.
4. **Calldata.** The LiFi contract call is `depositExactShares(proof, noteData, aspCiphertext, cap)` with
   `toApprovalAddress` = the router (the Executor is `msg.sender`, so it must approve the router), or
   `depositExactSharesNative(...)` with the cap as value. `fundingSource: "executor"` on
   `prepareYieldDeposit` emits no wallet approvals — nothing leaves the user's wallet.
5. **Assertions.** The Entrypoint-only target checks accept the configured router for the output
   share and then run `assertYieldDepositMatches`: target address, ABI matching the router mode, proof
   signals = share id + note value, cap = `totalDepositCost`, no native value on an ERC-20 router.
6. **Estimates.** `noteValue` is in shares, `vettingFee` reports `0` (the router takes it in shares
   inside the sizing), `totalDepositCost` is the funding-token budget LiFi must deliver.
7. **Cross-chain dust rescue** registers the funding token (underlying) as `tokenId`, since that is
   what a fallback would receive; the routing's `outputToken` is the native sentinel so RelaySwaps'
   source-chain balance reads never touch a destination-only address.
8. **Landing for a third-party recipient (2026-10-02 — reshield-and-transfer).** `prepareYieldSwapDeposit`
   now takes an optional trailing `recipient: YieldDepositForRecipient<TAddress>` and, when present,
   routes through `target.prepareSwapDeposit(budget, headroomPpm, recipient)` instead of the
   self-deposit path — the generic `YieldSwapDepositTarget` interface method (`packages/core-sdk`)
   gained this same optional parameter, forwarded by evm-sdk's `toYieldSwapDepositTarget` adapter to
   `PoolSessionYieldDeposit.prepareYieldDepositFor` (itself new: the shared `prepareYieldDeposit`
   pipeline — decode, re-encode as `depositExactShares`, approval planning — extracted into a private
   `prepareYieldDepositInternal` so both the self- and for-a-recipient paths share it). Recipient
   identity is the same blind-`noteAddressHash` / `discoveryData` union `IPoolSessionDeposit
   .prepareDepositFor` already accepts; the result carries a `noteSecret?: Hex`, present only when an
   unregistered `discoveryData.evmAddress` recipient opted into the out-of-band fallback
   (`allowOutOfBandFallback: true`) — no on-chain announcement, caller must deliver it out-of-band.
   Omitting `recipient` is behaviourally identical to before (still calls the self-deposit
   `prepareYieldDeposit`, never `prepareYieldDepositFor`) — this is purely additive. See
   [withdraw-and-swap.md](../core-sdk/withdraw-and-swap.md) §Reshield and Transfer and
   [pool-session.md](../core-sdk/pool-session.md) §Reshield and Transfer for the sessions that use it.

Not yet covered: `nativeMode` is configuration-supplied — the relayer's `/v1/details` `yield[]` does
not publish it, so `yieldDeploymentsFromDetails` leaves it unset and a discovery-built ppETH target
funds in WETH through `depositExactShares` (valid on a native-mode router, just not the native entry).
A `depositExactSharesNative` refund goes to `msg.sender` = LiFi's Executor; whether the Executor
forwards leftover native to the receiver is unverified on a fork.

## Not yet implemented
- **[DONE] Full-session fork e2e** (`packages/evm-sdk/scripts/e2e-yield/yield-e2e.test.ts`, gated `YIELD_E2E=1`): drives `PoolSessionYieldDeposit` + `PoolSessionYieldWithdraw` on a live anvil Sepolia fork with REAL Groth16 proofs — deposit -> 1yr Aave yield -> withdraw, recipient receives principal + delivered yield, pool drained.
- **Real-proof withdraw integration test.** The deposit re-encode has a runnable real-Groth16-proof
  test (`test/services/PoolSessionYieldDeposit.realproof.integration.test.ts`). The withdraw
  re-encode is covered with real *field-element-magnitude* values through the real `uint256[][]`
  ABIs, but not with a genuine transact proof — that needs a full valid transact witness (notes,
  Merkle/keystore/ASP proofs), i.e. the on-chain e2e harness, deferred with the relayed path.

Note: `PoolSessionFactory` now auto-wires the yield sessions/interactors as `PoolSession.yield` when
a `yieldDeployment` is configured (and the base deposit session + transact core are available). Since
2026-10-01 the wired sessions are the `EvmPoolSessionYield*` subclasses of the core sessions; the
public `YieldDeployment` config keeps its `ppRouter`/`ppUSDC` names.

## Deployments

`YIELD_DEPLOYMENTS` is empty: the module has no public-network deployment yet. Use
`LOCAL_FORK_YIELD_DEPLOYMENT` (local anvil Sepolia fork, dev/test only) or supply your own
`YieldDeployment`.

**Discovery (2026-09-17, vuln-mining #30).** Don't hand-copy wrappers for a relayed session: the
relayer publishes every wrapper it relays (`/v1/details` → `yield[]`, derived on-chain from its
`allowed_processors` at boot). `const details = await relayerInteractor.getChainDetails(relayer)`
then `PoolSessionBuilder.create({...}).withRelayerDetails(details)` enables one `YieldDeployment`
per wrapper with `ppRouter = yield[].router` — the processor a yield withdrawal must bind, or
the relay fails with `PoolVault_ProofContextMismatch`. Explicit `withYieldDeployment(s)` still wins.
`withRelayerDetails` also keeps the details (`EvmPoolSessionConfig.relayerChainDetails`, one entry
per call) to seed the cross-chain reshield's relayer-caps cache, so the B2 `max_swap_value_wei`
check makes no extra `/v1/details` call for that relayer; an entry for the destination chain also
supplies its `destinationCallsSupported`, which a cross-chain reshield into a share (or any other
destination deposit) checks before quoting — `false` → `DestinationCallsUnsupported` (see
[relayer-interactor.md](relayer-interactor.md) §RelayerChainDetails).

---

**Version History**

| Version | Change |
| --- | --- |
| 1.4.3 | 2026-10-14 — Discovery: a seeded `relayerChainDetails` entry for the destination chain also supplies `destinationCallsSupported`; a cross-chain deposit into a share is refused before quoting when it is `false` (`DestinationCallsUnsupported`). |
| 1.4.2 | 2026-10-14 — §Relayed withdrawals + §Spending a yield note through a RelaySwaps swap flow: a chain with yield assets but no `relay_swaps_contract` no longer fails relayer boot (`YieldZapRegistry` warns and skips it); shares still relay as plain `PPRouter` withdrawals, yield swaps are refused (400, `swapsSupported: false`). |
| 1.4.1 | 2026-10-08 — §Discovery: `withRelayerDetails` also appends the details to the new optional `EvmPoolSessionConfig.relayerChainDetails`, seeding the cross-chain reshield's relayer-caps cache. |
| 1.4 | 2026-10-05 — `YieldDepositForRecipient` is now an alias of `DepositForRecipient` (DEV-489), so a blind recipient's `noteData` may be a `NoteDataBuilder`: the share count is sized inside the SDK, so the caller cannot prebuild a payload that binds it. This is how `prepareSwapAndDeposit({ recipient })` lands a share for someone else, via the existing `prepareSwapDeposit(budget, headroomPpm, recipient?)` -> `prepareYieldDepositFor`. |
| 1.3 | 2026-10-02 — §Landing as a share, new point 8: `prepareYieldSwapDeposit` / `YieldSwapDepositTarget.prepareSwapDeposit` gain an optional `recipient` parameter, routing to the new `PoolSessionYieldDeposit.prepareYieldDepositFor` instead of the self-deposit path — the yield-share equivalent of `IPoolSessionDeposit.prepareDepositFor`, used by the new reshield-and-transfer sessions. Purely additive; omitting `recipient` is unchanged. |
| 1.2 | 2026-10-01 — **Breaking (public param type):** `YieldDepositParams.value` is now `bigint` (exact shares, smallest share-token unit) instead of `Hex`. `prepareYieldDeposit` rejects a `<= 0` value with `InvalidYieldAmount` (the malformed-hex rejection is gone) and hex-encodes it for the base `prepareDeposit`, so `sizeSharesForBudget(...).shares` / `sharesForUnderlying(...)` pass straight through. Same day, same break, extended to withdraw: `YieldWithdrawParams` / `YieldWithdrawRelayParams` `amount` / `amountOut` and `YieldWithdrawParams.feeAmount?` (default `0n`) are now `bigint` raw shares; `PoolSessionYieldWithdraw` validates them (`amountOut > 0`, `feeAmount >= 0`, else `InvalidYieldAmount`; malformed-hex rejection gone) and hex-encodes them for the base transact. Relayer fee-commitment amounts (`feeAmount` / `amountSent`, decimal strings) unchanged. `pendingNote.value` stays `Hex`. |
| 1.1 | 2026-10-01 — Yield made chain-agnostic. The sessions, their interfaces, types and sizing constants moved to core-sdk; this doc now describes EVM's implementation on top of them: `EvmYieldRouterCodec` (ABI re-encode, `nativeMode`, ERC-20 approval planning) and the `EvmPoolSessionYieldDeposit` / `Withdraw` / `Earned` subclasses (`toYieldDeploymentConfig` maps the EVM `YieldDeployment`). `IPPRouterInteractor = IYieldRouterInteractor<Address>` (gains `supplyBufferUnits`); `IPPYieldTokenInteractor extends IYieldTokenInteractor`. The relayed-withdraw theft guard is documented (`payoutRoutingCodec.decode` + `assertDecodedPayoutRoutingMatchesQuote`). Stellar counterpart: [stellar-sdk/yield-sessions.md](../stellar-sdk/yield-sessions.md). |
| 1.0 | 2026-07-02 → 2026-09-24 — Original ppUSDC yield-sessions spec (history carried in [core-sdk-tech-design.md](../core-sdk/core-sdk-tech-design.md) and [pool-session.md](../core-sdk/pool-session.md)). |
