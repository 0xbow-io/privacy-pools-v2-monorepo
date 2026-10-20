# KeystoreManager

### KeystoreManager

KeystoreManager is the stateful owner of all cryptographic key material for the account. It generates, stores, and provides access to the three private keys defined by the protocol: the privateNullifyingKey (used to compute nullifiers, immutable after registration), the privateRevocableKey (used for spending authorization, rotatable), and the viewingKeyPair (used for note discovery encryption/decryption).

KeystoreManager also tracks which chains the account has registered on. Key registration is a per-chain operation (each chain has its own key registry contract), and operations that require on-chain key proofs (transfer, withdraw, ragequit) must verify registration before proceeding.

KeystoreManager is a pure state container. It does not hash keys, compute digests, or interact with contracts. PoolSession reads keys from KeystoreManager and passes them to WitnessPreparationService or CryptoService as needed.

# Dependencies

None. KeystoreManager has no injected dependencies.

Keys may be supplied via the direct constructor (pre-derived externally) or via the static factory method that derives keys from a wallet signature.

# Static Factories

---

**`KeystoreManager.fromSignature(config, dependencies) → KeystoreManager`**

Creates a `KeystoreManager` by deriving all three protocol keys from a wallet signature and its signer address. Delegates to `CryptoService.deriveKeysFromSignature` (two-stage HKDF, see [crypto-service.md](./crypto-service.md)). EIP-712 is the recommended payload format; the integrator is responsible for both constructing the typed data and producing the signature — see `crypto-service.md` for the reference payload shape.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `config.signature` | `Hex` | 65-byte ECDSA signature as 0x-prefixed hex. Only `r` is used. |
| `config.signerAddress` | `Address` | 20-byte EVM address that produced the signature. |
| `config.revocableKeyIndex` | `Hex` _(required)_ | Rotation index for the revocable key, as 0x-prefixed hex. Pass `"0x0"` for a fresh account; pass the persisted value when re-hydrating an account that has rotated. The SDK does not discover the index from chain — the integrator is responsible for persisting it alongside the rest of the account state. Required to prevent silent fallback to index 0 after rotation. |
| `config.addressHash` | `Hex` _(optional)_ | Expected `keccak256(signerAddress)` from the signed EIP-712 payload. When provided, verified against the hash of `signerAddress` before derivation. See [crypto-service.md](./crypto-service.md). |
| `dependencies.cryptoService` | `ICryptoService` | Injected crypto service. |

**Returns:** `KeystoreManager` — Fully initialised instance.

**Throws:**
- `InvalidSignature` if the signature is not 65 bytes.
- `InvalidAddress` if the signer address is not 20 bytes.
- `PayloadAddressHashMismatch` (extends `KeyDerivationBaseError`) if `addressHash` is provided and does not equal `keccak256(signerAddress)`. Propagated from `CryptoService.deriveKeysFromSignature`.

---

# Constructor

**`new KeystoreManager(config) → KeystoreManager`**

Direct constructor — accepts pre-derived keys. Useful for testing or advanced integrations where keys are produced externally.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `config.privateNullifyingKey` | `Secret` | 32-byte hex. |
| `config.privateRevocableKey` | `Secret` | 32-byte hex. |
| `config.viewingPrivateKey` | `Secret` | 32-byte hex. |
| `config.viewingPublicKey` | `PublicKey` | 32-byte X25519 public key (0x-prefixed hex, no compression prefix byte). |
| `config.revocableKeyIndex` | `Hex` _(required)_ | Rotation index `n` of the supplied `privateRevocableKey`, as 0x-prefixed hex. MUST match the index the key was derived under (`HKDF-Expand("AUTH0:REVOCABLE" ‖ u64be(n), 48)`). Pass `"0x0"` for a fresh account. |

**Throws:** `InvalidKeystoreManagerConfig` if any key fails format validation.

---

# Instance Methods

---

**`getPrivateNullifyingKey() → Secret`**

Returns the private nullifying key. Used by AccountService to pass to WitnessPreparationService for nullifier computation. No params.

**Returns:** `Secret` — The private nullifying key.

---

**`getPrivateRevocableKey() → Secret`**

Returns the current private revocable key. Used for spending authorization inside the circuit. No params.

**Returns:** `Secret` — The current private revocable key.

---

**`getViewingKeyPair() → KeyPair`**

Returns the viewing key pair (private + public). The private key is used for ECDH in note discovery. The public key is registered on-chain so others can encrypt notes for this account. No params.

**Returns: `KeyPair`**

| Field | Type | Description |
| --- | --- | --- |
| `privateKey` | `Secret` | The viewing private key. |
| `publicKey` | `PublicKey` | The viewing public key (privateKey * G on the curve). |

---

**`getRevocableKeyIndex() → Hex`**

Returns the rotation index `n` of the currently-stored `privateRevocableKey` as 0x-prefixed hex.

**Returns:** `Hex` — The current rotation index.

---

**`applyRotation(newIndex, newKey) → void`**

Replaces the stored revocable key + index with a pre-derived pair. Intended for callers (typically `PoolSessionKeystore.executeRotateRevocableKey`) that already derived the new key during preparation and only need to commit the rotation in-memory after on-chain confirmation.

HKDF re-derivation lives in `CryptoService.deriveKeysFromSignature`; rotation orchestration lives in `PoolSessionKeystore`. KeystoreManager only owns the in-memory state mutation.

> **⚠ What rotation defends against — and what it does not.** The new revocable key at index `n+1` is `HKDF-Expand("AUTH0:REVOCABLE" ‖ u64be(n+1), …)` over the **same** `identityPRK`, which itself descends from the **same** wallet signature `r`. Rotation therefore:
>
> - **Defends against** a leaked *leaf* — e.g., the `privateRevocableKey` value escaping a single process (memory dump, witness leak, careless logging). Old leaf is invalidated on chain once the new root is accepted.
> - **Does NOT defend against** a leaked `r` (root signature). Whoever holds `r` can derive index `n`, `n+1`, `n+2`, …, and also the nullifying key and viewing key. See the "Threat model: signature compromise is total compromise" callout in [crypto-service.md](./crypto-service.md).
> - **Does NOT close the drain-after-rotate window.** The on-chain Keystore keeps the superseded root valid for `keystoreRootLiveness` seconds after replacement (see `contracts-tech-design.md`). During that window an attacker with the **old** revocable key can still produce valid spend proofs anchored to the old root. Integrators relying on rotation as an incident-response control must factor this window into their containment plan.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `newIndex` | `Hex` | Target rotation index as 0x-prefixed hex. MUST be strictly greater than the current index. |
| `newKey` | `Secret` | The pre-derived `privateRevocableKey` for `newIndex`. |

**Returns:** void

**Throws:** `InvalidRotationIndex` when `newIndex` is not strictly greater than the current index.

---

**`getAuthDigest() → Hash`**

Returns the current authorizerDigest. This is a convenience accessor that returns the cached value computed during key generation or rotation. The digest is Poseidon(revocableKeyHash, authorizerAddress=0). No params.

**Returns:** `Hash` — The current authorizer digest.

---

**`isRegistered(chainId) → boolean`**

Checks whether the account has completed key registration on a given chain.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `chainId` | `number` | The chain ID to check registration for. |

**Returns:** `boolean` — True if `Keystore.setAuthPolicy()` has been called on this chain.

**Note:** a partial registration already sets it — registering only the auth policy (`registerKeystore({ includeViewingKey: false })`, or `setAuthPolicy` mined but `setViewingKey` not yet) marks the chain, so `isRegistered` is `true` even while the viewing key is still unpublished. Resuming that partial registration in the same session therefore relies on the `isRegistered` guard in `PoolSessionKeystore.executeRegisterKeystore` (see `markRegistered`).

---

**`markRegistered(chainId) → void`**

Records that keystore registration has been completed on a given chain. Called by the caller after a successful `Keystore.setAuthPolicy()` transaction.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `chainId` | `number` | The chain ID to mark as registered. |

**Returns:** void

**Throws:** `AlreadyRegistered` (code: `KeystoreManager.ts`) when the chain is already marked — a second mark for the same chain is rejected, never a silent no-op.

**Note:** `PoolSessionKeystore.executeRegisterKeystore` calls this only when `isRegistered(chainId)` is false, so resuming a partial (auth-policy-only) registration in the same session — where the manager was already marked by the first run — succeeds instead of surfacing `AlreadyRegistered` for transactions that already landed on-chain. Callers who submit registration themselves must apply the same guard (or mark once).

---

# Relayed Keystore Registration (EIP-712 / Soroban auth entry)

The direct registration path (`PoolSession.prepareRegisterKeystore`, see [pool-session.md](./pool-session.md)) assumes the account owner submits `Keystore.setAuthPolicy` itself and pays gas. The **relayed** path lets a fresh, unfunded account authorize its auth policy off-chain via an EIP-712 signature, so a relayer can submit `Keystore.setAuthPolicyWithSig` on the owner's behalf. KeystoreManager still owns the underlying material — the nullifying key (for `nullifyingKeyHash`) and the cached `authDigest` (`getAuthDigest()`) — while assembling and signing the chain's authorization live on the keystore interactor and the PoolSession keystore surface.

**Chain-neutral seam (2026-10-01).** `IKeystoreChainAdapter` / `IKeystoreInteractor` expose `buildRegistrationAuthorization({ account, nullifyingKeyHash, authDigest, deadline, chainId }) → RelayedRegistrationAuthorization` and `signRegistrationAuthorization(authorization) → Hex`, where `RelayedRegistrationAuthorization = Eip712TypedData | SorobanRegistrationAuthorization`:

- **EVM** (`EvmKeystoreChainAdapter`): the EIP-712 payload from `buildSetAuthPolicyTypedData` (below), signed via `signTypedData`; a relayer submits `Keystore.setAuthPolicyWithSig` (or `registerAndRelay`).
- **Stellar** (`StellarKeystoreChainAdapter`): `SorobanRegistrationAuthorization = { kind: "sorobanAuthEntry", entryXdr, validUntilLedger }` — an unsigned `SorobanAuthorizationEntry` (address credentials for `account`, random positive i64 nonce) whose root invocation is **this keystore's `set_auth_policy(account, nullifyingKeyHash, authDigest)`** — the nested call `relay.register_and_relay` makes; the owner authorizes that call, not the relay entrypoint. `validUntilLedger = latestLedger + ceil((deadline − now) / 5 s)` (min 1). Signing goes through `IStellarWalletInteractor.signAuthEntry(entryXdr, validUntilLedger)` (Keypair: `authorizeEntry`; Freighter: `signAuthEntry` over the entry's preimage), and the returned `Hex` is the **signed entry's XDR**, not a detached signature. `signTypedData` throws on Stellar. Only the atomic register-and-withdrawal is relayed on Stellar; standalone relayed registration is unsupported.

**`buildSetAuthPolicyTypedData(config) → Eip712TypedData`**

Pure helper that assembles the EIP-712 payload the `Keystore` contract verifies in `setAuthPolicyWithSig`. Domain is `{ name: "PrivacyPoolsKeystore", version: "1", chainId, verifyingContract: keystoreAddress }`; the primary type is `SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)` — matching the contract's `SET_AUTH_POLICY_TYPEHASH`.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `keystoreAddress` | `Address` | Keystore contract address (EIP-712 `verifyingContract`). |
| `chainId` | `number` | Target chain id (EIP-712 domain). |
| `account` | `Address` | The account whose auth policy is being set. |
| `authDigest` | `Hash` | `Poseidon(revocableKeyHash, authorizerAddress=0)` — same digest as the direct path. |
| `nullifyingKeyHash` | `Hash` | Public hash of the nullifying key. |
| `deadline` | `Hex` | Unix timestamp after which the signature is no longer valid on-chain. |

**Returns:** `Eip712TypedData` — the `{ domain, types, primaryType, message }` structure, ready to hand to a wallet's `signTypedData`.

**Wallet dependency.** On EVM, signing the payload requires `IWalletInteractor.signTypedData(typedData): Promise<Hex>` (with viem and EIP-1193 implementations); `IKeystoreInteractor.signTypedData` is a thin passthrough to the wired wallet (`signRegistrationAuthorization` uses it). On Stellar it requires `IStellarWalletInteractor.signAuthEntry`. These are the only wallet capabilities the relayed path introduces — the direct path needs neither.

**Consuming method.** `PoolSession.prepareRelayedRegistration(options)` (documented on the facade in [pool-session.md](./pool-session.md)) is the counterpart to `prepareRegisterKeystore`: it computes `nullifyingKeyHash` + `authDigest` from KeystoreManager state, calls `keystoreInteractor.buildRegistrationAuthorization`, and — unless `sign: false` — signs it via `signRegistrationAuthorization`. It emits **no calldata** (the relayer submits `setAuthPolicyWithSig` on EVM, `relay.register_and_relay` on Stellar).

**Types:**

- `Eip712TypedData` — `{ domain, types, primaryType, message }` EIP-712 structure.
- `SorobanRegistrationAuthorization` — `{ kind: "sorobanAuthEntry", entryXdr: string /* base64 */, validUntilLedger: number }`.
- `RelayedRegistrationAuthorization` — `Eip712TypedData | SorobanRegistrationAuthorization` (narrow on `"kind" in`).
- `RelayedRegistrationOptions` — `{ deadline: Hex, sign?: boolean }`. `sign` defaults to `true`; pass `false` to get the unsigned `typedData` for an external signer.
- `PreparedRelayedRegistration` — `{ typedData: RelayedRegistrationAuthorization, account, authDigest, nullifyingKeyHash, deadline, signature: Hex | null }`. `signature` is `null` when `sign: false`; on Stellar it is the signed auth entry (hex XDR).

---

**Version History**

| Version | Change |
| --- | --- |
| 1.6.0 | 2026-10-01 — Relayed registration made chain-neutral: `IKeystoreChainAdapter` / `IKeystoreInteractor.buildRegistrationAuthorization` / `signRegistrationAuthorization`; `PreparedRelayedRegistration.typedData` is `RelayedRegistrationAuthorization = Eip712TypedData \| SorobanRegistrationAuthorization`. Stellar: unsigned auth entry over `keystore.set_auth_policy(account, nkh, digest)`, expiry ledger from the unix deadline at ~5 s/ledger, signed via `IStellarWalletInteractor.signAuthEntry`; `signature` carries the signed entry XDR. Standalone relayed registration stays unsupported on Stellar. |
| 1.5.1 | 2026-09-24 — Doc-only clarification for the same-session partial-registration resume (no `KeystoreManager` code change). `markRegistered` documents its `AlreadyRegistered` throw on a second mark for the same chain and that `PoolSessionKeystore.executeRegisterKeystore` calls it only when `isRegistered(chainId)` is false; `isRegistered` notes that a partial (auth-policy-only) registration already sets it. See [pool-session.md](pool-session.md) v1.25.4. |
| 1.5.0 | 2026-07-08 — Documented the relayed keystore-registration path (INTL-05). Added the `buildSetAuthPolicyTypedData` EIP-712 helper (domain `PrivacyPoolsKeystore`/`1`, type `SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)`, matching the contract's `SET_AUTH_POLICY_TYPEHASH`), the new wallet dependency `IWalletInteractor.signTypedData` (viem + EIP-1193 impls, `IKeystoreInteractor.signTypedData` passthrough), and the `Eip712TypedData` / `RelayedRegistrationOptions` / `PreparedRelayedRegistration` types. Cross-links to the consuming `PoolSession.prepareRelayedRegistration`. Doc-only. |
| 1.4.4 | 2026-05-22 — Added scope-of-rotation callout under `applyRotation`. Documents that revocable-key rotation defends against leaf-key leak only, not against root `r` leak, and does not close the on-chain `keystoreRootLiveness` drain-after-rotate window. Cross-links to crypto-service threat-model callout. Doc-only. |
| 1.4.3 | 2026-05-15 — Removed reference to the SDK-supplied `buildSecretDerivationPayload` helper; integrators now build the EIP-712 typed data themselves. SDK keeps consuming `(signature, signerAddress)` unchanged. |
| 1.4.2 | 2026-05-13 — Public `revocableKeyIndex` / `newIndex` types changed from `bigint` to `Hex` (0x-prefixed). Internal arithmetic stays on `bigint` — conversion happens at the boundary. JSON-safe serialisation per SDK API rule. |
| 1.4.1 | 2026-05-12 — Removed `rotateRevocableKey(config, dependencies)`. HKDF re-derivation now lives only in `CryptoService.deriveKeysFromSignature`; `KeystoreManager` exposes only the lower-level `applyRotation(newIndex, newKey)` primitive. Rotation orchestration moves to `PoolSessionKeystore.{prepare,execute}RotateRevocableKey`. |
| 1.4.0 | 2026-05-01 — `revocableKeyIndex` is now REQUIRED on both `fromSignature` and the direct constructor (no default, no optional). Documented `getRevocableKeyIndex()`. `rotateRevocableKey()` is now deterministic + index-based: it takes `(config, dependencies)` and re-derives the key via HKDF — replaces the previous random-rotation behaviour. Added `applyRotation(newIndex, newKey)` lower-level primitive used by `PoolSessionKeystore.rotateRevocableKey` after on-chain confirmation. |
| 1.3.0 | `viewingPublicKey` is now a 32-byte X25519 public key (was 33-byte compressed secp256k1). Aligned with the migration in `crypto-service.md` v1.4.0. |
| 1.2.2 | `fromSignature` config accepts optional `addressHash`; propagates `PayloadAddressHashMismatch` from `CryptoService.deriveKeysFromSignature` when the provided hash disagrees with `keccak256(signerAddress)`. |
| 1.2.1 | Noted SDK-exposed `buildSecretDerivationPayload` helper integrators can use to produce the EIP-712 payload fed into `fromSignature`. |
| 1.2.0 | `fromSignature` now accepts `{ signature, signerAddress, revocableKeyIndex? }` and uses the two-stage HKDF signature-based derivation spec. |
| 1.1.0 | Added `fromSignature` static factory (0XB-1065). Constructor remains for external-key / testing use. Removed stale `generateKeys` instance method. |
| 1.0.0 | Initial spec. |