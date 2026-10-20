# Relayer — Stellar (Soroban) Chain

Spec for the relayer's Stellar chain module (`packages/relayer/relayer/src/{quote,relay,config}/stellar/`,
`chain.service/stellar.chain.service.ts`). Same NestJS route layout as EVM (`/v1/quote/:chainType/:chainId/...`,
`/v1/relay/:chainType/:chainId/...`, `/v1/details/...`, with `chainType = stellar`); the SDK client is
`StellarRelayerInteractor` (see [core-sdk/relayer-interactor.md](../core-sdk/relayer-interactor.md)).

Signing is raw **ed25519** over a canonical byte string (Stellar has no EIP-712); the relayer's
`Keypair` signs and verifies. Every commitment ends with a contract StrKey and the network passphrase
— the domain-separation analogue of EIP-712's `verifyingContract` + `chainId`. All submissions are
built, simulated, signed and sent by the relayer's own account, which pays the resource fee.

## Configuration

Per supported asset (`stellar.config.schemas.ts`): `address`, optional `fee_bps`, optional
**`flat_fee_amount`**, and optional **`yield_router`**. Setting `yield_router` marks the asset as a
yield **share token**: that router is then the only processor a withdrawal of the asset may name (the
allowlist is per asset, so a router can never be pointed at another share), and a flat fee is quoted
**in shares**, converted from the configured amount (in the **underlying's** base units) with the share
token's `preview_withdraw` (rounded up). The on-chain `max_relay_fee` (pool `get_asset_config`) caps
every quote (`0` = uncapped).

The flat fee is per asset: `flatFeeAmount(asset)` (`StellarChainConfigWrapper` / `StellarConfigService`)
returns the asset's own `flat_fee_amount` (in its base units; for a yield share, the underlying's) or
falls back to the chain-level `flat_fee_amount` (default `100`). A single raw base-unit value only fits
assets worth about what XLM is (0.02 XLM / 0.02 USDC is sensible, 0.02 wBTC is not), and Stellar has
no price oracle to convert one value across assets, so each asset sets its own. Every quote route
(`quote`, `quoteTransfer`, `quoteBatch`) and the details endpoint (`fixedFeeAmount` per asset,
`stellar.details.service.ts`) use the per-asset value.

The fee is paid in the withdrawn asset (the underlying, for a yield share), so for a classic asset
(SAC-wrapped, e.g. testnet USDC / wETH / wBTC) the relayer's fee receiver account must hold a
trustline to it, or the payout fails. Testnet currently configures XLM, USDC, wETH, wBTC and their
yield shares ppXLM, ppUSDC, ppwETH, ppwBTC: XLM / ppXLM use the chain default (`200000` = 0.02),
USDC / ppUSDC `200000` (0.02 USDC), wETH / ppwETH `100` (0.00001 wETH), wBTC / ppwBTC `3`
(0.0000003 wBTC).

## Quote routes

| Route | Service | Fee |
|---|---|---|
| `POST quote/stellar/:id/send` | `quote(params, exact = false)` | `amount` is what leaves the pool; fee comes out of it (`amountReceived = amount − fee`; rejected if `amount < fee`). |
| `POST quote/stellar/:id/receive` | `quote(params, exact = true)` | `amount` is what the recipient gets; fee is added (`amountSent = amount + fee`). |
| `POST quote/stellar/:id/transfer` | `quoteTransfer` | The asset's flat fee (in shares for a yield share), capped at `max_relay_fee`. A relayed transfer's only public outflow is the fee (`amountOut == feeAmount`). |
| `POST quote/stellar/:id/batch` | `quoteBatch` | `computeBatchFees` (shared with the SDK) with `relayCost = 0` (no gas oracle on Soroban) and either the asset's `fee_bps` or its flat fee (in shares for a yield share), per item, capped at `max_relay_fee`. `extraGas` rejected. |

Single-withdrawal fee: `fee_bps` set → `amount × fee_bps / 10000`, else the asset's flat fee (in shares for a
yield share); capped at `max_relay_fee`. Commitments are signed **only** when `commit: true` (a
withdrawal commit also requires `recipient`).

## Commitment byte layouts

`routing` = `StellarPayoutRoutingCodec` bytes: `recipient StrKey (56 B ASCII) ‖ fee_recipient StrKey
(56 B ASCII) ‖ fee_amount (u128 LE, 16 B)` = 128 B, byte-identical to the relay contract's
`encode_routing` (the `processor_data` it binds into the proof context). A batch's `data` is the
concatenation of one 128-byte routing per item (`encodeArray` / `decodeArray`). Integers are
little-endian; StrKeys ASCII; the passphrase UTF-8.

| Commitment | Bytes signed |
|---|---|
| Withdrawal (send/receive) | `data (routing)` ‖ `asset` ‖ `expiration u64` ‖ `amountSent u128` ‖ `amountReceived u128` ‖ `relay contract id` ‖ `network passphrase` |
| Transfer | `"ppv2-stellar-transfer-v1"` ‖ `data (routing: fee receiver, fee receiver, fee)` ‖ `asset` ‖ `expiration u64` ‖ `feeAmount u128` ‖ `pool contract id` ‖ `network passphrase` |
| Batch | `"ppv2-stellar-batch-v1"` ‖ `data (routings[])` ‖ `asset` ‖ `expiration u64` ‖ `totalFee u128` ‖ `maxRelayFee u128` ‖ `relayCost u128` ‖ `feeBps u128` ‖ `flatFee u128` ‖ `relay contract id` ‖ `network passphrase` |

The distinct leading tags keep a transfer or batch signature from ever verifying as another kind.
Verification rejects an expired commitment first.

## Relay routes

**`POST relay/stellar/:id/withdrawal`** — checks: commitment signature valid and unexpired;
`amountOut > 0`; `amountOut == amountSent`; `amountOut >= feeAmount`. Routing = the committed `data`.
- Plain: `relay.relay(relayer, n, m, proof, roots, amount_out, token_id_out, nullifiers, commitments, asset, note_data, routing)`.
  The asset ↔ `tokenIdOut` binding is enforced on-chain by the relay contract.
- **Yield** (request carries `processorAddress`, optional `minUnderlyingOut`): `processorAddress` must
  equal the committed asset's configured `yield_router`, else rejected. Submits
  `router.withdraw_to_underlying(n, m, proof, roots, amount_out, token_id_out, nullifiers, commitments, note_data, routing, min_underlying_out)`
  (`minUnderlyingOut` defaults to `0` = no floor; a too-high floor fails simulation at no cost).

**`POST relay/stellar/:id/transfer`** — submits the **pool's own `transact`** with the relayer's account
as the gated processor (`processor_gated = true`, `processor_data` = the committed routing bytes), as on
EVM where the relayer calls `PoolVault.transact` itself; the relay contract is not involved. Checks:
transfer commitment valid; `feeAmount > 0` and `amountOut == feeAmount` **exactly** (anything more would
be a withdrawal paid out in the clear); `tokenIdOut` == the committed asset's field hash. The pool
rejects any other context. Gating is mandatory here: the pool rejects `processor_gated = false` with
`amount_out > 0` (`UngatedWithdrawal`), since an ungated context does not bind the processor that is paid.

**`POST relay/stellar/:id/batch`** — checks: batch commitment valid; routings count == items count; per
item `amountOut > 0`, `tokenIdOut` == the committed asset's field hash (the relay contract cannot see the
asset in a `tokenIdOut` alone), recipient / fee recipient identical across items, `feeAmount <=
maxRelayFee` (when non-zero) and `<= amountOut`; Σ item fees == `totalFee`. Submits
`relay.relay_batch(relayer, asset, items)` with each item as the contract's `BatchItem` struct.

**`POST relay/stellar/:id/register-and-withdrawal`** — the withdrawal is checked exactly as a plain one;
`registration.signature` is the owner's **signed Soroban auth entry** (hex XDR), validated before
anything is submitted: address credentials signed by `registration.account`; root invocation is a
contract call to **this relayer's keystore** `set_auth_policy(account, nullifyingKeyHash, authDigest)`
with exactly those args; `signatureExpirationLedger` > latest ledger. Submits
`relay.register_and_relay(relayer, owner, nullifying_key_hash, auth_digest, <withdrawal args>, routing)`
with the owner entry attached (`IStellarRPCInteractor.buildTransactionWithAuth`), simulated in
**enforcing** mode so a bad signature fails before the relayer pays.

Not supported on Stellar: `relay-and-announce` (no ERC-5564), `relay-swap` / swap quotes, standalone
relayed registration.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.2 | 2026-10-02 — Per-asset `flat_fee_amount` (falls back to the chain-level value; underlying units for a yield share), used by all quote routes and the details endpoint's `fixedFeeAmount`; fee receiver needs a trustline per classic asset; testnet asset set and fees (XLM, USDC, wETH, wBTC + pp shares). |
| 1.1 | 2026-10-01 — Transfer route: noted the pool rejects ungated `transact` with `amount_out > 0` (`UngatedWithdrawal`), so the gated processor is mandatory. |
| 1.0 | 2026-10-01 — Initial spec of the Stellar relayer: quote routes (send / receive / transfer / batch), relay routes (withdrawal incl. yield via `yield_router`, transfer as the pool's own `transact`, batch via `relay_batch`, register-and-withdrawal via `register_and_relay`), commitment byte layouts and domain tags (`ppv2-stellar-transfer-v1`, `ppv2-stellar-batch-v1`), per-route checks, and the `yield_router` asset config. |
