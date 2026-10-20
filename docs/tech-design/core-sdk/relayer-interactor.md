# RelayerInteractor (shared interface)

### IRelayerInteractor&lt;TAddress&gt;

`IRelayerInteractor<TAddress>` (`packages/core-sdk/src/interfaces/IRelayerInteractor.ts`) is the chain-agnostic interface for the relayer interaction lifecycle: discovering configured relayers, requesting fee quotes, and submitting transactions through them so `msg.sender` (or the chain's equivalent) is the relayer's address rather than the user's — preserving sender privacy. It is generic over the chain's address type `TAddress` (defaults to EVM's `Address`).

Two concrete implementations exist:

| Implementation | Package | Transport |
| --- | --- | --- |
| `RelayerInteractor` | `packages/evm-sdk` | HTTP client against the relayer's REST API — see [evm-sdk/relayer-interactor.md](../evm-sdk/relayer-interactor.md) for the full method/endpoint/type reference. |
| `StellarRelayerInteractor` | `packages/stellar-sdk` | HTTP client against the same relayer REST routes (`/v1/{quote,relay,details}/stellar/:chainId/...`) — see [relayer/stellar-relayer.md](../relayer/stellar-relayer.md) for the server side (commitment layouts, checks). |

# Dependencies

Implementations inject their own HTTP/transport client (e.g. `IHTTPClient` in the EVM implementation).

# Interface shape

The interface declares the relayer lifecycle methods used across both chains — quoting and relaying for transfers, withdrawals, batch withdrawals, keystore registration (standalone and combined with a withdrawal), stealth withdraw-and-announce, and swaps:

- `getRelayers(): Promise<RelayerInfo<TAddress>[]>`
- `getTransferQuote(relayer, params): Promise<TransferRelayerQuote<TAddress>>`
- `getWithdrawalQuote(relayer, params): Promise<WithdrawalRelayerQuote<TAddress>>`
- `getBatchWithdrawalQuote(relayer, params): Promise<BatchWithdrawalRelayerQuote>`
- `relayBatchWithdrawal(relayer, params): Promise<Hex>`
- `relayTransfer(relayer, params): Promise<Hex>`
- `relayWithdrawal(relayer, params): Promise<Hex>`
- `submitRelayedRegistration(relayer, params): Promise<Hex>`
- `relayRegisterAndWithdrawal(relayer, params): Promise<Hex>`
- `relayWithAnnounce(relayer, params): Promise<Hex>`
- `getSwapQuote(relayer, params): Promise<SwapRelayerQuote | UncommittedQuote>`
- `relaySwap(relayer, params): Promise<Hex>`

**Stellar support (2026-10-01).** `StellarRelayerInteractor` implements quoting (`getWithdrawalQuote` → `/receive`, `getTransferQuote` → `/transfer`, `getBatchWithdrawalQuote` → `/batch`), `relayWithdrawal` (forwards the optional `processorAddress` + `minUnderlyingOut` of a yield withdrawal, routed by the relayer to `router.withdraw_to_underlying`), `relayTransfer` (the relayer submits the pool's own `transact` as gated processor; `amountOut == feeAmount` exactly), `relayBatchWithdrawal` (`relay.relay_batch`), and `relayRegisterAndWithdrawal` (`relay.register_and_relay`; `registration.signature` is the owner's signed Soroban auth entry). Not supported on Stellar (throw): `submitRelayedRegistration` (standalone relayed registration), `relayWithAnnounce` (no ERC-5564), `getSwapQuote` / `relaySwap` (swap subsystem is EVM-only); `extraGas` is rejected (Stellar's `PayoutRouting` has no native-gas leg).

Every method's exact parameter/return shapes, HTTP endpoints, and the EVM-specific quote/commitment semantics (fee drift, zero-recipient sentinel, stealth binding, etc.) are documented per-implementation — see [evm-sdk/relayer-interactor.md](../evm-sdk/relayer-interactor.md), which is the only implementation with a full narrative spec today.

Confirmation is not part of `IRelayerInteractor`: callers watch the returned transaction hash via the chain's own RPC/wait-for-receipt mechanism. A relayer's returned hash is not guaranteed to be the hash that mines — see [evm-sdk/relayer-interactor.md](../evm-sdk/relayer-interactor.md) (1.9.0) for the EVM relayer's stuck-nonce cancel/replace behavior and its `202 Accepted` response-code fix.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.2 | 2026-10-01 — `StellarRelayerInteractor` row and new "Stellar support" paragraph: batch quote/relay, yield withdrawal fields, relayed transfer, register-and-withdrawal now implemented on Stellar; unsupported methods listed. Server side documented in the new [relayer/stellar-relayer.md](../relayer/stellar-relayer.md). |
| 1.1 | 2026-09-25 — Doc-only: corrected the "never replaces it" claim above — see evm-sdk/relayer-interactor.md 1.9.0 for the EVM relayer's stuck-nonce cancel/replace behavior and its 202 Accepted response-code fix. |
| 1.0 | 2026-09-16 — Split out of `sdk/relayer-interactor.md` as part of the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` package split. Documents only the shared `IRelayerInteractor<TAddress>` interface shape; the full method/endpoint reference and its version history live in [evm-sdk/relayer-interactor.md](../evm-sdk/relayer-interactor.md) (primary lineage — the original doc's 1.0.0–1.6.1 history). |
