# EVM SDK - Tech Design

> **Package scope.** This document covers `packages/evm-sdk` — the EVM-specific concrete implementations that plug into `packages/core-sdk`'s chain-agnostic architecture. For the shared facade (`PoolSession`), the stateful/stateless services, and the chain-adapter interfaces this package implements, see [core-sdk-tech-design.md](../core-sdk/core-sdk-tech-design.md), which also carries the **full pre-split version history** for the SDK as a whole (this doc's own history starts fresh below, at the point of the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` split). See [stellar-sdk-tech-design.md](../stellar-sdk/stellar-sdk-tech-design.md) for the sibling Stellar/Soroban package.

## Dependency

`packages/evm-sdk` depends on `packages/core-sdk` and implements its chain-adapter and service interfaces for EVM chains. It does not duplicate core-sdk's orchestration logic (note lifecycle, witness building, proof generation flow, generic swap/reshield session logic) — it supplies the EVM-specific pieces those generic classes are parameterized over.

## Scope

| Area | What lives here | Interface implemented (from core-sdk) | Doc |
| --- | --- | --- | --- |
| Cryptography | `CryptoService` — X25519 ECDH/ephemeral keys, ECDSA-signature-keyed HKDF key derivation (EIP-712 payload) | `ICryptoService<DeriveFromSignatureConfig>`, extends `AbstractCryptoService` | [crypto-service.md](crypto-service.md) |
| Proving | `ProofService` — EVM circuit-artifact wiring around the shared `Groth16Prover` | `IProofService`, extends `AbstractProofService` | — |
| Chain adapters | `EvmPoolVaultChainAdapter`, `EvmEntrypointChainAdapter`, `EvmKeystoreChainAdapter` — viem-backed reads/writes injected into core-sdk's generic `PoolVaultInteractor` / `EntrypointInteractor` / `KeystoreInteractor` | `IPoolVaultChainAdapter`, `IEntrypointChainAdapter`, `IKeystoreChainAdapter` | [contract-interactor.md §Chain implementations](../core-sdk/contract-interactor.md#chain-implementations) |
| RPC | `ViemRPCInteractor` — viem-backed chain reads (paginated `getLogs`, head / finalized block, receipts). `getBlockNumber()` always asks the node (`cacheTime: 0`): viem would otherwise serve a head up to 4 s old, and a log scan bounded by it misses blocks the caller just waited for | `IRPCInteractor` | — |
| Relaying | `RelayerInteractor` — HTTP client against the relayer's REST API (quotes, transfers, withdrawals, batch, keystore registration, stealth relay-and-announce, swaps) | `IRelayerInteractor<Address>` | [relayer-interactor.md](relayer-interactor.md) |
| Swap chain adapter | `EvmSwapChainAdapter` — router-allowlist reads, ERC-20 approval encode/decode, LiFi Executor screening (`isSwapExecutor` / `isSwapExecutorCall`, delegating to the exported utils `isLiFiExecutor` / `isLiFiExecutorCall` + `LIFI_EXECUTOR_SCREENING_ABI`), wired into core-sdk's generic `PoolSessionWithdrawAndSwap` / `PoolSessionReshield` / `PoolSessionReshieldCrosschain` / `PoolSessionSwapDeposit` sessions | `ISwapChainAdapter<TTx, TAddress>` | [withdraw-and-swap.md](../core-sdk/withdraw-and-swap.md) |
| DEX quoting | `LiFiSwapQuoteProvider` — wraps `@lifi/sdk` for withdraw-and-swap / reshield / swap-and-deposit quotes and swap-status polling | `ISwapQuoteProvider`, `ISwapAndDepositQuoteProvider`, `ISwapProvider` | [lifi-swap-quote-provider.md](lifi-swap-quote-provider.md) |
| Stealth addresses | ERC-5564 stealth address derivation/scanning/announcement, plus the stealth dust-rescue deposit-payload codec | (EVM-only extension, no core-sdk interface) | [stealth.md](stealth.md) |
| Note discovery | `EvmNoteDiscoveryService` — adds `scanStealthDeposits` (ERC-5564/secp256k1) on top of core-sdk's `NoteDiscoveryService` base | extends `INoteDiscoveryService` | see [note-discovery-service.md](../core-sdk/note-discovery-service.md) |
| Yield (ppUSDC) | `EvmYieldRouterCodec`, `EvmPoolSessionYieldDeposit` / `EvmPoolSessionYieldWithdraw` / `EvmPoolSessionYieldEarned` (subclasses of core's yield sessions, configured from the EVM `YieldDeployment`), `PPRouterInteractor`, `PPYieldTokenInteractor` — Aave/ERC-4626 venue | `IYieldRouterCodec`, `IYieldRouterInteractor`, `IYieldTokenInteractor` (core-sdk's chain-agnostic yield sessions) | [yield-sessions.md](yield-sessions.md) |
| Session wiring | `EvmPoolSession`, `PoolSessionFactory` (EVM), `PoolSessionBuilder` — construct a fully-wired `PoolSession` for an EVM chain, including the yield sessions when configured | — | see [core-sdk-tech-design.md](../core-sdk/core-sdk-tech-design.md) Architecture |

## What's generic vs. EVM-only

A common point of confusion: several session types with "swap" in the name are **not** EVM-only. `PoolSessionWithdrawAndSwap`, `PoolSessionReshield`, `PoolSessionReshieldCrosschain`, and `PoolSessionSwapDeposit` were genericized during the `core-sdk`/`evm-sdk`/`stellar-sdk` split and now live in `packages/core-sdk`, parameterized over the chain-agnostic `ISwapChainAdapter<TTx, TAddress>` interface. `EvmSwapChainAdapter` (this package) is the only implementation of that interface today. See [core-sdk/withdraw-and-swap.md](../core-sdk/withdraw-and-swap.md).

The **yield** sessions (`PoolSessionYieldDeposit` / `PoolSessionYieldWithdraw` / `PoolSessionYieldEarned`) are generic too since 2026-10-01: they live in `packages/core-sdk`, parameterized over `IYieldRouterCodec` / `IYieldRouterInteractor` / `IYieldTokenInteractor`. This package supplies the EVM venue (`PPRouter` / `PPYieldToken` over Aave) and `EvmYieldRouterCodec`; `packages/stellar-sdk` supplies a Blend v2 one. By contrast, the **stealth** address module genuinely has no generic equivalent (ERC-5564 is an EVM/secp256k1-specific standard).

---

**Version History**

| Version | Change |
| --- | --- |
| 1.4 | 2026-10-07 — Session wiring: `PoolSessionBuilder.withSwapExecutor({ executor, erc20Proxy })` sets the swap executor a same-chain native swap-and-deposit is composed through, overriding `LIFI_SWAP_EXECUTORS[chainId]` (see [lifi-swap-quote-provider.md](lifi-swap-quote-provider.md) v1.7.4). |
| 1.3 | 2026-10-06 — RPC row: `ViemRPCInteractor.getBlockNumber()` bypasses viem's block-number cache. With the default 4 s `cacheTime`, a scan run within seconds of a mined tx (note discovery after an ASP approval, `discoverRevocableKeyIndex` after a rotation) ended at a stale head and missed it. Surfaced by the EVM e2e moving from a Sepolia fork to a plain anvil. |
| 1.2 | 2026-10-02 — Swap chain adapter row: `EvmSwapChainAdapter` implements the new `ISwapChainAdapter.isSwapExecutor` / `isSwapExecutorCall` (LiFi Executor screening) via the newly exported utils `isLiFiExecutor` / `isLiFiExecutorCall` and `LIFI_EXECUTOR_SCREENING_ABI`. |
| 1.1 | 2026-10-01 — Yield row and "What's generic vs. EVM-only": the yield sessions are now core-sdk's chain-agnostic `PoolSessionYield*`; this package provides `EvmYieldRouterCodec` and the `EvmPoolSessionYield*` subclasses. See [yield-sessions.md](yield-sessions.md) v1.1. |
| 1.0 | 2026-09-16 — Split out of `sdk-tech-design.md` as part of the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` package split. This is a new, short package-overview doc; the individual service docs it points to (`crypto-service.md`, `relayer-interactor.md`, `lifi-swap-quote-provider.md`, `stealth.md`, `yield-sessions.md`) carry their own full histories. See [core-sdk-tech-design.md](../core-sdk/core-sdk-tech-design.md) for the complete pre-split SDK version history. |
