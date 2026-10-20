# RelayerInteractor (EVM)

### RelayerInteractor

`RelayerInteractor` (`packages/evm-sdk`) is the EVM implementation of the chain-agnostic `IRelayerInteractor<TAddress>` interface — see [core-sdk/relayer-interactor.md](../core-sdk/relayer-interactor.md) for the interface contract. `packages/stellar-sdk` has its own `StellarRelayerInteractor` implementation of the same interface.

RelayerInteractor handles communication with transaction relayers. Relayers submit transactions on behalf of users so that `msg.sender` is the relayer's address, not the user's—preserving the sender's privacy. This is used for transfers, withdrawals, combined register-and-withdrawals (relayed keystore registration), and label registration.

RelayerInteractor manages the relayer interaction lifecycle: discovering available relayers, requesting fee quotes, and submitting transactions. Confirmation happens outside this service — callers watch the returned transaction hash via `RPCInteractor.waitForTransactionReceipt`.

# Dependencies

| Dependency | Why |
| --- | --- |
| **IHTTPClient** | Injected interface for HTTP communication with relayer APIs. RelayerInteractor calls post() to submit transactions and get() to fetch relayer info. `IHTTPClient` also exposes `getBinary(url, options?): Promise<Uint8Array>` — used by `IpfsCircuitArtifacts` to fetch raw artifact bytes via `response.arrayBuffer()`, reusing the same retry / timeout / AbortController infra as `get` and `post`. The abstraction allows any HTTP client (fetch, axios, custom) to be used. |

# Types

### RelayerInfo

Information about an available relayer.

| Field | Type | Description |
| --- | --- | --- |
| `url` | `string` | The relayer's API endpoint URL. |
| `name` | `string` | Human-readable name of the relayer. |
| `chainId` | `number` | The chain ID the relayer operates on. |
| `chainType` | `string` | The chain type (e.g., "evm"). |
| `status` | `"active" \| "inactive"` | Whether the relayer is currently active or inactive. |
| `address` | `Address` | The relayer's signer — `msg.sender` of every relay. Discoverable as `relayerAddress` on `/v1/details`. |
| `processorAddress` | `Address` | The `transact` processor plain relayed withdrawals bind into their proof: PrivacyPoolRelay (`contracts.relay` on `/v1/details`). Relayed **transfers** do not use it — they bind the relayer signer (`address`), since the relayer calls `PoolVault.transact` directly (see [pool-session.md](../core-sdk/pool-session.md) §TransferParams). Swaps bind RelaySwaps (`relaySwapsAddress`) and yield-share notes bind their PPRouter (`yield[].router`) instead — see `RelayerChainDetails`. |

Prefer building it with `relayerInfoFromDetails(url/name, details)` from `getChainDetails()` rather than typing the two addresses: a wrong processor fails every relay of that note with `PoolVault_ProofContextMismatch` (vuln-mining #30).

### RelayerChainDetails

The relayer's own statement of the addresses it relays through on one chain, and of the per-chain native-wei ceilings it enforces — `GET {url}/v1/details/{chainType}/{chainId}`, fetched by `getChainDetails(relayer)` and validated with `RelayerChainDetailsSchema`.

| Field | Type | Description |
| --- | --- | --- |
| `id`, `name`, `type` | `number`, `string`, `string` | Chain identity; `id` must equal the `chainId` asked for (mismatch → `RelayerRequestFailed`). |
| `contracts.entrypoint` / `poolVault` | `Address` | Pool contracts. |
| `contracts.relay` | `Address` | PrivacyPoolRelay — processor for plain relayed withdrawals. (Relayed transfers bind `relayerAddress`, the relayer signer, not this contract.) |
| `contracts.relaySwaps` | `Address?` | RelaySwaps — processor for withdraw-and-swap / reshield; absent when `swapsSupported` is false. |
| `swapsSupported` | `boolean` | Whether the relayer relays swaps on this chain. |
| `destinationCallsSupported` | `boolean?` | Whether a cross-chain bridge can run a destination contract call **on this chain** — the pool / yield-router deposit that ends a cross-chain reshield (needs LI.FI's `ReceiverAcrossV3` / `ReceiverStargateV2` here). Relayer config `destination_calls_supported` (default `false`, fail-closed), `DESTINATION_CALLS_SUPPORTED_EVM_<id>` override. Destination-side only: source-side flows ignore it. Optional: absent on relayers predating it = allowed. |
| `assets[]` | `{ address, ticker, fixedFeeAmount?, feeBPS? }` | Assets the relayer quotes. |
| `relayerAddress` | `Address?` | The relayer's signer (`RelayerInfo.address`). Optional: absent on relayers predating discovery. |
| `processors[]` | `Address[]?` | Every alternate processor a relay may name (the PPRouters). Optional. |
| `yield[]` | `RelayerYieldWrapper[]?` | Per wrapper: `ppToken`, `underlying`, `router` (the processor to bind for that share), `zap`, `ppDecimals`, `underlyingDecimals`, `underlyingSymbol`. Derived on-chain by the relayer at boot. Optional. |
| `maxSwapValueWei` | `string?` | `max_swap_value_wei` as a decimal string, in **this (source) chain's** native wei: the B2 ceiling on a swap quote's client-supplied `swapValue` (the LayerZero fee RelaySwaps mints in-contract on a Mainnet-destination reshield). Reflects the `MAX_SWAP_VALUE_WEI_EVM_<id>` env override. Optional: absent on relayers predating cap publication. Parsed leniently (see below); a malformed value becomes `undefined`. |

Consumers: `PoolSessionBuilder.withRelayerDetails(details)` (derives `relaySwapsAddress` and one `YieldDeployment` per wrapper, and appends `details` to `EvmPoolSessionConfig.relayerChainDetails` — one entry per call — to seed the cross-chain reshield's relayer-caps cache), `relayerInfoFromDetails()`, `yieldDeploymentsFromDetails()`, `relaySwapsAddressFromDetails()`. `PoolSessionReshieldCrosschain` also reads the **destination** chain's `destinationCallsSupported` (from a seeded entry for that chain, else the same relayer's `getChainDetails` for the destination chain) and refuses an explicit `false` with `DestinationCallsUnsupported` — see [pool-session.md](../core-sdk/pool-session.md) §Cross-Chain Reshield.

The relayer serializes `maxSwapValueWei` as a decimal string (its global `BigInt.prototype.toJSON` → `toString`). `RelayerChainDetailsSchema` parses it leniently and normalizes it to a decimal string: a decimal string, a `0x` hex string, or a non-negative safe-integer JSON number is accepted; anything else (a number past `Number.MAX_SAFE_INTEGER` that may have lost precision, or garbage) becomes `undefined` rather than failing the whole response — the same response drives discovery (`relayerAddress`, `processors`, `yield`), which a bad cap must not break.

`relayerCapsFromDetails(details)` returns `RelayerCaps` — `{ maxSwapValueWei?: bigint }` — parsed from the normalized cap string. An `undefined` cap means the relayer did not publish it or published it malformed: **unknown, not unlimited**. Publication is informational only — the relayer still enforces the cap at quote and relay time (HTTP 400). (The relayer has no native-gas cap: `/v1/details` does not publish `maxNativeGasWei`, and the `extraGas` top-up is the fixed relayer-computed amount bounded by `maxRelayFee` — see `getSwapQuote`.) `PoolSessionReshieldCrosschain` reads `maxSwapValueWei` to refuse an oversized B2 `swapValue` before proving (`SwapValueExceedsRelayerCap`; see [withdraw-and-swap.md](../core-sdk/withdraw-and-swap.md) §SDK Pre-Flight Validation). It caches the caps per relayer (`chainId` + `relayerAddress`, lowercased) for 5 minutes (`RELAYER_CAPS_TTL_MS`), refetching via `getChainDetails` after expiry and not caching failed fetches; the optional `relayerChainDetails` session config (filled by `withRelayerDetails`) seeds that cache, so a session built with it makes no extra `/v1/details` call for that relayer within the TTL.

### ProofResult

The output of a successful proof generation, as defined in the ProofService types. Used in relay submissions.

| Field | Type | Description |
| --- | --- | --- |
| `proof` | `Proof` | The Groth16 proof object containing pi_a, pi_b, pi_c curve points. |
| `publicSignals` | `Hex[]` | The public circuit signals as hex strings, in the order declared by the circuit. |

### FeeCommitment

Base fee commitment returned in transfer quotes and used in relay params.

| Field | Type | Description |
| --- | --- | --- |
| `data` | `Hex` | Commitment data. |
| `asset` | `Address` | The asset address. |
| `expiration` | `number` | Unix timestamp after which this commitment expires. |
| `feeAmount` | `string` | The fee amount. |
| `signedRelayerCommitment` | `Hex` | The relayer's signed commitment. |

### WithdrawalFeeCommitment

Extends `FeeCommitment` with withdrawal-specific fields.

| Field | Type | Description |
| --- | --- | --- |
| *(all FeeCommitment fields)* | | |
| `recipient` | `Address` | The recipient address. |
| `amountSent` | `string` | The amount sent. |
| `amountReceived` | `string` | The amount received by the recipient. |

### SwapFeeCommitment

Extends `FeeCommitment` with swap-specific fields.

| Field | Type | Description |
| --- | --- | --- |
| *(all FeeCommitment fields)* | | |
| `recipient` | `Address` | The recipient address for the swap output. The zero address means "no source-chain recipient" (reshield or cross-chain swap — output is re-deposited or delivered on the destination chain by LiFi). |
| `amountSent` | `string` | The total amount withdrawn from the pool (amount + fee). |

# Methods

---

**`getRelayers() → Promise<RelayerInfo[]>`**

Returns the list of relayers provided at construction time.

**Returns: `RelayerInfo[]`**

Array of available relayers. Each contains: `url` (relayer API endpoint), `name` (human-readable name), `chainId` (chain ID), `chainType` (chain type), `status` (active/inactive).

---

**`getTransferQuote(relayer, params) → Promise<TransferRelayerQuote>`**

Requests a fee quote from a relayer for a transfer operation.

**Endpoint:** `POST /v1/quote/{chainType}/{chainId}/transfer`

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to request a quote from. |
| `params` | `TransferQuoteParams` | Transfer parameters: `asset` (Address), `commit` (boolean). |

**Returns: `TransferRelayerQuote`**

| Field | Type | Description |
| --- | --- | --- |
| `txCost` | `string` | The transaction cost. |
| `gasPrice` | `string` | The gas price. |
| `feeAmount` | `string` | The fee amount. |
| `feeCommitment` | `FeeCommitment` | The relayer's fee commitment. |

The relayer response also carries `processor` (`Address`) — the `TransactParams.processor` the relayer will submit with; for a transfer, the relayer signer address (it calls `PoolVault.transact` directly). The SDK's `TransferRelayerQuoteSchema` does not type it (the non-strict schema strips it); `relayTransfer` binds `relayerInfo.address`, which must equal it.

---

**`getWithdrawalQuote(relayer, params) → Promise<WithdrawalRelayerQuote>`**

Requests a fee quote from a relayer for a withdrawal operation.

**Endpoint:** `POST /v1/quote/{chainType}/{chainId}/send`

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to request a quote from. |
| `params` | `WithdrawalQuoteParams` | Withdrawal parameters: `asset` (Address), `commit` (boolean), `recipient` (Address), `extraGas` (boolean), `amount` (string). |

**Returns: `WithdrawalRelayerQuote`**

| Field | Type | Description |
| --- | --- | --- |
| `txCost` | `string` | The transaction cost. |
| `gasPrice` | `string` | The gas price. |
| `feeAmount` | `string` | The fee amount. |
| `amountSent` | `string` | The amount sent. |
| `amountReceived` | `string` | The amount received by the recipient. |
| `feeCommitment` | `WithdrawalFeeCommitment` | The relayer's withdrawal fee commitment. |

The relayer response also carries `processor` (`Address`) — the **default** `TransactParams.processor` for a withdrawal: the relay contract (PrivacyPoolRelay, `contracts.relay`). The quote request takes no processor, so this value never reflects an alternate processor. The SDK's `WithdrawalRelayerQuoteSchema` does not type it (the non-strict schema strips it); the session binds `relayerInfo.processorAddress`, which must equal it. A yield withdrawal instead binds the PPRouter passed as `processorAddress` on the relay request (`yield[].router`, allowlisted in `processors[]`), not the quote's `processor`. Swap and batch quotes have no `processor` field.

---

**`relayTransfer(relayer, params) → Promise<Hex>`**

Submits a transfer transaction to the relayer for on-chain execution.

**Endpoint:** `POST /v1/relay/{chainType}/{chainId}/transfer`

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to submit the transaction to. |
| `params` | `TransferRelayParams` | `proof` (ProofResult), `noteData` (NoteData[]), `signedFeeCommitment` (FeeCommitment), `inputNullifierNumber` (number), `outputCommitmentNumber` (number). |

**Returns:** `Hex` — The transaction hash.

---

**`relayWithdrawal(relayer, params) → Promise<Hex>`**

Submits a withdrawal transaction to the relayer for on-chain execution.

**Endpoint:** `POST /v1/relay/{chainType}/{chainId}/withdrawal`

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to submit the transaction to. |
| `params` | `WithdrawalRelayParams` | `proof` (ProofResult), `noteData` (NoteData[]), `signedFeeCommitment` (WithdrawalFeeCommitment), `inputNullifierNumber` (number), `outputCommitmentNumber` (number). Optional (relayed yield withdrawal, F-1): `processorAddress` (Address — the PPRouter; relayer routes to `PPRouter.withdrawToUnderlying`) and `minUnderlyingOut` (Hex — slippage floor on the redeem leg). Both forwarded to the relayer; omit for a plain withdrawal. |

**Returns:** `Hex` — The transaction hash.

**Relayer-side proof-context pre-check (`withdrawal` and `transfer` only).** Before simulating, the relayer recomputes the proof context off-chain — `keccak256(abi.encode(TransactParams{processor, data}, noteData)) % SNARK_SCALAR_FIELD`, with `processor` = the request's `processorAddress` (an allowlisted PPRouter) if given, else the default for the op (PrivacyPoolRelay for `withdrawal`, the relayer signer for `transfer`), and `data` = the signed fee commitment's `data` — and compares it with the proof's context public signal. A mismatch is rejected with HTTP 400 `Proof context mismatch ...` (instead of an on-chain `PoolVault_ProofContextMismatch` revert); any `noteData[i].hint` that is not exactly 32 bytes is also rejected with 400. The `noteData` count is intentionally not checked against the output count. `register-and-relay`, `relay-and-announce`, swap and batch relays do not run this pre-check.

---

**`submitRelayedRegistration(relayer, params) → Promise<Hex>`**

Submits a standalone relayed keystore registration — a fresh, unfunded account authorizes its auth policy off-chain (EIP-712 `SetAuthPolicy`, see [keystore-manager.md](../core-sdk/keystore-manager.md)) and the relayer submits `Keystore.setAuthPolicyWithSig`. Registration-only, no withdrawal.

**Endpoint:** `POST /v1/relay/{chainType}/{chainId}/register`

> **Not yet wired server-side.** The client method and its params exist, but the relayer `/register` endpoint is deferred pending a fee-economics question (a registration alone moves no value, so the fee model is open). See `agents/deviations.md` (INTL-05). Use `relayRegisterAndWithdrawal` for the atomic path, which is wired.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to submit to. |
| `params` | `RegisterKeystoreRelayParams` | The relayed registration fields (see `RelayedRegistrationFields`). |

**Returns:** `Hex` — The transaction hash.

---

**`relayRegisterAndWithdrawal(relayer, params) → Promise<Hex>`**

Submits an **atomic** bundle that both registers the recipient's keystore auth policy and withdraws a received note in a single relayer-submitted transaction — the fresh-unfunded-recipient flow. The withdrawal proof was built against the predicted post-registration keystore root (see `PoolSession.prepareRegisterAndWithdrawRelay` in [pool-session.md](../core-sdk/pool-session.md) and [merkle-service.md](../core-sdk/merkle-service.md)), so the registration and withdrawal legs must land together. The withdrawal fee quote is the same `WithdrawalFeeCommitment` used by `relayWithdrawal` — reused unchanged for the relay leg.

**Endpoint:** `POST /v1/relay/{chainType}/{chainId}/register-and-relay`

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to submit to. |
| `params` | `RegisterAndWithdrawalRelayParams` | `WithdrawalRelayParams` plus a nested `registration` (see below). |

**Returns:** `Hex` — The transaction hash.

**Relayed-registration types:**

- `RelayedRegistrationFields` — the signed EIP-712 registration carried to the relayer: `{ account: Address, authDigest: Hash, nullifyingKeyHash: Hash, deadline: Hex, signature: Hex }` (the `signature` over the `SetAuthPolicy` typed data). The relayer replays these into `Keystore.setAuthPolicyWithSig`.
- `RegisterKeystoreRelayParams` — params for `submitRelayedRegistration`: the `RelayedRegistrationFields` for a registration-only submission.
- `RegisterAndWithdrawalRelayParams` — `WithdrawalRelayParams` (all `relayWithdrawal` fields — `proof`, `noteData`, `signedFeeCommitment`, `inputNullifierNumber`, `outputCommitmentNumber`) **plus** a nested `registration: RelayedRegistrationFields`. The withdrawal fee quote is reused for the relay leg; the registration adds no separate fee.

---

**`relayWithAnnounce(relayer, params) → Promise<Hex>`**

Submits an **atomic** stealth withdrawal: the relayer relays a withdrawal paying an ERC-5564 stealth address and, in the **same transaction**, publishes the ERC-5564 announcement so the recipient can discover the payment by scanning (`PrivacyPoolRelay.relayAndAnnounce`, see [contracts-tech-design.md](../contracts/contracts-tech-design.md) §5). Because the two legs land together, the announce↔withdraw binding (STLTH-18) is enforced on-chain rather than advisory — the contract reverts unless the announced stealth address equals the withdrawal recipient. Standard-relay only (no yield / `processorAddress` path). The announcement carries no value, so the same `WithdrawalFeeCommitment` quote used by `relayWithdrawal` is reused unchanged for the relay leg.

**Endpoint:** `POST /v1/relay/{chainType}/{chainId}/relay-and-announce`

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to submit to. |
| `params` | `RelayAndAnnounceRelayParams` | `WithdrawalRelayParams` plus a nested `announcement` (see below). |

**Returns:** `Hex` — The transaction hash.

**Relay-and-announce types:**

- `StealthAnnouncementFields` — the ERC-5564 announcement carried to the relayer: `{ schemeId: Hex, stealthAddress: Address, ephemeralPubKey: Hex, metadata: Hex }`. `schemeId` is the ERC-5564 scheme id (e.g. `0x0001` canonical); `stealthAddress` must equal the withdrawal recipient; `metadata` (view-tag + scheme bytes) is forwarded verbatim to the on-chain Announcer.
- `RelayAndAnnounceRelayParams` — `WithdrawalRelayParams` (all `relayWithdrawal` fields) **plus** a nested `announcement: StealthAnnouncementFields`. The withdrawal fee quote is reused for the relay leg; the announcement adds no separate fee. The stealth sub-package stays isolated (INTL-01) — the announcement is plain data on the wire.

---

**`getSwapQuote(relayer, params) → Promise<SwapRelayerQuote | UncommittedQuote>`**

Requests a fee quote from a relayer for a withdraw-and-swap operation. The return
shape depends on `params.commit` (overloaded — the literal `commit` value selects
the return type):

- `commit: false` — a **non-committed** quote: a fee estimate only (`txCost`,
  `gasPrice`, `feeAmount`). The relayer returns **no** `feeCommitment` because
  there is nothing to sign yet (no `swapCalldata`/`swapTarget`). Resolves to
  `UncommittedQuote`. Callers use it to bound the fee and size the swap input — but the
  LiFi input is **not** the exact `amount − feeAmount`: the withdraw path over-estimates
  the fee (`amount − (feeAmount + WITHDRAW_SWAP_FEE_BUFFER_BPS·amount)`) so the fixed LiFi
  input still fits after per-call fee drift, and the reshield path is output-driven (it
  fetches the LiFi quote first). See [`withdraw-and-swap.md`](../core-sdk/withdraw-and-swap.md).
- `commit: true` — a **committed** quote carrying the relayer's signed
  `feeCommitment` over the proof-bound routing. Resolves to `SwapRelayerQuote`.

The response is validated against the matching schema (`UncommittedQuoteSchema` vs
`SwapRelayerQuoteSchema`), so a non-committed estimate is not rejected for the
absent `feeCommitment`.

**The two fees may differ.** The relayer prices `feeAmount` per call from
near-live inputs — the gas price is cached in-memory for up to 15s and the
Entrypoint asset config (`maxRelayFee` etc.) for up to 60s (`ASSET_CONFIG_TTL_MS`) —
so the `commit: false` (preliminary) and `commit: true` (committed) fees for identical
params can differ by a small gas-price tick (two quotes inside one cache window may
also coincidentally match, but nothing guarantees it). The SDK's swap paths absorb this drift
rather than requiring the fees to match: `prepareSwapQuote` sizes the swap input against
an over-estimated fee and `prepareReshieldQuote` uses an output-driven quote, both
validated by `assertLifiBudget` (budget + dust bounds) — see
[`withdraw-and-swap.md`](../core-sdk/withdraw-and-swap.md). Callers must not assume the committed
fee equals the preliminary one.

The quoted `gasPrice` is also not a ceiling on what the relayer actually pays: when the
relayer runs with a broadcast tip floor (`MIN_PRIORITY_FEE_WEI`, see
[relayer/stuck-nonce-reconciliation.md](../relayer/stuck-nonce-reconciliation.md)), its
broadcast tip is `max(eth_maxPriorityFeePerGas, floor)` while quote pricing is unchanged,
so the on-chain cost can slightly exceed the quoted gas price. This is the relayer's margin
to absorb; the signed fee is unaffected.

**Endpoint:** `POST /v1/quote/{chainType}/{chainId}/swap`

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to request a quote from. |
| `params` | `SwapQuoteParams` | Swap parameters: `asset` (Address), `commit` (boolean), `recipient` (Address — the zero address signals "no source-chain recipient": reshield or cross-chain swap), `amount` (string), `outputToken` (Address), `minOutputAmount` (string — must be `0` when `recipient` is the zero address; the relayer rejects the quote otherwise), `extraGas` (boolean, optional, defaults to `false` — opt-in ETH gas top-up for the recipient, mirroring the withdrawal path's `extraGas` flag; must be `false`/omitted when `recipient` is the zero address. The client cannot choose the amount: when the flag is set, the relayer computes the top-up as `extraGasFundAmount` (600 000 gas) × current gas price (fixed, unclamped), converts it to token units via the oracle, and folds it into `feeAmount` so the user pre-pays it — bounded by the `amount < feeAmount` guard and the asset's on-chain `maxRelayFee` (a gas spike fails the quote rather than being clamped); the resolved amount is committed as the signed routing's `nativeGas` uint256), `fallbackAddress` (Address, optional — defaults to `recipient`; used as LiFi's `toFallbackAddress`, the destination-chain address receiving the bridged token if the destination swap fails), `dustRecipient` (Address — source-chain address receiving swept dust; must be non-zero), `swapTarget` (Hex, optional — the DEX/LiFi target; required when `commit` is `true`), `approvalAddress` (Hex, optional — token approval target, defaults to `swapTarget`), `swapCalldata` (Hex, optional — the full LiFi swap calldata, embedded in the `SwapRouting` struct for proof binding; required when `commit` is `true`), `dustRescue` (`RelaySwapDustRescue`, optional — opt-in cross-chain dust rescue; only valid when `recipient` is the zero address, rejected otherwise (RC-10). Encoded into `SwapRouting.dustRescue` on a committed quote, inheriting the struct's proof-context binding — see [pool-session.md](pool-session.md) §Stealth Dust Rescue). The relayer validates the zero-recipient invariant at quote time (schema validation: `extraGas` must be unset when `recipient` is the zero address; `dustRescue`, conversely, may only be set when `recipient` *is* the zero address) and again at relay time on the decoded routing. |

**Returns: `SwapRelayerQuote` (committed) or `UncommittedQuote` (non-committed)**

| Field | Type | Present when | Description |
| --- | --- | --- | --- |
| `txCost` | `string` | always | The transaction cost. |
| `gasPrice` | `string` | always | The gas price. |
| `feeAmount` | `string` | always | The fee amount. |
| `feeCommitment` | `SwapFeeCommitment` | `commit: true` only | The relayer's signed swap fee commitment. |

`UncommittedQuote` is the neutral estimate base (`txCost`, `gasPrice`, `feeAmount`);
`SwapRelayerQuote = UncommittedQuote & { feeCommitment }`.

---

**`relaySwap(relayer, params) → Promise<Hex>`**

Submits a withdraw-and-swap or reshield transaction to the relayer via the `RelaySwaps` processor. Both withdraw-and-swap and reshield use the same endpoint and contract entry point (`RelaySwaps.execute()`). The full swap calldata is embedded as the `bytes swapCalldata` field of the `SwapRouting` struct, which is ABI-encoded into `transactParams.data` and bound into the ZK proof context — so any change to a calldata byte invalidates the proof, preventing relayer tampering. There is no separate on-chain hash check. For reshield, the deposit is embedded in the LiFi swap calldata via `getContractCallsQuote()`.

**Endpoint:** `POST /relay-swap`

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to submit the transaction to. |
| `params` | `SwapRelayParams` | `proof` (ProofResult), `noteData` (NoteData[]), `signedSwapCommitment` (SwapFeeCommitment — its `data` already embeds the swap calldata), `inputNullifierNumber` (number), `outputCommitmentNumber` (number). |

**Returns:** `Hex` — The transaction hash.

---

**`relayRegisterAndWithdrawal(relayer, params) → Promise<Hex>`**

Submits a combined keystore-registration + withdrawal. The relayer registers a fresh, unfunded recipient's auth policy (authorized by an off-chain EIP-712 `SetAuthPolicy` signature) and withdraws their note atomically on-chain, so the recipient never funds their own address to pay registration gas. The withdrawal proof anchors to the *predicted* post-registration keystore root (see [`WitnessPreparationService`](../core-sdk/witness-preparation-service.md) / the `appendPredictedKeystoreLeaf` witness input); registration and transact land in the same transaction.

**Endpoint:** `POST /v1/relay/{chainType}/{chainId}/register-and-withdrawal`

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer to submit the transaction to. |
| `params` | `RegisterAndWithdrawalRelayParams` | `WithdrawalRelayParams` plus `registration`: `{ account (Address), authDigest (Hex), nullifyingKeyHash (Hex), signature (Hex) }`. `authDigest`/`nullifyingKeyHash` are hex-encoded uint256 (the relayer coerces them via `BigInt`). |

**Returns:** `Hex` — The transaction hash.

The `SetAuthPolicy` payload is built by [`PoolSessionKeystore.buildSetAuthPolicyTypedData`](../core-sdk/keystore-manager.md) and signed by the integrator's wallet — the SDK never signs it. See [`PoolSessionWithdraw.registerAndWithdraw`](../core-sdk/pool-session.md) for the orchestration that assembles these params.

---

Confirmation is not part of RelayerInteractor: the relayer's HTTP response (`202 Accepted`) confirms only that the transaction was broadcast, not that it will confirm on-chain — callers watch the returned transaction hash via `RPCInteractor.waitForTransactionReceipt`. The relayer does not guarantee the returned hash is the hash that mines: if its own bookkeeping finds that hash's nonce stuck (evicted from the mempool, or simply unconfirmed past a timeout), it cancels that nonce with a 0-value self-transfer and moves on — the original hash then never mines, and callers should treat that as a real failure requiring resubmission, not just slowness to wait out. This check runs both reactively (the next write on the same chain) and on a fixed interval independent of write traffic, plus an externally-triggered backstop — see [relayer/stuck-nonce-reconciliation.md](../relayer/stuck-nonce-reconciliation.md) — so a stuck nonce no longer needs a live write request to ever be noticed.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.16.0 | 2026-10-14 — `RelayerChainDetails` gains optional `destinationCallsSupported` (relayer `destination_calls_supported`, fail-closed default; whether a bridge can run a destination call on that chain). Absent = allowed (older relayers). Consumed by `PoolSessionReshieldCrosschain`'s destination capability gate (`DestinationCallsUnsupported`). |
| 1.15.0 | 2026-10-08 — Relayer `max_native_gas_wei` removed: `RelayerChainDetails.maxNativeGasWei` and `RelayerCaps.maxNativeGasWei` dropped (`relayerCapsFromDetails` returns `{ maxSwapValueWei? }` only; `/v1/details` no longer publishes it); `SwapQuoteParams.extraGas` top-up is exactly `extraGasFundAmount` × gas price, unclamped, bounded by `maxRelayFee`, with no relay-time re-cap. |
| 1.14.2 | 2026-10-08 — `maxNativeGasWei` / `maxSwapValueWei` parsed leniently: decimal string, `0x` hex string or non-negative safe-integer number accepted and normalized to a decimal string; anything else becomes `undefined` (cap unknown; relayer still enforces) instead of rejecting the whole `/v1/details` response, so discovery survives a malformed cap. |
| 1.14.1 | 2026-10-08 — `withRelayerDetails` also appends the details to `EvmPoolSessionConfig.relayerChainDetails` (new optional field, one entry per call), seeding `PoolSessionReshieldCrosschain`'s per-relayer caps cache (`chainId` + `relayerAddress`, 5-minute TTL; failed fetches not cached), so the B2 cap check no longer reads `/v1/details` on every sizing. |
| 1.14.0 | 2026-10-08 — `RelayerChainDetails` gains optional `maxNativeGasWei` / `maxSwapValueWei` (decimal strings; the relayer's per-chain `max_native_gas_wei` / `max_swap_value_wei`, now always published on `/v1/details`); new `relayerCapsFromDetails()` → `RelayerCaps` (bigints; undefined = unknown, not unlimited). Older relayers still parse. Relayer enforcement unchanged. |
| 1.13.0 | 2026-10-02 — `RelaySwapDustRescue` gains a required `destinationChainType: string` field alongside `destinationChainId` — a bare numeric chain ID became ambiguous once more than one chain type exists (an EVM chain and a chain of another type can share a numeric ID). See `docs/tech-design/core-sdk/withdraw-and-swap.md` §Cross-Chain Reshield. SDK-only; no wire/contract change beyond the new request field (the on-chain `SwapRouting.dustRescue` struct is unaffected). |
| 1.12.0 | 2026-09-30 — Doc-only: noted that the relayer's broadcast tip floor (`MIN_PRIORITY_FEE_WEI`) can make its actual gas cost exceed the quoted `gasPrice`; quote pricing and the signed fee are unchanged. |
| 1.11.0 | 2026-09-30 — Stuck-nonce detection is no longer purely reactive: a watermark-clearing bug that let an evicted transaction's gap go undetected forever was fixed, and detection now also runs on a periodic in-process timer plus an externally-triggered (Cloud Scheduler) backstop, independent of write traffic — see [relayer/stuck-nonce-reconciliation.md](../relayer/stuck-nonce-reconciliation.md). Doc-only elsewhere; the response contract (202, cancel-and-move-on semantics) is unchanged. |
| 1.10.0 | 2026-09-28 — Relayer: transfer and withdrawal quote responses now return `processor` (transfer → relayer signer; withdrawal → PrivacyPoolRelay, the default only — alternate PPRouter processors are not reflected); documented as a relayer field the SDK schemas currently strip. `relayWithdrawal`/`relayTransfer`: documented the relayer's off-chain proof-context pre-check (400 `Proof context mismatch`, 400 on non-32-byte `noteData[i].hint`). Fixed `RelayerInfo.processorAddress` and `contracts.relay` rows, which wrongly said PrivacyPoolRelay is also the transfer processor — transfers bind the relayer signer. |
| 1.9.0 | 2026-09-25 — Response-contract fix (fatlabsxyz/pp-relayer-v2#238): every `/v1/relay/*` and `/relay-swap` endpoint now returns `202 Accepted` (previously an implicit, undocumented `201`) — the status code never claimed on-chain confirmation, only broadcast acceptance, and 202 says so accurately. Also corrected the "never replaces it" claim below: the relayer now detects a stuck nonce (evicted from the mempool, or simply unconfirmed past a timeout) the next time a write touches the same chain, and cancels it with a 0-value self-transfer rather than leaving every subsequent write permanently wedged behind it — so a previously-returned hash is no longer guaranteed to eventually mine. |
| 1.8.0 | 2026-09-17 — Discovery (vuln-mining #30): new `getChainDetails(relayer)` → `RelayerChainDetails` (`GET /v1/details/{chainType}/{chainId}`, zod-validated, chain-id echo checked), plus `relayerInfoFromDetails`, `yieldDeploymentsFromDetails`, `relaySwapsAddressFromDetails` and `PoolSessionBuilder.withRelayerDetails()` / `withYieldDeployments()`. Closes the three-processors-one-field gap: `RelayerInfo.processorAddress` is PrivacyPoolRelay, swaps use `contracts.relaySwaps`, yield-share notes use `yield[].router` — all taken from the relayer, none hand-copied. `RelayerInfo.address` / `processorAddress` rows documented. Older relayers (no `relayerAddress`/`processors`/`yield`) still parse. |
| 1.7.0 | 2026-09-16 — Security fix (RC-10 / vuln-mining #10): `SwapQuoteParams` gains optional `dustRescue` (`RelaySwapDustRescue`), only valid when `recipient` is the zero address — encoded into `SwapRouting.dustRescue` on a committed quote, so it inherits the struct's proof-context binding. Previously `dustRescue` only existed on `relaySwap`'s request body (`SwapRelayParams`), unsigned and unbound to any quote; that field is now removed — the relayer reads `dustRescue` off the already-committed, already-executed routing instead. |
| 1.6.1 | 2026-09-16 — Doc split following the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` package split: this file now documents only the EVM `RelayerInteractor`. The chain-agnostic `IRelayerInteractor<TAddress>` interface moved to [core-sdk/relayer-interactor.md](../core-sdk/relayer-interactor.md). No code change. |
| 1.6.0 | 2026-08-22 — Doc-only. Qualified the `getSwapQuote` "two fees may differ" note: the relayer now prices `feeAmount` from a gas price cached up to 15s and asset config cached up to 60s (`ASSET_CONFIG_TTL_MS`) rather than a strictly per-call live read. The guarantee direction is unchanged — callers must not assume the committed fee equals the preliminary one. Part of the relayer RPC-latency hardening (bounded transports, quote deadline). |
| 1.5.0 | 2026-07-28 — Swap quote gas top-up is now a boolean opt-in: `SwapQuoteParams.nativeGas` (client-supplied string amount) replaced by `extraGas` (boolean, optional, default `false`), aligning with the withdrawal path. The relayer computes, caps (`max_native_gas_wei`), oracle-converts, and folds the top-up into `feeAmount`; the resolved amount lands in the signed routing's `nativeGas`. Zero-recipient invariant: `extraGas` must be unset when `recipient` is the zero address. |
| 1.4.0 | 2026-07-11 — Documented that the `commit: false` and `commit: true` `feeAmount`s may differ (the relayer prices each call from live gas) and that the SDK's swap paths absorb the delta via `assertLifiBudget` rather than requiring fee equality. Doc-only. |
| 1.3.0 | 2026-07-10 — `getSwapQuote` now models the two quote shapes explicitly: a non-committed request (`commit: false`) returns an `UncommittedQuote` (fee estimate only — `txCost`/`gasPrice`/`feeAmount`, no `feeCommitment`), and a committed request (`commit: true`) returns a `SwapRelayerQuote` with the signed `feeCommitment`. The method is overloaded on the literal `commit` value; the response is parsed against `UncommittedQuoteSchema` vs `SwapRelayerQuoteSchema` accordingly, so a non-committed estimate is no longer rejected for the absent commitment. Introduced the neutral `UncommittedQuote` base type (`SwapRelayerQuote = UncommittedQuote & { feeCommitment }`; `TransferRelayerQuote` composes from it too). |
| 1.2.0 | 2026-07-09 — Documented the atomic stealth-withdrawal surface (M-1): `relayWithAnnounce(relayer, params)` → `POST .../relay-and-announce` (relays a withdrawal to a stealth address and publishes the ERC-5564 announcement in the same transaction; standard-relay only, no yield path). Added the `StealthAnnouncementFields` and `RelayAndAnnounceRelayParams` (= `WithdrawalRelayParams` + nested `announcement`) types; the withdrawal fee quote is reused and the announcement carries no value. Doc-only. |
| 1.1.0 | 2026-07-08 — Documented the relayed keystore-registration surface (INTL-05): `submitRelayedRegistration(relayer, params)` → `POST .../register` (standalone; client-side only, relayer endpoint deferred on a fee-economics question) and `relayRegisterAndWithdrawal(relayer, params)` → `POST .../register-and-relay` (atomic register + withdraw for a fresh, unfunded recipient). Added the `RelayedRegistrationFields`, `RegisterKeystoreRelayParams`, and `RegisterAndWithdrawalRelayParams` (= `WithdrawalRelayParams` + nested `registration`) types; the withdrawal fee quote is reused for the relay leg. Doc-only. |
| 1.0.0 | Initial spec. |
