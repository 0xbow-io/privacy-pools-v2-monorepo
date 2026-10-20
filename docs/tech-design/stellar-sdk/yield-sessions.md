# Stellar SDK — Yield Sessions (Blend v2)

**Status:** EXTENSION. Stellar's implementation of core-sdk's chain-agnostic yield sessions. The
flows themselves (sizing, spend cap, slippage floor, relayed-withdraw guards) are core-sdk's and are
specified in [evm-sdk/yield-sessions.md](../evm-sdk/yield-sessions.md) §Deposit flow / §Withdraw flow
/ §Relayed withdrawals; this page covers only what differs on Soroban.

## Venue

The privacy pool shields a non-rebasing **share token** (`yield-token`), registered as an ordinary
pool asset; the user holds and receives the **underlying** (e.g. XLM). The share wraps a position in
a **Blend v2** pool through `yield-blend-adapter`, and `yield-router` bridges underlying ↔ shielded
shares in one call each way:

- **Deposit:** underlying → `router.deposit_exact_shares(from, value, output_commitment, proof, note_data, asp_ciphertext, max_underlying_in)` → the router takes exactly `max_underlying_in` from the depositor, mints the shares paying the adapter itself, `pool.deposit`s them, and refunds `max_underlying_in − cost` to the depositor.
  The depositor's signature covers only the router call and that fixed transfer, so it cannot go stale when
  `b_rate` moves between simulation and inclusion (the earlier shape had the depositor authorize Blend's
  `submit` with a rate-derived amount and failed with `auth: invalid_action`). Consequence: the depositor must
  **hold** `max_underlying_in`, not just the quoted `underlyingNeeded`. Inside, `yield-blend-adapter.supply`
  pulls the amount into the adapter and calls Blend `submit` with the adapter as `from` and `spender`.
- **Withdraw:** shielded shares → `router.withdraw_to_underlying(n, m, proof, roots…, amount_out, token_id_out, nullifiers, commitments, note_data, routing, min_underlying_out)` → `pool.transact` with the router as processor → redeem → underlying to the recipient, fee leg to the fee recipient.

No zap and no factories (unlike EVM's `PPYieldTokenZap` / wrapper factory). Contracts are deployed by
`packages/contracts-stellar/scripts/deploy/deploy-yield.mts` (local venue:
`scripts/blend/deploy-local-blend.mts`).

## Components

| Component | Implements (core-sdk) | Notes |
|---|---|---|
| `StellarYieldTokenInteractor` | `IYieldTokenInteractor<StellarAddress>` | `exchange_rate`, `preview_deposit`, `preview_redeem` reads; plus `previewMint` and `adapterAddress` used by the router interactor. |
| `StellarYieldRouterInteractor` | `IYieldRouterInteractor<StellarAddress>` | The Soroban router has no quote getters, so the quotes are **rebuilt** from the reads the router makes, with its rounding: `quote(value)` = `total = value + floor(value × vetting_fee_bps / 10000)` (fee read live from the pool's `get_asset_config` for the share), `underlyingNeeded = preview_mint(total)`; `quoteWithdraw(shares)` = `preview_redeem(shares)`; `supplyBufferUnits()` = the adapter's `supply_buffer` (Blend's `floor(b_rate) + 1`, moves with the reserve). |
| `StellarYieldRouterCodec` | `IYieldRouterCodec<string, StellarAddress>` | Parses the single `InvokeHostFunction` of the built pool call (`deposit` / `deposit_with_label`, or `transact`), checks asset = share token (and deposit value = requested shares), and rebuilds + simulates `deposit_exact_shares` / `withdraw_to_underlying`, reusing the proof, note data and committed values verbatim as ScVals. The withdraw call takes the `PayoutRouting` **struct**, decoded from the transact's `processor_data` with `StellarPayoutRoutingCodec`. `planDepositFunding` is always `[]` (the router's fixed `max_underlying_in` pull is authorized by the depositor's signature on the router call itself; no approval transaction). Rejects a non-zero `nativeGas` (`InvalidYieldAmount`: Stellar's routing has no gas leg). |
| `StellarPoolSession` | — | `PoolSession` subclass returned by `createStellarPoolSession` / `StellarPoolSessionBuilder.create`, exposing `yield` (first deployment), `yields` (all, config order) and `yieldFor(tokenAddress)` (match on share token or underlying; StrKeys compare exactly). Each entry is `StellarYieldSessions { deployment, deposit, withdraw, earned, token, router }`. |

`StellarYieldDeployment` is core's `YieldDeploymentConfig<StellarAddress>` as-is (`router`,
`shareToken`, `shareDecimals`, `underlying`, `underlyingDecimals`, `underlyingSymbol`).

## Wiring

- `StellarPoolSessionConfig.yield?: StellarYieldSessionConfig` — `{ deployments, rpcInteractor,
  readSourcePublicKey, poolContractId, aspRegistryContractId, walletInteractor? }`. Builder:
  `StellarPoolSessionBuilderConfig.yieldDeployments` (each share must be a registered pool asset).
  The same share configured twice throws `DuplicateYieldDeployment`.
- The factory builds the namespace through core's `buildChainExtensions` hook. The yield deposit runs
  on **its own deposit session**, obtained from `ChainSessionBuildContext.buildDeposit({ entrypointInteractor })`
  over a `StellarEntrypointChainAdapter` with `simulateDeposits: false`: the depositor holds no shares
  until the router mints them inside `deposit_exact_shares`, so simulating the plain share-token
  `pool.deposit` would always fail. That unsimulated envelope is never submitted — the codec lifts its
  arguments into the (simulated) router call.
- Withdraw uses the session's `TransactOrchestrator`, `StellarPayoutRoutingCodec`,
  `StellarAddressEqualityComparator` and `STELLAR_EMPTY_ADDRESS`.

## Relayed withdrawal

`withdraw.prepareYieldWithdrawRelay` returns `WithdrawalRelayParams` with `processorAddress = router`
and `minUnderlyingOut`; `StellarRelayerInteractor.relayWithdrawal` forwards both. The relayer accepts
`processorAddress` only when it equals the asset's configured `yield_router` and then submits
`router.withdraw_to_underlying` (see [relayer/stellar-relayer.md](../relayer/stellar-relayer.md)).
The fee is quoted in shares (the share's flat fee, set in the underlying's base units, converted via
the share's `preview_withdraw`). `extraGas`
is unsupported.

## Not covered on Stellar

- Swap-shaped flows landing as a share (no Stellar swap adapter).
- A direct share → Blend exit API in the SDK (EVM's `encodeRedeem`).

---

**Version History**

| Version | Change |
| --- | --- |
| 1.2 | 2026-10-02 — Yield fee note: the relayer's flat fee is per asset, in the underlying's base units (no longer a single stroop amount). |
| 1.1 | 2026-10-01 — Deposit: router pulls the fixed `max_underlying_in`, mints as payer and refunds the unused part (depositor must hold the ceiling); adapter `supply` pulls first and submits to Blend as its own spender, so the signature no longer goes stale on `b_rate` moves. |
| 1.0 | 2026-10-01 — Initial spec: Stellar yield over Blend v2 on core-sdk's chain-agnostic yield sessions (`StellarYieldTokenInteractor`, `StellarYieldRouterInteractor`, `StellarYieldRouterCodec`, `StellarPoolSession.yield/yields/yieldFor`, `StellarPoolSessionConfig.yield`, builder `yieldDeployments`, unsimulated share-token deposit via `buildDeposit`). |
