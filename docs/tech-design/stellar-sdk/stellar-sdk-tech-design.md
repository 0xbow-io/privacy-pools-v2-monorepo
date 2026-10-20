# Stellar SDK - Tech Design

> **Package scope.** This document covers `packages/stellar-sdk` — the Stellar/Soroban-specific concrete implementations that plug into `packages/core-sdk`'s chain-agnostic architecture. For the shared facade (`PoolSession`), the stateful/stateless services, and the chain-adapter interfaces this package implements, see [core-sdk-tech-design.md](../core-sdk/core-sdk-tech-design.md), which also carries the **full pre-split version history** for the SDK as a whole (this doc's own history starts fresh below, at the point of the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` split). See [evm-sdk-tech-design.md](../evm-sdk/evm-sdk-tech-design.md) for the sibling EVM package.

## Dependency

`packages/stellar-sdk` depends on `packages/core-sdk` and implements its chain-adapter and service interfaces for Stellar/Soroban. It does not duplicate core-sdk's orchestration logic (note lifecycle, witness building, proof generation flow, generic swap/reshield session logic) — it supplies the Stellar-specific pieces those generic classes are parameterized over.

## Scope

| Area | What lives here | Interface implemented (from core-sdk) | Doc |
| --- | --- | --- | --- |
| Cryptography | `StellarCryptoService` — secp256k1 ECDH/ephemeral keys, ed25519-signature-keyed HKDF key derivation | `ICryptoService<StellarDeriveFromSignatureConfig>`, extends `AbstractCryptoService` | [crypto-service.md](crypto-service.md) (see also the retained historical draft [stellar-crypto-service.md](stellar-crypto-service.md)) |
| Proving | `StellarProofService` — Soroban circuit-artifact wiring around the shared `Groth16Prover` | `IProofService`, extends `AbstractProofService` | — |
| Chain adapters | `StellarPoolVaultChainAdapter`, `StellarEntrypointChainAdapter`, `StellarKeystoreChainAdapter` — Soroban-RPC-backed reads/writes injected into core-sdk's generic `PoolVaultInteractor` / `EntrypointInteractor` / `KeystoreInteractor` | `IPoolVaultChainAdapter`, `IEntrypointChainAdapter`, `IKeystoreChainAdapter` | [contract-interactor.md §Chain implementations](../core-sdk/contract-interactor.md#chain-implementations) |
| Relaying | `StellarRelayerInteractor` — Stellar/Soroban relayer client: quotes (send/receive/transfer/batch), relayed withdrawal (incl. yield via `processorAddress` + `minUnderlyingOut`), transfer, batch (`getBatchWithdrawalQuote` / `relayBatchWithdrawal`), register-and-withdrawal. Standalone `submitRelayedRegistration`, stealth relay-and-announce and swaps are unsupported | `IRelayerInteractor<TAddress>` | [relayer/stellar-relayer.md](../relayer/stellar-relayer.md) |
| Batch / routing codecs | `StellarRelayBatchCodec` builds (and simulates) `relay.relay_batch(relayer = owner, asset, items)` for a self-submitted batch; `StellarPayoutRoutingCodec` (`decodeArray` / `encodeArray` = concatenated 128-byte routings); `StellarPreparedTxVerifier` accepts `relay_batch` | `IRelayBatchCodec`, `IPayoutRoutingCodec`, `IPreparedTxVerifier` | [batch-withdraw.md](../core-sdk/batch-withdraw.md) |
| Relayed registration | `StellarKeystoreChainAdapter.buildRegistrationAuthorization` / `signRegistrationAuthorization` (Soroban auth entry over `keystore.set_auth_policy`), `IStellarWalletInteractor.signAuthEntry` (Keypair: `authorizeEntry`; Freighter: `signAuthEntry` over the preimage) | `IKeystoreChainAdapter` | [keystore-manager.md §Relayed Keystore Registration](../core-sdk/keystore-manager.md) |
| Yield (Blend v2) | `StellarYieldTokenInteractor`, `StellarYieldRouterInteractor`, `StellarYieldRouterCodec`, exposed as `StellarPoolSession.yield` / `yields` / `yieldFor` | `IYieldTokenInteractor`, `IYieldRouterInteractor`, `IYieldRouterCodec` (core's `PoolSessionYield*`) | [yield-sessions.md](yield-sessions.md) |
| Session wiring | `createStellarPoolSession` / `StellarPoolSessionBuilder` → `StellarPoolSession` (config `yield`, builder `yieldDeployments`) | — | see [core-sdk-tech-design.md](../core-sdk/core-sdk-tech-design.md) Architecture |

**Pool reads and writes.** A deposit carrying an ASP ciphertext calls `pool.deposit_with_label`, which registers the label with the pool's ASP registry in the same invocation (Soroban allows one contract call per transaction, so a separate `register_label` could half-succeed); an empty ciphertext uses plain `deposit`. `getCommitmentValue` / `getNullifierValue` read the pool's O(1) `commitment_created_at` / `nullifier_spent_at` timestamps and fall back to reconstructing them from event history only when that read fails (e.g. an archived entry). `encodeTransact(..., { deferSimulation: true })` (set by the orchestrator for a register-and-withdraw proof) builds the call unsimulated via `IStellarRPCInteractor.buildUnsimulatedTransaction`; `buildTransactionWithAuth` builds a call carrying third-party auth entries and simulates it in enforcing mode (the relayer's `register_and_relay`). See [contract-interactor.md §Chain implementations](../core-sdk/contract-interactor.md#chain-implementations).

**Receipt polling.** `SorobanRPCInteractor.waitForTransactionReceipt` re-checks a submitted transaction every `receiptPollIntervalMs` (config on `SorobanRPCInteractorConfig` and `StellarPoolSessionBuilder`; default 2000 ms, timeout 60 s). The default suits public networks (~5 s ledgers); a local standalone network closes a ledger about every second, and the e2e suite uses 200 ms.

**Event fetching.** The chain adapters read `LeavesInserted` / keystore / note events through `SorobanRPCInteractor.getEvents`, which starts at the caller's requested ledger (minimum 1) — there is no fixed lookback from the head. If that ledger predates the RPC's retention window, it retries once at the RPC-reported oldest ledger (parsed from the `startLedger must be within the ledger range: <min> - <max>` error); other range errors throw `StellarEventRetentionWindowExceeded`. Because stellar-rpc caps the ledgers scanned per request (~10k on stellar-rpc 28), a short page is not the end of the range: paging continues until a short page's cursor ledger reaches the response's `latestLedger` (or the cursor stops advancing). History older than the RPC's retention window is not reachable — see [contract-interactor.md §Chain implementations](../core-sdk/contract-interactor.md#chain-implementations).

## What doesn't exist here (yet)

Several EVM-only extensions in `packages/evm-sdk` have no Stellar counterpart today:

- **Swap chain adapter.** The chain-agnostic `ISwapChainAdapter<TTx, TAddress>` interface (used by core-sdk's generic `PoolSessionWithdrawAndSwap` / `PoolSessionReshield` / `PoolSessionSwapDeposit` sessions) has no Stellar implementation — only `EvmSwapChainAdapter` exists. Withdraw-and-swap / reshield / swap-and-deposit flows are not currently reachable on Stellar.
- **Stealth addresses.** ERC-5564 is an EVM/secp256k1-specific standard; no equivalent stealth-payment module exists for Stellar.
- **Standalone relayed registration.** Only the atomic register-and-withdrawal is relayed on Stellar (`relay.register_and_relay`); `submitRelayedRegistration` throws.
- **Note discovery extensions.** `packages/stellar-sdk` uses core-sdk's `NoteDiscoveryService` base directly, with no `scanStealthDeposits`-style Stellar-specific subclass (mirroring the absence of a stealth module here).

---

**Version History**

| Version | Change |
| --- | --- |
| 1.3 | 2026-10-07 — Added the "Receipt polling" note under Scope: new optional `receiptPollIntervalMs` on `SorobanRPCInteractorConfig` and `StellarPoolSessionBuilder` config (default unchanged, 2000 ms). |
| 1.2 | 2026-10-01 — Scope gains yield (Blend v2 over core's chain-agnostic yield sessions; new [yield-sessions.md](yield-sessions.md)), batch withdraw (`StellarRelayBatchCodec` → `relay_batch`, routing-array codec, verifier), relayed registration (Soroban auth entry, `signAuthEntry`), the expanded `StellarRelayerInteractor` surface and `StellarPoolSession` wiring. New "Pool reads and writes" note: `deposit_with_label`, O(1) `commitment_created_at` / `nullifier_spent_at` with event fallback, `deferSimulation` / `buildUnsimulatedTransaction`, `buildTransactionWithAuth`. Removed "Yield sessions" from "What doesn't exist here (yet)"; added standalone relayed registration there. |
| 1.1 | 2026-09-30 — Added the "Event fetching" note under Scope: `SorobanRPCInteractor.getEvents` no longer clamps the start ledger to a fixed 1000-ledger lookback from the head (which silently dropped older events and left rebuilt state/keystore leaf arrays sparse); it starts at the requested ledger, falls back to the RPC-reported oldest ledger on a retention-range error, and pages until the cursor reaches the head instead of stopping at the first short page. No public API change. |
| 1.0 | 2026-09-16 — Split out of `sdk-tech-design.md` as part of the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` package split. This is a new, short package-overview doc; the individual service docs it points to carry their own full histories where they exist. See [core-sdk-tech-design.md](../core-sdk/core-sdk-tech-design.md) for the complete pre-split SDK version history. |
