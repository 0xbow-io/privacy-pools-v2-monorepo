# ContractInteractor

### ContractInteractor

ContractInteractor handles all direct interactions with on-chain smart contracts. It encodes function calls, submits transactions via the injected wallet adapter, and decodes return values. It also provides read methods for fetching on-chain state (tree leaves, roots) that PoolSession needs for witness construction.

ContractInteractor knows the contract ABIs and addresses but has no protocol logic. It does not compute commitments or validate proofs—it just sends what it's given and returns what it gets back.

# Chain implementations

The generic `PoolVaultInteractor` / `EntrypointInteractor` / `KeystoreInteractor` classes and their `IPoolVaultInteractor` / `IEntrypointInteractor` / `IKeystoreInteractor` interfaces documented on this page live in `packages/core-sdk` and are chain-agnostic — they own the caching/delta-fetch orchestration described below but delegate the actual chain read/write calls to an injected chain adapter. The adapter interfaces (`IPoolVaultChainAdapter`, `IEntrypointChainAdapter`, `IKeystoreChainAdapter`) are also defined in `packages/core-sdk`; concrete implementations are per-chain:

- **EVM** — `EvmPoolVaultChainAdapter`, `EvmEntrypointChainAdapter`, `EvmKeystoreChainAdapter` (`packages/evm-sdk`), built on `IWalletAdapter` / `IRPCProvider` (viem-backed) as described in this doc.
- **Stellar** — `StellarPoolVaultChainAdapter`, `StellarEntrypointChainAdapter`, `StellarKeystoreChainAdapter` (`packages/stellar-sdk`), built on Soroban RPC/wallet equivalents. Caveat: a Soroban RPC only retains events for its retention window, so the delta-fetch scan (from `deploymentBlock`) is clamped to the node's oldest retained ledger — a pool or keystore deployed before that ledger cannot be fully rebuilt from events and needs a `LeafCacheSeed` or an archival RPC. See [stellar-sdk-tech-design.md §Event fetching](../stellar-sdk/stellar-sdk-tech-design.md#scope). Stellar specifics (2026-10-01): a deposit with a non-empty ASP ciphertext encodes `pool.deposit_with_label` (atomic label registration in the same invocation), else `pool.deposit`; `StellarEntrypointChainAdapter` takes `simulateDeposits: false` (+ `networkPassphrase`) to build the deposit envelope unsimulated, used only by the yield deposit whose codec re-targets it at the router. `getCommitmentValue` / `getNullifierValue` read the pool's O(1) `commitment_created_at` / `nullifier_spent_at` getters and fall back to the event-history reconstruction only when the read fails (e.g. an archived entry).

Cross-chain adapter additions (2026-10-01):

- `IPoolVaultChainAdapter.encodeTransact(proof, signals, transactParams, noteData, asset, options?)` / `IPoolVaultInteractor.encodeTransact` gained `options.deferSimulation`. `TransactOrchestrator` sets it for a pending keystore registration (register-and-withdraw), whose proof is anchored to a root that only exists once the bundled registration lands. EVM ignores it (calldata is never simulated while encoding); Stellar builds the call unsimulated via `IStellarRPCInteractor.buildUnsimulatedTransaction` — inspection only, the relayer submits its own bundled call.
- `IKeystoreChainAdapter` / `IKeystoreInteractor` gained `buildRegistrationAuthorization(...) → RelayedRegistrationAuthorization` and `signRegistrationAuthorization(authorization) → Hex`, the chain-neutral relayed-registration seam (EVM: EIP-712 `SetAuthPolicy`; Stellar: a Soroban auth entry over `keystore.set_auth_policy`). `signTypedData` remains for EVM-only callers and throws on Stellar. See [keystore-manager.md §Relayed Keystore Registration](keystore-manager.md).

# Dependencies

| Dependency | Why |
| --- | --- |
| **IWalletAdapter** | Injected interface for signing and sending transactions. ContractInteractor encodes the calldata and passes it to IWalletAdapter.sendTransaction(). The abstraction supports any wallet: browser extensions (MetaMask), hardware wallets, server-side signers, or smart contract wallets. |
| **IRPCProvider** | Injected interface for read-only contract calls. Used by methods that query on-chain state (getStateRoot, getCommitmentTreeLeaves, getKeystoreLeaves) without requiring a transaction. |

# Methods

---

**`deposit(token, amount, proof) → Promise<TxReceipt>`**

Submits a deposit transaction to the privacy pool contract. Encodes the proof and public signals into the contract's expected format. For native ETH, includes `msg.value`. For ERC-20, assumes prior approval.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `token` | `Address` | Token contract address. address(0) for native ETH. |
| `amount` | `bigint` | Deposit amount in the token's smallest unit. |
| `proof` | `DepositProof` | The proof and public signals from ProofService.proveDeposit(). |

**Returns: `TxReceipt`**

| Field | Type | Description |
| --- | --- | --- |
| `status` | `boolean` | Whether the transaction succeeded. |
| `blockNumber` | `bigint` | Block the transaction was mined in. |
| `txHash` | `Hex` | Transaction hash. |
| `logs` | `Log[]` | Emitted event logs. |

---

**`registerLabel(ciphertext) → Promise<TxReceipt>`**

Submits a permissionless label-registration event to the `ASPRegistry` contract. There is no ZK proof: the contract simply emits `LabelRegistered(ciphertext)`. In most flows this is inlined with deposit via `Entrypoint.deposit(proof, noteData, aspCiphertext)`; this wrapper exists for post-deposit registration.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `ciphertext` | `Hex` | Encrypted payload for the ASP, typically containing `{label, depositCommitment}`. Opaque to the contract. |

**Returns:** `TxReceipt` — Same structure as deposit().

---

**`transact(proof, transactData, ciphertext) → Promise<TxReceipt>`**

Submits a transact transaction (transfer or withdrawal) to the privacy pool contract.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `proof` | `TransactProof` | The proof and public signals from ProofService.proveTransact(). |
| `transactData` | `TransactData` | Additional transaction data: nullifiers, outputCommitments, amountOut, tokenIdOut, recipientAddress, fee. |
| `ciphertext` | `Hex` | Encrypted note payloads for recipient discovery. |

**Returns:** `TxReceipt` — Same structure as deposit().

---

**`ragequit(proof, asset) → Promise<TxReceipt>`**

Submits a ragequit transaction directly to the privacy pool contract.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `proof` | `RagequitProof` | The proof and public signals from ProofService.proveRagequit(). |
| `asset` | `AssetData` | Token identifier and amount for the withdrawal. |

**Returns:** `TxReceipt` — Same structure as deposit().

---

**`encodeRagequit(proof, asset) → Hex`**

Encodes a ragequit function call and returns the ABI-encoded calldata without submitting a transaction. Used by `PoolSession.prepareRageQuit()` to return unsigned calldata for the caller to submit later.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `proof` | `RagequitProof` | The proof and public signals from ProofService.proveRagequit(). |
| `asset` | `AssetData` | Token identifier and amount for the withdrawal. |

**Returns:** `Hex` — ABI-encoded calldata for the `ragequit` function.

---

**`setAuthPolicy(authDigest, nullifyingKeyHash) → Promise<TxReceipt>`**

Submits the one-time auth policy registration to the `Keystore` contract.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `authDigest` | `Hash` | The authorizerDigest: `Poseidon(authType, ...methodSpecificData)`. |
| `nullifyingKeyHash` | `Hash` | Poseidon hash of the `privateNullifyingKey`. Immutable once set. |

**Returns:** `TxReceipt` — Same structure as deposit().

---

**`setViewingKey(viewingKey) → Promise<TxReceipt>`**

Publishes the viewing public key via the `Keystore`'s `viewingKeys` mapping. May be called at any time; overwrites any prior value for `msg.sender`.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `viewingKey` | `PublicKey` | The account's viewing public key. |

**Returns:** `TxReceipt` — Same structure as deposit().

---

**`updateAuthPolicy(oldAuthDigest, updatedAuthDigest, siblingNodes) → Promise<TxReceipt>`**

Submits a key rotation transaction to the `Keystore` contract.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `oldAuthDigest` | `Hash` | The current authorizerDigest being replaced. |
| `updatedAuthDigest` | `Hash` | The new authorizerDigest. |
| `siblingNodes` | `Hash[]` | LeanIMT inclusion proof for the current key leaf. Used by the contract to verify the old leaf exists before replacing it. |

**Returns:** `TxReceipt` — Same structure as deposit().

---

**`encodeUpdateAuthPolicy(oldAuthDigest, newAuthDigest, siblingNodes) → PreparedTransaction`** _(IKeystoreInteractor)_

Encodes an `updateAuthPolicy` call without sending. The keystore contract recomputes the old leaf as `Poseidon(msg.sender, nullifyingKeyHash, oldAuthDigest)` and verifies it sits at `siblingNodes` against the current keystore root before replacing it. Used by `PoolSessionKeystore.rotateRevocableKey()` to assemble the calldata before submission.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `oldAuthDigest` | `Hash` | The currently-registered authorizerDigest. |
| `newAuthDigest` | `Hash` | The new authorizerDigest to install. |
| `siblingNodes` | `Hash[]` | Sibling hashes along the path from the old leaf to the root, padded to keystore tree depth. |

**Returns:** `PreparedTransaction` — `{ to, data, value }` ready for submission via `submitTransaction`.

---

**`approveERC20(token, spender, amount) → Promise<TxReceipt>`**

Approves an ERC-20 token for spending by the privacy pool contract.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `token` | `Address` | ERC-20 token contract address. |
| `spender` | `Address` | The address to approve (the privacy pool contract). |
| `amount` | `bigint` | Amount to approve. |

**Returns:** `TxReceipt` — Same structure as deposit().

---

**`getStateRoot(poolAddress) → Promise<Hash>`**

Reads the current `stateTree` root from the `PoolVault` contract. The state tree stores both timestamped commitment and nullifier leaves.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `poolAddress` | `Address` | The privacy pool contract address. |

**Returns:** `Hash` — The current stateTree root.

---

**`getStateLeaves() → Promise<Hash[]>`**

Reconstructs the timestamped leaves of the `stateTree` from the `PoolVault` contract's `LeavesInserted` events. Each leaf is either a commitment-tagged or nullifier-tagged Poseidon hash bound to its on-chain insertion timestamp. No params — the `PoolVaultInteractor` instance is already bound to its `poolAddress` at construction.

Leaves are cached in-memory on the `PoolVaultInteractor` instance using the identical pattern documented below for `getKeystoreLeaves()` (`cachedLeaves` / `cachedToBlock`, delta-fetched from `cachedToBlock + 1` on every call after the first, concurrent callers sharing one `inFlightFetch`). Same per-chain safety rationale: each `PoolSession` constructs its own `PoolVaultInteractor` instance. `PoolSessionBuilder` fires the same kind of non-blocking, error-swallowing warm-up call immediately after constructing the `PoolVaultInteractor`.

**Returns:** `Hash[]` — Array of leaf hashes in insertion order.

---

**`getKeystoreLeaves() → Promise<Hash[]>`**

Reads all key registry tree leaves from the key registry contract. No params.

Leaves are cached in-memory on the `KeystoreInteractor` instance (`cachedLeaves` / `cachedToBlock`). The first call performs a full `getLogs` scan from the keystore contract's `deploymentBlock` to the current head — on chains like Arbitrum this range can span hundreds of millions of blocks, making the first call slow. Every subsequent call delta-fetches only the range from `cachedToBlock + 1` to the new head and appends the result, instead of re-scanning from `deploymentBlock` each time. Concurrent callers that arrive while a fetch is already in flight (`inFlightFetch`) share that single promise rather than racing two overlapping scans of the same range. This is safe per-chain because each `PoolSession` constructs its own `KeystoreInteractor` instance — instances are never pooled or shared across chains.

`PoolSessionBuilder` fires a non-blocking, error-swallowing warm-up call to `getKeystoreLeaves()` immediately after constructing the `KeystoreInteractor`, so the expensive first scan starts at session-construction time rather than at whenever a transact/withdraw/reshield/ragequit flow first needs the leaves. `PoolSessionBuilder` fires the identical kind of warm-up for `PoolVaultInteractor.getStateLeaves()` right after constructing that interactor (see below). `TransactOrchestrator.warmMerkleCaches()` (see [core-sdk-tech-design.md](core-sdk-tech-design.md)) lets a caller explicitly await both warm-ups together, in parallel — either the background scans finishing or fresh ones starting — before a time-sensitive step, such as requesting a relayer fee commitment with a short expiration.

**Seeding and exporting the cache across process/session boundaries.** Both caches only help within one process's lifetime — a fresh test run or dApp session still starts cold and pays the full `deploymentBlock` scan once. To let a caller persist and restore that state, `KeystoreInteractor`'s and `PoolVaultInteractor`'s constructor dependencies (`KeystoreInteractorDependencies` / `PoolVaultInteractorDependencies`) accept an optional `seed?: LeafCacheSeed` — `{ toBlock: bigint; leaves: Hash[] }`, a new type in `types/ContractInteractor.ts`. When supplied, `cachedLeaves`/`cachedToBlock` start pre-populated from the seed, so the first real call is already a delta-fetch from `seed.toBlock + 1` instead of a full scan. Both interactors (and `IKeystoreInteractor`/`IPoolVaultInteractor`) also gain `exportLeafCache(): LeafCacheSeed | undefined`, which snapshots the current cache state — `undefined` if nothing has been fetched yet. The SDK itself never touches disk or browser storage; seeding and exporting are entirely the caller's responsibility. `PoolSessionBuilder` threads `keystoreLeafCacheSeed` / `stateLeafCacheSeed` config fields straight into these constructors, and `PoolSession` exposes `exportKeystoreLeafCache()` / `exportStateLeafCache()` on the facade — see [pool-session.md](pool-session.md).

**Returns:** `Hash[]` — Array of key registry leaf hashes.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.2.0 | 2026-10-01 — "Chain implementations": Stellar `deposit_with_label` for deposits with an ASP ciphertext, `simulateDeposits: false` entrypoint option, O(1) `commitment_created_at` / `nullifier_spent_at` reads with event-history fallback; new adapter surface `encodeTransact` `options.deferSimulation` and `IKeystoreChainAdapter` / `IKeystoreInteractor.buildRegistrationAuthorization` / `signRegistrationAuthorization`. |
| 1.1.5 | 2026-09-30 — Doc-only. "Chain implementations" Stellar bullet: added the Soroban RPC event-retention caveat (leaves older than the node's oldest retained ledger cannot be rebuilt from events; seed the leaf cache or use an archival RPC). No interface change. |
| 1.1.4 | 2026-09-16 — Doc-only. Moved to `docs/tech-design/core-sdk/` following the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` package split; added the "Chain implementations" section pointing to the EVM (`packages/evm-sdk`) and Stellar (`packages/stellar-sdk`) concrete `*ChainAdapter` implementations of the chain-adapter interfaces this doc's classes are built on. No behavior change. |
| 1.1.3 | 2026-08-14 — Storage-agnostic leaf-cache seed/export: `KeystoreInteractor`/`PoolVaultInteractor` constructor dependencies accept an optional `seed?: LeafCacheSeed` (`{ toBlock: bigint; leaves: Hash[] }`, new type in `types/ContractInteractor.ts`) that pre-populates `cachedLeaves`/`cachedToBlock`; new `exportLeafCache(): LeafCacheSeed | undefined` on `IKeystoreInteractor`/`IPoolVaultInteractor` reads the current snapshot back, `undefined` before any fetch. The SDK never persists the snapshot itself — `PoolSessionBuilder` threads it in via `keystoreLeafCacheSeed`/`stateLeafCacheSeed` config fields, `PoolSession` exports it via `exportKeystoreLeafCache()`/`exportStateLeafCache()` (see [pool-session.md](pool-session.md)). Additive, no change to existing method signatures. |
| 1.1.2 | 2026-08-13 — Extended the same delta-fetch leaf cache to `PoolVaultInteractor.getStateLeaves()` (`cachedLeaves`/`cachedToBlock`/`inFlightFetch`, identical to `getKeystoreLeaves()`); `PoolSessionBuilder` fires a matching background warm-up for it. Doc entry for this method updated from the stale `getStateTreeLeaves(poolAddress, fromIndex?)` name/signature to the current no-param `getStateLeaves()`. `TransactOrchestrator.warmKeystoreCache()` renamed to `warmMerkleCaches()` and broadened to await both leaf caches in parallel. |
| 1.1.1 | 2026-08-13 — `getKeystoreLeaves()` now caches leaves in-memory per `KeystoreInteractor` instance and delta-fetches from `cachedToBlock + 1` on subsequent calls instead of re-scanning from `deploymentBlock` every time; concurrent calls share one in-flight fetch. `PoolSessionBuilder` fires a non-blocking warm-up call at session-construction time. No signature change. |
| 1.1.0 | 2026-05-01 — Added `IKeystoreInteractor.encodeUpdateAuthPolicy(oldAuthDigest, newAuthDigest, siblingNodes)` — encode-only variant of `updateAuthPolicy` consumed by `PoolSessionKeystore.rotateRevocableKey()`. |
| 1.0.0 | Initial spec. |