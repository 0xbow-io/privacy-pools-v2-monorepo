# PoolSession

PoolSession is the sole public-facing entry point of the SDK. It implements the facade pattern: every user-facing operation—keystore registration, deposit, swap-and-deposit, transfer, withdraw, withdraw-and-swap, ragequit, note discovery, and account export/import—is a method on PoolSession. No other service is exposed to integrators.

For write-path operations, the API is split into two halves:

- `prepareX(params)` builds the witness, generates the ZK proof, encrypts any required payloads, and returns ready-to-submit calldata along with a `NoteReceipt` and any bookkeeping metadata. The caller remains in control of submission.
- `relayX(params)` (for transfer, withdraw, and withdraw-and-swap) forwards a prepared transaction to a third-party relayer, rebuilding the witness with the relayer-selected fee quote before generating the final proof. Ragequit and deposit do not have a `relay*` counterpart: ragequit is submitted directly by `ownerAddress` (it already reveals the owner), and deposit is submitted directly by the depositor.

PoolSession owns zero domain logic. It does not hash, encrypt, prove, or query chains. Instead, it orchestrates: for each operation, it gathers the necessary inputs from stateful services (keys from KeystoreManager, notes from NoteManager), delegates computation to stateless services (WitnessPreparationService, ProofService, CryptoService, NoteComputationService), interacts with external systems (ContractInteractor, RelayerInteractor, ASPClient), and updates state with the results.

This means PoolSession is the only place where the full flow of an operation is visible. Reading `prepareDeposit()` reveals the complete sequence: key retrieval → secret generation → witness construction → proof generation → ASP ciphertext encryption → calldata encoding → note tracking. No step is hidden in a sub-service's side effect.

Account portability (`exportAccount` / `importAccount`) is exposed directly on PoolSession. Lifecycle concerns that are out of current scope — background synchronization, event subscriptions, and explicit `destroy()` — are intentionally not part of the interface; integrators drive discovery explicitly via `discoverNotes()`. See the Scope section in the [SDK tech design](core-sdk-tech-design.md) for the milestones that cover persistent storage and background sync.

> **Package scope.** `PoolSession` and every session delegate documented on this page (`PoolSessionDeposit`, `PoolSessionTransfer`, `PoolSessionWithdraw`, `PoolSessionRagequit`, `PoolSessionKeystore`, `PoolSessionNoteDiscovery`, `PoolSessionBatchWithdraw`, and — as of the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` split — the swap-related sessions `PoolSessionWithdrawAndSwap`, `PoolSessionReshield`, `PoolSessionReshieldCrosschain`, `PoolSessionSwapDeposit`) live in `packages/core-sdk` and are chain-agnostic. The swap sessions are wired to the generic `ISwapChainAdapter<TTx, TAddress>` interface, whose only implementation today is `EvmSwapChainAdapter` in `packages/evm-sdk` — see [withdraw-and-swap.md](withdraw-and-swap.md). The concrete per-chain wiring that constructs a fully-configured `PoolSession` is **not** chain-agnostic: `EvmPoolSession` / `PoolSessionBuilder` live in `packages/evm-sdk`, `StellarPoolSession` / `StellarPoolSessionBuilder` in `packages/stellar-sdk`. Chain extensions attach through `PoolSessionConfig.buildChainExtensions(ctx)`; the `ChainSessionBuildContext` carries the base `deposit` session, `transactCore`, the logger and — since 2026-10-01 — `buildDeposit({ entrypointInteractor })`, which builds another deposit session identical to `deposit` except for its entrypoint (used by Stellar yield, whose share-token deposit cannot be simulated before the router mints the shares). The yield sessions `PoolSessionYieldDeposit` / `PoolSessionYieldWithdraw` / `PoolSessionYieldEarned` are chain-agnostic core-sdk classes (since 2026-10-01) exposed through those extensions (`session.yield` / `yields` / `yieldFor` on both chains) — see [yield-sessions.md](../evm-sdk/yield-sessions.md) (EVM) and [stellar-sdk/yield-sessions.md](../stellar-sdk/yield-sessions.md) (Stellar).

# **Dependencies**

| Dependency | Why |
| --- | --- |
| **NoteManager** | Read and write note state. Every operation either queries notes (transfer needs input notes) or mutates them (deposit adds a note, transfer marks inputs as SPENT and adds outputs). |
| **KeystoreManager** | Read private keys for witness construction (nullifying key, revocable key) and viewing keys for encryption. Check registration status before operations that require it. |
| **CryptoService** | Encrypt label registration payloads for the ASP, and re-derive the `privateRevocableKey` during `rotateRevocableKey`. Note payload encryption (ECDH + encrypt) for recipients is handled by `NoteComputationService.generateNoteData()`. |
| **MerkleService** | Generate the keystore inclusion proof (`siblingNodes`) used by `rotateRevocableKey` to feed the keystore contract's `updateAuthPolicy`. |
| **WitnessPreparationService** | Build the complete witness (private inputs) for each circuit type. PoolSession passes raw values in, gets a structured witness out. |
| **ProofService** | Generate ZK proofs from witnesses. PoolSession never touches circuit artifacts directly. |
| **ContractInteractor** | Submit on-chain transactions (deposit, ragequit, `setAuthPolicy`, `setViewingKey`, `updateAuthPolicy`) and read on-chain state (tree leaves, state roots). |
| **RelayerInteractor** | Submit privacy-sensitive transactions (transfer, withdraw) through relayers so `msg.sender` is not the user's address. Label registration is a plain event emission (`ASPRegistry.registerLabel`) optionally inlined with deposit. |
| **ASPClient** | Fetch association set data (roots, leaves, merkle proofs) for compliance verification. Fetch ASP public key for encrypted label registration. |

# **Methods**

> <a id="keystore-registration-precheck"></a>**Keystore-registration precheck (2026-09-24, v1.25.3).** Every spend built through `TransactOrchestrator.prepareTransact` (withdraw, relayed withdraw, transfer / cold-start transfer, payment-request fulfilment, batch withdraw, withdraw-and-swap, reshield, cross-chain reshield) first calls `assertKeystoreRegistered` (`utils/KeystoreRegistration.ts`) for the **session owner**, which reads `Keystore.getNullifyingKeyHash(owner)`; zero means not registered and throws the existing `KeystoreNotRegistered` (`Keystore not registered for <addr>; call registerKeystore first`), or `RegistrationCheckFailed` when the read itself fails. It runs after input-note validation (a non-ACTIVE note still fails first with `TransactNoteNotActive`) and **before** any merkle leaves are fetched, so a never-registered owner fails fast instead of after proof work. It is **skipped** when `pendingKeystoreRegistration` is set (the register-and-withdraw bundle). `prepareRageQuit` runs the same check for the **note owner** (`note.ownerAddress`). `isKeystoreRegistered()` shares the same read (no behaviour change). Both errors extend `PoolSessionKeystoreBaseError` — *not* `PoolSessionTransactBaseError` / `PoolSessionRagequitBaseError` — so the affected interface methods list `PoolSessionKeystoreBaseError` in their `@throws`. An owner who **is** registered but whose (wrong / rotated) session keys produce a leaf absent from the tree is deliberately *not* reported as unregistered: it still fails later as `WitnessPreparationFailed` wrapping the merkle `LeafNotFound` (see [witness-preparation-service.md](witness-preparation-service.md)).

**`prepareRegisterKeystore(options?) → Promise<RegisterKeystoreResult>`**

Generates calldata for the one-time keystore registration flow. Computes `nullifyingKeyHash` and `authDigest` via the injected `IHashService`, reads on-chain state (`isKeystoreRegistered()` for the auth policy; the viewing-key read only when `includeViewingKey` is true), and returns one of three shapes:

1. **Fully registered — short circuit.** Auth policy already set and (when requested) viewing key already published: returns `{ alreadyRegistered: true, keystoreCalldata: null, viewingKeyCalldata: null, ... }`.
2. **Fresh registration.** Encodes `Keystore.setAuthPolicy(authDigest, nullifyingKeyHash)` into `keystoreCalldata` and (by default) `Keystore.setViewingKey(viewingKey)` into `viewingKeyCalldata`.
3. **Partial resumption.** Auth policy already on-chain but the viewing key is missing (e.g. an earlier `registerKeystore({ includeViewingKey: false })`, or a run that died between the two transactions): `alreadyRegistered` is `false`, `keystoreCalldata` is `null`, and only the missing `setViewingKey` transaction is built in `viewingKeyCalldata`. Passing `includeViewingKey: false` when the auth policy is on-chain takes shape 1.

Submission is either SDK-driven (`executeRegisterKeystore` / `registerKeystore`, below — which also marks the chain registered) or by the caller, who must then call `keystoreManager.markRegistered(chainId)` after on-chain confirmation.

**Returns: `RegisterKeystoreResult`**

| Field | Type | Description |
| --- | --- | --- |
| `alreadyRegistered` | `boolean` | `true` if nothing remains to register (auth policy on-chain and, when requested, viewing key set); when `true` both calldata fields are `null`. |
| `keystoreCalldata` | `PreparedTransaction \| null` | ABI-encoded `setAuthPolicy(authDigest, nullifyingKeyHash)` transaction. `null` when already registered **or** when the auth policy is already on-chain (partial resumption). |
| `viewingKeyCalldata` | `PreparedTransaction \| null` | ABI-encoded `setViewingKey(viewingKey)` transaction. `null` when the caller opts out (`includeViewingKey: false`) or when already registered. |
| `nullifyingKeyHash` | `Hash` | Public hash of the nullifying key (immutable once set in the Keystore). |
| `authDigest` | `Hash` | `Poseidon(Poseidon(privateRevocableKey), 0)` — stored on-chain in the keystore leaf. |

**`isKeystoreRegistered() → Promise<boolean>`**

Reads the `Keystore` contract to determine whether the account already has an `authPolicy` set. Lightweight wrapper for callers that want to branch on registration status before calling `prepareRegisterKeystore`.

---

**`executeRegisterKeystore(result) → Promise<TxReceipt[]>`**

Submits a prepared registration through the injected keystore interactor and awaits each receipt. Returns `[]` when `result.alreadyRegistered`. Otherwise:

1. **Validates every calldata before signing any.** `keystoreCalldata` (target = Keystore contract, operation = `setAuthPolicy`) and `viewingKeyCalldata` (target = Keystore contract, operation = `setViewingKey`) are both verified via the injected `IPreparedTxVerifier` up front. A tampered second transaction is therefore refused with `UnexpectedTransactionTarget` while **nothing has been submitted**, rather than after `setAuthPolicy` is already on-chain as a partial registration.
2. **Submits in order** — `keystoreCalldata` first (skipped when `null`; its receipt must have `status` true, else `PoolSessionKeystoreBaseError("setAuthPolicy transaction reverted")`), then `viewingKeyCalldata` (skipped when `null`; same check for `setViewingKey`). Receipts are returned in submission order (0, 1 or 2 entries).
3. **Marks the chain registered only if not already marked.** After the last receipt it calls `keystoreManager.markRegistered(chainId)` **only when `!keystoreManager.isRegistered(chainId)`**. `KeystoreManager.markRegistered` rejects a second mark for the same chain with `AlreadyRegistered` (unchanged), so the guard is what lets a partial registration be resumed in the same session: `registerKeystore({ includeViewingKey: false })` registers the auth policy and marks the manager; a later `registerKeystore()` takes the partial-resumption path of `prepareRegisterKeystore` (only `setViewingKey` is built), submits it, and succeeds instead of throwing `AlreadyRegistered` for transactions that already landed on-chain.

Skip this method when bringing your own signer/broadcaster — the integrator then calls `keystoreManager.markRegistered(chainId)` itself after on-chain confirmation.

**Params:** `RegisterKeystoreResult` — the result from `prepareRegisterKeystore`.

**Returns:** `TxReceipt[]` — receipts of the submitted transactions, in order.

**Throws:** `UnexpectedTransactionTarget` (either calldata fails verification; nothing submitted), `PoolSessionKeystoreBaseError` (a submitted transaction reverted).

---

**`registerKeystore(options?) → Promise<TxReceipt[]>`**

Convenience wrapper that runs `prepareRegisterKeystore` then `executeRegisterKeystore` in one call. Same options as `prepareRegisterKeystore`.

**Returns:** `TxReceipt[]` (see `executeRegisterKeystore` above).

---

**`prepareRelayedRegistration(options) → Promise<PreparedRelayedRegistration>`**

Relayed counterpart to `prepareRegisterKeystore` for a fresh, unfunded account that cannot pay gas to submit `Keystore.setAuthPolicy` itself. Chain-neutral: computes `nullifyingKeyHash` + `authDigest` from KeystoreManager state (same values as the direct path), asks the keystore interactor for the chain's authorization payload (`IKeystoreInteractor.buildRegistrationAuthorization`) and — unless `sign: false` — signs it (`signRegistrationAuthorization`). On EVM the payload is the EIP-712 `SetAuthPolicy` typed data (domain `PrivacyPoolsKeystore`/`1`, matching the contract's `SET_AUTH_POLICY_TYPEHASH`) signed via `IWalletInteractor.signTypedData`; on Stellar it is an unsigned Soroban auth entry over `keystore.set_auth_policy(account, nullifyingKeyHash, authDigest)` (random nonce, expiry ledger derived from `deadline` at ~5 s/ledger) signed via `IStellarWalletInteractor.signAuthEntry` — see [keystore-manager.md](./keystore-manager.md). Produces **no calldata**: a relayer submits `Keystore.setAuthPolicyWithSig` (EVM) or `relay.register_and_relay` (Stellar) on the owner's behalf. Calls `isKeystoreRegistered()` first and rejects an already-registered account with `KeystoreAlreadyRegistered` (a plain relayed withdrawal should be used instead), then rejects a `deadline` already in the past with `RegistrationDeadlineInPast` — both before any signing. Delegated to `IPoolSessionKeystore` and exposed on the facade.

The signed result feeds `prepareRegisterAndWithdrawRelay` (below) or the standalone `IRelayerInteractor.submitRelayedRegistration` (EVM only — standalone relayed registration is unsupported on Stellar).

**Params: `RelayedRegistrationOptions`**

| Param | Type | Description |
| --- | --- | --- |
| `deadline` | `Hex` | Unix timestamp after which the signature is invalid on-chain (Stellar: converted to the entry's expiry ledger). Must be in the future (`RegistrationDeadlineInPast` otherwise). |
| `sign` | `boolean?` | Defaults to `true`. Pass `false` to get the unsigned `typedData` back (`signature: null`) for an external signer. |

**Returns: `PreparedRelayedRegistration`**

| Field | Type | Description |
| --- | --- | --- |
| `typedData` | `RelayedRegistrationAuthorization` | `Eip712TypedData \| SorobanRegistrationAuthorization`: the EIP-712 `SetAuthPolicy` payload (EVM), or `{ kind: "sorobanAuthEntry", entryXdr, validUntilLedger }` — the unsigned auth entry, base64 XDR (Stellar). Narrow on `"kind" in`. |
| `account` | `Address` | The account whose auth policy is being set. |
| `authDigest` | `Hash` | `Poseidon(revocableKeyHash, authorizerAddress=0)`. |
| `nullifyingKeyHash` | `Hash` | Public hash of the nullifying key. |
| `deadline` | `Hex` | Echoed signature deadline. |
| `signature` | `Hex \| null` | The account's authorization over `typedData`; `null` when `sign: false`. EVM: the EIP-712 signature. Stellar: the **signed auth entry itself** (hex of its XDR) — Soroban authorization travels as a whole entry (nonce, expiry ledger, invocation), not a detached signature. |

**Throws:** `KeystoreAlreadyRegistered`, `RegistrationDeadlineInPast`.

---

**`getRevocableKeyIndex() → Hex`**

Returns the rotation index `n` of the active `privateRevocableKey`. Proxy for `KeystoreManager.getRevocableKeyIndex()` exposed on the facade so integrators can read/persist the index without holding a `KeystoreManager` reference (the facade is the sole public entry point).

---

**`discoverRevocableKeyIndex(config, gapLimit?) → Promise<Hex>`**

Recovers the active rotation index from chain. Reads the latest `authDigest` for `config.signerAddress` from `AuthPolicySet` / `AuthPolicyUpdated` events, then for `n = 0..gapLimit` re-derives `privateRevocableKey_n` via `CryptoService.deriveKeysFromSignature` and compares `Poseidon(0, Poseidon(privateRevocableKey_n))` against the on-chain digest. Returns the matching `n`.

Used during wallet cold-start when local storage no longer holds the rotation index.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `config` | `Omit<DeriveFromSignatureConfig, "revocableKeyIndex">` | Wallet signature + signer address (same shape as `rotateRevocableKey`). |
| `gapLimit` | `number?` | Highest candidate index scanned (exclusive). Defaults to 20. |

**Returns:** `Hex` — Rotation index `n` as 0x-prefixed hex.

**Throws:** `KeystoreNotRegistered`, `RevocableKeyIndexNotFound`.

---

**`prepareRotateRevocableKey(config) → Promise<RotateRevocableKeyResult>`**

Prepares the calldata for a revocable-key rotation. Increments the current rotation index by one, re-derives the new key from the wallet signature via `CryptoService.deriveKeysFromSignature`, computes the old/new auth digests, and builds the `updateAuthPolicy` calldata via the private helper `buildUpdateAuthPolicyCalldata(oldAuthDigest, newAuthDigest)` — which re-reads the keystore leaves, locates the current leaf, pads the Merkle siblings to `KEYSTORE_MAX_DEPTH`, and ABI-encodes `updateAuthPolicy`. Submission stays with the caller — either pass the result to `executeRotateRevocableKey` (SDK-submitted) or sign + broadcast the calldata yourself and then call `keystoreManager.applyRotation(newIndex, newRevocableKey)` to commit the in-memory rotation.

The returned `keystoreCalldata` is the single carrier of the old/new auth digests. The result no longer exposes `oldAuthDigest` / `newAuthDigest` as separate fields: `executeRotateRevocableKey` decodes them from the validated calldata, so a tampered result cannot carry digests that disagree with what is actually submitted on-chain.

**Params: `RotateRevocableKeyConfig`** — `Omit<DeriveFromSignatureConfig, "revocableKeyIndex">`.

| Param | Type | Description |
| --- | --- | --- |
| `signature` | `Hex` | 65-byte ECDSA signature. |
| `signerAddress` | `Address` | The signer's address. |
| `addressHash` | `Hex?` | Optional `keccak256(signerAddress)` from the EIP-712 payload, see [crypto-service.md](./crypto-service.md). |

The target rotation index is always `currentIndex + 1n`; arbitrary-skip rotation is intentionally not supported. To recover the current index after a state wipe, use `discoverRevocableKeyIndex()` (above) and pass the recovered value to the builder's `protocolKeys.revocableKeyIndex` before resuming rotation.

**Returns: `RotateRevocableKeyResult`**

| Field | Type | Description |
| --- | --- | --- |
| `keystoreCalldata` | `PreparedTransaction` | ABI-encoded `updateAuthPolicy(oldAuthDigest, newAuthDigest, siblings)` calldata. Sole carrier of the old/new auth digests — `executeRotateRevocableKey` decodes them from here rather than from loose result fields. |
| `newIndex` | `Hex` | Target rotation index as 0x-prefixed hex (= `currentIndex + 1`). |
| `newRevocableKey` | `Secret` | Freshly-derived `privateRevocableKey` for `newIndex`. |

**Throws:** `KeystoreNotRegistered`, `CurrentLeafNotFound`.

---

**`executeRotateRevocableKey(result) → Promise<RotateRevocableKeyOutcome>`**

Submits a prepared rotation through the injected wallet interactor and awaits the receipt. Before submitting it:

1. **Validates `keystoreCalldata`** via `assertPreparedTxMatches` (target = keystore contract, selector = `updateAuthPolicy`). The validator returns the decoded function name and args.
2. **Decodes `oldAuthDigest` / `newAuthDigest`** from those args. These decoded values are the only digests used downstream, so the tamper guard on the calldata covers everything that reaches the chain.
3. **Recomputes the auth digest** from `result.newRevocableKey` and throws `RotationKeyMismatch` if it does not equal the decoded new digest. This stops the SDK from storing a local key that can never match the on-chain digest (a key that could never authorize again).
4. **Rebuilds the Merkle path** against the latest keystore tree right before submitting — same digests, fresh siblings — via `buildUpdateAuthPolicyCalldata`. `Keystore.updateAuthPolicy` verifies the siblings against the exact current root, so a path baked at prepare time reverts if a keystore insertion landed in between. Rebuilding shrinks the staleness window from prepare→execute down to fetch→inclusion.

On a successful receipt calls `keystoreManager.applyRotation(newIndex, newRevocableKey)` so SDK state matches chain. The outcome digests are returned from the decoded calldata values (not from loose result fields). Skip this method when bringing your own signer/broadcaster — the integrator handles `applyRotation` directly after on-chain confirmation in that path.

`newIndex` tampering remains unvalidated by design: it is not recomputable at execute time, and a wrong index self-heals via `discoverRevocableKeyIndex`.

**Throws:** `RotationKeyMismatch`, `CurrentLeafNotFound`.

**Returns: `RotateRevocableKeyOutcome`**

| Field | Type | Description |
|---|---|---|
| `receipt` | `TxReceipt` | On-chain transaction receipt for the `updateAuthPolicy` submission. |
| `oldAuthorizerDigest` | `Hash` | Authorization digest that was superseded. |
| `newAuthorizerDigest` | `Hash` | Authorization digest now active on-chain. |
| `newRevocableKeyIndex` | `Hex` | Rotation index of the newly active `privateRevocableKey`. Integrators MUST persist atomically with `receipt` — losing it before durable storage leaves the next session deriving the wrong `privateRevocableKey` from `signature + staleIndex`, causing every subsequent proof to fail until manual recovery. |

---

**`rotateRevocableKey(config) → Promise<RotateRevocableKeyOutcome>`**

Convenience wrapper that runs `prepareRotateRevocableKey` then `executeRotateRevocableKey` in one call. Same params as `prepareRotateRevocableKey`.

**Returns:** `RotateRevocableKeyOutcome` (see `executeRotateRevocableKey` above).

**Throws:** `KeystoreNotRegistered`, `CurrentLeafNotFound`.

---

**`prepareDeposit(params) → Promise<PrepareDepositResult>`**

Prepares a self-deposit. Generates `noteSecret` and `depositSecret`, builds the deposit witness via WitnessPreparationService (computes Poseidon hash chain: noteAddressHash -> precommitment -> label -> commitment), generates ZK proof, encrypts ASP ciphertext using viewing keys, and encodes the calldata. Adds the resulting `Note` (with `ownerAddress` and `noteSecret`) to the NoteManager.

**Params: `DepositParams`**

| Param | Type | Description |
| --- | --- | --- |
| `tokenId` | `Address` | Token identifier. 0xEeee...EEeE for native ETH, ERC-20 contract address for tokens. |
| `value` | `Hex` | Amount to deposit in the token's smallest unit (e.g. wei), as 0x-prefixed hex. |

The circuit's `context` public input is computed internally as `keccak256(abi.encode(NoteData)) mod SNARK_SCALAR_FIELD` and is not caller-supplied.

**Returns: `PrepareDepositResult`**

| Field | Type | Description |
| --- | --- | --- |
| `receipt` | `NoteReceipt` | Note receipt with commitment, label, status, and other note fields (excludes `ownerAddress`, `noteSecret`, and `isOwned`). |
| `callData` | `Hex` | ABI-encoded `deposit(proof, noteData, aspCiphertext)` calldata for on-chain submission via the Entrypoint. |
| `to` | `Address` | Entrypoint contract address (transaction target). |
| `msgValue` | `Hex` | ETH value to send with the transaction (value+fee for native, 0x0 for ERC-20). |
| `approvalTxs` | `PreparedTransaction[]` | Every ERC-20 approval to submit, in order, before the deposit: one from a zero allowance; two (`approve(0)` then `approve(total)`) on a token that requires a zero reset before re-approving a residual allowance (mainnet USDT); empty for native ETH or a sufficient allowance. `executeDeposit` validates all of them **and** `depositTx` (target = the Entrypoint, `deposit` selector) before signing anything, then submits the approvals in order followed by the deposit. |
| `approvalTx` | `PreparedTransaction \| null` | The last of `approvalTxs`, or null — kept for callers that submit a single approval; such callers still fail on a residual USDT allowance, so prefer `approvalTxs`. |

---

**`executeDeposit(result) → Promise<TxReceipt>`**

Submits a prepared deposit through the injected entrypoint interactor. **Validates everything before signing anything:** every ERC-20 approval (`approvalTxs`, plus a legacy `approvalTx` not already in that list) is checked via `assertApprovalTx` (target = the deposit token, selector = `approve`, spender = the Entrypoint) **and** `depositTx` is verified (target = the Entrypoint, `deposit` selector) — all before the first approval is submitted. A tampered deposit transaction is thus refused with `UnexpectedTransactionTarget` while no allowance exists on-chain; previously `depositTx` was verified only after the approvals were mined, leaving a genuine exact-amount Entrypoint allowance behind. It then submits the approvals in order, then `depositTx`, and on a successful receipt for an owned note persists it to the NoteManager. `deposit(params)` is the prepare + execute convenience wrapper.

**Throws:** `UnexpectedTransactionTarget` (any approval or `depositTx` fails verification; nothing submitted), `PoolSessionDepositBaseError` (an approval reverted).

---

**`prepareDepositFor(params) → Promise<PrepareDepositResult>`**

Prepares a deposit on behalf of a recipient (cold start flow). Takes a pre-computed `noteAddressHash` instead of computing it from `ownerAddress + noteSecret`. The sender generates the `noteSecret`, computes `noteAddressHash = Poseidon(recipientAddress, noteSecret)`, and shares both the `noteSecret` and deposit output with the recipient out-of-band. Does NOT add to NoteManager (sender doesn't own the note).

**Params: `DepositForParams`** (extends `DepositParams`)

| Param | Type | Description |
| --- | --- | --- |
| `tokenId` | `Address` | Token identifier. 0xEeee...EEeE for native ETH, ERC-20 contract address for tokens. |
| `value` | `Hex` | Amount to deposit in the token's smallest unit (e.g. wei), as 0x-prefixed hex. |
| `noteAddressHash` | `Hex` | Pre-computed `Poseidon(recipientAddress, noteSecret)`. |
| `discoveryData` | `DiscoveryData?` | Optional discovery material — either `{publicViewingKey, noteSecret}` or `{evmAddress, noteSecret}` — used to emit an encrypted `NoteData` payload the recipient can decrypt. |
| `noteData` | `{hint, data} \| NoteDataBuilder?` | Blind form only: the announcement the proof context is bound to. A `NoteDataBuilder` (`(note: {tokenId, value, noteAddressHash, depositSecret, label, commitment}) => {hint, data}`) is called once, synchronously, after the label and commitment are fixed and before proving; its output is re-validated (`InvalidDepositParams` on a throw or a malformed payload). Used when the committed value is sized by the SDK (a yield share in a swap-and-deposit). |
| `depositSecret` | `Hex?` | Blind form only: fixes the label, so a caller can pre-compute it. |

The recipient half of these params (everything but `tokenId`/`value`) is the exported type `DepositForRecipient`, also accepted as `SwapAndDepositParams.recipient` and (as `YieldDepositForRecipient`) by `prepareYieldDepositFor`.

**Returns: `PrepareDepositResult`** (same as `prepareDeposit`)

---

**Types:**

**`NoteReceipt = Omit<Note, 'ownerAddress' | 'noteSecret' | 'isOwned'>`**

Note receipt returned to the caller. Excludes internal fields (`ownerAddress`, `noteSecret`, `isOwned`) that are only relevant for NoteManager tracking.

| Field | Type | Description |
| --- | --- | --- |
| `noteAddressHash` | `Hash` | `Poseidon(ownerAddress, noteSecret)`. Used to bind the note to the owner without exposing the address on-chain. |
| `commitment` | `Hash` | The on-chain commitment: Poseidon(precommitment, label). |
| `value` | `Hex` | Token amount in smallest unit. |
| `tokenId` | `Address` | Token identifier. |
| `label` | `Label` | Poseidon(precommitment, depositSecret). Lineage identifier. |
| `status` | `NoteStatus` | PENDING after preparation. |
| `createdAtBlock` | `Hex` | Block number at which the note was observed on-chain (0x0 until confirmed). The on-chain `stateTree` leaves and `commitments` mapping also store a `block.timestamp`; the SDK currently surfaces the block number here. |
| `spentAtBlock` | `Hex \| null` | Null until spent. |
| `txHash` | `Hash` | Transaction hash (0x0 until submitted). |

---

**`prepareTransfer(params) → Promise<PrepareTransferResult>`**

Prepares a private internal transfer. Validates input notes via NoteManager (must be ACTIVE with sufficient balance). Fetches keys from KeystoreManager. Resolves the recipient identity (see "Recipient resolution" below). Fetches tree leaves from ContractInteractor (commitments, keystore) and ASPClient (association set). Builds transact witness via WitnessPreparationService (with `amountOut = feeAmount` — `0` for a fee-less self-submit; the relayer fee is the only public outflow — computes nullifiers, output commitments, merkle proofs for all three trees). Generates proof via ProofService. Returns `PrepareTransferResult` with both a self-submit payload (`executeOptions`) and per-relayer payloads (`relayOptions`) — the caller picks one and submits via `executeTransfer` or `relayTransfer`. Note state is mutated by `executeTransfer` / `relayTransfer`, not by `prepareTransfer`.

Explicitly awaits `warmMerkleCaches()` before requesting the relayer's committed quote — see "Cross-Chain Reshield" above for why.

**Recipient resolution.** `prepareTransfer` accepts the recipient in three forms via `TransferParams`:

- `recipientNoteAddressHashByLabel` — caller pre-computed the hash per input label as a `Map<Label, Hash>`; resolves to the **blind** variant (no on-chain note announcement, no off-chain secrets returned). Keys MUST exactly equal the set of unique labels present in `inputCommitments`; missing or extra entries throw `InvalidTransactParams`. (Map chosen over Record/object literal to match `RecipientDiscoveryData.noteSecretsMap` / `PaymentRequestRecord.noteSecretsMap` convention and to get strict `| undefined` typing on `.get()` lookups.)
- `recipientNoteAddressHash` — **deprecated.** Positional `Hash[]` whose indices must align with the SDK's internal first-occurrence label iteration. An undocumented contract; callers that order the array any other way silently misalign recipient hashes (F-012). Use `recipientNoteAddressHashByLabel` instead. Emits a one-shot deprecation warning via `logger.warn`.
- `recipientDiscoveryData` — discovery material analogous to `DepositForParams.discoveryData`. Two sub-shapes:
    - `{ evmAddress, noteSecretsMap?, allowOutOfBandFallback? }` — SDK looks up the recipient's viewing key in the on-chain keystore. If present, resolves to **discoverable** and publishes encrypted recipient `noteData` on-chain. If the keystore returns `0x0` (recipient not registered), the SDK **throws `RecipientViewingKeyUnregistered`** by default — it never downgrades silently, because a caller that assumed a discoverable transfer would discard the only copy of the note secrets. With `allowOutOfBandFallback: true` the caller opts in and the SDK falls back to **outOfBand** — no on-chain announcement; the recipient note secrets are returned in the result (`recipientNotes`) for off-chain delivery, and delivering them is then the caller's responsibility (discarding them locks the funds). RPC errors propagate; only the explicit "not registered" signal reaches this branch.
    - `{ publicViewingKey, noteSecretsMap }` — caller pre-resolved the viewing key and secrets; resolves to **discoverable**.
    - `{ publicViewingKey, noteAddressHashes }` — payment-request fulfillment; caller has only the pre-committed hashes, no secrets. Resolves to **discoverable-without-secrets** (no-secret v2 payload).

`blind` and `outOfBand` produce identical on-chain footprints (no recipient `Note` event); `discoverable` and `discoverable-without-secrets` trigger ECDH + payload encryption for the recipient note (v1 with the secret, v2 without). The change note's payload is always encrypted for self-discovery.

**Params: `TransferParams`** (`PrepareTransactBase & ({ recipientNoteAddressHashByLabel } | { recipientNoteAddressHash } | { recipientDiscoveryData })`)

| Param | Type | Description |
| --- | --- | --- |
| `inputCommitments` | `Hash[]` | Commitment hashes of the input notes to spend. All must be ACTIVE. |
| `recipientNoteAddressHashByLabel` | `Map<Label, Hash>` | (Variant 1, **recommended**) Pre-computed `noteAddressHash = Poseidon(recipientAddress, noteSecret)` keyed by input label. Keys MUST exactly equal the set of unique labels in `inputCommitments`. Resolves to the **blind** variant. Mutually exclusive with `recipientNoteAddressHash` and `recipientDiscoveryData`. |
| `recipientNoteAddressHash` | `Hash[]` | (Variant 1, **deprecated**) Positional pre-computed `noteAddressHash` per recipient note. The i-th element binds to the i-th unique label encountered in `inputCommitments` (first-occurrence order) — an implicit contract that the spec did not previously document and that silently strands funds when violated. Prefer `recipientNoteAddressHashByLabel`. Mutually exclusive with the other two variants. |
| `recipientDiscoveryData` | `RecipientDiscoveryData` | (Variant 2) Recipient identity for on-chain note announcement. One of `{ evmAddress, noteSecretsMap?, allowOutOfBandFallback? }` (SDK resolves the viewing key from the keystore; when the recipient is unregistered it throws `RecipientViewingKeyUnregistered` unless `allowOutOfBandFallback: true` opts into `outOfBand`), `{ publicViewingKey, noteSecretsMap }`, or `{ publicViewingKey, noteAddressHashes }` (payment-request, no secrets). Mutually exclusive with the blind-variant fields. |
| `amount` | `Hex` | Amount to transfer to the recipient (becomes an output note inside the pool). |
| `tokenId` | `Address` | Token identifier. Must match the tokenId of all input notes (per-label value conservation enforced by circuit). The match is case-insensitive: notes that spell the same token checksummed on one and lowercase on another (different creation paths do both) spend together; genuinely different tokens still throw `InvalidTransactParams` ("All input notes must have the same tokenId"). Applies to every transact-shaped flow (transfer, withdraw, batch, swap, reshield) via `TransactOrchestrator.getNotesTokenId`. |
| `relayAddress` | `Address` | PrivacyPoolRelay deployment address. Used as the fee recipient in the self-relay calldata (`PayoutRouting.feeRecipient`). Independent of the third-party relayer options returned in the result. |
| `feeAmount` | `Hex` | Fee amount for the self-relay calldata (`PayoutRouting.feeAmount`). When using a third-party relayer via `relayTransfer()`, the relayer's own fee quote overrides this value. |
| `processorAddress` | `Address` | Address of the processor contract for self-relay (`PayoutRouting.processor`). When using a third-party relayer via `relayTransfer()`, this is ignored — a private transfer's only public outflow is the relayer fee itself (`amountOut == feeAmount`, paid by the pool to the processor), so it needs no withdrawal processor contract. `relayTransfer` binds `TransactParams.processor` to `selectedQuote.relayerInfo.address` (the relayer's own submitting address — see contracts-tech-design.md §4, "User (or Relayer) calls transact(...) on PoolVault" directly), matching the address the relayer actually submits with (`msg.sender` on EVM; the gated processor of the pool's own `transact` on Stellar, which the Stellar relayer checks with `amountOut == feeAmount` exactly). |

**Returns: `PrepareTransferResult`**

| Field | Type | Description |
| --- | --- | --- |
| `executeOptions` | `ExecuteTransferParams` | Self-submit payload for `executeTransfer()`. Contains calldata, target, the resolved recipient kind, and the `PendingNote[]` for change and recipient outputs. |
| `relayOptions` | `RelayTransferParams[]` | Per-relayer payloads for `relayTransfer()` — one entry per available relayer. Each entry carries the resolved recipient and the relayer's quote so the relay path produces the same on-chain semantics as `executeTransfer`. |

**Throws:** `KeystoreNotRegistered` (a `PoolSessionKeystoreBaseError`; the session owner has no on-chain keystore registration — checked before any merkle leaves are fetched, see [Keystore-registration precheck](#keystore-registration-precheck)), or `RegistrationCheckFailed` when the registration read itself fails. Also applies to `prepareFulfillPaymentRequest`. The check concerns the sender (session owner); a recipient needs no registration to *receive*.

---

**`prepareColdStartTransfer(params) → Promise<PrepareTransferResult>`**

Explicit "skip the keystore lookup" convenience for sending to an EVM address known not to have a registered viewing key. Equivalent to `prepareTransfer` with `recipientDiscoveryData: { evmAddress }` except no keystore lookup is performed and the result is always the **outOfBand** variant (no on-chain announcement; `noteSecretsMap` returned for off-chain delivery). Use when callers want to bypass the network round-trip.

**Params: `ColdStartTransferParams`** (`PrepareTransactBase & { recipientEvmAddress }`)

| Param | Type | Description |
| --- | --- | --- |
| `inputCommitments` | `Hash[]` | Commitment hashes of the input notes to spend. |
| `recipientEvmAddress` | `Address` | Recipient's EVM address. SDK generates a fresh `noteSecret` and computes `noteAddressHash = Poseidon(recipientEvmAddress, noteSecret)` internally. |
| `amount` | `Hex` | Amount to transfer. |
| `tokenId` | `Address` | Token identifier. |
| `relayAddress` / `feeAmount` / `processorAddress` | — | As in `TransferParams`. |

**Returns:** `PrepareTransferResult` (same shape as `prepareTransfer`).

**Throws:** `KeystoreNotRegistered` / `RegistrationCheckFailed` as in `prepareTransfer` — the check concerns the **sender** (session owner), not the recipient, whose lack of registration is what this method exists for.

---

**`executeTransfer(opts) → Promise<TransferResult>`**

Self-submits a prepared transfer using the wallet adapter (no relayer). Takes the `executeOptions` returned by `prepareTransfer` / `prepareColdStartTransfer`, submits the transact transaction on-chain via ContractInteractor, and updates the sender's NoteManager: input notes → SPENT and the change note is added. Recipient notes are never written to the sender's NoteManager — they are returned to the caller (when secrets are known) for off-chain delivery, or discovered by the recipient via `discoverNotes()`.

**Params: `ExecuteTransferParams`**

| Field | Type | Description |
| --- | --- | --- |
| `to` | `Address` | PoolVault contract address (transaction target). |
| `callData` | `Hex` | ABI-encoded `transact` calldata. |
| `spentNotes` | `Note[]` | Input notes to mark SPENT after submission. |
| `changePendingNotes` | `PendingNote[]` | Sender's change note(s) to commit to NoteManager. |
| `recipientPendingNotes` | `PendingNote[]` | Recipient note(s). Enriched with `noteSecret` + `ownerAddress` for any non-blind recipient (i.e. when `noteSecretsMap` is set). |
| `recipient` | `ResolvedTransferRecipient` | Resolved recipient state — see [ResolvedTransferRecipient](#resolvedtransferrecipient). |
| `recipientEvmAddress` | `Address?` | Recipient's EVM address — stamped onto returned recipient notes' `ownerAddress` when known. |

**Returns: `TransferResult`** — `{ txReceipt: TxReceipt, recipientNotes?: Note[] }`. `recipientNotes` is returned whenever the resolved recipient carries a `noteSecretsMap` (i.e. for both `outOfBand` and `discoverable`); absent for the `blind` and `discoverable-without-secrets` (payment-request) variants — the latter never exposes the recipient's secrets to the sender.

---

**`relayTransfer(params) → Promise<TransferResult>`**

Submits a prepared transfer to a relayer for on-chain execution. Takes one of the `relayOptions` returned by `prepareTransfer` / `prepareColdStartTransfer` / `prepareFulfillPaymentRequest`. Before generating the proof, asserts the quote's fee commitment is not expired and that `feeCommitment.asset` matches the `tokenId` being transferred (`InvalidTransactParams` on mismatch) — same asset rule as `relayWithdraw`. Rebuilds the witness with the relayer's fee context (deducting the fee from the change note), generates a new proof, and submits to the selected relayer. On-chain semantics match `executeTransfer` for the same recipient variant.

The caller MUST select the `relayOptions[i]` entry explicitly. `relayOptions` is ordered by relayer configuration (not by fee), and `relayTransfer` binds `selectedQuote.quote.feeAmount` into the proof as the public outflow — so the chosen quote's fee is deducted from the caller's change note. There is intentionally **no auto-relay one-shot** (no `fulfillPaymentRequest` / auto-`relayTransfer(relayOptions[0])`): silently taking the first quote would bind whatever fee the first-configured (possibly hostile) relayer set, draining the surplus. Forcing explicit selection guarantees the caller has reviewed the fee they are accepting.

**Params: `RelayTransferParams`** (`PrepareTransactBase & { recipient, recipientEvmAddress?, selectedQuote }`)

| Field | Type | Description |
| --- | --- | --- |
| `recipient` | `ResolvedTransferRecipient` | Resolved recipient state — same shape as in `ExecuteTransferParams`. |
| `recipientEvmAddress` | `Address?` | Recipient's EVM address — stamped onto returned recipient notes' `ownerAddress` when known. |
| `selectedQuote` | `PrepareTransferRelayerQuotes` | Selected relayer and its fee quote. |
| `inputCommitments` / `amount` / `tokenId` / ... | — | Inherited transact inputs from `PrepareTransactBase`. |

**Returns: `TransferResult`** — `{ txReceipt: TxReceipt, recipientNotes?: Note[] }`. Same presence rule as `executeTransfer`.

**Throws:** `InvalidTransactParams` (fee-commitment / asset guards above); `KeystoreNotRegistered` / `RegistrationCheckFailed` as in `prepareTransfer`.

---

**`prepareWithdraw(params) → Promise<PrepareWithdrawResult>`**

Public withdrawal. Same flow as transfer but with amountOut > 0. Uses the same `transact` circuit with a single change output note (mOutputs = 1). The withdrawn amount exits the pool and is sent to the PrivacyPoolRelay processor (`relayAddress`), which deducts `feeAmount` from `amountOut` and sends it to `feeRecipient`, forwarding the remaining amount to `recipientAddress` (Bob). The processor field is set to the relay deployment address, and data is ABI-encoded as `PayoutRouting { recipient, feeRecipient, feeAmount, nativeGas }` — the layout PrivacyPoolRelay expects to `abi.decode`. Context is computed over the real transactParams (processor + data + encryptedPayload). Updates NoteManager: input → SPENT, adds change note if any.

Explicitly awaits `warmMerkleCaches()` before requesting the relayer's committed quote (via `getWithdrawRelayerQuotes()`) — see "Cross-Chain Reshield" above for why.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `inputCommitments` | `Hash[]` | Array of note IDs to spend. All must be ACTIVE. |
| `amount` | `Hex` | Amount to withdraw from the pool (becomes `amountOut`, includes fee). |
| `tokenId` | `Address` | Token identifier for the withdrawn asset. Becomes `tokenIdOut` in the circuit's public inputs. |
| `recipientAddress` | `Address` | Recipient address for the net amount after fee (`PayoutRouting.recipient` / Bob). |
| `relayAddress` | `Address` | PrivacyPoolRelay deployment address (becomes the `processor` in transactParams). |
| `feeAmount` | `Hex` | Fee amount deducted from `amountOut` (`PayoutRouting.feeAmount`). |
| `feeRecipient` | `Address?` | Fee recipient address (`PayoutRouting.feeRecipient`). Omit to default to `relayAddress`; pass `address(0)` to fall back to `msg.sender` on-chain. |
| `nativeGas` | `Hex?` | Native ETH the caller commits to attach to `relay()` (`PayoutRouting.nativeGas`). Defaults to `0x0`. PrivacyPoolRelay enforces `msg.value == nativeGas`. |

The service internally generates a fresh `noteSecret` via `CryptoService.generateSecret()` and computes `senderNoteAddressHash = Poseidon(ownerAddress, noteSecret)` for the change note. The generated secret is returned in the result.

**Returns: `PrepareWithdrawResult`**

| Field | Type | Description |
| --- | --- | --- |
| `changeReceipt` | `NoteReceipt` | Receipt of the sender's change note (remainder after withdrawal). |
| `nullifiers` | `Hash[]` | Nullifier hashes for each spent input note. |
| `amountOut` | `Hex` | The public withdrawal amount included in the proof. |
| `callData` | `Hex` | ABI-encoded calldata for the transact function. |
| `to` | `Address` | PoolVault contract address (transaction target). |
| `relayerOptions` | `ExecuteWithdrawRelayerParams[]` | Pre-built relay options — one per available relayer — for submitting via `relayWithdraw()`. |

**Throws:** `KeystoreNotRegistered` (a `PoolSessionKeystoreBaseError`; the session owner has no on-chain keystore registration — checked before any merkle leaves are fetched, see [Keystore-registration precheck](#keystore-registration-precheck)), or `RegistrationCheckFailed` when the registration read itself fails. The same precheck guards the self-submit `withdraw` path, `prepareFulfillPaymentRequest`, and the batch-withdraw prepare / self-submit methods (see [batch-withdraw.md](batch-withdraw.md)) — they all share `TransactOrchestrator.prepareTransact` — but not `prepareRegisterAndWithdrawRelay` (below).

---

**`relayWithdraw(params) → Promise<Hash>`**

Submits a prepared withdrawal to a relayer for on-chain execution. Takes one of the `relayerOptions` returned by `prepareWithdraw()`. Rebuilds the witness with the relayer's fee context, generates a new proof, and submits to the selected relayer.

Before generating the proof, the SDK decodes the relayer-signed `PayoutRouting` tuple from `selectedQuote.quote.feeCommitment.data` and asserts that its `recipient`, `feeAmount`, and `nativeGas` slots match the values the caller agreed to in the JSON quote. It also asserts that `feeCommitment.asset` matches the `tokenId` being withdrawn, so a quote obtained for a different asset cannot be bound into the proof. A mismatch throws `InvalidTransactParams` — preventing the user from cryptographically endorsing routing the relayer encoded unilaterally. `nativeGas` is locked to `0` while the SDK requests quotes with `extraGas: false`; that pins the assertion until the extra-gas feature is wired through.

**Receipt log verification before persisting SPENT (AW-L-02 / #1070).** After the relayer-supplied `txHash` confirms, and *before* the notes are persisted SPENT, the SDK parses the receipt's `Transacted` logs and requires that every spent note's nullifier hash appears in a log **emitted by the expected PoolVault** (the `Transacted` emitter is the pool, which also serves the emitter check). This defends against a relayer that returns the hash of an unrelated successful transaction to make the wallet treat still-spendable notes as spent. The check is **verify-and-WARN, not a hard gate**: on a mismatch the SDK logs a warning and persists nothing, leaving `discoverNotes()` as the backstop — so a genuine spend whose logs are merely unparseable (e.g. a proxied/wrapped call) is never stranded by a throw. The same verification is applied by `registerAndWithdraw`, the self-submit `executeWithdraw` path, the batch path (`relayBatchWithdraw`), the internal-transfer paths (`relayTransfer` and the self-submit `executeTransfer`), and the relayed swap paths (`relayWithdrawAndSwap`, `relayReshield`) — every relayed/self-submit path that persists input notes SPENT. Only `Transacted` is parsed — the aggregate `RelayedBatch` event carries no nullifiers.

The `verification` argument to `ITransactOrchestrator.persistNoteUpdates` (and to `IBatchWithdrawOrchestrator.persistBatchNoteUpdates`) is **required, not optional**. This is a deliberate API choice rather than a stylistic one: `SPENT` is a terminal state in the note-status transition table, so a note persisted SPENT on unverified evidence can never be walked back by `discoverNotes()` — the backstop only rescues the skip-persist direction. While the parameter was optional the check failed **open**, and the two relayed swap paths omitted it entirely and persisted on an unverified relayer `txHash`. Making it required turns any missed call site into a compile error.

**Params: `ExecuteWithdrawRelayerParams`**

| Field | Type | Description |
| --- | --- | --- |
| `recipientAddress` | `Address` | The recipient address for the withdrawn funds. |
| `selectedQuote` | `PrepareWithdrawRelayerQuotes` | The selected relayer and its fee quote. |
| `transactWitnessInputs` | `BuildTransactWitnessInputs` | The transact witness inputs to finalize proof generation with relay context. |
| `noteData` | `NoteData[]` | Encrypted note data payloads for the relayer to include on-chain. Each entry's `data` field contains an encrypted RLP-encoded NotePayload. |

**Returns:** `Hash` — The transaction hash of the relayed transaction.

**Throws:** `KeystoreNotRegistered` (a `PoolSessionKeystoreBaseError`; the session owner has no on-chain keystore registration — checked before any merkle leaves are fetched, see [Keystore-registration precheck](#keystore-registration-precheck)), or `RegistrationCheckFailed` when the registration read itself fails; plus the fee/asset guards above (`InvalidTransactParams`).

---

**`prepareRegisterAndWithdrawRelay(params, registration) → Promise<PrepareRegisterAndWithdrawResult>`**

The fresh-unfunded-recipient atomic flow: a recipient who has just received a note but has never registered a keystore auth policy — and holds no gas — registers **and** withdraws the note in one relayer-submitted bundle. Runs the same fee/routing guards as `relayWithdraw` (extracted into a shared `buildGuardedWithdrawTransact`), but builds the withdrawal proof with `pendingKeystoreRegistration: true` so the witness anchors `keystoreRoot` to the **predicted post-insertion root** — the root the keystore tree will have *after* `setAuthPolicyWithSig` inserts the owner's leaf (see [merkle-service.md](./merkle-service.md) and item 3 of the flow below). This is what makes the bundle atomic: the withdrawal proof is valid against the tree state the registration leg produces.

Takes a signed `registration` (from `prepareRelayedRegistration`) — rejects an unsigned one — plus the usual withdrawal `params`. Does **not** submit; returns the pieces for the caller to hand to `IRelayerInteractor.relayRegisterAndWithdrawal`.

Because the proof is anchored to a keystore root that only exists once the bundled registration lands, `TransactOrchestrator` encodes the transact with `IPoolVaultChainAdapter.encodeTransact(..., { deferSimulation: true })`: EVM ignores the flag (it encodes calldata without simulating), Stellar builds the call unsimulated (`buildUnsimulatedTransaction`) — that transaction is for inspection only, the relayer submits its own bundled call. Chain-neutral; on Stellar the relayer submits `relay.register_and_relay` with the owner's signed auth entry attached (see [relayer/stellar-relayer.md](../relayer/stellar-relayer.md)).

Because the predicted root is **optimistic** (any concurrent keystore mutation invalidates it), the atomic bundle should be submitted via private orderflow so a stale-root revert costs no gas.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `params` | withdrawal params | Same withdrawal inputs as `relayWithdraw` (`recipientAddress`, `selectedQuote`, etc.). |
| `registration` | `PreparedRelayedRegistration` | Signed relayed-registration payload from `prepareRelayedRegistration`. Must carry a non-null `signature`. |

**Returns: `PrepareRegisterAndWithdrawResult`**

| Field | Type | Description |
| --- | --- | --- |
| `relayer` | `RelayerInfo` | The relayer selected for the bundle. |
| `relayParams` | `RegisterAndWithdrawalRelayParams` | The atomic relay payload (withdrawal fields + nested `registration`) — hand to `relayRegisterAndWithdrawal`. |
| `spentNotes` | `Note[]` | Input notes to mark SPENT after the bundle mines. |
| `changePendingNotes` | `PendingNote[]` | Change note(s) to commit to NoteManager after the bundle mines. |

**Throws:** rejects an unsigned `registration`; plus the fee/asset guards inherited from the shared withdraw path (`InvalidTransactParams`). The keystore-registration precheck (`KeystoreNotRegistered`) does **not** apply here: the witness is built with `pendingKeystoreRegistration: true`, proving against the predicted post-registration root, so the owner is legitimately not yet on-chain. A registered owner's wrong/rotated keys still surface as `WitnessPreparationFailed` (merkle `LeafNotFound`).

> **Deferred (INTL-05):** the yield-specific atomic variant on `PoolSessionYieldWithdraw`, and the standalone `/register` relayer endpoint, are mechanical follow-ups — see `agents/deviations.md` (INTL-05) and `docs/tech-design/future-ideas/relayed-key-registration.md`.

---

**`prepareSwapQuote(params) → Promise<PreparedSwapQuote>`**

Orchestrates the full swap quoting flow for withdraw-and-swap: relayer fee quote, DEX swap quote, and relayer commitment — returning everything needed for `relayWithdrawAndSwap()`. Eliminates the 20+ lines of manual quoting callers previously had to write.

Requires `swapQuoteProvider` in `PoolSessionConfig`. Delegates to `PoolSessionWithdrawAndSwap`, whose config now requires `entrypointInteractor: IEntrypointInteractor` (threaded by `PoolSessionFactory`) for RPC-backed pre-flight validation.

Explicitly awaits `warmMerkleCaches()` before step 6's committed quote — see "Cross-Chain Reshield" above for why.

**Internal flow:**
1. Pre-flight: read the input asset's config from the Entrypoint via `getAssetConfig(tokenId)` to bound the relayer fee
2. Relayer preliminary quote (`commit: false`) → `feeAmount`; fee bounds check — `RelayFeeExceedsMax` when a nonzero `maxRelayFee` is exceeded, `InvalidTransactParams` when the fee consumes the whole withdrawal amount
3. `netSwapAmount = amount - feeAmount`
4. DEX swap quote via `swapQuoteProvider.getSwapQuote()` → `transactionData`, `toAmountMin`
5. Cross-check the quote's echoed route (`fromTokenAddress` / `toTokenAddress` / `fromChainId` / `toChainId`) against the request → `SwapQuoteMismatch` on divergence; then swap-executor screening (`assertNoSwapExecutor`, see below) on `transactionTo` / `approvalAddress` / `transactionData` → `UnexpectedTransactionTarget`
6. Relayer committed quote (`commit: true`, with `swapCalldata: transactionData`, `swapTarget`, `approvalAddress`, `minOutputAmount: toAmountMin` same-chain / `0` cross-chain) → signed commitment
7. Fee bounds re-check on the committed quote, then assert the committed `feeCommitment.amountSent` equals the requested gross withdrawal `amount` — `InvalidTransactParams` otherwise, so the relayer cannot silently alter the gross pool outflow in the commitment (defense-in-depth; the relay path re-checks `amountSent == amount + fee` on the net amount)
8. Decode the signed routing (`decodeRelaySwapRouting`) and validate it field-by-field: embedded `swapCalldata` byte-equality, `recipient`, `fallbackAddress`, `outputToken`, `dustRecipient`, `feeAmount`, `minOutputAmount`, `nativeGas` (against the `extraGas` flag: `0` when off, nonzero when on — the amount is relayer-computed, and its cost is bounded by the fee checks since it is folded into `feeAmount`), `swapTarget === transactionTo`, `approvalAddress`
9. Assemble and return

**Swap-executor screening (2026-10-02).** LiFi's `Executor` is on `RelaySwaps.approvedRouters` (the same-chain native swap-and-deposit needs it) but runs arbitrary calls for anyone: a transaction targeting it can move the funds anywhere while merely embedding the expected bytes, and an allowance granted to it can be spent by anyone (e.g. after the swap meant to consume it reverts). The allowlist check therefore does not suffice. The core-sdk util `assertNoSwapExecutor(adapter, { transactionTo, approvalAddress, transactionData })` throws `UnexpectedTransactionTarget` when the spender or target is a swap executor (`ISwapChainAdapter.isSwapExecutor`: a known `LIFI_SWAP_EXECUTORS` address on any chain, or a contract answering `erc20Proxy()` non-zero; cached) or the calldata calls an executor entry point (`ISwapChainAdapter.isSwapExecutorCall`: `swapAndExecute` / `swapAndCompleteBridgeTokens` selector, whatever the target). An `erc20Proxy()` revert or empty return means "not an executor"; any other read failure throws (uncached), so screening fails closed. Withdraw-and-swap, reshield and cross-chain reshield run it at prepare on the LiFi quote **and** at relay time on the decoded signed routing (`swapTarget` / `approvalAddress` / `swapCalldata`), since hand-built or tampered params skip prepare. Swap-and-deposit's rule is under `prepareSwapAndDeposit` below.

**Params: `PrepareSwapQuoteParams`**

| Param | Type | Description |
| --- | --- | --- |
| `relayerInfo` | `RelayerInfo` | The relayer to quote from. |
| `amount` | `Hex` | Withdrawal amount in input token units. |
| `tokenId` | `Address` | Input token address. |
| `outputToken` | `Address` | Desired output token address. |
| `recipientAddress` | `Address` | Recipient address for swap output. For cross-chain swaps this is a destination-chain address — it goes only into the proof-bound LiFi calldata (`toAddress`); the on-chain routing recipient is `address(0)`. |
| `fallbackAddress` | `Address?` | Destination-chain address receiving the bridged token if the destination swap fails (LiFi's `toFallbackAddress`). **Required for cross-chain swaps** (throws `InvalidTransactParams` otherwise, including when it is the empty-address sentinel — bridged funds would be unrecoverable on a failed destination swap; matches cross-chain reshield / swap-and-deposit); defaults to `recipientAddress` for same-chain swaps. |
| `dustRecipient` | `Address?` | Source-chain address to receive dust left on processor. Defaults to `recipientAddress` same-chain, and to the relayer address cross-chain (`recipientAddress` is a destination-chain address, invalid as a source-chain dust target). |
| `extraGas` | `boolean?` | Opt-in ETH gas top-up for the recipient. Defaults to `false`. The relayer — not the caller — computes the amount (exactly `extraGasFundAmount` × gas price, unclamped) and folds its token-denominated cost into `feeAmount`, bounded by the asset's on-chain `maxRelayFee`; the resolved amount lands in the signed routing's `nativeGas`. **Not supported for cross-chain swaps** (throws `InvalidTransactParams`). |
| `slippage` | `number?` | Slippage tolerance (0-1 range). Defaults to 0.5% same-chain / 3% cross-chain. |
| `toChainId` | `number?` | Destination chain ID for cross-chain swaps. Defaults to the relayer's chain (same-chain). When it differs, the routing recipient is `address(0)` and on-chain `minOutputAmount` is `0` — slippage protection is enforced by LiFi's destination executor via the proof-bound calldata. |
| `denyExchanges` | `string[]?` | LiFi tool/exchange names to exclude from routing (e.g. `["fly"]`), forwarded to the configured swap quote provider's `getSwapQuote()`. |

**Returns: `PreparedSwapQuote`**

| Field | Type | Description |
| --- | --- | --- |
| `selectedQuote` | `PrepareSwapRelayerQuotes` | Relayer info + signed fee commitment, ready for `relayWithdrawAndSwap()`. |
| `swapCalldata` | `Hex` | LiFi swap calldata. |
| `minOutputAmount` | `Hex` | On-chain enforced minimum output amount (hex-encoded). `0x0` for cross-chain swaps — the source chain cannot verify destination output. |
| `destinationMinOutputAmount` | `Hex` | Minimum output amount from LiFi (`toAmountMin`, hex-encoded, informational). Cross-chain, this is enforced by LiFi's destination executor via the proof-bound calldata, not by the source-chain contract. |
| `feeAmount` | `string` | Relayer fee in input token units (informational). |
| `estimatedOutput` | `string` | Estimated output amount from LiFi (informational). |
| `swapTarget` | `Address` | Swap target contract (LiFi `transactionTo`), echoed from the validated routing tuple. |
| `approvalAddress` | `Address` | Token approval target (LiFi `approvalAddress`), echoed from the validated routing tuple. |
| `dustRecipient` | `Address` | Effective dust recipient committed in the signed routing (explicit param, or the same-chain/cross-chain default). Pass through to `relayWithdrawAndSwap` — omitting it there makes relay-time validation fall back to the default, which diverges from the signed routing when an explicit dust recipient was used at prepare time. |
| `toChainId` | `number` | Destination chain ID this quote was prepared for (equals the relayer's chain for same-chain swaps). Pass through to `relayWithdrawAndSwap` — omitting it there treats a cross-chain quote as same-chain and validation fails against the zero-recipient routing. |

**Throws:** `InvalidTransactParams` when `swapQuoteProvider` is not configured, cross-chain params are inconsistent (incl. an empty-address-sentinel `fallbackAddress`), or the signed routing diverges; `RelayFeeExceedsMax` when the relayer fee exceeds a nonzero Entrypoint `maxRelayFee`; `SwapQuoteMismatch` when the LiFi quote routes different tokens/chains than requested; `UnexpectedTransactionTarget` when the quote targets, approves or calls a swap executor.

**Usage:**
```typescript
const prepared = await session.prepareSwapQuote({
    relayerInfo,
    amount: `0x${withdrawAmount.toString(16)}`,
    tokenId: USDC,
    outputToken: USDT,
    recipientAddress: account.address,
});

const txReceipt = await session.relayWithdrawAndSwap({
    inputCommitments: [note.commitment],
    amount: `0x${(withdrawAmount - BigInt(prepared.feeAmount)).toString(16)}`,
    tokenId: USDC,
    recipientAddress: account.address,
    outputToken: USDT,
    minOutputAmount: prepared.minOutputAmount,
    swapCalldata: prepared.swapCalldata,
    selectedQuote: prepared.selectedQuote,
});
```

---

**`relayWithdrawAndSwap(params) → Promise<TxReceipt>`**

Submits a prepared withdraw-and-swap to a relayer for on-chain execution. A withdraw-and-swap moves value out of the pool to the `RelaySwaps` processor, which executes a DEX swap (via LiFi calldata) and sends the output tokens to the recipient. The caller provides LiFi swap calldata externally; this method handles proof generation, commitment validation, relayer submission, and receipt polling.

Swap calldata is proof-bound directly: the full `bytes swapCalldata` is embedded in the `SwapRouting` struct, which is ABI-encoded into `transactParams.data` and bound into the ZK proof context. There is no separate on-chain hash check — the calldata is committed by the proof itself, so the relayer cannot tamper with swap routing, slippage, or recipient. The SDK additionally byte-compares the relayer-embedded `swapCalldata` against the caller's calldata before proving.

Before building the proof, the method first asserts the selected quote's `feeCommitment.asset` matches the withdrawn `tokenId` (`InvalidTransactParams` otherwise — mirrors the plain-withdraw asset rule, so a quote obtained for a different asset cannot be bound into the proof) and that its fee commitment has not expired — failing fast before the ~30-60 s `prepareTransact` rather than after an on-chain revert. It then decodes the relayer-signed routing **once** (shared `decodeRelaySwapRouting()` util) and re-validates it offline — defense-in-depth, since these params may be hand-built rather than coming from `prepareSwapQuote()` (which already validated them): (1) the routing-embedded `swapCalldata` must byte-equal the caller's `swapCalldata`; (2) the relayer-quoted `amountSent` must equal `amount + feeAmount`, preventing the relayer from inflating the pool outflow beyond what the caller intended; (3) a consolidated field-by-field routing assert — `recipient` (caller's `recipientAddress`, or the `address(0)` sentinel cross-chain), `fallbackAddress` (defaults to `recipientAddress`), `outputToken`, `dustRecipient` (defaults to `recipientAddress` same-chain / the relayer address cross-chain), tuple `feeAmount` vs the quote's `feeAmount`, `minOutputAmount`, a non-zero `feeRecipient` when `feeAmount > 0` (mirrors the on-chain `RelaySwaps_ZeroFeeRecipient` revert that would otherwise burn the fee), and `nativeGas` against the `extraGas` echo flag — flag off/omitted → must be `0` (always the case cross-chain, where `extraGas` is forbidden), flag on → must be nonzero. The top-up amount itself is relayer-computed; its fairness is bounded by the fee checks, since its cost is folded into `feeAmount` (capped by `maxRelayFee`); (4) swap-executor screening (`assertNoSwapExecutor`, see `prepareSwapQuote`) on the routing's `swapTarget` / `approvalAddress` / `swapCalldata`.

**Cross-chain** (`toChainId` differs from the relayer's chain): `fallbackAddress` is required and the caller's `minOutputAmount` must be `0x0` (the source chain cannot verify destination output — slippage protection lives in the proof-bound LiFi calldata, enforced by LiFi's destination executor). The assertions change accordingly: the routing `recipient` must be the `address(0)` sentinel (the real recipient is bound only via the proof-bound LiFi calldata), and the routing `nativeGas` must be `0`. These mirror the on-chain guards (`RelaySwaps_NativeGasWithoutRecipient`, `RelaySwaps_MinOutputWithoutRecipient`) and the relayer's quote/relay-time validation.

Delegates to `PoolSessionWithdrawAndSwap`, which uses `TransactOrchestrator.prepareTransact` to build the ZK proof (with `RELAY_SWAP_ROUTING_ABI` for ABI-encoding `SwapRouting` including the full `swapCalldata`), validates that the committed `swapCalldata` byte-equals the caller's calldata, then submits via `RelayerInteractor.relaySwap`. On a successful receipt, persists note updates (inputs -> SPENT, change note added).

**Params: `ExecuteWithdrawAndSwapRelayerParams`**

| Field | Type | Description |
| --- | --- | --- |
| `inputCommitments` | `Hash[]` | Commitment hashes of the input notes to spend. |
| `amount` | `Hex` | Amount to withdraw (in input token units, hex-encoded). |
| `tokenId` | `Address` | Token identifier for the withdrawn asset. |
| `recipientAddress` | `Address` | Recipient address for the swap output (destination-chain address for cross-chain swaps). |
| `outputToken` | `Address` | The desired output token address. |
| `minOutputAmount` | `Hex` | Minimum acceptable output amount (hex-encoded). Must be `0x0` for cross-chain swaps. |
| `fallbackAddress` | `Address?` | Destination-chain address that receives the bridged token if the destination swap fails. Required for cross-chain swaps; defaults to `recipientAddress` when not specified. Passed to LiFi as `toFallbackAddress` and encoded into the `SwapRouting` ABI tuple (never read on-chain — proof-binding + SDK assertion only). |
| `swapCalldata` | `Hex` | LiFi swap calldata (hex-encoded), provided by the caller. |
| `selectedQuote` | `PrepareSwapRelayerQuotes` | The selected relayer and its fee quote for the swap. |
| `toChainId` | `number?` | Destination chain ID for cross-chain swaps. Defaults to the relayer's chain (same-chain). |
| `dustRecipient` | `Address?` | Expected dust recipient in the signed routing. Defaults to `recipientAddress` (same-chain) or the relayer address (cross-chain), mirroring `prepareSwapQuote`. |
| `extraGas` | `boolean?` | Echo of the `extraGas` flag passed to `prepareSwapQuote`. Defaults to `false`. The signed routing's `nativeGas` is always validated against it: flag off/omitted → must be `0`; flag on → must be nonzero (the amount itself is relayer-computed and its cost is folded into `feeAmount`, bounded by the fee checks). Forbidden for cross-chain swaps. |

**Returns:** `TxReceipt` — The on-chain transaction receipt.

**Throws:** `InvalidTransactParams` when `feeCommitment.asset` does not match the withdrawn `tokenId`, the fee commitment is expired, or commitment validation fails (calldata-hash mismatch, amountSent mismatch, or any decoded routing-field mismatch — recipient, fallbackAddress, outputToken, dustRecipient, feeAmount, minOutputAmount, nativeGas, or a zero `feeRecipient` with `feeAmount > 0`), or — cross-chain — when `fallbackAddress` is missing, `minOutputAmount` is nonzero, or the routing `nativeGas` is nonzero. `UnexpectedTransactionTarget` when the signed routing targets, approves or calls a swap executor. `KeystoreNotRegistered` (a `PoolSessionKeystoreBaseError`) when the session owner has no on-chain keystore registration, or `RegistrationCheckFailed` when that read fails — see [Keystore-registration precheck](#keystore-registration-precheck).

---

**`estimateReshieldAmount(params) → Promise<ReshieldEstimate>`**

Estimates the deposit amount for a reshield by querying relayer fees and a DEX swap quote. Returns `noteValue` and `totalDepositCost` needed to call `prepareDeposit()` before `prepareReshieldQuote()`.

The reshield flow has a chicken-and-egg problem: LiFi's `getContractCallsQuote` needs deposit calldata, but deposit proof needs `noteValue` which depends on swap output. This method solves step 1 — estimating the output so the deposit proof can be generated with a tight value.

The vetting fee is always read on-chain via `getAssetConfig(outputToken)` — the only value `Entrypoint.deposit` accepts — so callers no longer supply `vettingFeeBPS`. RPC-backed pre-flight checks run before quoting: the output token must be enabled on the Entrypoint (`AssetNotSupported`), the relayer fee must respect the input asset's `maxRelayFee` when set (`RelayFeeExceedsMax`) and be below the withdrawal amount (`InvalidTransactParams`), and the LiFi quote's echoed route is cross-checked against the request (`SwapQuoteMismatch`).

Works backwards from `toAmountMin` (with a 1% safety buffer for contractCalls-quote divergence — same-chain only; the cross-chain estimate uses 2% plus a route-guarantee probe, see `estimateReshieldCrosschainAmount` below): `noteValue = safeMinOutput * 10000 / (10000 + vettingFeeBPS)`, then `totalDepositCost = noteValue + vettingFee`. A `noteValue` below the Entrypoint's `minAmount` throws `DepositBelowMinimum`.

Requires `swapQuoteProvider` in `PoolSessionConfig`. Delegates to `PoolSessionReshield`, whose config now requires `entrypointInteractor: IEntrypointInteractor` (threaded by `PoolSessionFactory`) for these pre-flight reads.

**Params: `EstimateReshieldParams`**

| Param | Type | Description |
| --- | --- | --- |
| `relayerInfo` | `RelayerInfo` | The relayer to quote from. |
| `amount` | `Hex` | Withdrawal amount in input token units. |
| `tokenId` | `Address` | Input token address. |
| `outputToken` | `Address` | Desired output token address (deposit token). |
| `dustRecipient` | `Address?` | Address to receive dust left on processor. Defaults to relayer address. |
| `slippage` | `number?` | Slippage tolerance (0-1 range). Defaults to 0.5% same-chain / 3% cross-chain. |

**Returns: `ReshieldEstimate`**

| Field | Type | Description |
| --- | --- | --- |
| `feeAmount` | `string` | Relayer fee in input token units. |
| `netSwapAmount` | `string` | Net amount after fee, used for LiFi swap. |
| `estimatedOutput` | `string` | LiFi estimated output (informational). |
| `estimatedMinOutput` | `string` | LiFi minimum output accounting for slippage. |
| `noteValue` | `Hex` | Recommended deposit note value (hex-encoded). |
| `vettingFee` | `string` | Vetting fee for the deposit (informational). |
| `totalDepositCost` | `string` | Total deposit cost: noteValue + vettingFee. |

**Throws:** `InvalidTransactParams` when `swapQuoteProvider` is not configured or the fee exceeds the amount; `AssetNotSupported` when the output token is not enabled on the Entrypoint; `RelayFeeExceedsMax` when the relayer fee exceeds a nonzero `maxRelayFee`; `DepositBelowMinimum` when the computed note value is below the Entrypoint minimum; `SwapQuoteMismatch` when the LiFi quote routes different tokens/chains than requested.

---

**`prepareReshieldQuote(params) → Promise<PreparedReshieldQuote>`**

Prepares the full reshield quote after the caller has generated a deposit proof. Fetches a LiFi `getContractCallsQuote` (swap + deposit atomically) and commits with the relayer.

Requires `swapAndDepositQuoteProvider` in `PoolSessionConfig`. Delegates to `PoolSessionReshield`.

Explicitly awaits `warmMerkleCaches()` before step 5's committed quote — see "Cross-Chain Reshield" above for why.

**Internal flow:**
1. Pre-flight, before any network call: `depositResult.to` must equal the session Entrypoint (`entrypointInteractor.getAddress()`), or the configured router when `outputToken` is a yield share → `DepositTargetMismatch` — the deposit target is proof-bound via the LiFi calldata and unrecoverable if wrong
2. Pre-flight, RPC-backed: output token enabled (`AssetNotSupported`); `depositResult.pendingNote.tokenId === outputToken`; note value ≥ Entrypoint minimum (`DepositBelowMinimum`); `totalDepositCost === noteValue + on-chain vetting fee` — stale-estimate guard (`InvalidTransactParams`)
3. LiFi `getSwapAndDepositQuote()` — embeds deposit calldata in swap transaction; echoed route cross-checked against the request (`SwapQuoteMismatch`); deposit-embedding check, then swap-executor screening (`assertNoSwapExecutor`, see `prepareSwapQuote`) → `UnexpectedTransactionTarget` — the embedding check proves nothing once an executor is the target or spender
   - **Executor-routed quotes (2026-10-06, ppv2 DEV-507).** For a swap-then-deposit LiFi routes through its own `Executor.swapAndExecute`, which `assertNoSwapExecutor` refuses, so with screening in place every mainnet same-chain reshield was refused. When the session is built with `swapExecutor` (+ `nativeAssetAddress`; the EVM factory passes `LIFI_SWAP_EXECUTORS[chainId]`), such a quote is thrown away whole and the call composed by the session, as in swap-and-deposit (§Swap-executor screening there): an ordinary exact-out `getSwapQuote` of the swap input into the token the deposit needs, paid to the Executor, then the deposit call handed exactly what it consumes (the native coin as its value, an ERC-20 as an Executor approval), leftovers to RelaySwaps (whose delta sweep forwards them to `dustRecipient`). `swapTarget` = the Executor and `approvalAddress` = its ERC20Proxy, both on `RelaySwaps.approvedRouters`; RelaySwaps scopes the proxy approval to the swap amount and resets it to 0. The composition is decoded and pinned at prepare (exact deposit target and calldata) and again in `relayReshield` (receiver RelaySwaps, input/output tokens, deposit target = the session's Entrypoint or the output share's router, executor-free allowlisted swap leg); any other executor transaction is still refused. Without `swapExecutor` nothing changes. Mainnet fork against the live Executor: 50 USDC pulled through the proxy, swapped to USDT, the deposit target pulled exactly the 30 USDT call amount, 19.997 USDT returned to the caller, Executor balances and the proxy allowance unchanged.
4. Relayer preliminary quote — fee bounds check (`RelayFeeExceedsMax` / fee-consumes-amount guard) and `lifiQuote.fromAmount ≤ amount - fee` budget check
5. Relayer committed quote (`commit: true`, with `swapCalldata: transactionData`, `swapTarget`, `approvalAddress`) → signed commitment
6. Fee bounds re-check on the committed quote, then assert the committed `feeCommitment.amountSent` equals the requested gross withdrawal `amount` — `InvalidTransactParams` otherwise, so the relayer cannot silently alter the gross pool outflow in the commitment (defense-in-depth; the relay path re-checks `amountSent == amount + fee` on the net amount)
7. Decode the signed routing (`decodeRelaySwapRouting`) and validate it: embedded `swapCalldata` byte-equality, zero-`recipient` sentinel, `minOutputAmount == 0`, `nativeGas == 0`, `outputToken`, `dustRecipient`, `feeAmount`, `swapTarget === lifiQuote.transactionTo`, `approvalAddress === lifiQuote.approvalAddress`
8. Assemble and return

**Params: `PrepareReshieldQuoteParams`**

| Param | Type | Description |
| --- | --- | --- |
| `relayerInfo` | `RelayerInfo` | The relayer to quote from. |
| `amount` | `Hex` | Withdrawal amount in input token units. |
| `tokenId` | `Address` | Input token address. |
| `outputToken` | `Address` | Desired output token address (deposit token). |
| `depositResult` | `PrepareDepositResult` | Result of `session.prepareDeposit()` for the output token. |
| `totalDepositCost` | `string` | Total deposit cost from `ReshieldEstimate.totalDepositCost`. |
| `dustRecipient` | `Address?` | Address to receive dust left on processor. Defaults to relayer address. |
| `slippage` | `number?` | Slippage tolerance (0-1 range). Defaults to 0.5% same-chain / 3% cross-chain. |

**Returns: `PreparedReshieldQuote`**

| Field | Type | Description |
| --- | --- | --- |
| `selectedQuote` | `PrepareSwapRelayerQuotes` | Relayer info + signed fee commitment, ready for `relayReshield()`. |
| `swapCalldata` | `Hex` | LiFi swap+deposit calldata. |
| `feeAmount` | `string` | Relayer fee in input token units. |
| `swapTarget` | `Address` | Swap target contract (LiFi `transactionTo`), echoed from the validated routing tuple. |
| `approvalAddress` | `Address` | Token approval target (LiFi `approvalAddress`), echoed from the validated routing tuple. |
| `dustRecipient` | `Address` | Effective dust recipient committed in the signed routing (explicit param, or the relayer-address default). Pass through to `relayReshield` — omitting it makes relay-time validation fall back to the relayer default, which diverges from the signed routing when an explicit dust recipient was used at prepare time. |

**Throws:** `InvalidTransactParams` when `swapAndDepositQuoteProvider` is not configured, params are inconsistent (tokenId/totalDepositCost/budget), or the signed routing diverges; `DepositTargetMismatch` when `depositResult.to` is not the session Entrypoint; `AssetNotSupported` when the output token is not enabled; `DepositBelowMinimum` when the note value is below the Entrypoint minimum; `RelayFeeExceedsMax` when the relayer fee exceeds a nonzero `maxRelayFee`; `SwapQuoteMismatch` when the LiFi quote routes different tokens/chains than requested; `UnexpectedTransactionTarget` when the quote targets, approves or calls a swap executor.

**Full reshield usage (3 steps):**
```typescript
// Step 1: Estimate deposit amount
const estimate = await session.estimateReshieldAmount({
    relayerInfo,
    amount: `0x${withdrawAmount.toString(16)}`,
    tokenId: USDC,
    outputToken: USDT,
});

// Step 2: Generate deposit proof
const depositResult = await session.prepareDeposit({
    tokenId: USDT,
    value: estimate.noteValue,
});

// Step 3: Prepare reshield quote
const prepared = await session.prepareReshieldQuote({
    relayerInfo,
    amount: `0x${withdrawAmount.toString(16)}`,
    tokenId: USDC,
    outputToken: USDT,
    depositResult,
    totalDepositCost: estimate.totalDepositCost,
});

// Step 4: Execute
const txReceipt = await session.relayReshield({
    inputCommitments: [note.commitment],
    amount: `0x${(withdrawAmount - BigInt(prepared.feeAmount)).toString(16)}`,
    tokenId: USDC,
    outputToken: USDT,
    swapCalldata: prepared.swapCalldata,
    selectedQuote: prepared.selectedQuote,
});
```

---

**`relayReshield(params) → Promise<TxReceipt>`**

Submits a reshield (withdraw + swap + deposit) to a relayer. Atomically withdraws shielded Token A, swaps to Token B via LiFi, and deposits Token B back into the pool. Funds never leave the privacy system. The deposit is embedded in the LiFi swap calldata via `getContractCallsQuote()` — LiFi executes the swap and then calls `Entrypoint.deposit()` as a post-swap contract call. No separate deposit proof submission is needed.

Swap calldata is proof-bound directly: the full `bytes swapCalldata` is embedded in the `SwapRouting` struct and committed by the ZK proof context, so the relayer cannot tamper with swap routing, deposit proof, or slippage. There is no separate on-chain hash check. The deposit proof embedded in the LiFi calldata IS the slippage protection for reshield — `Entrypoint.deposit()` reverts if the swap output is insufficient to cover the deposit amount plus vetting fee.

Performs offline defense-in-depth validation (this method accepts hand-built params, so it re-checks even what `prepareReshieldQuote` already validated): first asserts the selected quote's `feeCommitment.asset` matches the withdrawn `tokenId` (`InvalidTransactParams` otherwise — mirrors the plain-withdraw asset rule) and that its fee commitment has not expired — failing fast before the ~30-60 s `prepareTransact` rather than after an on-chain revert — then decodes the relayer-signed routing **once** via the shared `decodeRelaySwapRouting()` util, validates the embedded `swapCalldata` byte-equals the caller's calldata and `amountSent === amount + feeAmount`, then asserts the reshield routing invariants — zero-`recipient` sentinel, `minOutputAmount == 0`, `nativeGas == 0`, `outputToken` match, `dustRecipient` match (defaults to the relayer address), tuple `feeAmount === quote.feeAmount`, a non-zero `feeRecipient` when `feeAmount > 0` (mirrors the on-chain `RelaySwaps_ZeroFeeRecipient` revert that would otherwise burn the fee), and — when the caller passes the optional `swapTarget` / `approvalAddress` expecteds (echoed on `PreparedReshieldQuote`) — that the routing's swap target and approval address match; and runs swap-executor screening (`assertNoSwapExecutor`) on the routing's `swapTarget` / `approvalAddress` / `swapCalldata`. Only then generates the withdrawal proof (via `TransactOrchestrator`) using `RELAY_SWAP_ROUTING_ABI` and submits to the relayer via `RelayerInteractor.relaySwap` (same endpoint as withdraw-and-swap).

The reshield quote requests send `recipient: EMPTY_ADDRESS` (the zero address) — the contract's "no source-chain recipient" mode — since the output re-deposits into the pool via LiFi `contractCalls` rather than going to an external recipient. In this mode the routing `nativeGas` and `minOutputAmount` must both be `0` (enforced on-chain via `RelaySwaps_NativeGasWithoutRecipient` / `RelaySwaps_MinOutputWithoutRecipient`, plus relayer quote/relay-time validation). `dustRecipient` defaults to the relayer address.

**Params: `ReshieldParams`**

| Param | Type | Description |
| --- | --- | --- |
| `inputCommitments` | `Hash[]` | Commitment hashes of the input notes to spend. |
| `amount` | `Hex` | Amount to withdraw (in input token units, hex-encoded). |
| `tokenId` | `Address` | Token identifier for the withdrawn asset. |
| `outputToken` | `Address` | The desired output token address (to deposit back into pool). |
| `swapCalldata` | `Hex` | LiFi swap calldata (hex-encoded) with embedded deposit via `getContractCallsQuote()`, provided by the caller. |
| `selectedQuote` | `PrepareSwapRelayerQuotes` | The selected relayer and its fee quote. |
| `dustRecipient` | `Address?` | Expected dust recipient in the signed routing. Defaults to the relayer address. |
| `onBroadcast` | `((txHash: Hex) => void)?` | Fired once with the relayed tx hash as soon as the relayer accepts it, before the receipt wait. Local only, never sent to the relayer; a throwing or rejecting callback is logged and swallowed, never fails the relay. Same field on `ReshieldCrosschainParams`. |

**Returns:** `TxReceipt` — The on-chain transaction receipt.

**Throws:**
- `KeystoreNotRegistered` (a `PoolSessionKeystoreBaseError`; the session owner has no on-chain keystore registration — checked before any merkle leaves are fetched, see [Keystore-registration precheck](#keystore-registration-precheck)), or `RegistrationCheckFailed` when the registration read itself fails.
- `InvalidTransactParams` when `feeCommitment.asset` does not match the withdrawn `tokenId`, the fee commitment is expired, or commitment validation fails (amountSent mismatch, swapCalldata mismatch, or any decoded routing-field divergence — nonzero recipient/minOutputAmount/nativeGas, outputToken, dustRecipient, feeAmount, a zero `feeRecipient` with `feeAmount > 0`, or — when the optional expecteds are provided — swapTarget/approvalAddress mismatch).
- `UnexpectedTransactionTarget` when the signed routing targets, approves or calls a swap executor.

---

## Cross-Chain Reshield

`PoolSessionReshieldCrosschain` extends the reshield pattern above to a real `toChainId`: withdraw shielded Token A on the session's own chain, bridge + swap via LiFi, and deposit Token B into a **different** chain's pool. It is a separate service/facade methods from `PoolSessionReshield` (`estimateReshieldCrosschainAmount` / `prepareReshieldCrosschainQuote` / `relayReshieldCrosschain`), not a `toChainId` parameter bolted onto the same-chain methods, because it needs a second Entrypoint interactor with its own RPC connection to the destination chain (see `destinationEntrypointInteractor` below) — nothing else in the SDK reads state from a chain other than the session's own.

**Why same-chain reshield can't just take a `toChainId`.** Same-chain reshield's whole correctness guarantee is atomicity: withdraw, swap, and `Entrypoint.deposit()` all happen inside one `RelaySwaps.execute()` transaction. A bridge leg is inherently asynchronous — LiFi's own destination executor completes it later, with no 0xBow contract on the destination chain and no protocol-owned verification of what lands there (see `docs/tech-design/future-ideas/cross-chain-destination-verifier.md`, which already flags this trust gap for cross-chain withdraw-and-swap). Cross-chain reshield accepts the same LiFi-destination-executor trust extension: if the embedded `Entrypoint.deposit()` call reverts on the destination chain (insufficient swap output), LiFi's standard cross-chain failure handling delivers the raw bridged tokens to `fallbackAddress` instead — the same Leg-2 failure taxonomy documented above for cross-chain withdraw-and-swap, just with a deposit call in place of a plain transfer.

**`estimateReshieldCrosschainAmount(params) → Promise<ReshieldCrosschainEstimate>`**

Same shape as `estimateReshieldAmount`, but reads the output asset's config (`enabled`, `minAmount`, `vettingFeeBPS`) from the **destination** chain's Entrypoint, not the session's own. Requires `toChainId` **and** `toChainType` to match the session's configured `destinationChainId`/`destinationChainType` (`DestinationChainNotSupported` otherwise) and a `fallbackAddress` (required, no same-chain default — mirrors cross-chain withdraw-and-swap). The chain-type check (2026-10-02) exists because a bare numeric chain ID is ambiguous once more than one chain type exists — an EVM chain and a chain of another type can share a numeric ID; see [withdraw-and-swap.md](withdraw-and-swap.md) §Cross-Chain Reshield for the full rationale. `createEvmPoolSession` defaults `destinationChainType` to `"evm"`.

**Destination capability gate (2026-10-14).** Right after the destination-chain match check and before any quote, `estimateReshieldCrosschainAmount` and `prepareReshieldCrosschainQuote` call `assertDestinationAcceptsCalls(relayerInfo)`: a cross-chain reshield always ends in a destination contract call (Entrypoint or yield-router deposit), which a bridge can only run where LI.FI's receiver contracts (`ReceiverAcrossV3` / `ReceiverStargateV2`) exist — elsewhere the bridged funds just land at `fallbackAddress`. The value is the destination chain's `RelayerChainDetails.destinationCallsSupported` (see [relayer-interactor.md](../evm-sdk/relayer-interactor.md) §RelayerChainDetails): taken from a seeded `relayerChainDetails` entry whose `id`/`type` equal the destination chain (no fetch), else from the **same** relayer's `GET /v1/details/{destinationChainType}/{destinationChainId}`, cached per relayer URL with the caps cache's 5-minute TTL (`RELAYER_CAPS_TTL_MS`; failures not cached). Only an explicit `false` throws `DestinationCallsUnsupported(toChainId, toChainType)`; an absent field (older relayer) or unreadable details (e.g. that relayer does not serve the destination chain) are allowed with a logger warning. Production relayer config (verified on-chain 2026-10-14): `true` on Mainnet, BSC, Optimism, Base, Arbitrum; `false` on Citrea (no LI.FI diamond) and Robinhood (diamond registers no receivers). `relayReshieldCrosschain` does not re-check (its quote already passed the gate).

**Sizing (actual behaviour, 2026-09-24).** The plain `swapQuoteProvider.getSwapQuote()` estimate's `toAmountMin` is capped at the net input for a same-asset bridge (`capBridgeOutputToInput`), reduced by a flat 3% B2 reserve when the destination is Ethereum mainnet (`B2_ESTIMATE_MAINNET_RESERVE_BPS`), and then taken at **98%** — not the same-chain estimator's 99% — because the contractCalls route LiFi actually builds (bridge + destination DEX) diverges ~1% from the single-hop plain quote. Then, when a `swapAndDepositQuoteProvider` is configured, the estimate **probes the real contractCalls route**: it calls `getSwapAndDepositQuote()` with placeholder destination calldata (`ESTIMATE_PROBE_CALLDATA` — LiFi does not simulate the destination call, it only needs some calldata to build the route) mirroring `prepareReshieldCrosschainQuote`'s request shape (`fromAmount` mode with `netFromAmount` for a cross-asset swap, `toAmount` mode otherwise, same `depositGasLimit` — the flat `CROSS_CHAIN_DESTINATION_GAS_LIMIT` (see **Destination gas** below), router or Entrypoint as `poolAddress`), and reads the destination call budget LiFi encoded (`decodeLiFiDestinationCallAmount`, falling back to the quote's `destinationCallAmount`). LiFi encodes the route's guaranteed delivery there, never the amount requested (see [lifi-swap-quote-provider.md](lifi-swap-quote-provider.md) §`getSwapAndDepositQuote`), so a deposit costing more than it fails on arrival. When `guarantee × (1 − DESTINATION_GUARANTEE_MARGIN_BPS = 100 bps)` is lower than the plain-quote sizing, the estimate sizes down to it (the margin absorbs the few-tenths-of-a-percent drift between two LiFi quotes). Without a `swapAndDepositQuoteProvider` the probe is skipped and the plain-quote sizing stands. `noteValue`/`totalDepositCost` then follow the same formula as the same-chain estimator (shares via `sizeSharesForBudget` for a yield output). `prepare` remains authoritative and re-checks the budget against the real quote.

**Destination gas (2026-10-13).** Every cross-chain destination deposit call gets one flat LiFi `toContractGasLimit` (`depositGasLimit`) of **2,000,000** (`CROSS_CHAIN_DESTINATION_GAS_LIMIT`, `utils/CrossChainDestinationGas.ts`) — the estimate probe and the prepare quote alike, whether the target is the Entrypoint or a yield router and with or without a destination swap; cross-chain swap-and-deposit uses the same constant. It is not estimated: the call is proof-bound, and an `eth_estimateGas` of the real calldata would hand the deposit proof to the destination RPC before the bridge lands it. The previous flat 800,000 ran out of gas in production on Ethereum → BNB Chain reshields (a yield router `depositExactShares` needs ~1.1M; the Entrypoint deposit alone took ~545k), and a cross-chain swap-deposit used up to 1.5M; 2M leaves ~33% over the heaviest seen. Same-chain reshield keeps its own 800,000 (`DEPOSIT_CALL_GAS_LIMIT`). Caveat: only bridges that carry the budget (StargateV2 / LayerZero executor options) give the call exactly that gas. On Across the filler picks the fill's gas limit and LiFi's `ReceiverAcrossV3` forwards whatever is left inside a try/catch that recovers funds to `fallbackAddress`, so there the figure only prices the route — an Across fill into a yield share can still fall back. Cost: on a Mainnet destination the LayerZero native fee scales with this budget (B2 funds it with 1.2x headroom), so the relayer's `max_swap_value_wei` trips sooner during gas spikes.

**`prepareReshieldCrosschainQuote(params) → Promise<PreparedReshieldCrosschainQuote>`**

Same shape as `prepareReshieldQuote`, except `depositResult` must come from a **destination-chain-scoped** `PoolSession` (i.e. a session built for `toChainId`, not the source session) — `prepareReshieldCrosschainQuote` validates `depositResult.to` against the destination Entrypoint (`DestinationDepositTargetMismatch` on mismatch), not the source one. When `outputToken` is a yield share, `depositResult` is instead `prepareYieldSwapDeposit(target, BigInt(estimate.totalDepositCost))` for the destination session's matching target (`destinationYieldDepositTargets`, `withDestinationYieldDepositTargets()`), `depositResult.to` must be that router, and `assertYieldDepositMatches` re-checks calldata, cap and native value; shares are sized with `CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM` — see [yield-sessions.md](yield-sessions.md) §Landing as a share. Swap-executor screening (`assertNoSwapExecutor`, see `prepareSwapQuote`) runs on the contractCalls quote after the deposit-embedding check, and on the B2 gas-swap quote (`UnexpectedTransactionTarget`).

**Native destination deposits are refused (2026-09-24).** A plain native-coin deposit (`depositResult.to` is the destination Entrypoint and the deposit asset is the chain's native asset) throws `NativeDestinationDepositUnsupported(outputToken, totalDepositCost)` before any network call. LiFi's Executor sends the route's guaranteed delivery as `msg.value`, while `Entrypoint.deposit{value}` requires `msg.value == noteValue + vettingFee` exactly; the two never coincide, so the call fails on arrival and the bridged coin lands at `fallbackAddress` (three production losses on BSC, 2026-09-22/23; reproduced on a fork 2026-09-24). Land as an ERC-20 or a yield share instead. The native-mode yield router (`depositExactSharesNative`) is exempt: `msg.value` is a cap there and the surplus is refunded, so the affordability gate below suffices.

**Destination affordability gate — every route (2026-09-24).** After the contractCalls quote, the SDK reads the destination call budget LiFi encoded: `destBudget = swapChainAdapter.getDestinationCallAmount(transactionData, depositResult.callData) ?? lifiQuote.destinationCallAmount ?? swapChainAdapter.getDestinationDeliveryBudget(transactionData)` (EVM: `decodeLiFiDestinationCallAmount` / Stargate `minAmountLD`). If `totalDepositCost > destBudget` it throws `DestinationDepositUnaffordable(totalDepositCost, destBudget, affordableNoteValue)` **before** requesting the committed relayer quote. Previously this gate ran only on the Stargate/B2 (Ethereum-mainnet-destination) path, reading Stargate's `minAmountLD`; LiFi encodes the route guarantee as the call budget on Across too (measured 2026-09-24 on Optimism, Base, Arbitrum and BSC), so it now applies on every route. `affordableNoteValue` is sized from `destBudget × (1 − 100 bps)` (the same `DESTINATION_GUARANTEE_MARGIN_BPS` refit margin the estimate uses; via `sizeSharesForBudget` with `CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM` for a yield output, else `refitBudget × 10000 / (10000 + vettingFeeBPS)`), so the caller's rebuilt deposit + re-prepare (a fresh quote, a fresh guarantee) does not trip the check again.

**B2 `swapValue` relayer cap (2026-10-08).** For an Ethereum-mainnet destination, the B2 gas-swap sizing (shared by `estimateReshieldCrosschainAmount` and `prepareReshieldCrosschainQuote`) computes `swapValue = transactionValue × 1.2` and then looks up the relayer's published caps (`relayerCapsFromDetails`). The session keeps a per-relayer caps cache keyed by `chainId` + relayer signer address (lowercased) with a 5-minute TTL (`RELAYER_CAPS_TTL_MS`): within the TTL no `/v1/details` request is made (so an estimate → prepare round trip fetches at most once); after it, `relayerInteractor.getChainDetails(relayerInfo)` is called again, so an operator raising `max_swap_value_wei` is picked up within minutes rather than only on session rebuild. The cache can be seeded through the optional `PoolSessionReshieldCrosschainConfig.relayerChainDetails?: RelayerChainDetails[]` (EVM: `EvmPoolSessionConfig.relayerChainDetails`, filled by `PoolSessionBuilder.withRelayerDetails`), matched to a `RelayerInfo` by `chainId` + `relayerAddress`; seeded entries also expire one TTL after session construction. If `swapValue > maxSwapValueWei` it throws `SwapValueExceedsRelayerCap(swapValue, maxSwapValueWei)` — before the gas-swap LiFi quote and before proving — instead of letting the relayer 400 the quote. Both values are in the **source chain's** native wei (the relayer's `max_swap_value_wei` applies per chain in that chain's native unit, e.g. BNB on BSC). If the details call fails or the relayer does not publish the cap, the SDK logs a warning and skips the check; the relayer still enforces it. Failed fetches are not cached — the next B2 sizing retries. See [withdraw-and-swap.md](withdraw-and-swap.md) §Cross-Chain Reshield.

**Native input: fund the bridge's fee from the budget (2026-10-09).** For a native-coin input, `RelaySwaps`' native branch already forwards `netSwapAmount` as `msg.value`; only a native bridge fee stacked on top of that (StargateV2's LayerZero fee — the quote's `transactionValue` is `fromAmount + fee`) is unfundable, and used to be refused outright. `prepareReshieldCrosschainQuote` now re-quotes once with `fromAmount` reduced (`netFromAmount = netSwapAmount − 1.02× fee − 2 bps` of the budget) so `fromAmount + fee` fits the forwarded `msg.value`, re-validates it, and re-checks; if it still doesn't fit — or the fee would consume the whole amount — the refusal (`InvalidTransactParams`, "This route needs … wei of native msg.value") stands. The destination-affordability gate above still applies to the smaller bridged amount, refusing with a refit note value exactly as after an ERC-20 B2 re-quote. `estimateReshieldCrosschainAmount` sizes the note off the same reduced probe. The dust check (`assertLifiBudget`) now compares against `transactionValue`, not `fromAmount` alone, for a native route — the fee is consumed by the route, not dust swept to `dustRecipient` — else a real ~18% fee would have falsely tripped the 300 bps dust cap. ERC-20 input is unchanged (still funded via B2, above). See [withdraw-and-swap.md](withdraw-and-swap.md) §Cross-Chain Reshield for the full rationale and the production incident.

Before requesting the relayer's **committed** quote (the step that sets `feeCommitment.expiration` and starts its short-lived, ~60 s-by-default clock), this method calls `await this.core.warmMerkleCaches()` (`ITransactOrchestrator.warmMerkleCaches()`, see [core-sdk-tech-design.md](core-sdk-tech-design.md) and [contract-interactor.md](contract-interactor.md)). This guarantees both the keystore leaf scan and the state-tree leaf scan — either of which can be a slow, uncached, full `deploymentBlock`→head `getLogs` scan on its very first run — are already finished (or, if `PoolSessionBuilder`'s background warm-ups are still in flight, waited on, in parallel) before the commitment clock starts, instead of racing them later inside `prepareTransact()`'s Merkle-proof step. This was root-caused from a mainnet integration failure where that race produced `FeeCommitmentExpired` errors.

This explicit `warmMerkleCaches()` await has since been rolled out to five more flows: `PoolSessionReshield.prepareReshieldQuote()` (same-chain reshield), `PoolSessionWithdrawAndSwap.prepareSwapQuote()`, `PoolSessionWithdraw.prepareWithdraw()`, `PoolSessionTransfer.prepareTransfer()` / `prepareColdStartTransfer()`, and `PoolSessionBatchWithdraw.prepareBatchWithdraw()` (the last via a new `IBatchWithdrawOrchestrator.warmMerkleCaches()` passthrough that delegates to `ITransactOrchestrator.warmMerkleCaches()` — see [batch-withdraw.md](batch-withdraw.md)). Each now awaits it immediately before its own committed-quote request, mirroring cross-chain reshield.

Both caches are still per-process — a fresh test run or dApp session pays the full first scan again. `PoolSessionBuilder`'s config (`PoolSessionBuilderBaseConfig`, shared by `PoolSessionBuilderConfig` and `PoolSessionSimpleConfig`) accepts two optional fields, `keystoreLeafCacheSeed` / `stateLeafCacheSeed` (`LeafCacheSeed`, see [contract-interactor.md](contract-interactor.md)), that pre-populate the `KeystoreInteractor`/`PoolVaultInteractor` caches at construction time — so even the background warm-up starts as a delta-fetch instead of a full `deploymentBlock` scan. Ignored when a `KeystoreInteractor`/`PoolVaultInteractor` override is supplied via `.withKeystoreInteractor()`/`.withVaultInteractor()`, since the override already owns its own cache state. The corresponding snapshot is read back out via `PoolSession.exportKeystoreLeafCache()` / `exportStateLeafCache()` (see below) — the SDK itself never persists it.

**Known gap:** `PoolSessionYieldWithdraw` remains unaddressed — unlike the other flows, it has no internal method that requests a committed relayer quote; the signed fee commitment is obtained by the caller outside the SDK and passed in as `params.signedFeeCommitment` to `prepareYieldWithdrawRelay()`, so there is no internal call site to hook an explicit await into. It still benefits only from the background warm-ups `PoolSessionBuilder` fires at session-construction time, so the same class of race remains possible there, just less likely in practice since the caches will usually have had more time to populate. Closing this gap would require a new public method — a separate design decision, not a mechanical rollout.

Optionally accepts `dustRescue: { recipientIdentifier }` — see "Stealth Dust Rescue" below. When present, `dustRecipient` (if explicitly passed) must equal the relayer's own address (`DustRescueRecipientConflict` otherwise) — the relayer must hold the swept leftover itself to later act on it.

**`relayReshieldCrosschain(params) → Promise<TxReceipt>`**

Same validation and submission shape as `relayReshield`, targeting the destination chain's Entrypoint via the LiFi-embedded deposit call. Swap-executor screening runs on the decoded routing as there, and the routing's B2 `gasSwapCalldata` must not call an executor entry point either (`UnexpectedTransactionTarget`). `dustRescue` is not forwarded separately here — it was already encoded into `SwapRouting.dustRescue` by `prepareReshieldCrosschainQuote()`'s committed quote request, and travels to the relayer inside the signed commitment `relaySwap` already submits. See below.

**Throws:** as `relayReshield`, including `KeystoreNotRegistered` / `RegistrationCheckFailed`.

### Stealth Dust Rescue

For large cross-chain reshields, the value left over after the destination-chain deposit ("dust") can be large enough that forfeiting it to the relayer's ordinary `dustRecipient` sweep is wasteful — worth its own extra deposit instead. `dustRescue` opts into that: the swept leftover is rescued into a new shielded note owned by a fresh ERC-5564 stealth address derived from the caller's `recipientIdentifier`, rather than kept by the relayer.

**The client cannot pre-size or pre-authorize this deposit.** If it could know the leftover amount in advance, it would simply size the withdrawal to avoid leaving any — that's the definition of dust. So `dustRescue` carries only a stealth `recipientIdentifier` (a structural mirror of the stealth sub-package's `RecipientIdentifier`, see [stealth.md](../evm-sdk/stealth.md)) — no amount, no proof. **The relayer generates the rescue deposit's witness and proof itself**, after the fact, once it has observed the actual swept amount. This is implemented as a deliberately separate module, `packages/relayer/dust-rescue-prover` (see its package description), because proving is CPU/memory-heavy and — for the first time in this codebase — relayer-initiated rather than client-request-triggered.

**The `dustRescue` *request itself* is proof-bound (as of the RC-10 fix, 2026-09-16).** `destinationChainId`/`tokenId`/`recipientIdentifier` are now encoded into the on-chain `SwapRouting.dustRescue` field the relayer signs at quote time (`RelaySwaps.sol`/`IRelaySwaps.sol`'s nested `DustRescue` struct) — inheriting the same proof-context binding as every other routing field, since `TransactParams.data` is hashed as opaque bytes. A relayer can no longer attach, alter, or drop a caller's `dustRescue` block between quote and relay; `EvmRelayService.relaySwap` reads it straight off the already-executed, already-context-verified routing (`fromRoutingDustRescue`), not a separate unsigned request field. This closes the specific gap the finding this fix addresses (RC-10 / vuln-mining #10) named: *"today the relayer prices and signs one thing, and the caller can attach an arbitrary, unpriced `dustRescue` block afterward with no consequence."*

**Trust extension (accepted, not hidden) — the *later rescue deposit itself* remains discretionary.** Binding the request doesn't bind the relayer's subsequent behavior: nothing on-chain forces the relayer to actually generate and submit the rescue deposit, to derive the stealth address correctly, or to do so promptly — that action happens off-chain, after the fact, with no client-supplied proof or signed commitment constraining it (unlike every other relayer action in this SDK). The mitigation for *that* part is still **detection, not prevention**: the swept leftover lands at a relayer-controlled address that's independently observable on public chain data, so a client who cares can verify after the fact that the rescued amount (once they discover/import the resulting note) matches what was actually swept. This is a materially different guarantee than the rest of this document's threat tables and should not be read as equivalent to them.

**Secret delivery (RESOLVED, 2026-08-10 — "Camouflaged dust-rescue delivery").** The rescue deposit is a real shielded note (`noteAddressHash = Poseidon(stealthAddress, noteSecret)`), not a plain token transfer, so the recipient needs the note payload to ever spend it. The SDK's normal note-discovery channel (`NoteData` ECDH-encrypted under a registered viewing key) cannot be used — a stealth address never registers a viewing key. `NoteDiscoveryService.scanStealthDeposits` closes this gap: a sibling to `scanCatchAll` that scans a Note event's `noteData.data` for a packed stealth payload instead of the standard viewing-key format, and — unlike every other scan path — the discovered note's owner is the *derived stealth address*, not the scanning session's own fixed address (`DiscoveredNote.ownerAddress`, threaded through `discoverNotes()`'s commitment computation).

Delivery reuses the ECDH shared secret the stealth derivation *already* computes as an intermediate value (`h` in `derive-canonical.ts`/`derive-fluidkey.ts`) — exposed via the stealth module's `deriveStealthSharedSecret` (sender) / `recoverStealthSharedSecret` (recipient, via `scanDepositNoteData`'s positive match); ECDH commutativity means both sides derive the identical value. The relayer encodes the full note payload (`noteSecret`/`value`/`tokenId`/`label`) and encrypts it under that shared secret (`CryptoService.encrypt`, the same XChaCha20-Poly1305 primitive that already encrypts ordinary `NoteData` payloads), then packs the ephemeral pubkey, view tag, and ciphertext into a single opaque blob (`encodeStealthDepositPayload`) that becomes the deposit's own `noteData.data` — arbitrary-length, unlike ERC-5564's fixed 1-byte `metadata` field, so no separate announcement channel is needed at all.

The resulting call is a **plain `Entrypoint.deposit(proof, noteData, aspCiphertext)`** — the exact same call shape any third-party `depositFor` caller already uses, no distinct selector or event. This supersedes an earlier design (`RelaySwaps.rescueDust(...)` + a `DustRescued` event) that publicly tagged rescue deposits and shrank their anonymity set, contradicting the feature's anonymity requirement. `packages/relayer/dust-rescue-prover`'s `proveDustRescueDeposit()` returns this call fully assembled (`stealthAddress`/`noteValue`/`depositCallData`/`depositTarget`/`depositMsgValue`/`approvalTx`).

**The note's value is netted, not raw `sweptAmount` (fixed 2026-09-17 — finding #8).** `Entrypoint.deposit` pulls `value + value*vettingFeeBPS/10000` from the sender, but the rescue wallet only ever holds the swept amount itself — sizing the note at the raw swept amount left the wallet short by exactly the vetting fee, deterministically, on every fee-bearing asset. `proveDustRescueDeposit` now inverts the swept amount into the note's actual `value` (`sweptAmount × 10000 / (10000 + vettingFeeBPS)`, read live off the destination Entrypoint), the same formula shape `estimateReshieldCrosschainAmount` above already uses, and rejects the job if the netted value falls below the Entrypoint's `minAmount`. The returned `noteValue` is this netted figure, not `sweptAmount`.

**Submission (RESOLVED, 2026-08-17).** `packages/relayer/relayer`'s `DustRescueOrchestratorService` no longer computes or submits anything itself — it is a thin, request-scoped Pub/Sub publisher. Detection, proving, and on-chain submission now live in a standalone service, `packages/relayer/dust-rescue-service` (see [dust-rescue-service.md](../relayer/dust-rescue-service.md) for the full design: job state machine, LiFi-status-based detection, key custody, deploy). That service is built and unit-tested but not yet deployed to a live GCP project. See `agents/deviations.md` INTL-09 for the full history of this decision.

## Reshield and Transfer

`PoolSessionReshieldTransfer` (same-chain) and `PoolSessionReshieldTransferCrosschain` (cross-chain) extend reshield so the redeposit lands on behalf of a **third-party recipient** instead of the withdrawer — mirroring Internal Transfer's recipient-resolution model. Both are generic, chain-agnostic classes in `packages/core-sdk`, composing the existing `IPoolSessionReshield` / `IPoolSessionReshieldCrosschain` delegate: `estimate*`/`prepare*Quote`/`relay*` are one-line delegations (already fully recipient-agnostic), and only the deposit-building step is new.

**Output: yield share, or (same-chain) a plain pool asset.** A configured yield share resolves to its `YieldSwapDepositTarget`. The same-chain session also takes an optional `depositDelegate`; with it, an `outputToken` that is not a configured share is deposited as a plain pool note through `prepareDepositFor` (see `prepareReshieldTransferDeposit`). Without it the session is yield-share only and any other output throws `YieldTargetNotConfigured`. The cross-chain session stays yield-share only: `destinationYieldDepositTargets` is **required** there, because every cross-chain deposit must resolve to a `YieldSwapDepositTarget`. **Plain pool rule:** an asset that has a configured yield share on the chain is never deposited into a plain pool. A plain `outputToken` equal to the `fundingToken` (underlying, or the native sentinel for a native-mode share) of any configured `yieldDepositTargets` entry throws `InvalidTransactParams` (pass the share instead) before any estimate, quote or deposit work. `prepareReshieldTransferQuote` applies the same check to `outputToken` and the deposit result's `tokenId`, so a hand-built plain deposit for a share's underlying cannot be quoted either. Plain outputs are only for assets with no configured share (e.g. BNB, FDUSD on BSC, where the only share wraps USDT).

**`estimateReshieldTransferAmount(params: EstimateReshieldParams) → Promise<ReshieldEstimate>`** / **`estimateReshieldTransferCrosschainAmount(params: EstimateReshieldCrosschainParams) → Promise<ReshieldCrosschainEstimate>`**

Delegate verbatim to `estimateReshieldAmount` / `estimateReshieldCrosschainAmount` (so the cross-chain variant inherits the destination capability gate, `DestinationCallsUnsupported` — see §Cross-Chain Reshield), plus a pre-flight check that `outputToken` is served: a configured yield-share target, or (same-chain, with a `depositDelegate`) a plain pool asset. Anything else throws `YieldTargetNotConfigured` before any estimate, rather than silently estimating a deposit this session cannot build.

**`prepareReshieldTransferDeposit(params: PrepareReshieldTransferDepositParams) → Promise<PrepareDepositResult>`** / **`prepareReshieldTransferCrosschainDeposit(params: PrepareReshieldTransferCrosschainDepositParams) → Promise<PrepareDepositResult>`**

The new step. Resolves `outputToken` to a `YieldSwapDepositTarget`, or — same-chain, with a `depositDelegate`, and only when no share matches — to a plain deposit (`YieldTargetNotConfigured` otherwise). A plain output is built with `depositDelegate.prepareDepositFor({ ...recipient, tokenId: outputToken, value: params.noteValue })`: `noteValue` (from `ReshieldEstimate.noteValue`) is **required** (`InvalidTransactParams` without it) and is the deposit value, not `totalDepositCost`, because the vetting fee is charged on top and `prepareReshieldQuote` re-checks `totalDepositCost == noteValue + fee`. A result that comes back `isOwned` is refused (`InvalidTransactParams`) so a self-owned deposit can never reach the quote. The yield path narrows `params` into a `YieldDepositForRecipient` (blind `noteAddressHash`, or `discoveryData` — see `IPoolSessionDeposit.prepareDepositFor`), and calls `target.prepareSwapDeposit(BigInt(params.totalDepositCost), headroomPpm, recipient)` — the cross-chain variant passes `CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM`, matching `PoolSessionReshieldCrosschain`'s own sizing. Recipient identity mirrors `IPoolSessionDeposit.prepareDepositFor`'s union directly (`YieldDepositForRecipient<TAddress>`), not Internal Transfer's `RecipientDiscoveryData` — a reshield-and-transfer deposit is exactly one output note, so there is nothing to key by a `noteSecretsMap`-style Map the way a multi-note transfer needs; `PreparedYieldDeposit`/`PrepareDepositResult` carry a plain `noteSecret?: Hex`, present only when the out-of-band fallback fired (unregistered `discoveryData.evmAddress` recipient with `allowOutOfBandFallback: true`) — the caller must then deliver it to the recipient out-of-band, same as `prepareDepositFor`'s own `noteSecret`.

For the cross-chain variant, recipient resolution is scoped to the **destination** chain automatically: each `destinationYieldDepositTargets` entry's `deposit` is already a destination-chain-scoped `PoolSessionYieldDeposit` (built from a second, destination-chain `PoolSession` the caller constructs), so this session needs no keystore/crypto dependency of its own — resolution happens two layers down, inside code this session never touches.

**`prepareReshieldTransferQuote(params: PrepareReshieldQuoteParams) → Promise<PreparedReshieldQuote>`** / **`prepareReshieldTransferCrosschainQuote(params: PrepareReshieldCrosschainQuoteParams) → Promise<PreparedReshieldCrosschainQuote>`**

Delegate verbatim to `prepareReshieldQuote` / `prepareReshieldCrosschainQuote` — identical shape, already recipient-agnostic — except for one guard: throws `InvalidTransactParams` if `params.depositResult.pendingNote.isOwned` is `true`. A self-owned deposit result means the caller built it via a self-deposit path instead of `prepareReshieldTransferDeposit`/`prepareReshieldTransferCrosschainDeposit`, which would silently reshield to the caller's own session instead of transferring to the intended recipient.

**`relayReshieldTransfer(params: ReshieldTransferParams) → Promise<TxReceipt>`** / **`relayReshieldTransferCrosschain(params: ReshieldTransferCrosschainParams) → Promise<TxReceipt>`**

Delegate verbatim to `relayReshield` / `relayReshieldCrosschain`. `ReshieldTransferParams` / `ReshieldTransferCrosschainParams` are `Omit<ReshieldParams, "depositNote">` / `Omit<ReshieldCrosschainParams, "depositNote">` — the sender must never persist a note it doesn't own, and omitting the field from the type (rather than accepting and silently ignoring it) makes a type-safe caller's mistake impossible, not just discouraged.

**Dust recovery to the originator.** Both sessions accept the same `dustRescue: { recipientIdentifier }` opt-in plain/cross-chain reshield already has (see §Stealth Dust Rescue above) — with one semantic difference: here `recipientIdentifier` identifies **the originator** (the withdrawer who pays for and initiates the operation), not the deposit recipient. This is the first feature in this family where "who paid for the operation" and "who receives the deposit" can be different people.

**Construction.** `PoolSessionFactory` builds `reshieldTransfer` only when `reshield` is itself available and either at least one yield-share target is configured or a `deposit` delegate exists (the plain-output path); `reshieldTransferCrosschain` only when `reshieldCrosschain` is available and at least one destination yield-share target is configured — same gating shape as every other optional delegate. `createEvmPoolSession` composes the *same* `reshield` / `reshieldCrosschain` instance already built for plain reshield (not a fresh one), so router-allowlist/routing-layout caches are shared, not duplicated.

No contract or circuit change: the deposit proof already supports an arbitrary client-chosen `noteAddressHash` (what `prepareDepositFor` already exercises via dust-rescue). No relayer change: `relaySwap` executes whatever proof-bound `RelaySwaps.execute()` call it is given, recipient-shape-agnostic.

---

**`getSwapStatus(params) → Promise<SwapStatusResult>`**

Queries the current execution status of a swap transaction from the DEX aggregator (e.g., LiFi). For same-chain swaps, status resolves immediately after the transaction is mined. For cross-chain swaps, tracks bridge delivery to the destination chain — callers should poll at 5-10 second intervals until `status` is `DONE` or `FAILED`.

Delegates to the `ISwapProvider` implementation wired via `swapAndDepositQuoteProvider` in `PoolSessionConfig`. Throws if no swap provider is configured.

**Params: `SwapStatusRequest`**

| Param | Type | Description |
| --- | --- | --- |
| `txHash` | `Hex` | Source chain transaction hash. |
| `fromChainId` | `number` | Source chain ID. |
| `toChainId` | `number` | Destination chain ID. |
| `bridge` | `string?` | Bridge tool identifier (e.g. `"stargateV2"`). Speeds up cross-chain lookup. Returned as `tool` in `SwapQuoteResult`. |

**Returns: `SwapStatusResult`**

| Field | Type | Description |
| --- | --- | --- |
| `status` | `SwapStatus` | Top-level status: `NOT_FOUND`, `PENDING`, `DONE`, or `FAILED`. |
| `substatus` | `SwapSubstatus?` | Detailed substatus (e.g. `WAIT_DESTINATION_TRANSACTION`, `REFUNDED`). |
| `substatusMessage` | `string?` | Human-readable substatus message from the bridge. |
| `sending` | `SwapTransactionInfo?` | Source chain transaction info. |
| `receiving` | `SwapTransactionInfo?` | Destination chain transaction info. Present when bridge delivers. |
| `explorerLink` | `string?` | Link to aggregator explorer for this transfer. |

**Throws:** `SwapQuoteProviderBaseError` when no swap provider is configured. `SwapStatusFailed` when the aggregator API call fails.

---

**`prepareSwapAndDeposit(params) → Promise<PrepareSwapAndDepositResult>`**

Prepares a swap-and-deposit: swaps an input token into the pool's deposit token via LiFi, then deposits the output into the privacy pool atomically. Internally delegates to `IPoolSessionDeposit.prepareDeposit` (or `prepareDepositFor` when `recipient` is set) to generate the deposit proof (locking the exact deposit amount), then calls `ISwapAndDepositQuoteProvider.getSwapAndDepositQuote` to obtain a LiFi `getContractCallsQuote` that wraps the swap + deposit into a single transaction. Quotes are fixed-output (`amountType: "to"`) by default; a cross-chain request with `inputAmount` switches to fromAmount mode. The input token is approved to LiFi's `approvalAddress`, not the entrypoint.

**Params: `SwapAndDepositParams`**

| Param | Type | Description |
| --- | --- | --- |
| `fromChainId` | `number` | Source chain ID where the input token resides. Either equals the pool chain (same-chain swap) or matches the configured `swapDepositSourceChain.chainId` (cross-chain). Any other value throws `InvalidSwapAndDepositParams` — in particular, cross-chain requests without a source-chain attachment configured. |
| `inputToken` | `Address` | Input token the user holds (token X) to swap from — on `fromChainId`. |
| `depositToken` | `Address` | Pool deposit token (token Y, the swap output) accepted by the pool. |
| `depositAmount` | `Hex` | Exact amount of `depositToken` to deposit into the pool (fixed output), hex-encoded wei. The deposit proof is generated for this amount. |
| `fallbackAddress` | `Address?` | Cross-chain only: destination-chain address receiving the bridged tokens if the destination deposit cannot execute (LiFi's `toFallbackAddress`). Defaults to the session's `ownerAddress` — the user's own EOA exists on the destination chain, unlike the relayer-mediated reshield flow. Ignored for same-chain swaps. |
| `inputAmount` | `Hex?` | Cross-chain only: the caller's input-token budget; switches the quote to fromAmount mode. |
| `recipient` | `DepositForRecipient?` | Deposit FOR someone else (see below). Omitted, the session owner gets the note. |

> These seven fields are the entire `SwapAndDepositParams`. Six of them are `SwapAndDepositParamsSchema`; `inputAmount` is validated separately on the cross-chain path (`crossChainInputBudget`). There is no `fromToken`/`toToken`/`fromAddress`/`toChainId` param; passing those is rejected by the Zod schema.

**Cross-chain mode.** When the session is built with a source-chain attachment (`PoolSessionConfig.swapDepositSourceChain`, or the builder's `sourceChain` config: `{ chainId, rpcUrl, walletInteractor, relaySwapsAddress }`), `fromChainId` may name that chain. The prepare path then: reads the input-token allowance on the **source** chain; validates LiFi's `transactionTo` and `approvalAddress` against the **source chain's** `RelaySwaps.approvedRouters` (that is where the transaction executes — the pool chain's allowlist would be the wrong trust anchor); and passes `fallbackAddress` to the quote. A cross-chain swap transaction may never target, approve or call a swap executor (`assertNoSwapExecutor` → `UnexpectedTransactionTarget`; see "Swap-executor screening" below). The destination-side guarantees are unchanged: the vetting-fee padding reads the pool chain's Entrypoint config, and the byte-level assertion that the deposit calldata + Entrypoint address are embedded verbatim in LiFi's `transactionData` applies identically. Two cross-chain-only checks (2026-09-24) mirror `prepareReshieldCrosschainQuote`: a plain native-coin `Entrypoint.deposit{value}` is refused before any network call with `NativeDestinationDepositUnsupported` (LiFi's Executor sends its own guaranteed delivery as `msg.value`, the Entrypoint requires an exact match; a native-mode yield router is exempt since `msg.value` is a cap there); and after the quote the destination call budget LiFi encoded — `decodeLiFiDestinationCallAmount(transactionData, depositResult.callData) ?? quoteResult.destinationCallAmount ?? decodeStargateDestBudget(transactionData)` — must cover `totalDepositCost` on **every** route (previously Stargate only), else `DestinationDepositUnaffordable(totalDepositCost, destBudget, affordableNoteValue)` with `affordableNoteValue` sized from `destBudget × (1 − 100 bps)` so the caller's re-prepare does not trip again. The destination deposit call is quoted with the flat 2,000,000 `CROSS_CHAIN_DESTINATION_GAS_LIMIT` (2026-10-13; previously 800,000), with the same Across caveat — see §Cross-Chain Reshield, **Destination gas**.

**Swap-executor screening (2026-10-02).** `assertSwapTxTrusted` (run at prepare and execute) accepts exactly one kind of executor transaction: a session-composed same-chain deposit (`transactionTo` equals the configured `swapExecutor.executor`; see [lifi-swap-quote-provider.md](../evm-sdk/lifi-swap-quote-provider.md) §Same-chain native deposits), fully decoded and pinned argument-by-argument; its inner swap leg may not itself call, target or approve an executor. The call is handed one asset: a native output must hand it exactly `depositMsgValue`, an ERC-20 output a non-zero token amount (an executor approval to the deposit target) with `depositMsgValue` of `0`. The transaction's `msgValue` is the input amount for a native input and `0` otherwise. Every other transaction — cross-chain, and chains without a configured executor — goes through `assertNoSwapExecutor`. The approval spender may never be an executor, on any route.

**Executor-targeted contract-calls quotes (2026-10-06, DEV-489).** For a native-coin input, LiFi's same-chain contract-calls quote targets its own `Executor.swapAndExecute` in a layout the session does not sign. With an executor configured, `prepareSwapAndDeposit` discards that quote (nothing from it reaches the transaction) and composes the deposit itself, as it does for a plain native-coin deposit: an ordinary exact-out swap of the input into the token the deposit needs (the deposit token, or a share's funding token), paid to the executor, then the deposit call. A native input rides as the transaction's own value, so nothing is approved. Without a configured executor nothing is composed and that quote fails `assertNoSwapExecutor` (`UnexpectedTransactionTarget`), as before. With an executor but no swap quote provider to compose from, the route is refused with `NativeSwapDepositUnavailable`. Verified on a mainnet fork against the live Executor: 0.01 ETH swapped to USDT, the deposit target pulled exactly the call amount, the leftover USDT went to the receiver and the Executor kept nothing.

**For a recipient (`recipient`, 2026-10-02).** The embedded deposit carries the recipient's depositFor proof, built by `prepareDepositFor` with the same forms it accepts: `{ discoveryData }` for a registered recipient (the note is announced to their viewing key, read from the keystore on the pool chain; an unregistered one throws `DepositRecipientViewingKeyUnregistered` before quoting), or the blind `{ noteAddressHash, noteData?, depositSecret? }` form (no keystore read). For a yield share the router's exact-shares deposit wraps that same proof (`YieldSwapDepositTarget.prepareSwapDeposit(budget, headroomPpm, recipient)` → `prepareYieldDeposit({ ..., recipient })`); because the shares are sized inside the SDK, a blind caller that binds its own announcement passes `noteData` as a `NoteDataBuilder`, which receives the sized share value and label. Same-chain and cross-chain alike. Everything else is unchanged: the quote request (still `fromAddress = ownerAddress`, cross-chain `fallbackAddress` defaulting to `ownerAddress`, so a failed destination deposit refunds the payer), the vetting-fee padding, every embedding/allowlist check. The returned `pendingNote` is the recipient's (`isOwned: false`, `ownerAddress` = the recipient for the discoverable form, empty for blind); `executeSwapAndDeposit` never persists it, and `prepareSwapAndDeposit` throws `InvalidSwapAndDepositParams` if a delegate returns an owned note for a recipient. For a blind recipient its `commitment`, `label`, `value`, `tokenId` and `depositSecret` plus the caller's own `noteSecret` are the claim material, exactly as for a blind `prepareDepositFor`. No new field in any relayer or LiFi request.

**Returns: `PrepareSwapAndDepositResult`**

| Field | Type | Description |
| --- | --- | --- |
| `receipt` | `NoteReceipt` | Deposit note receipt (same as `PrepareDepositResult.receipt`). |
| `transactionRequest` | `TransactionRequest` | LiFi transaction to submit (wraps swap + deposit atomically). |
| `approvalAddress` | `Address` | Address to approve `fromToken` spending to (LiFi's approval address). |
| `approvalAmount` | `Hex` | Amount of `fromToken` to approve. |

**Throws:** `InvalidSwapAndDepositParams` when the params fail schema validation or when `fromChainId` matches neither the pool `chainId` nor a configured `swapDepositSourceChain.chainId`; `SwapAndDepositQuoteFailed` when the LiFi contract-calls quote fails; `SwapQuoteMismatch` when LiFi's returned route (`fromChainId`/`toChainId`/`fromToken`/`toToken`) differs from what was requested — a buggy or compromised quote cannot redirect the deposit to a different chain or token; `UnallowedLiFiAddress` when the quote's `transactionTo`/`approvalAddress` (or a composed native deposit's inner swap leg) is not approved on the relevant chain's RelaySwaps allowlist; `UnexpectedTransactionTarget` when the transaction calls a swap executor other than as a session-composed same-chain deposit, the approval spender is a swap executor, or the composed call's decoded arguments differ from the validated deposit; `RelaySwapsLayoutMismatch` (RC-32) when that chain's `RelaySwaps.ROUTING_TYPEHASH()` disagrees with this SDK build's `SwapRouting` encoding — checked in the same pre-proof step, before the allowlist read; cross-chain only: `NativeDestinationDepositUnsupported` when the destination deposit is a plain native-coin `Entrypoint.deposit{value}` (before any network call), and `DestinationDepositUnaffordable(totalDepositCost, destBudget, affordableNoteValue)` when the destination call budget LiFi encoded is below `totalDepositCost` (any route).

---

**`executeSwapAndDeposit(result) → Promise<TxReceipt>`**

Submits a prepared swap-and-deposit transaction using the wallet adapter. Takes the result of `prepareSwapAndDeposit`, handles input token approval if needed, and submits the LiFi transaction on-chain. Before submitting the approval it validates the prepared `approvalTx` — the transaction must target the input token, call `approve`, and name `approvalAddress` (the LiFi router) as the spender — throwing `UnexpectedTransactionTarget` on any mismatch, so a tampered `PrepareSwapAndDepositResult` cannot grant an unexpected spender an allowance.

**Execute-time re-validation.** Because `PrepareSwapAndDepositResult` is plain serializable data that may round-trip through UI state / storage / a backend before execution, `executeSwapAndDeposit` re-anchors the swap transaction's trust before signing — it does not trust the object's fields as-is: `transactionTo` and `approvalAddress` are re-checked against the executing chain's `RelaySwaps.approvedRouters`; `depositTarget` must equal the session's own Entrypoint (not the value in the result); the deposit calldata must be byte-embedded in `transactionData`; the swap-executor screening above is re-run (the composed native deposit re-decoded and re-pinned, any other executor target/spender/call rejected); and the approval amount must not exceed the estimated input (`UnexpectedTransactionTarget` on excess — caps blast radius against an unbounded-approval tamper). A tampered result is therefore rejected before any transaction is sent.

**Cross-chain semantics.** When `result.fromChainId` differs from the pool chain (requires the matching `swapDepositSourceChain` config — `InvalidSwapAndDepositParams` otherwise), both transactions are signed by the **source-chain** wallet and their receipts awaited on the source-chain RPC. The returned receipt is the **source-chain** receipt: it proves the swap/bridge was accepted, not that the deposit has landed — LiFi's destination executor performs the Entrypoint deposit on the pool chain minutes later. The SDK deliberately does not persist the note locally in this mode (no destination commitment exists yet at source-receipt time): the caller keeps `result.pendingNote` (the secrets), and the note becomes spendable through the session's normal on-chain sync once the destination deposit exists. Callers wanting delivery confirmation poll `getSwapStatus` (see the cross-chain integration tests for the pattern).

**Params:** `PrepareSwapAndDepositResult` — the result from `prepareSwapAndDeposit`.

**Returns:** `TxReceipt` — The on-chain transaction receipt.

**Throws:** `UnexpectedTransactionTarget` when the prepared approval targets the wrong token, selector, or spender, or the swap transaction fails the swap-executor screening.

---

**`swapAndDeposit(params) → Promise<TxReceipt>`**

Convenience wrapper that runs `prepareSwapAndDeposit` then `executeSwapAndDeposit` in one call. Same params as `prepareSwapAndDeposit`.

**Returns:** `TxReceipt` — The on-chain transaction receipt.

---

**`prepareRageQuit(params) → Promise<RageQuitResult>`**

Emergency exit bypassing ASP compliance. Validates note exists and is not EXITED via NoteManager. Fetches keys from KeystoreManager. Fetches commitment and keystore tree leaves from ContractInteractor (no ASP data needed). Builds ragequit witness via WitnessPreparationService (1-in, 0-out, no ASP proof). Generates proof via ProofService. Submits DIRECTLY on-chain via ContractInteractor (not via relayer—ragequit reveals ownerAddress anyway). Updates note to EXITED. The circuit enforces recipientAddress = ownerAddress to prevent theft.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `commintment` | `Hash` | The commitment hash of the note to exit. Must not be EXITED. Can be ACTIVE, PENDING, or even INACTIVE—ragequit bypasses all compliance checks. |

**Returns: `RageQuitResult`**

| Field | Type | Description |
| --- | --- | --- |
| `commitment` | `Hash` | Commitment of the note being ragequit. Echoed back so `executeRageQuit` can transition local state without separately tracking the input, and so integrators broadcasting externally can pass it to `markNotesExited`. |
| `value` | `Hex` | Amount withdrawn. Equal to the note's full value (ragequit is always a full withdrawal). |
| `tokenId` | `Address` | Token identifier of the withdrawn asset. |
| `nullifierHash` | `Hash` | Nullifier hash published on-chain, marking the note as spent. |
| `recipientAddress` | `Address` | The ownerAddress that received the funds. Forced by the circuit to equal the note's ownerAddress. |
| `callData` | `Hex` | Call data to execute rageQuit |

**Throws:** `KeystoreNotRegistered` when the **note owner** (`note.ownerAddress`) has no on-chain keystore registration, or `RegistrationCheckFailed` when that read fails (both `PoolSessionKeystoreBaseError`, not `PoolSessionRagequitBaseError`). The check is on the note owner — not the session owner — because the ragequit witness's keystore leaf is built from the note's owner address; it runs after the EXITED / addressless-note guards and before any tree leaves are fetched. `executeRageQuit` takes an already-prepared result and does not re-check.

**`executeRageQuit(result) → Promise<TxReceipt>`**

Submits the prepared ragequit calldata through `IPoolVaultInteractor` and awaits the receipt. On a successful receipt (`txReceipt.status === true`), transitions the note to `EXITED` via `noteManager.updateNoteStatus(commitment, EXITED, txReceipt.blockNumber)`. Mirrors the SDK-broadcast persistence pattern already used by `executeDeposit` and `TransactOrchestrator.persistNoteUpdates`; if the chain tx reverts, local state is left untouched so the next `prepare*` call sees the note as still spendable.

---

**`async discoverNotes(params?) → Promise<Note[]>`**

Explicit note discovery. Fetches NoteEvents internally from the PoolVault contract starting from the sync cursor via `poolVaultInteractor.getNoteEvents()`. If contacts are provided, runs targeted discovery (O(k) where k = number of contacts). Otherwise runs catch-all discovery (O(N) where N = all anonymous transfers). Delegates to PoolSessionNoteDiscovery, which uses NoteDiscoveryService for scanning and NoteManager for state tracking. Note commitments are computed internally after decryption.

**Params: `DiscoverNotesParams` (optional)**

All params are optional. If omitted entirely, uses the stored sync cursor and runs in catch-all mode.

| Param | Type | Description |
| --- | --- | --- |
| `fromBlock` | `Hex?` | Block number to start fetching events from. If omitted, uses the stored sync cursor. |
| `contacts` | `Contact[]?` | Array of known contacts with their viewing public keys. If provided, runs targeted discovery: computes shared secrets only for these contacts, then filters events by expected tags. If omitted, runs catch-all: attempts ECDH + decrypt against every anonymous transfer event. |

**Returns: `Promise<Note[]>`**

Array of newly discovered Note objects. Each note is automatically added to NoteManager with INACTIVE status (pending label verification).

**Note-status sync and snapshot coverage.** After new notes are persisted, `discoverNotes` refreshes the status of every locally-held note (`PENDING → ACTIVE → SPENT`, `→ EXITED`) from the ASP `EventSnapshot`'s `transacts` and `ragequits`, then scans `Transacted` / `Ragequit` logs for whatever range the snapshot did not cover — bounded at the same head the event scan used, i.e. the block the sync cursor advances to.

How much of the range the snapshot is credited with is a trust decision, not a field read:

- **Snapshot fetched and fully valid** → covered through `snapshotBlockNumber`; the chain scan handles only the tail past it.
- **Snapshot unreachable or its envelope invalid** → covered through nothing; note status is rebuilt from a chain scan of the *entire* requested range, which on a first sync is every block since deployment (hundreds of paginated `eth_getLogs` calls). Correct, but expensive enough that it is logged at `warn` rather than performed silently.
- **Snapshot valid but some rows dropped** (see [asp-client.md](asp-client.md) — only a field this sync actually reads can drop a row; a row missing just its `blockNumber` is kept and stamped with the scan's `fromBlock`) → coverage stops one block *below* the earliest dropped `transacts` / `ragequits` row, so the chain scan re-reads exactly the range whose row was lost. A dropped row is missing state, so crediting `snapshotBlockNumber` anyway would let a spend or a ragequit stay invisible to this client indefinitely. If a dropped row's own `blockNumber` is unusable the gap cannot be located, and the snapshot is credited with nothing. Drops in the arrays this sync does not read (`deposits`, `leaves`, `keystoreLeaves`) cost no coverage. This guards accidental ASP-side loss, not a lying ASP — snapshot rows are unauthenticated, so see the corresponding note in [asp-client.md](asp-client.md) for what actually catches one.

Coverage is floored at the requested `fromBlock`: blocks below the sync cursor were reconciled by an earlier pass, so a row the ASP keeps serving malformed at an old height cannot drag later syncs back to it.

A `StateInvariantViolation` raised while applying snapshot rows (e.g. a ragequit for a note already `SPENT`) propagates to the caller; only the snapshot *fetch* is treated as a recoverable failure.

---

**`async purgePhantomNotes(params?) → Promise<Hash[]>`**

Explicit phantom-note maintenance op. Removes locally-persisted notes whose commitment was never inserted on-chain — decryption garbage written by earlier SDK builds during the alt-parity / Curve25519 transition. The on-chain commitment set is built from the ASP `EventSnapshot` (`deposits[].outputCommitment` ∪ all `transacts[].outputCommitments[*]`) plus a chain-tail catch-up that scans `Deposited` and `Transacted` logs from `snapshotBlockNumber + 1` to the current head. For each candidate not in that union, the method performs a per-candidate on-chain double-check via `IPoolVaultInteractor.getCommitmentTimestamp(commitment)`. Only when the chain itself returns `0n` (absent on-chain) is the local note removed via `NoteManager.deleteNote()`; on a non-zero timestamp the candidate is kept. If any `getCommitmentTimestamp` call throws, the entire purge run is aborted and wrapped as `NoteDiscoveryScanFailed` — destructive action is never taken on uncertain state. After successful deletions the storage adapter is flushed.

Not invoked from `discoverNotes()` — driving the snapshot+tail scan on every sync would be wasteful since healthy SDK builds cannot produce phantoms. Call this on demand (e.g. once at session bootstrap for legacy accounts, or behind a user action). The sync cursor is **not** modified; purge is independent of discovery progress.

**Must not be called while a transaction is in flight** (deposit/transfer/withdraw). Locally-staged notes whose commitments have not yet been mined will be classified as phantoms and removed. Wait until any pending tx is confirmed and discovered before invoking.

If the ASP snapshot is unreachable, the method falls back to scanning the full chain history for `Deposited` and `Transacted` events so a transient ASP outage cannot misclassify legitimate notes as phantoms. The same applies in miniature when the snapshot arrives with dropped rows: a dropped `deposits` / `transacts` row is a commitment missing from the comparison set — a real note that would look like a phantom — so the tail scan starts at the earliest dropped row instead of `snapshotBlockNumber + 1` (block `0` when the gap's height is unknown). The per-candidate `getCommitmentTimestamp` double-check remains the last line of defense, not the only one.

**Params: `PurgePhantomNotesParams` (optional)**

| Param | Type | Description |
| --- | --- | --- |
| `dryRun` | `boolean?` | When `true`, runs the entire pipeline (ASP fetch, tail catch-up, per-candidate `getCommitmentTimestamp` double-check) and returns the would-purge set without mutating the NoteManager or storage adapter. Defaults to `false`. |

**Returns: `Promise<Hash[]>`**

Commitments of the notes that were purged. When `dryRun: true`, the commitments that **would have been** purged. Empty array when nothing qualifies.

---

**`exportAccount() → AccountExport`**

Serializes full account state for portability and backup. No params.

The returned blob contains note secrets and payment-request `noteSecretsMap` entries in cleartext. The SDK does not encrypt exported data — the integrator owns encryption at rest, the same trust model as the storage adapter. Treat the blob as backup material for the same account, never as something to share.

**Returns: `AccountExport`**

| Field | Type | Description |
| --- | --- | --- |
| `notes` | `Note[]` | All notes with their statuses and metadata. |
| `syncCursor` | `Hex` | Last synced block, so import can resume from where export left off. |
| `paymentRequests` | `SerializedPaymentRequestRecord[]` | Pending recipient-side payment requests. `noteSecretsMap` is carried as array-of-entries (a `Map` does not survive `JSON.stringify`); `paymentPrivKey` is dropped because it is re-derived on import. Without this, a restored session loses the secrets needed to discover incoming payment-request notes. |
| `owner` | `Address` (optional) | Owner address the export was produced for. Absent on exports written before this field existed. |
| `chainId` | `number` (optional) | Chain id the export was produced for. Absent on legacy exports. |

---

**`importAccount(data) → Promise<void>`**

Restores account state from a previous export. Hydrates NoteManager and PaymentRequestService.

If `owner` or `chainId` is present and disagrees with the live session, the import is rejected (`AccountExportMismatch`) — this stops one account's note and payment-request secrets from being grafted onto another. A missing field skips its check, so legacy exports still import. A missing `paymentRequests` field leaves in-memory requests untouched rather than clearing them.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `data` | `AccountExport` | Previously exported account state from `exportAccount()`. |

**Returns:** `Promise<void>`

`importAccount` restores the user's own backup, which is a trusted input, so it stores the whole blob without re-verifying note internals.

---

**`exportKeystoreLeafCache() → LeafCacheSeed | undefined`**

Snapshots the session's `KeystoreInteractor` leaf cache for persistence across process/session boundaries — proxy for `IKeystoreInteractor.exportLeafCache()` (see [contract-interactor.md](contract-interactor.md)). Returns `undefined` if `getKeystoreLeaves()` has never been called (including the background warm-up) on this session. Always available — every `PoolSession` has a keystore interactor. Feed the result back in as `keystoreLeafCacheSeed` on a later `PoolSessionBuilder` config to skip the initial full scan.

**Returns:** `LeafCacheSeed | undefined` — `{ toBlock: bigint; leaves: Hash[] }`, or `undefined` before any fetch.

---

**`exportStateLeafCache() → LeafCacheSeed | undefined`**

Snapshots the session's `PoolVaultInteractor` leaf cache — proxy for `IPoolVaultInteractor.exportLeafCache()`. Same semantics as `exportKeystoreLeafCache()`, feeding a later session's `stateLeafCacheSeed`.

**Returns:** `LeafCacheSeed | undefined` — `{ toBlock: bigint; leaves: Hash[] }`, or `undefined` before any fetch.

**Throws:** `PoolSessionLeafCacheBaseError` when the session was not configured with a `poolVaultInteractor` — the same "delegate not configured" pattern used elsewhere on `PoolSession`.

---

**`importReceivedNote(note) → Promise<void>`**

Stores a single note handed over out-of-band (e.g. a `blind` transfer output the recipient received off-chain). Unlike `importAccount`, a received note comes from another party, so its fields are untrusted and verified before storage. The check rebuilds the cryptographic chain and rejects any mismatch with `InvalidNoteError`:

- `note.ownerAddress` must equal the session owner — otherwise the note cannot be spent with this session's keys.
- `note.noteAddressHash` must equal `computeNoteAddressHash(ownerAddress, noteSecret)`.
- `note.commitment` must equal `computeFullCommitment({ noteAddressHash, tokenId, value, label })` — a commitment that does not bind its value would be unspendable.

On success the note is added via `NoteManager.addNote` with `status = PENDING` (subsequent `discoverNotes()` promotes it to `ACTIVE`), followed by a single `flush()`. Comparisons use `BigInt`, so hex padding and case do not matter.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `note` | `Note` | The received note to verify and store. |

**Returns:** `Promise<void>`

---

**`addNotes(params) → Promise<void>`** / **`markNotesSpent(params) → Promise<void>`** / **`markNotesExited(params) → Promise<void>`**

Batch surface for integrators who sign and broadcast transactions through their own infrastructure (custom wallets, batch submitters, AA bundlers) and therefore never go through the SDK's `execute*` path. `addNotes` handles output-side bookkeeping; `markNotesSpent` and `markNotesExited` handle input-side bookkeeping for transact/withdraw and ragequit broadcasts respectively. A single broadcast can produce multiple output notes and consume multiple input notes, so all three methods are batch-shaped and validate the entire batch up front — on any validation failure no mutations are applied. On success a single `noteManager.flush()` is issued.

Use `markNotesExited` (not `markNotesSpent`) for ragequit-style consumption. `SPENT` is a terminal absorbing state with no `SPENT → EXITED` edge; calling `markNotesSpent` on a ragequit'd commitment would later wedge `discoverNotes()` when it observes the ragequit event (`PoolSessionNoteDiscovery.processRagequitEvents` raises `StateInvariantViolation` for `SPENT → EXITED`).

### `addNotes(params) → Promise<void>`

Registers one or more output notes from externally-broadcast transactions as `PENDING` in the local NoteManager state.

Each commitment's on-chain block timestamp is resolved via `IPoolVaultInteractor.getCommitmentTimestamp` (with bounded retry, see `resolveCommitmentTimestamp`), in parallel across the batch. The broadcast transactions MUST already be mined — when any timestamp cannot be resolved the method throws `NoteCommitmentNotMined` and applies no mutations, because `createdAtBlock` is hashed into the timestamped state-tree leaf and a stale value would silently break ragequit / transact witnesses.

`addNotes` is sender-only: entries with `pendingNote.isOwned === false` (recipient outputs from `prepareTransfer`, `prepareDepositFor` outputs sent to a third party) are rejected at the schema boundary. The sender's NoteManager never holds foreign notes, matching the SDK-broadcast paths where `executeDeposit` gates persistence on `isOwned` and `TransactOrchestrator.persistNoteUpdates` only ever receives `changePendingNotes`.

Registered notes transition to `ACTIVE` on the next `discoverNotes()` run that observes the commitment on-chain. If a broadcast transaction never lands, the entry remains `PENDING` and can be cleaned up via `purgePhantomNotes()`.

Empty array is a no-op (no flush).

**Params: `AddNoteParams[]`** — each entry:

| Param | Type | Description |
| --- | --- | --- |
| `pendingNote` | `PendingNote` | The note to register, as produced by `prepareDeposit` / `prepareTransfer` / `prepareWithdraw`. Must have `isOwned === true`. |
| `txHash` | `Hash` | Hash of the externally-broadcast transaction that created the commitment on-chain. |

**Returns:** `Promise<void>`

Throws `InvalidAddNoteParams` (Zod validation, including the `isOwned: true` refinement), `NoteCommitmentNotMined` (timestamp unresolved), or propagates `NoteManagerBaseError` from NoteManager's own note-record validation.

### `markNotesSpent(params) → Promise<void>`

Transitions one or more locally-tracked input notes from `ACTIVE` to `SPENT` after an externally-broadcast transact / withdraw transaction consumed them on-chain. Without this, subsequent `prepare*` calls may re-select the same notes and produce a proof that reverts at the on-chain nullifier check.

The caller supplies `spentAtBlock` directly (they already have the broadcast tx receipt). The SDK does not re-fetch the receipt — `spentAtBlock` is metadata only and is never hashed into a witness, so the SDK's on-chain reads stay scoped to protocol-critical values like `addNotes`'s `createdAtBlock`.

The batch is validated up front: every commitment is looked up via `noteManager.getNote` (throws `NoteNotFoundError`) and every note is checked to be in `ACTIVE` status (throws `InvalidStatusTransitionError`) before any mutation. Empty array is a no-op (no flush).

**Params: `MarkNoteSpentParams[]`** — each entry:

| Param | Type | Description |
| --- | --- | --- |
| `commitment` | `Hash` | Commitment hash of the input note that was consumed on-chain. |
| `spentAtBlock` | `Hex` | Block number in which the spending transaction was mined (from the caller's tx receipt). |

**Returns:** `Promise<void>`

Throws `InvalidMarkNoteSpentParams` (Zod validation), `NoteNotFoundError` (commitment not tracked locally), or `InvalidStatusTransitionError` (note not in ACTIVE status).

### `markNotesExited(params) → Promise<void>`

Transitions one or more locally-tracked notes to `EXITED` after an externally-broadcast ragequit transaction consumed them on-chain. Companion to `markNotesSpent` for the ragequit path — required because `SPENT` is terminal and the discovery loop's later `ACTIVE → EXITED` transition would otherwise conflict (`processRagequitEvents` raises `StateInvariantViolation` for `SPENT → EXITED`).

Accepts notes in `ACTIVE` (normal ragequit) or `REJECTED` (ASP-rejected ragequit failsafe) source statuses, matching the transition table. Other source statuses (`PENDING`, `INACTIVE`) are rejected via `InvalidStatusTransitionError` so callers cannot accidentally settle a not-yet-active note.

The caller supplies `exitedAtBlock` directly (metadata only, NoteManager reuses the `spentAtBlock` field for terminal `SPENT` and `EXITED` states). The batch is validated up front with the same all-or-nothing semantics as `markNotesSpent`. Empty array is a no-op (no flush).

**Params: `MarkNoteExitedParams[]`** — each entry:

| Param | Type | Description |
| --- | --- | --- |
| `commitment` | `Hash` | Commitment hash of the note that was exited on-chain (from `PrepareRageQuitResult.commitment`). |
| `exitedAtBlock` | `Hex` | Block number in which the ragequit transaction was mined. |

**Returns:** `Promise<void>`

Throws `InvalidMarkNoteExitedParams` (Zod validation), `NoteNotFoundError` (commitment not tracked locally), or `InvalidStatusTransitionError` (note not in ACTIVE or REJECTED status).

---

# Supporting Types

### NoteData

Encrypted note payload included in on-chain transactions for note discovery.

| Field | Type | Description |
| --- | --- | --- |
| `hint` | `Hex` | Discovery hint for the recipient to identify incoming notes. |
| `data` | `Hex` | Encrypted note data. New payloads are emitted at wire version `0x02` with a `kind` byte: `RLP([0x02, KIND_FULL, noteSecret, value, tokenId, label])` for ordinary notes, or `RLP([0x02, KIND_BLIND, noteAddressHash, value, tokenId, label])` for payment-request notes (no secret in payload). `decodeNotePayload` also accepts the legacy v1 layout `RLP([0x01, noteSecret, value, tokenId, label])` so notes already on-chain remain discoverable. The complete `NoteData` tuple (hint + encrypted data) is produced by `NoteComputationService.generateNoteData()` / `generatePaymentRequestNoteData()`. Wire-kind `blind` (no secret in payload) is distinct from the `ResolvedTransferRecipient.blind` variant (no on-chain event at all). Typical plaintext size: ~92-124 bytes depending on value length. |

### TransactParams

Parameters encoding the processor routing for a transact call.

| Field | Type | Description |
| --- | --- | --- |
| `processor` | `Address` | Address of the processor contract that handles post-proof execution logic. |
| `data` | `Hex` | ABI-encoded data passed to the processor (e.g., payout routing). |

### computeTransactContext(transactParams, noteData) → Hex

Computes the `context` field for the transact circuit. The context is a keccak256 hash of the ABI-encoded `TransactParams` and `NoteData[]`, binding the proof to the specific transaction parameters. This prevents proof malleability — a valid proof can only be used with the exact processor, routing data, and note payloads it was generated for.

### RecipientDiscoveryData

Caller-supplied recipient identity for `prepareTransfer`. Discriminated by which key is present.

| Variant | Fields | Description |
| --- | --- | --- |
| EVM-address resolution | `{ evmAddress: Address, noteSecretsMap?: Map<Hash, Secret>, allowOutOfBandFallback?: boolean }` | SDK fetches the recipient's viewing key from the on-chain keystore. If unregistered (returns `0x0`), it throws `RecipientViewingKeyUnregistered`, unless `allowOutOfBandFallback: true` opts into `outOfBand`. `noteSecretsMap` is generated if absent. |
| Pre-resolved viewing key | `{ publicViewingKey: PublicKey, noteSecretsMap: Map<Hash, Secret> }` | Caller already resolved the viewing key and secrets; SDK publishes encrypted `noteData` directly (always `discoverable`). |
| Payment-request (no secrets) | `{ publicViewingKey: PublicKey, noteAddressHashes: Hash[] }` | Payment-request fulfillment: caller has only the recipient's pre-committed `noteAddressHash` slots, never the secrets. SDK publishes a no-secret **v2** `noteData` payload; resolves to `discoverable-without-secrets`. |

### ResolvedTransferRecipient

Resolved recipient identity consumed by the orchestrator and the execute/relay paths. Pure crypto material — discriminated by **field presence** (no `kind` tag). Four variants:

| Variant | Shape | On-chain effect |
| --- | --- | --- |
| **blind** | `{ noteAddressHash: Hash[], noteAddressHashByLabel?: Map<Label, Hash> }` | No recipient `Note` event. Recipient must already know the secrets out-of-band. `noteAddressHashByLabel` is populated when the caller used the recommended `recipientNoteAddressHashByLabel` input; absent on the deprecated positional array path. |
| **outOfBand** | `{ noteAddressHash: Hash[], noteSecretsMap: Map<Hash, Secret> }` | No recipient `Note` event. `noteSecretsMap` returned to the caller for off-chain delivery. |
| **discoverable** | `{ noteAddressHash: Hash[], noteSecretsMap: Map<Hash, Secret>, publicViewingKey: PublicKey }` | Encrypted recipient `noteData` is published on-chain so the recipient can discover the note via `discoverNotes()`. |
| **discoverable-without-secrets** | `{ noteAddressHash: Hash[], publicViewingKey: PublicKey }` | Payment-request fulfillment. Encrypted **v2** `noteData` (carrying `noteAddressHash`, no secret) is published on-chain. The recipient holds the secret locally and reconstructs the note at discovery. No `recipientNotes` are returned to the sender. |

Discrimination at consumer sites: no `publicViewingKey` and no `noteSecretsMap` → blind; `publicViewingKey` present → discoverable (with `noteSecretsMap`) or discoverable-without-secrets (without); otherwise → outOfBand. `buildNotesData` branches on `noteSecretsMap` presence inside the `publicViewingKey` block to pick the v1 vs v2 payload. The recipient's EVM address (when known) travels alongside on `ExecuteTransferParams` / `RelayTransferParams` as ownership-stamping metadata, not on the resolved recipient itself.

For the blind variant, the orchestrator prefers `noteAddressHashByLabel` when present: it looks up each input label by name and asserts strict keyset equality with the unique labels in `inputCommitments`. When only the deprecated `noteAddressHash` array is present, the orchestrator zips it against `Object.keys(groupByLabel(inputNotes))` (first-occurrence order) to derive the same label → hash mapping internally.

`blind` and `outOfBand` produce identical on-chain footprints; only `discoverable` triggers ECDH + payload encryption for the recipient note.

### TransferResult

Returned by `executeTransfer` and `relayTransfer`.

| Field | Type | Description |
| --- | --- | --- |
| `txReceipt` | `TxReceipt` | Transaction receipt from the on-chain submission. |
| `recipientNotes` | `Note[]?` | Enriched recipient notes returned to the sender for off-chain delivery. Present whenever the resolved recipient carries a `noteSecretsMap` (i.e. `outOfBand` or `discoverable`); absent for `blind` and `discoverable-without-secrets`. |

### ExecuteWithdrawRelayerParams

Parameters for executing a prepared withdrawal via a relayer. Returned as `relayerOptions` from `prepareWithdraw()`.

| Field | Type | Description |
| --- | --- | --- |
| `recipientAddress` | `Address` | The recipient address for the withdrawn funds. |
| `selectedQuote` | `PrepareWithdrawRelayerQuotes` | The selected relayer and its fee quote. |
| `transactWitnessInputs` | `BuildTransactWitnessInputs` | The transact witness inputs to finalize proof generation with relay context. |
| `noteData` | `NoteData[]` | Encrypted note data payloads for the relayer to include on-chain. Each entry's `data` field contains an encrypted RLP-encoded NotePayload. |

### PrepareSwapRelayerQuotes

Selected relayer and its swap fee quote. Returned by `settleSwapRelayerQuotes()` and passed to `relayWithdrawAndSwap()`.

| Field | Type | Description |
| --- | --- | --- |
| `relayerInfo` | `RelayerInfo` | Relayer information (name, URL, processor address, etc.). |
| `quote` | `SwapRelayerQuote` | The fee quote returned by the relayer for this swap. |

### SwapAndDepositParams

Parameters for the swap-and-deposit flow. Matches `SwapAndDepositParamsSchema` exactly.

| Field | Type | Description |
| --- | --- | --- |
| `fromChainId` | `number` | Source chain ID where the input token resides — the pool chain, or the configured `swapDepositSourceChain.chainId` for cross-chain. |
| `inputToken` | `Address` | Input token the user holds (token X) on `fromChainId`. |
| `depositToken` | `Address` | Pool deposit token (token Y). A yield share (ppUSDC/ppUSDT/ppETH) is accepted when the session has a matching `yieldDepositTargets` entry: LiFi then swaps into the wrapper's funding token (underlying, or native coin in `nativeMode`) and the final leg is `PPRouter.depositExactShares` — see [yield-sessions.md](yield-sessions.md) §Landing as a share. |
| `depositAmount` | `Hex` | Exact amount of `depositToken` to deposit (fixed output). The deposit proof locks this amount. |
| `fallbackAddress` | `Address?` | Cross-chain only — destination fallback for undeliverable deposits; defaults to `ownerAddress`. |
| `inputAmount` | `Hex?` | Cross-chain only — the caller's input budget (fromAmount-mode quote). |
| `recipient` | `DepositForRecipient?` | Deposit for someone else: `{ discoveryData }` or the blind `{ noteAddressHash, noteData?, depositSecret? }` (`noteData` may be a `NoteDataBuilder`). The note is the recipient's (`isOwned: false`). |

### PrepareSwapAndDepositResult

Result of `prepareSwapAndDeposit()`.

| Field | Type | Description |
| --- | --- | --- |
| `pendingNote` | `PendingNote` | Note data (including secrets) for the deposit — the caller's responsibility to retain cross-chain, where the SDK does not persist it. With `recipient` it is the recipient's unowned note (`isOwned: false`), never persisted by this session. |
| `inputToken` | `Address` | The input token (token X), echoed for execute-time approval validation. |
| `estimatedInputAmount` | `Hex` | Input amount LiFi estimates it needs (hex-encoded wei). |
| `inputAmountUSD` / `depositAmountUSD` | `string?` | Informational USD values from the quote. |
| `approvalAddress` | `Address` | Spender for the input-token approval (LiFi's approval address). |
| `approvalTxs` | `PreparedTransaction[]` | Every input-token approval to submit, in order: `[approve(0), approve(amount)]` on a residual allowance (mainnet USDT), else one or none. `executeSwapAndDeposit` validates each (token, selector, spender, amount ≤ estimate) before signing any. |
| `approvalTx` | `PreparedTransaction \| null` | The last of `approvalTxs`, or null — kept for single-approval callers. |
| `transactionData` / `transactionTo` / `msgValue` | `Hex` / `Address` / `Hex` | The LiFi swap+deposit transaction to submit. |
| `estimatedDuration` | `number` | LiFi's estimated execution duration in seconds. |
| `fromChainId` | `number` | Chain the swap transaction executes on — drives execute-time submission routing (source wallet vs pool wallet). |
| `depositCallData` | `Hex` | The embedded deposit calldata — `Entrypoint.deposit(...)` for a plain output, `PPRouter.depositExactShares(...)` / `depositExactSharesNative(...)` for a share — carried so `executeSwapAndDeposit` can re-verify the embedding on a result that may have round-tripped through untrusted storage. |
| `depositTarget` | `Address` | The embedded deposit's target; re-checked at execute against the session's own Entrypoint, or the configured router for the output share (then `assertYieldDepositMatches` runs on the calldata, cap and value). |
| `depositMsgValue` | `Hex?` | Native value the embedded deposit carries — the spend cap for a native-mode router (`depositExactSharesNative`), `0x0` otherwise. |

---

**Version History**

| Version | Change |
| --- | --- |
| 1.35.0 | 2026-10-14 — §Cross-Chain Reshield new "Destination capability gate" paragraph: `estimateReshieldCrosschainAmount` / `prepareReshieldCrosschainQuote` refuse, before any quote, a destination whose relayer publishes `destinationCallsSupported: false` (no LI.FI receiver contracts, so no bridge can run the deposit call) with new `DestinationCallsUnsupported(toChainId, toChainType)`. Read from a seeded `relayerChainDetails` entry, else the same relayer's destination-chain `/v1/details` (5-minute cache per relayer URL; failures not cached); absent/unreadable = allowed with a warning. §Reshield and Transfer: cross-chain variant inherits it by delegation. |
| 1.34.0 | 2026-10-13 — Cross-chain destination gas: every cross-chain destination deposit call (cross-chain reshield estimate probe + prepare quote, cross-chain swap-and-deposit) now gets a flat 2,000,000 `toContractGasLimit` (`CROSS_CHAIN_DESTINATION_GAS_LIMIT`), was 800,000, after prod out-of-gas fallbacks; Across caveat and LayerZero-fee cost noted. Same-chain unchanged. |
| 1.33.0 | 2026-10-09 — Reshield and Transfer (same-chain): a plain (non-yield-share) pool asset is now a valid output, built with the session's `deposit` delegate (optional `PoolSessionReshieldTransferConfig.depositDelegate`; `PrepareReshieldTransferDepositParams.noteValue`, required for a plain output). `reshieldTransfer` is now also built when only a deposit delegate exists. Plain pool rule: a plain output that is the underlying of a configured share throws `InvalidTransactParams` (pass the share). Cross-chain unchanged. EXTENSION; no contract, circuit or relayer change. |
| 1.32.0 | 2026-10-09 — §Cross-Chain Reshield new "Native input: fund the bridge's fee from the budget" paragraph: `prepareReshieldCrosschainQuote` no longer refuses a native-input route outright when its quoted `transactionValue` (`fromAmount + bridge fee`) exceeds `netSwapAmount` — it re-quotes once with `fromAmount` shrunk to fund the fee and only refuses if that still doesn't fit or the fee would consume the whole amount. `estimateReshieldCrosschainAmount` sizes off the same reduced probe; the dust check now counts the fee as consumed, not dust. See [withdraw-and-swap.md](withdraw-and-swap.md) §Cross-Chain Reshield for the full rationale and the production incident. |
| 1.31.0 | 2026-10-08 — `PrepareSwapQuoteParams.extraGas`: relayer `max_native_gas_wei` clamp removed; the top-up is exactly `extraGasFundAmount` × gas price, folded into `feeAmount`, bounded by `maxRelayFee`. |
| 1.30.1 | 2026-10-08 — §Cross-Chain Reshield "B2 `swapValue` relayer cap": caps are now cached per relayer (`chainId` + signer address, 5-minute TTL `RELAYER_CAPS_TTL_MS`) instead of fetching `/v1/details` on every B2 sizing; failed fetches are not cached; new optional `PoolSessionReshieldCrosschainConfig.relayerChainDetails` seeds the cache (EVM: `EvmPoolSessionConfig.relayerChainDetails`, filled by `PoolSessionBuilder.withRelayerDetails`). |
| 1.30.0 | 2026-10-08 — §Cross-Chain Reshield: new "B2 `swapValue` relayer cap" paragraph — the B2 sizing used by `estimateReshieldCrosschainAmount` / `prepareReshieldCrosschainQuote` checks `swapValue` against the relayer's published `max_swap_value_wei` (`/v1/details` → `relayerCapsFromDetails`) and throws `SwapValueExceedsRelayerCap` before the gas-swap quote and proving; skipped with a warning when the cap is unavailable. |
| 1.29.0 | 2026-10-05 — Swap-and-deposit for someone else (DEV-489, EXTENSION). `SwapAndDepositParams.recipient?: DepositForRecipient` routes the embedded deposit through `prepareDepositFor` (same forms) for a plain pool token and through `YieldSwapDepositTarget.prepareSwapDeposit(..., recipient)` (so `prepareYieldDepositFor`) for a yield share, same-chain and cross-chain. The same-chain native Executor path (v1.27.x) embeds the recipient proof unchanged; its dust refund still goes to the payer. The note is unowned and never persisted by the payer's session. New exported types `DepositForRecipient` (the recipient half of `DepositForParams`, which is now `DepositParams & DepositForRecipient`; `YieldDepositForRecipient` is an alias of it), `NoteDataBuilder` / `NoteDataBuilderInput`: the blind form's `noteData` may be a synchronous builder resolved once the label and commitment are fixed (async builders are rejected by the schema). `SwapAndDepositParamsSchema` validates `recipient`. No change without `recipient`; no relayer, LiFi, contract or wire-format change. |
| 1.28.1 | 2026-10-13 — New optional `onBroadcast?: (txHash: Hex) => void` on `ReshieldParams` and `ReshieldCrosschainParams` (`relayReshield` / `relayReshieldCrosschain`). Fired once with the relayed tx hash as soon as the relayer accepts it, before the receipt wait; local only, never forwarded to the relayer. A throwing callback, or a rejected promise from an async one, is logged and swallowed via the new `utils/BroadcastCallback.ts` `notifyBroadcast` — it must never fail the relay. No API-shape change beyond the new optional field. |
| 1.28.0 | 2026-10-02 — New "Reshield and Transfer" section: `PoolSessionReshieldTransfer` / `PoolSessionReshieldTransferCrosschain`, chain-agnostic core-sdk sessions that redeposit on behalf of a third-party recipient (full API: estimate/prepare-deposit/prepare-quote/relay, dust-recovery-to-originator, construction gating). §Cross-Chain Reshield: `estimateReshieldCrosschainAmount`/`prepareReshieldCrosschainQuote`/`relayReshieldCrosschain` now also validate `toChainType` against the session's configured `destinationChainType` (required on `PoolSessionReshieldCrosschainConfig`) — closes a chain-id-collision gap now that more than one chain type exists; see [withdraw-and-swap.md](withdraw-and-swap.md) v1.12.1 for the full rationale. No contract change; `createEvmPoolSession` defaults `destinationChainType` to `"evm"`. |
| 1.27.1 | 2026-10-02 — Security fix: swap-executor screening. LiFi's `Executor` is on `RelaySwaps.approvedRouters` but runs arbitrary calls for anyone, defeating the byte-containment checks and making any allowance granted to it spendable by anyone. New `ISwapChainAdapter.isSwapExecutorCall` / `isSwapExecutor` and core-sdk util `assertNoSwapExecutor` (`UnexpectedTransactionTarget`). `isSwapExecutor` fails closed on read failures. Swap-and-deposit accepts only the session-composed same-chain native deposit as an executor transaction (fully decoded; `callValue == depositMsgValue`, `msgValue == 0`, inner leg executor-free); the approval spender is never an executor. Withdraw-and-swap, reshield and cross-chain reshield (incl. the B2 gas-swap quote and `gasSwapCalldata`) screen at prepare and at relay time on the decoded routing. Withdraw-and-swap rejects an empty-address-sentinel cross-chain `fallbackAddress` (`InvalidTransactParams`) at prepare and relay time. |
| 1.27.0 | 2026-10-01 — Chain-neutral relayed registration and Stellar parity. `prepareRelayedRegistration` now builds/signs through `IKeystoreInteractor.buildRegistrationAuthorization` / `signRegistrationAuthorization`; `PreparedRelayedRegistration.typedData` is `RelayedRegistrationAuthorization = Eip712TypedData \| SorobanRegistrationAuthorization` and on Stellar `signature` carries the signed auth entry (hex XDR). `prepareRegisterAndWithdrawRelay` documents `encodeTransact`'s new `deferSimulation` option (Stellar builds unsimulated); standalone relayed registration stays EVM-only. Package scope: yield sessions are now chain-agnostic core classes; `ChainSessionBuildContext.buildDeposit({ entrypointInteractor })` documented. Transfer: corrected the `amountOut == 0` wording — `prepareTransfer` / `relayTransfer` set `amountOut = feeAmount` (the fee is the only public outflow, paid to the relayer as processor), on both chains. |
| 1.26.1 | 2026-09-24 — Input-note `tokenId` equality is case-insensitive in `TransactOrchestrator.getNotesTokenId` (the last raw comparison in the transact pipeline; hex ids fold case, other encodings compare as-is). A QA account holding two approved ppUSDT notes, one with the checksummed address and one lowercase, could only spend one of them per transact; both now go into one proof. Different tokens are still rejected with `InvalidTransactParams`. Documented on the `TransferParams.tokenId` row; the rule is shared by every transact-shaped flow. Numbered after 1.26.0 (`v2.0`, route-guarantee sizing), which this branch predates. |
| 1.26.0 | 2026-09-24 — Cross-chain destination budget = LiFi's route guarantee. `estimateReshieldCrosschainAmount` documents its actual 98% plain-quote sizing and now, when a `swapAndDepositQuoteProvider` is configured, probes the contractCalls route with placeholder calldata (`ESTIMATE_PROBE_CALLDATA`) and sizes the deposit down to the encoded guarantee × (1 − `DESTINATION_GUARANTEE_MARGIN_BPS` = 100 bps) when lower. `prepareReshieldCrosschainQuote` / cross-chain `prepareSwapAndDeposit`: the `DestinationDepositUnaffordable` gate now runs on every route (`decodeLiFiDestinationCallAmount` → `destinationCallAmount` → Stargate `minAmountLD` fallback), not only Stargate/B2, with `affordableNoteValue` sized from `destBudget × (1 − 100 bps)`; new pre-flight error `NativeDestinationDepositUnsupported` refuses a plain native-coin `Entrypoint.deposit{value}` cross-chain (native-mode yield router exempt). No contract, relayer or wire-format change. |
| 1.25.5 | 2026-09-24 — Doc-only correction of the cold-start transfer description. `recipientDiscoveryData: { evmAddress }` for an unregistered recipient does NOT silently fall back to `outOfBand`; `prepareTransfer` throws `RecipientViewingKeyUnregistered` unless the caller passes `allowOutOfBandFallback: true` (the field already existed in the schema/types). `prepareColdStartTransfer` remains the explicit out-of-band path. No code change. |
| 1.25.4 | 2026-09-24 — (a) Same-session partial-registration resume (EXTENSION). `executeRegisterKeystore` no longer throws `AlreadyRegistered` after a successful resume: it calls `keystoreManager.markRegistered(chainId)` only when `!keystoreManager.isRegistered(chainId)`. Previously `registerKeystore({ includeViewingKey: false })` followed by `registerKeystore()` in the same session took the partial-resumption path (`keystoreCalldata: null`, only `setViewingKey` built), submitted it, then threw `AlreadyRegistered` from `KeystoreManager.markRegistered` after the tx had already succeeded. `KeystoreManager.markRegistered` itself is unchanged. (b) Validate everything before signing anything (EXTENSION). `executeDeposit` now verifies `depositTx` (Entrypoint target, `deposit` selector) before submitting any ERC-20 approval, not after the approvals were mined; `executeRegisterKeystore` verifies both `keystoreCalldata` (`setAuthPolicy`) and `viewingKeyCalldata` (`setViewingKey`) before submitting the first, so a tampered second transaction leaves no partial registration. Both throw `UnexpectedTransactionTarget` with nothing submitted. `executeSwapAndDeposit` already behaved this way. Docs: `prepareRegisterKeystore` now documents the partial-resumption path and its real result shape (`keystoreCalldata` / `viewingKeyCalldata` / `authDigest`); new `executeRegisterKeystore`, `registerKeystore` and `executeDeposit` entries. No API-shape change. |
| 1.25.3 | 2026-09-24 — Fail-fast keystore-registration precheck before witness building (extension; reuses the existing `KeystoreNotRegistered`). New helper `assertKeystoreRegistered` reads `Keystore.getNullifyingKeyHash(owner)` (zero = not registered) and throws `KeystoreNotRegistered` or, when the read fails, `RegistrationCheckFailed`. Wired into `TransactOrchestrator.prepareTransact` (session owner; after input-note validation, before merkle leaves are fetched; skipped when `pendingKeystoreRegistration` is set, i.e. `prepareRegisterAndWithdrawRelay` / `registerAndWithdraw`) and `PoolSessionRagequit.prepareRageQuit` (note owner, after the EXITED / addressless guards). Throws of prepare/relay withdraw, transfer, cold-start transfer, payment-request fulfilment, batch withdraw, withdraw-and-swap, reshield, cross-chain reshield and ragequit gain the two errors; interface `@throws` lists `PoolSessionKeystoreBaseError`. `isKeystoreRegistered()` shares the read (no behaviour change). A registered owner with wrong/rotated keys still fails as `WitnessPreparationFailed` (`LeafNotFound`). No API-shape change. |
| 1.25.2 | 2026-09-23 — Bug fix: `relayWithdrawAndSwap` and `relayReshield` (and their prepare/estimate steps) used `selectedQuote.relayerInfo.processorAddress` — the relayer's withdrawal-only `PrivacyPoolRelay` — as the proof-bound `TransactParams.processor`, as the swap quote's `fromAddress`, and as the address whose `approvedRouters`/`approvedZaps` allowlists vet the aggregator quote. A relayed swap actually executes via `RelaySwaps.execute()`, which calls `PoolVault.transact()` itself, so relayed swaps reverted `PoolVault_ProofContextMismatch` and reshield's router-allowlist read hit `PrivacyPoolRelay` (no `approvedRouters`). Both sessions now take an optional `relaySwapsAddress` (from `PoolSessionConfig.relaySwapsAddress`, wired by `PoolSessionFactory` / `EvmPoolSessionFactory`) and use it for all three purposes; the swap methods throw `InvalidTransactParams` if it is unset (e.g. Sepolia v9, where RelaySwaps is not yet deployed). `PoolSessionReshieldCrosschain` still uses `relayerInfo.processorAddress` and is expected to have the same defect (not yet fixed). No API-shape change beyond the new optional config field. |
| 1.25.1 | 2026-09-22 — Bug fix: `relayTransfer` bound `TransactParams.processor` to `selectedQuote.relayerInfo.processorAddress` (the relayer's withdrawal fee-processor contract), not the address the relayer actually submits with for a private transfer. Per contracts-tech-design.md §4, transfer moves no value out of `PoolVault` (`amountOut == 0`; the fee is a change note, not an external payout), so the relayer calls `PoolVault.transact()` directly with itself as `msg.sender` — never through the withdrawal processor contract. The mismatch baked a `processor` into the proof context that a correctly-behaving relayer's submission could never match, so every relayed transfer (`relayTransfer`, and `prepareFulfillPaymentRequest` → `relayTransfer` for payment-request fulfillment) reverted with `PoolVault_ProofContextMismatch()`. `relayTransfer` now binds `processor: selectedQuote.relayerInfo.address`. No API-shape change. |
| 1.25.0 | 2026-09-18 — Yield shares as swap-shaped *outputs* (P5 of `relayswaps-yield-unwrap.md`, plan in `future-ideas/cross-chain-reshield-into-yield.md`). `SwapAndDepositParams.depositToken`, `ReshieldParams.outputToken` and `ReshieldCrosschainParams.outputToken` accept a ppToken when the session has a matching `yieldDepositTargets` / `destinationYieldDepositTargets` entry (auto-wired from `session.yields` by `PoolSessionFactory`; cross-chain via `PoolSessionBuilder.withDestinationYieldDepositTargets()`). The LiFi final leg becomes `PPRouter.depositExactShares` (or `depositExactSharesNative` for a `nativeMode` deployment) with `toApprovalAddress` = the router; shares are sized from the delivered budget (`sizeSharesForBudget`, 1 ppm same-chain / 500 ppm cross-chain headroom), the cap is the full budget, estimates report `noteValue` in shares, `vettingFee` = 0 and `totalDepositCost` = the funding-token budget; `PrepareSwapAndDepositResult` gains `depositMsgValue`. Target asserts accept the configured, chain-bound router and run `assertYieldDepositMatches`. New exports in `utils/YieldSwapOutput.ts`, `YieldDeployment.nativeMode`, `YieldSessions.chainId`, `PP_ROUTER_DEPOSIT_NATIVE_ABI`, `CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM`. |
| 1.24.0 | 2026-09-17 — vuln-mining #28 (Tether-style `approve`): every ERC-20 approval site now plans `[approve(0), approve(n)]` when the current allowance is non-zero and insufficient (`utils/Erc20Approval.ts` `planApprovals`), else `[approve(n)]` or `[]`. `PrepareDepositResult`, `PrepareSwapAndDepositResult` and `PreparedYieldDeposit` gain `approvalTxs: PreparedTransaction[]`; `approvalTx` stays as the last element (now nullable on `PreparedYieldDeposit`, which previously always approved even when the allowance sufficed). `executeDeposit` / `executeSwapAndDeposit` validate every approval before submitting any, then submit in order. `PoolSessionYieldDeposit` gains an optional `allowanceOf` (wired by the factory via `EntrypointInteractor.getAllowance`) so the rate headroom left approved by a previous yield deposit is reset before the next one — mainnet ppUSDT deposits used to fail on the second attempt. |
| 1.23.6 | 2026-09-17 — Security fix (RC-32): §prepareSwapAndDeposit's Throws list gains `RelaySwapsLayoutMismatch` — `prepareSwapAndDeposit`/`executeSwapAndDeposit` (and, per [withdraw-and-swap.md](withdraw-and-swap.md), `PoolSessionSwap`/`PoolSessionReshield` too) now read the target `RelaySwaps.ROUTING_TYPEHASH()` and compare it against a new SDK constant, `RELAY_SWAP_ROUTING_TYPEHASH`, in the same pre-proof step that already checks LiFi's addresses against `approvedRouters` — throwing before proof generation if a deployment's compiled `SwapRouting` shape disagrees with what this SDK build encodes. No API-shape change. |
| 1.23.5 | 2026-09-17 — Security fix (finding #8): §Stealth Dust Rescue — `dust-rescue-prover`'s note value is now netted of the destination Entrypoint's live vetting fee (`sweptAmount × 10000 / (10000 + vettingFeeBPS)`) instead of sized at the raw swept amount, which left the rescue wallet short by exactly the fee on every fee-bearing asset. `proveDustRescueDeposit()`'s result gains a `noteValue` field. No SDK API change (relayer-only). |
| 1.23.4 | 2026-09-16 — Security fix (RC-10 / vuln-mining #10): `dustRescue`'s `destinationChainId`/`tokenId`/`recipientIdentifier` are now proof-bound, encoded into the on-chain `SwapRouting.dustRescue` field the relayer signs at quote time instead of travelling as an unsigned field on the `relaySwap` request. `prepareReshieldCrosschainQuote()`'s committed `getSwapQuote` call now forwards `dustRescue` (it never did before — the request-tampering gap this closes); `relayReshieldCrosschain()` no longer attaches `dustRescue` to `relaySwap` separately, since it already rides inside the signed commitment. `assertReshieldCrosschainRouting` gained a `dustRescue` check alongside its existing per-field routing re-verification. Requires a `RelaySwaps.sol` redeploy (new nested `DustRescue` struct on `SwapRouting`); no circuit change. The *later rescue deposit itself* remains relayer-discretionary — see "Stealth Dust Rescue" below, updated accordingly. |
| 1.23.4 | 2026-09-16 — Doc-only. Moved to `docs/tech-design/core-sdk/` following the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` package split; added a "Package scope" note clarifying that this page's sessions (including the genericized swap/reshield/swap-deposit sessions, now wired via `EvmSwapChainAdapter`) live in `packages/core-sdk`, while `EvmPoolSession`/`PoolSessionBuilder` and the yield sessions are `packages/evm-sdk`-only. No behavior change. |
| 1.23.3 | 2026-08-26 — Security fix (audit finding #221): `prepareReshieldQuote`'s internal flow gains a new step asserting the committed `feeCommitment.amountSent` equals the requested gross withdrawal `amount` before the routing decode, closing a gap where reshield's only prior guard (`amountSent == amount + feeAmount` at relay time) was tautological — `amount` there is itself derived as `amountSent - feeAmount`, so it could never fail regardless of how much the relayer inflated `amountSent`. Mirrors the pre-existing `prepareSwapQuote` guard (step 7 above) and `PoolSessionReshieldCrosschain.prepareReshieldCrosschainQuote`'s identical fix (same shape as `prepareReshieldQuote`). No API-shape change — reuses `InvalidTransactParams`. |
| 1.23.2 | 2026-08-20 — Extend the AW-L-02 / #1070 verify-before-persist gate to `relayReshieldCrosschain`, the last uncovered relay path. Cross-chain reshield landed on `v2.0` after this branch forked, so it was written against the pre-1.22.0 signature and called `persistNoteUpdates` bare — persisting notes as `SPENT` on an unverified relayer `txHash`, unrecoverable because `SPENT` is terminal. Surfaced by merging `v2.0` in: the **required** `verification` parameter from 1.22.0 turned the omission into a compile error, exactly as intended. `PoolSessionReshieldCrosschain` now destructures `spentNullifiers` from `prepareTransact` and threads `{ expectedNullifiers, receiptLogs }`, mirroring `relayReshield`; its unit test's orchestrator double now returns `spentNullifiers` and asserts the verification argument (it previously asserted the three-argument call). No API-shape change. |
| 1.23.1 | 2026-08-15 — Make the 1.23.0 expiry actually reach the sender, and stop the deadline itself from causing the loss it prevents (#600, review residuals). `generatePaymentRequest` hand-built the shareable payload and dropped `record.expiresAt`, so every request the SDK issued carried no stamp — which the grandfathering rule reads as "never expires", leaving the new sender-side guard unreachable in production while the recipient still dropped the request at 7 days. It now carries the stamp through (conditionally, so a legacy unstamped record still yields no key rather than an explicit `undefined`). Separately, `isExpired` now compares against `expiresAt + SCAN_EXPIRY_GRACE_MS` (24h) so the recipient keeps scanning past the sender's deadline: a payment that was legitimate when submitted still has to prove, submit, and be included, and a scan set closing at `expiresAt` exactly would strand it. The sender's bound is unchanged at `expiresAt`. Both constants moved to `src/constant/PaymentRequest.ts`. |
| 1.23.0 | 2026-08-14 — Payment-request expiry is now **sender-visible and SDK-enforced** (#600). `expiresAt` (unix-ms hex) is a field on the public, shareable `PaymentRequest` payload, and `prepareFulfillPaymentRequest` throws the new `PaymentRequestExpired` before any proof work when it has passed. Previously the bound was recipient-local, so a sender could pay a lapsed link and create a note that is on-chain, valid, and undiscoverable by the recipient through the payment-request path. A UI-level warning alone is insufficient — the SDK is the layer that can refuse to spend. Requests carrying no `expiresAt` predate the policy and never lapse, so already-shared requests are not retro-voided; the field is optional in the wire format, so older QR/link payloads still parse. |
| 1.22.0 | 2026-08-14 — Close the fail-OPEN hole in the AW-L-02 / #1070 verify-before-persist gate. `verification` is now **required** on `ITransactOrchestrator.persistNoteUpdates` and `IBatchWithdrawOrchestrator.persistBatchNoteUpdates` (was optional). While optional it silently no-op'd, and the relayed swap paths `relayWithdrawAndSwap` + `relayReshield` called persist bare — persisting SPENT on an unverified relayer `txHash`. `SPENT` is terminal, so that corruption is unrecoverable by `discoverNotes()`. Both swap paths now thread `{ expectedNullifiers, receiptLogs }`, and the required parameter makes any future omission a compile error. Adversarial regression tests added for both paths (their doubles previously stubbed persist and asserted nothing). |
| 1.21.0 | 2026-07-30 — Extend the AW-L-02 / #1070 verify-before-persist gate to the internal-transfer paths (`relayTransfer` + self-submit `executeTransfer`), closing the same bogus-`txHash` note-state-corruption vector on transfers that #1070 closed on withdrawals (found by the SDK-cluster quality loop). `finalizeTransfer` now threads `{ expectedNullifiers, receiptLogs }` into `persistNoteUpdates`; `ExecuteTransferParams` gains `spentNullifiers` (`= proof.publicSignals[0:nInputs]`, sourced from the transfer prepare result). Same verify-and-WARN semantics (mismatch → warn + persist nothing, never strand). |
| 1.20.0 | 2026-07-30 — Verify-before-persist for relayed withdrawals (audit **AW-L-02** / #1070). `relayWithdraw`, `registerAndWithdraw`, and the self-submit `executeWithdraw` now parse the confirmed receipt's `Transacted` logs and require every spent note's nullifier hash to appear in a log emitted by the expected PoolVault before marking the notes SPENT — so a relayer returning the hash of an unrelated successful tx cannot make the wallet treat spendable notes as spent. Verify-and-WARN, not a hard gate: on a mismatch the SDK warns and persists nothing, relying on `discoverNotes()` as the backstop (a benign log-parse miss never strands a genuine spend). New `IPoolVaultInteractor.extractSpentNullifiers(logs)`; `PrepareTransactResult` / `PrepareWithdrawResult` gain `spentNullifiers` (`= proof.publicSignals[0:nInputs]`); `persistNoteUpdates` gains an optional `verification` (`{ expectedNullifiers, receiptLogs }`). Contracts finding #966 (relayBatch atomicity) is separate and out of scope; a whole-tx `!status` still persists nothing. No public session API-shape change. |
| 1.19.4 | 2026-08-17 — Doc-only. §Stealth Dust Rescue: submission wiring is RESOLVED — `DustRescueOrchestratorService` no longer computes or submits the rescue deposit itself (that logic moved to the new standalone `packages/relayer/dust-rescue-service`, see `docs/tech-design/relayer/dust-rescue-service.md`); the orchestrator is now a thin `Scope.REQUEST` Pub/Sub publisher. No SDK code change — `PoolSessionReshieldCrosschain`'s API is unaffected. |
| 1.19.3 | 2026-08-14 — Storage-agnostic leaf-cache seed/export, threaded through the builder and facade: `PoolSessionBuilderBaseConfig` gains optional `keystoreLeafCacheSeed` / `stateLeafCacheSeed` (`LeafCacheSeed`, see [contract-interactor.md](contract-interactor.md)), passed into the `KeystoreInteractor`/`PoolVaultInteractor` constructors at `PoolSessionBuilder.create()` (ignored when an interactor override is supplied). New facade methods `exportKeystoreLeafCache()` (always available) and `exportStateLeafCache()` (throws new `PoolSessionLeafCacheBaseError` when `poolVaultInteractor` isn't configured) snapshot the current cache state for persistence across process/session boundaries. Additive, no API-shape change to existing methods. |
| 1.19.2 | 2026-08-14 — Rolled the explicit pre-commitment `warmMerkleCaches()` await out to five more flows: `PoolSessionReshield.prepareReshieldQuote()`, `PoolSessionWithdrawAndSwap.prepareSwapQuote()`, `PoolSessionWithdraw.prepareWithdraw()`, `PoolSessionTransfer.prepareTransfer()` / `prepareColdStartTransfer()`, and `PoolSessionBatchWithdraw.prepareBatchWithdraw()` (new `IBatchWithdrawOrchestrator.warmMerkleCaches()` passthrough to `ITransactOrchestrator.warmMerkleCaches()`, additive interface method — see [batch-withdraw.md](batch-withdraw.md)). `PoolSessionYieldWithdraw` remains an open gap (no internal committed-quote call site to hook into). No API-shape change for the other four. |
| 1.19.1 | 2026-08-13 — `prepareReshieldCrosschainQuote()`'s explicit pre-commitment await now calls the renamed, broadened `ITransactOrchestrator.warmMerkleCaches()` (was `warmKeystoreCache()`), which awaits both the keystore leaf cache and the newly-added `PoolVaultInteractor.getStateLeaves()` state-tree leaf cache in parallel via `Promise.all` (see [contract-interactor.md](contract-interactor.md) and [core-sdk-tech-design.md](core-sdk-tech-design.md)). The "Known gap" note is updated to reference `warmMerkleCaches()` by its new name; the gap itself (the other 6 `prepare*Quote()`-style flows only get the background warm-up, not the explicit await) is unchanged. No API-shape change. |
| 1.19.0 | 2026-08-13 — `PrepareSwapQuoteParams` gains optional `denyExchanges: string[]` — LiFi tool/exchange names to exclude from routing (e.g. `["fly"]`), forwarded to `swapQuoteProvider.getSwapQuote()` inside `prepareSwapQuote()`. Same mechanism/motivation as the existing `SwapQuoteRequest.denyExchanges` (see [withdraw-and-swap.md](withdraw-and-swap.md) Security Properties and [lifi-swap-quote-provider.md](../evm-sdk/lifi-swap-quote-provider.md)) — now reachable from the convenience method without dropping to the provider interface directly. No breaking change. |
| 1.18.0 | 2026-08-10/11 — "Camouflaged dust-rescue delivery": **supersedes 1.17.0's `RelaySwaps.rescueDust`/`DustRescued` design**, reverted for publicly tagging rescue deposits (contradicted the anonymity requirement). Delivery now packs the encrypted note payload straight into a plain `Entrypoint.deposit(...)` call's own `noteData.data` — no distinct selector or event. `RelaySwaps.rescueDust`/`DustRescued`/`DustRescueAnnouncement`/`RELAY_SWAPS_RESCUE_DUST_ABI` all removed. New stealth-module exports `encodeStealthDepositPayload` (sender-side packing) and `scanDepositNoteData` (recipient-side sibling to `scanAnnouncement`, `stealth/scan.ts`). New `NoteDiscoveryService.scanStealthDeposits` — the first discovery path for stealth-owned deposits; `DiscoveredNote` gains optional `ownerAddress` (the derived stealth address, not the scanning session's own), threaded through `PoolSessionNoteDiscovery.discoverNotes()`'s commitment computation via a new opt-in `DiscoverNotesParams.stealthDepositCredentials`. `packages/relayer/dust-rescue-prover`'s result shape changed accordingly (`depositCallData`/`depositTarget`/`depositMsgValue`/`approvalTx` replace the earlier `rescueDust*`/`approvalAmount` fields — a net simplification, since the module no longer needs to separately compute `amountPlusFee`: `prepareDepositFor`'s own `msgValue`/`approvalTx` are already correctly sized for the plain deposit call). See "Stealth Dust Rescue" above and `agents/deviations.md` INTL-09. |
| 1.17.0 | 2026-08-07 — **Superseded by 1.18.0, kept for history.** Stealth dust-rescue secret delivery resolved: new stealth-module exports `deriveStealthSharedSecret` (sender) / `recoverStealthSharedSecret` (recipient) expose the ECDH shared secret the stealth derivation already computes internally, reused (via `CryptoService.encrypt`) to encrypt the rescue note's `noteSecret`. New `RelaySwaps.rescueDust(...)` contract function (`packages/swaps/contracts/src/RelaySwaps.sol`, owner-only) deposits the rescued amount and emits `DustRescued` with the encrypted secret in the same transaction; new SDK ABI constant `RELAY_SWAPS_RESCUE_DUST_ABI`. `packages/relayer/dust-rescue-prover`'s result shape changed accordingly (`rescueDustCallData`/`rescueDustTarget`/`rescueDustMsgValue`/`approvalAmount` replace the earlier separate deposit+announce fields). See "Stealth Dust Rescue" above and `agents/deviations.md` INTL-09. |
| 1.16.1 | 2026-08-13 — `prepareReshieldCrosschainQuote()` now explicitly awaits `ITransactOrchestrator.warmKeystoreCache()` before requesting the relayer's committed quote, so the (potentially slow, first-ever) keystore leaf scan finishes before that quote's fee-commitment expiration clock starts — root-caused from a mainnet `FeeCommitmentExpired` failure (see the "Cross-Chain Reshield" section's `prepareReshieldCrosschainQuote()` entry). `getKeystoreLeaves()` itself now caches leaves in-memory and delta-fetches (see [contract-interactor.md](contract-interactor.md)); `PoolSessionBuilder` warms this cache in the background at session construction. Noted as a known gap: the equivalent explicit await has not yet been added to `prepareReshieldQuote()`, `prepareSwapQuote()`, or the withdraw/transfer/batch-withdraw/yield-withdraw prepare paths. No API-shape change. |
| 1.16.0 | 2026-08-07 — Cross-chain reshield: new `PoolSessionReshieldCrosschain` service + facade methods `estimateReshieldCrosschainAmount` / `prepareReshieldCrosschainQuote` / `relayReshieldCrosschain` (see new "Cross-Chain Reshield" section above). `PoolSessionConfig` gains optional `destinationChainId` / `destinationEntrypointInteractor`; `PoolSessionBuilder`/`PoolSessionBuilderConfig` gain matching `destinationChainId` / `destinationRpcUrl` / `destinationDeployment` / `.withDestinationEntrypointInteractor()`. New errors `DestinationChainNotSupported`, `DestinationDepositTargetMismatch`, `DustRescueRecipientConflict` (all `PoolSessionTransactBaseError`, in `errors/PoolSessionTransact.ts`). Optional stealth "dust rescue" opt-in (`dustRescue: { recipientIdentifier }`) forwarded through to the relayer as `RelaySwapDustRescue` on `SwapRelayParams` — the relayer, not the client, generates and (not yet) submits the rescue deposit; see the "Stealth Dust Rescue" subsection for the accepted trust extension and the known secret-delivery gap. Relayer-side: new isolated `packages/relayer/dust-rescue-prover` package and `DustRescueOrchestratorService` in `packages/relayer/relayer` (see `agents/deviations.md`). |
| 1.16.3 | 2026-08-18 — Two swap-and-deposit hardening guards: (1) the RelaySwaps allowlist cache key now includes the chainId, so a router approved on one chain can no longer satisfy a query against a different chain's RelaySwaps deployed at the same address (deterministic-deployment case); (2) `prepareSwapAndDeposit` rejects an explicit zero `fallbackAddress` (`InvalidSwapAndDepositParams`) — it would send bridged funds to the burn address on a failed destination deposit; omit the field to default to the owner. No API-shape change. |
| 1.16.2 | 2026-08-18 — `executeSwapAndDeposit` now re-validates the swap transaction before signing instead of trusting the passed `PrepareSwapAndDepositResult` verbatim: `transactionTo`/`approvalAddress` re-checked against the on-chain allowlist, `depositTarget` must equal the session's Entrypoint, deposit calldata re-verified as embedded in `transactionData`, and the approval amount bounded by the estimated input (`UnexpectedTransactionTarget` on excess). `PrepareSwapAndDepositResult` gains `depositCallData` and `depositTarget`; `assertApprovalTx` gains the amount bound. Closes the tampered-result gap where a result round-tripped through untrusted storage/transport could redirect funds or grant an unbounded approval. No API-shape change to method signatures. |
| 1.16.1 | 2026-08-18 — `prepareSwapAndDeposit` now validates LiFi's returned route against the request (`SwapQuoteMismatch` on any `fromChainId`/`toChainId`/`fromToken`/`toToken` divergence), mirroring `PoolSessionReshieldCrosschain`. Prevents a buggy/compromised quote from delivering the deposit to a different chain — critical because the protocol reuses one Entrypoint address across chains and the deposit calldata is chain-agnostic. No API-shape change. |
| 1.16.0 | 2026-08-18 — Cross-chain swap-and-deposit. `PoolSessionSwapDeposit` accepts an optional `sourceChain` attachment (`{ chainId, walletInteractor, rpcInteractor, relaySwapsAddress }`; builder config `sourceChain: { chainId, rpcUrl, walletInteractor, relaySwapsAddress }`, factory config `swapDepositSourceChain`). With it, `prepareSwapAndDeposit` accepts `fromChainId = sourceChain.chainId`: the input-token allowance is read on the source chain, LiFi's `transactionTo`/`approvalAddress` are validated against the **source chain's** `RelaySwaps.approvedRouters`, and the new optional `SwapAndDepositParams.fallbackAddress` (default `ownerAddress`) is forwarded as LiFi's `toFallbackAddress`. `executeSwapAndDeposit` signs/sends both transactions with the source-chain wallet, returns the **source-chain** receipt, and skips local note persistence (no destination commitment exists yet — the caller retains `pendingNote`; the note is picked up by normal on-chain sync after delivery). `PrepareSwapAndDepositResult` gains `fromChainId`. Builder validates the source wallet against `ownerAddress` + `sourceChain.chainId` and rejects `sourceChain.chainId === chainId`. Same-chain behavior unchanged. |
| 1.15.0 | 2026-07-28 — Swap-path gas top-up aligned with the withdrawal path's boolean opt-in: `PrepareSwapQuoteParams.nativeGas` (`Hex?`) replaced by `extraGas` (`boolean?`, default `false`, still forbidden cross-chain); relayer wire field `SwapQuoteParams.nativeGas` (string amount) replaced by `extraGas` (boolean). The relayer computes the top-up amount, clamps it at `max_native_gas_wei`, and folds its oracle-converted cost into `feeAmount`; the resolved amount is committed as the signed routing's `nativeGas` (on-chain layer unchanged). `ExecuteWithdrawAndSwapRelayerParams` gains optional `extraGas` (echo of the prepare flag); `relayWithdrawAndSwap` now always validates routing `nativeGas` against it — off → `0`, on → nonzero (previously the same-chain path skipped this check). Plain-withdrawal `prepareWithdraw.nativeGas` unchanged. |
| 1.14.5 | 2026-07-14 — Restored a further batch of audit guards dropped in the same merge (SDK). `relayWithdrawAndSwap` / `relayReshield` now reject a fee commitment whose `feeCommitment.asset` differs from the withdrawn `tokenId` (`InvalidTransactParams`) before proving — mirrors the plain-withdraw asset rule. `prepareSwapQuote` now rejects a committed `feeCommitment.amountSent` that differs from the requested gross withdrawal `amount` (`InvalidTransactParams`; defense-in-depth alongside the relay-path `amountSent == amount + fee` check). `prepareSwapAndDeposit` again fails fast with `InvalidSwapAndDepositParams` when `fromChainId` differs from the pool `chainId` (cross-chain swap-and-deposit is not supported; same-chain only). No API-shape change. |
| 1.14.4 | 2026-07-14 — Restored three audit guards dropped in a merge (SDK). `executeSwapAndDeposit` re-validates the prepared `approvalTx` (target = input token, selector = `approve`, spender = `approvalAddress`/LiFi router) and throws `UnexpectedTransactionTarget` on mismatch. `relayReshield` / `relayWithdrawAndSwap` re-assert the fee commitment is not expired before the ~30-60 s `prepareTransact`, and their consolidated routing assert now also rejects a zero `feeRecipient` when `feeAmount > 0` (`InvalidTransactParams`), mirroring the on-chain `RelaySwaps_ZeroFeeRecipient` revert that would otherwise burn the fee. No API-shape change. |
| 1.12.1 | 2026-07-10 — Doc-only errata: the `relayWithdrawAndSwap` validation list and the cross-chain paragraph still referenced the removed `swapCalldataHash`/`keccak256` check and "LiFi calldata hash". Corrected to the byte-equality wording already used elsewhere in the section and recorded in the 1.12.0 entry (`assertSwapCalldataMatches`). No code change. |
| 1.11.1 | 2026-07-10 — `prepareRelayedRegistration` now calls `isKeystoreRegistered()` up front and rejects an already-registered account with the new `KeystoreAlreadyRegistered` error, before any signing — mirroring the direct `prepareRegisterKeystore` path and sparing wasted proof-gen/relayer gas (`registerAndRelay` is idempotent for a matching key and reverts for a mismatching one). Harvested from superseded PR #314. Doc-only. |
| 1.14.3 | 2026-07-09 — Audit **H3** router-allowlist hardening (contract): `RelaySwaps.execute` now requires `approvedRouters[approvalAddress]` in addition to `approvedRouters[swapTarget]` (new `RelaySwaps_InvalidApprovalAddress`), pinning the ERC20-approval target to the vetted allowlist instead of only checking `!= 0`. Owner approves the Diamond and, for LiFi v4, its separate ERC20Proxy (`DeployRelaySwaps` gains an optional `APPROVAL_ADDRESS`). The `// TODO how safe is arbitrary calldata` is resolved with the security model (allowlisted target + approval, proof-bound + SDK-validated calldata). No SDK change — the SDK already validates `approvalAddress` against the LiFi quote; the allowlist is defense-in-depth. Requires a RelaySwaps redeploy. |
| 1.14.2 | 2026-07-09 — Audit **C2** fee-accounting clarity: `PreparedSwapQuote` / `PreparedReshieldQuote` gain `netAmount` (`= amountSent − feeAmount`). `prepareSwapQuote` / `prepareReshieldQuote` take the **gross** withdrawal as `amount`; `relayWithdrawAndSwap` / `relayReshield` take the **net** amount — forward `PreparedSwapQuote.netAmount` verbatim (the gross/net handoff was previously implicit and a naive caller passing gross to both tripped `amountSent == amount + feeAmount`). The relay-side invariant `amountSent == amount + feeAmount` (amount = net) is unchanged. Unit mocks corrected to model the real relayer (`amountSent = gross request amount`, not `amount + fee`), which had masked the mismatch. No relayer / proof-accounting / on-chain change. |
| 1.14.1 | 2026-07-08 — Relay-time swapTarget/approvalAddress validation: `ReshieldParams` and `ExecuteWithdrawAndSwapRelayerParams` gain optional `swapTarget` / `approvalAddress` expecteds (echo the `PreparedReshieldQuote` / `PreparedSwapQuote` fields). When provided, `relayReshield` / `relayWithdrawAndSwap` assert the signed routing's swap target and approval address match — closes the relay-time gap where a tampered quote could redirect approvals and swap calls to a different target. `PreparedSwapQuote` / `PreparedReshieldQuote` also gain the effective `dustRecipient` (echo of the value committed in the signed routing), so prepared quotes with an explicit dust recipient stay self-contained through the prepare→relay flow. |
| 1.11.0 | 2026-07-08 — Relayed keystore registration + atomic register-and-withdraw for fresh, unfunded recipients (INTL-05). Added `prepareRelayedRegistration(options)` — the relayed counterpart to `prepareRegisterKeystore`: computes `nullifyingKeyHash` + `authDigest`, builds the EIP-712 `SetAuthPolicy` payload, signs it via the new `IWalletInteractor.signTypedData` (unless `sign: false`), emits no calldata (the relayer submits `setAuthPolicyWithSig`), and guards a past `deadline` with `RegistrationDeadlineInPast`. Added `prepareRegisterAndWithdrawRelay(params, registration)` — runs the shared `buildGuardedWithdrawTransact` fee/routing guards, builds the withdrawal proof with `pendingKeystoreRegistration: true` (anchoring `keystoreRoot` to the predicted post-insertion root), rejects an unsigned registration, and returns `PrepareRegisterAndWithdrawResult` (`relayer`, `relayParams: RegisterAndWithdrawalRelayParams`, `spentNotes`, `changePendingNotes`) without submitting. New types `RelayedRegistrationOptions` / `PreparedRelayedRegistration`. Predicted root is optimistic — submit via private orderflow. Deferred: yield-specific atomic variant + standalone `/register` endpoint. Doc-only. |
| 1.14.0 | 2026-07-07 — SDK pre-flight validation. New errors extending `PoolSessionTransactBaseError`: `AssetNotSupported`, `DepositBelowMinimum`, `RelayFeeExceedsMax` (checked only when the Entrypoint's `maxRelayFee > 0`; no percentage cap by design), `SwapQuoteMismatch`, `DepositTargetMismatch`. `PoolSessionReshieldConfig` / `PoolSessionWithdrawAndSwapConfig` now require `entrypointInteractor: IEntrypointInteractor` (threaded by `PoolSessionFactory`). `EstimateReshieldParams.vettingFeeBPS` removed — vetting fee read on-chain via `getAssetConfig(outputToken)`. New optional `dustRecipient` on `ReshieldParams` and `ExecuteWithdrawAndSwapRelayerParams`. `PreparedSwapQuote` / `PreparedReshieldQuote` gain `swapTarget` + `approvalAddress` echo fields. Prepare methods run RPC-backed pre-flight (asset enabled, min deposit, fee bounds, LiFi route echo cross-check, deposit-target check before any network call in `prepareReshieldQuote`); relay methods decode the signed routing once via the new shared `decodeRelaySwapRouting()` util (`src/utils/RelaySwapRouting.ts`) and validate the tuple field-by-field offline. |
| 1.13.0 | 2026-07-07 — Cross-chain withdraw-and-swap: optional `toChainId` on `PrepareSwapQuoteParams` and `ExecuteWithdrawAndSwapRelayerParams`. Cross-chain requires explicit `fallbackAddress` (destination-chain address, LiFi `toFallbackAddress`) and forbids `nativeGas`; routing `recipient` is the `address(0)` sentinel (real recipient only in proof-bound LiFi calldata), on-chain `minOutputAmount = 0` (slippage enforced by LiFi's destination executor), `dustRecipient` defaults to the relayer address. `PreparedSwapQuote` gains `destinationMinOutputAmount` (informational LiFi `toAmountMin`); `minOutputAmount` is the on-chain-enforced value (`0x0` cross-chain). `relayWithdrawAndSwap` cross-chain assertions: zero-recipient routing, zero caller `minOutputAmount`, zero routing `nativeGas`. Reshield quote requests now send `recipient: EMPTY_ADDRESS` (zero address) instead of the relayer-address placeholder; `ReshieldParams` no longer includes `minOutputAmount`. Matches renamed/new contract errors `RelaySwaps_NativeGasWithoutRecipient` / `RelaySwaps_MinOutputWithoutRecipient`. |
| 1.12.0 | 2026-07-07 — `SwapRouting` now embeds the full `bytes swapCalldata` instead of `bytes32 swapCalldataHash`. The calldata is proof-bound directly via the `transactParams.data` context hash; the on-chain `keccak256` check and the separate `execute()` calldata argument are removed. SDK validation replaces the hash comparison with a byte-equality check (`assertSwapCalldataMatches`). `SwapQuoteParams.swapCalldata` (full calldata) replaces `swapCalldataHash`; `SwapRelayParams` no longer carries a separate `swapCalldata`. |
| 1.11.0 | 2026-07-07 — Added `prepareSwapQuote(params)` to `PoolSessionWithdrawAndSwap`: orchestrates full swap quoting flow (relayer prelim → LiFi quote → relayer commit) internally, returning `PreparedSwapQuote` with calldata, minOutputAmount, and signed relayer commitment. Added `estimateReshieldAmount(params)` + `prepareReshieldQuote(params)` to `PoolSessionReshield`: two-step reshield quoting (estimate deposits amount from swap output, then prepare full quote after deposit proof). New `swapQuoteProvider?: ISwapQuoteProvider` field on `PoolSessionConfig`. New types: `PrepareSwapQuoteParams`, `PreparedSwapQuote`, `EstimateReshieldParams`, `ReshieldEstimate`, `PrepareReshieldQuoteParams`, `PreparedReshieldQuote`. Added `minOutputAmount` validation in `relayWithdrawAndSwap()` (decodes `SwapRouting.minOutputAmount` from relayer commitment, asserts match with caller value). Smart slippage defaults in `LiFiSwapQuoteProvider`: 0.5% same-chain, 3% cross-chain. |
| 1.10.0 | 2026-07-04 — `RelaySwaps` contract with unified `execute()` entry point and proof-bound swap calldata via `swapCalldataHash` in `SwapRouting` struct. `PoolSessionWithdrawAndSwap`: uses `RELAY_SWAP_ROUTING_ABI` (includes `swapCalldataHash`), validates `swapCalldataHash == keccak256(swapCalldata)`, submits via `RelayerInteractor.relaySwap()` (`POST /relay-swap`). `PoolSessionReshield`: deposit embedded in LiFi calldata via `getContractCallsQuote()`, protected by `swapCalldataHash`. Uses `RELAY_SWAP_ROUTING_ABI` and `RelayerInteractor.relaySwap()` (same endpoint as withdraw-and-swap). New SDK constant: `RELAY_SWAP_ROUTING_ABI`. New `RelayerInteractor.relaySwap()` method at `POST /relay-swap`. `SwapQuoteParams` gains optional `swapCalldataHash` field. |
| 1.9.0 | 2026-07-01 — Added `getSwapStatus(params)` to the PoolSession facade, delegating to the configured `ISwapProvider` (wired from `swapAndDepositQuoteProvider`). Tracks swap transaction execution status from the DEX aggregator. Cross-chain swaps require polling until `DONE`/`FAILED`. New types: `SwapStatusRequest`, `SwapStatusResult`, `SwapTransactionInfo`, `SwapStatus` (`NOT_FOUND` / `PENDING` / `DONE` / `FAILED`), `SwapSubstatus`. `IPoolSession` now extends `ISwapProvider`. |
| 1.8.0 | 2026-06-30 — Added `fallbackAddress` (optional `Address`) to `ExecuteWithdrawAndSwapRelayerParams`. Defaults to `recipientAddress`. Used as LiFi's `toFallbackAddress` for cross-chain bridge failure refunds. SDK validates decoded `SwapRouting.fallbackAddress` matches caller's expected value. `relayWithdrawAndSwap` now performs three safety assertions (added fallbackAddress match). |
| 1.7.0 | 2026-06-30 — Added `relayReshield(params)` to the PoolSession facade, delegating to a new `PoolSessionReshield` sub-session. Reshield atomically withdraws Token A, swaps to Token B via LiFi, and deposits Token B back into the pool via the relayer. Validates relayer commitment (`amountSent` consistency). New types: `ReshieldParams`. `IPoolSession` now extends `IPoolSessionReshield`. |
| 1.6.0 | 2026-06-22 — Added `prepareSwapAndDeposit(params)`, `executeSwapAndDeposit(result)`, and `swapAndDeposit(params)` to the PoolSession facade, delegating to a new `PoolSessionSwapDeposit` sub-session. Swap-and-deposit atomically swaps token X into token Y via LiFi `getContractCallsQuote`, then deposits token Y into the privacy pool. Deposit proof is generated first (fixed output amount), LiFi wraps swap + deposit into one transaction. New types: `SwapAndDepositParams`, `PrepareSwapAndDepositResult`. `IPoolSession` now extends `IPoolSessionSwapDeposit`. |
| 1.5.0 | 2026-06-19 — Added `relayWithdrawAndSwap(params)` to the PoolSession facade, delegating to a new `PoolSessionWithdrawAndSwap` sub-session. Withdraw-and-swap moves value out of the pool to the `RelaySwaps` processor, which executes a DEX swap (via LiFi calldata) and sends the output tokens to the recipient. The method validates the relayer-quoted `SwapRouting.recipient` and `amountSent` before building the proof. New types: `ExecuteWithdrawAndSwapRelayerParams`, `PrepareSwapRelayerQuotes`, `SwapRelayerQuote`. `IPoolSession` now extends `IPoolSessionWithdrawAndSwap`. |
| 1.10.0 | 2026-06-04 — Revocable key rotation: execute-time path rebuild + calldata-derived digests + `RotationKeyMismatch` binding check. `RotateRevocableKeyResult` drops `oldAuthDigest` / `newAuthDigest`; the digests now travel only inside `keystoreCalldata`, and `executeRotateRevocableKey` decodes them from the validated calldata (via `assertPreparedTxMatches`, which now returns the decoded function name and args) so a tampered result cannot disagree with what is submitted. `executeRotateRevocableKey` recomputes the auth digest from `newRevocableKey` and throws the new `RotationKeyMismatch` if it differs from the decoded new digest, and rebuilds the Merkle path against the latest keystore tree right before submitting (same digests, fresh siblings) — shrinking the staleness window from prepare→execute to fetch→inclusion and adding `CurrentLeafNotFound` to its throw set. Both prepare and execute build the calldata via a shared private `buildUpdateAuthPolicyCalldata(oldAuthDigest, newAuthDigest)`. `newIndex` tampering stays unvalidated by design (not recomputable at execute; self-heals via `discoverRevocableKeyIndex`). |
| 1.9.3 | 2026-06-04 — `relayWithdraw` and `relayTransfer` now assert `feeCommitment.asset` matches the transaction's `tokenId` before generating the proof (`InvalidTransactParams` on mismatch), so a quote obtained for a different asset cannot be bound into the proof (audit #55). |
| 1.9.2 | 2026-06-02 — `AccountExport` now carries `paymentRequests` plus `owner`/`chainId` metadata. `exportAccount` serializes pending recipient-side payment requests alongside notes; `importAccount` restores them and rejects a blob whose `owner`/`chainId` disagrees with the live session (`AccountExportMismatch`). Both new envelope fields are optional so pre-existing exports still import. Fixes the audit finding where export/import silently dropped pending payment requests — losing the `noteSecretsMap` needed to discover incoming payment-request notes. Also removed `paymentRequestStorageAdapter` from `PoolSessionConfig`: `PoolSessionFactory.create` is synchronous and cannot hydrate, so it now only builds an in-memory `PaymentRequestService`. A persistent one must be constructed, loaded, and passed via `config.paymentRequestService` — which `PoolSessionBuilder` does. This closes the path where a direct factory caller supplied a storage adapter and silently got an unhydrated service that overwrote saved requests. |
| 1.9.1 | 2026-06-01 — `importReceivedNote` shape validation (`NoteSchema`) now runs before the `BigInt` consistency comparisons, so a malformed field throws `InvalidNoteError` instead of a raw `BigInt` `SyntaxError`. |
| 1.9.0 | 2026-06-01 — `importReceivedNote` now verifies an out-of-band received note's internals before storing it: `ownerAddress` must match the session owner, `noteAddressHash` must equal `computeNoteAddressHash(ownerAddress, noteSecret)`, and `commitment` must equal `computeFullCommitment({ noteAddressHash, tokenId, value, label })`; any mismatch throws `InvalidNoteError`. `PoolSessionExport` now takes `noteComputationService` and `ownerAddress` (`PoolSessionExportConfig`), wired in `PoolSessionFactory`. `importAccount` is unchanged — the user's own backup is a trusted input and is restored without re-verification. |
| 1.8.0 | 2026-05-29 — Removed the `fulfillPaymentRequest` one-shot from `IPoolSessionTransfer` and the `PoolSession` facade. It auto-relayed via `relayOptions[0]`, but `relayOptions` is ordered by relayer config (not fee), so the first-configured relayer's quoted fee was bound into the proof without the caller ever seeing it — a hostile first relayer could inflate the fee and drain the surplus. Payment-request fulfillment is now `prepareFulfillPaymentRequest` → review `relayOptions[i].selectedQuote.quote.feeAmount` → `relayTransfer(chosen)`; explicit quote selection is mandatory. `prepareFulfillPaymentRequest` and `relayTransfer` are unchanged. |
| 1.7.1 | 2026-05-28 — New on-chain NotePayloads are emitted at wire version `0x02` with a `kind` byte selecting the field-set: `KIND_FULL` for ordinary notes (deposit/change/withdraw output/discoverable transfer; carries `noteSecret`), `KIND_BLIND` for payment-request notes (carries `noteAddressHash`, no secret). `decodeNotePayload` keeps accepting the legacy v1 layout for backward compatibility with notes already on-chain. API names unchanged. |
| 1.7.0 | 2026-05-27 — Stripped `noteSecret` from the shareable payment request. `PaymentRequest` now carries `noteAddressHashes: Hash[]` (the `noteSecretsMap` stays recipient-local on `PaymentRequestRecord`), closing a deanonymization vector where co-located `(noteAddressHash, noteSecret)` pairs let a holder confirm the recipient's EVM address via one Poseidon hash. Added a 4th `ResolvedTransferRecipient` variant **discoverable-without-secrets** and a no-secret `{ publicViewingKey, noteAddressHashes }` `RecipientDiscoveryData` shape. Payment-request notes now publish a **v2** NotePayload (`RLP([0x02, noteAddressHash, value, tokenId, label])`); the recipient reconstructs the spendable secret from its local map at discovery. `fulfillPaymentRequest` no longer returns `recipientNotes`. |
| 1.6.0 | 2026-05-27 — Addressed Auditware AW-M-04: `relayWithdraw` now decodes the relayer-signed `PayoutRouting` tuple and asserts `recipient`, `feeAmount`, and `nativeGas` against the caller-visible quote before proof generation. Previously only `recipient` was validated; the user could end up endorsing a routing where `feeAmount`/`nativeGas` diverged from the JSON quote they saw. `nativeGas` is pinned to `0n` while the SDK hardcodes `extraGas: false` on quote requests; the assertion threading needs to update when the extra-gas feature lands. |
| 1.5.0 | 2026-05-27 — Addressed Auditware AW-L-08: `executeRotateRevocableKey` and `rotateRevocableKey` now return `RotateRevocableKeyOutcome` (was `TxReceipt`). Added `newRevocableKeyIndex: Hex` to the outcome so integrators can persist the rotation index atomically with the receipt; previously the SDK advanced its in-memory index without surfacing the value, so a crash between the in-memory bump and the integrator-side write left storage with a stale index and the next session derived the wrong `privateRevocableKey`. Spec table previously documented `TxReceipt` return — corrected to match the runtime shape. |
| 1.4.0 | 2026-05-22 — Added `recipientNoteAddressHashByLabel: Map<Label, Hash>` input to `TransferParams` for the blind variant; resolves the F-012 silent-fund-loss bug where the positional `recipientNoteAddressHash: Hash[]` indices were implicitly bound to the SDK's first-occurrence label iteration. The positional array is now deprecated and emits a one-shot `logger.warn`. Orchestrator now throws `InvalidTransactParams` on (a) keyset mismatch between supplied `noteAddressHashByLabel` and unique input labels, (b) `noteSecretsMap` lookup miss (replaces silent `EMPTY_BYTES32` substitution), and (c) `remainingSentAmount > 0` after the per-label loop (post-loop truncation guard). |
| 1.3.2 | 2026-05-15 — Aligned `PayoutRouting` ABI with `IPrivacyPoolRelay.PayoutRouting`: added `nativeGas` (4th tuple slot) so `abi.decode` succeeds on PrivacyPoolRelay; `recipientAddress` from `prepareTransact` is now wired to `PayoutRouting.recipient` (previously `relayAddress` was used in both slots). `prepareWithdraw` accepts optional `nativeGas` and `feeRecipient` overrides. |
| 1.3.1 | 2026-05-13 — Public `revocableKeyIndex` / `newIndex` typed as `Hex` (0x-prefixed) instead of `bigint` across the facade, `IKeystoreManager`, `RotateRevocableKeyResult`, `KeystoreManagerConfig`, and `DeriveFromSignatureConfig`. Aligns with SDK rule that public-API values are `Hex` for JSON-safe serialisation. |
| 1.3.0 | 2026-05-13 — Added `discoverRevocableKeyIndex(config, gapLimit?)` for cold-start recovery: reads the latest on-chain `authDigest` from `AuthPolicySet` / `AuthPolicyUpdated` events and scans candidate `Poseidon(privateRevocableKey_n)` values for the matching `n`. Default `gapLimit = 20`. |
| 1.2.0 | 2026-05-12 — Rotation API split: `prepareRotateRevocableKey` + `executeRotateRevocableKey` exposed in addition to the convenience `rotateRevocableKey` (mirrors the registration flow split). `revocableKeyIndex` dropped from `RotateRevocableKeyConfig` — the SDK always rotates `currentIndex + 1n`; arbitrary-skip rotation is intentionally not supported. Added `getRevocableKeyIndex()` getter on the facade so integrators can read/persist the current index without reaching past PoolSession. |
| 1.1.0 | 2026-05-01 — Added `rotateRevocableKey` to the IPoolSessionKeystore surface (delegated through `PoolSession`). Listed `MerkleService` as a PoolSession dependency (used by the rotation flow); CryptoService usage extended to revocable-key re-derivation. The integrator persists the rotation index — no chain-side discovery is provided. |
| 1.0.0 | Initial spec. |
