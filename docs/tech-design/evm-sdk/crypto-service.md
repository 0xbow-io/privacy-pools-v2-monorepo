# CryptoService (EVM)

### CryptoService

CryptoService handles non-ZK cryptographic operations: elliptic curve Diffie-Hellman key exchange, symmetric encryption/decryption, and key derivation. These are the operations that protect note payloads in transit—ensuring only the intended recipient can read the note data embedded in on-chain events.

CryptoService is stateless with no dependencies. It operates on raw keys and data passed per-call.

`CryptoService` (`packages/evm-sdk`) is the EVM implementation of `ICryptoService`. It extends the chain-agnostic `AbstractCryptoService<TDeriveConfig>` base defined in `packages/core-sdk` — see [core-sdk/crypto-service.md](../core-sdk/crypto-service.md) for the shared contract (`encrypt`/`decrypt`, `generateSecret`, and the appSecret-down HKDF tree) and for the second concrete implementation, `StellarCryptoService` (`packages/stellar-sdk`, secp256k1 + ed25519-signature derivation — see [stellar-sdk/crypto-service.md](../stellar-sdk/crypto-service.md)). Every method below describes the EVM `CryptoService` specifically: X25519 for `ecdh`/`generateEphemeralKeyPair`, and an ECDSA-signature-keyed HKDF tree for `deriveKeysFromSignature`.

# Dependencies

None.

# Methods

---

**`ecdh(privateKey, publicKey) → Secret`**

Performs Elliptic Curve Diffie-Hellman key exchange. Computes a shared secret from a private key and a counterparty's public key. Used for both note payload encryption (sender computes shared secret with recipient's viewing key) and note discovery (recipient recomputes the same shared secret).

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `privateKey` | `Secret` | The caller's private key (viewing private key or ephemeral private key). |
| `publicKey` | `PublicKey` | The counterparty's public key (recipient's viewing public key or event's ephemeral public key). |

**Returns:** `Secret` — The shared secret. Both parties compute the same value.

---

**`encrypt(data, sharedSecret) → Hex`**

Symmetrically encrypts data using a shared secret derived from ECDH. For note payloads, the input `data` is an RLP-encoded NotePayload (produced by `NoteComputationService.encodeNotePayload()`), ensuring only the holder of the corresponding private key can decrypt it.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `data` | `Uint8Array` | The plaintext data to encrypt. For note payloads, this is an RLP-encoded NotePayload. |
| `sharedSecret` | `Secret` | The shared secret from ECDH, used to derive the symmetric encryption key. |

**Returns:** `Hex` — The ciphertext.

---

**`decrypt(ciphertext, sharedSecret) → Uint8Array`**

Symmetrically decrypts ciphertext using a shared secret. Returns the original plaintext if the correct shared secret is used. For note payloads, the output is an RLP-encoded NotePayload to be decoded by `NoteComputationService.decodeNotePayload()`. If the wrong key is used, decryption fails (returns garbage or throws, depending on the cipher mode).

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `ciphertext` | `Hex` | The encrypted data from an on-chain event or off-chain channel. |
| `sharedSecret` | `Secret` | The shared secret from ECDH. Must match the secret used for encryption. |

**Returns:** `Uint8Array` — The decrypted plaintext.

---

**`generateSecret() → Secret`**

Generates a cryptographically secure random secret as a **BN254 scalar field element** in `[0, p−1]`. Used for `noteSecret` and `depositSecret`, both of which are fed to Poseidon and consumed as circuit signals — see [`cryptography-glossary.md`](../circuits/cryptography-glossary.md) on the field-element invariant. Implementation samples 48 random bytes and reduces modulo `p`; per RFC 9380 §5.1 the resulting statistical distance from uniform is ≤ 2⁻¹²⁸.

**Params:** None.

**Returns:** `Secret` — A BN254 field element as 0x-prefixed 32-byte hex string.

---

**`generateEphemeralKeyPair() → KeyPair`**

Generates a single-use **X25519 (Curve25519)** key pair for ECDH encryption (e.g. inside `NoteComputationService.generateNoteData`). Distinct from `generateSecret` because an ephemeral private key is a Curve25519 scalar (32 uniform random bytes, clamped per RFC 7748 on use), not a BN254 field element — they are different number systems. `@noble/curves` `x25519.keygen()` produces the random scalar and the corresponding public key; clamping is applied internally on every scalar multiplication.

**Params:** None.

**Returns:** `KeyPair` — `{ privateKey: Secret, publicKey: PublicKey }` where `publicKey` is the 32-byte X25519 public key (u-coordinate, no prefix byte).

---

**`deriveKeysFromSignature(config) → DerivedKeyMaterial`**

Derives the protocol's three private keys from a wallet signature and signer address, following the Signature-Based Derivation spec. EIP-712 is recommended for the underlying payload (with RFC 6979-deterministic ECDSA), but the SDK only accepts the resulting signature + address — integrators choose how to produce them.

> **Generic seam.** `ICryptoService` is generic over the signature-derivation config type `TDeriveConfig` (defaults to `DeriveFromSignatureConfig`, the EVM shape documented below), and `deriveKeysFromSignature`'s parameter type is `TDeriveConfig`. This seam is now used by a second, non-EVM implementation — `StellarCryptoService` (`TDeriveConfig = StellarDeriveFromSignatureConfig`) — which derives its root secret from a raw ed25519 signature rather than an ECDSA `r`; see "Stellar support" below. Every other method on the interface (`ecdh`, `encrypt`, `decrypt`, `generateSecret`, `generateEphemeralKeyPair`) stays chain-independent at the interface level — each concrete class supplies its own curve-specific primitives (`ecdh`/`generateEphemeralKeyPair` are X25519 for `CryptoService`, secp256k1 for `StellarCryptoService`). `derivePaymentRequestKeyPair`'s `ownerAddress` param deliberately stays concrete EVM `Address`: the payment-request subsystem is a separate, already EVM-only boundary not touched by either implementation. For the EVM default (`DeriveFromSignatureConfig`), everything below is unchanged.

> **⚠ Determinism is load-bearing.** The HKDF tree is keyed on `r` (the first 32 bytes of the ECDSA signature). The SDK has no way to detect or correct a wallet that randomizes the ECDSA nonce `k` — re-signing the same EIP-712 payload on a non-RFC-6979 signer produces a different `r`, and therefore a different `(privateNullifyingKey, privateRevocableKey, viewingPrivateKey)`. Notes encrypted to the old viewing key become undecryptable; nullifiers computed against the new nullifying key won't match the on-chain commitments; the keystore leaf can't be located for rotation. Funds aren't stolen but are permanently unreachable through normal SDK flows.
>
> **Integrators MUST one of**:
> 1. **Use an RFC-6979-deterministic signer** for the `SecretDerivation` payload (most software wallets, viem `signTypedData`, ethers `_signTypedData`, Ledger app-eth ≥1.5, MetaMask ≥10). Hardware wallets with randomized nonces are not safe under (2) below.
> 2. **Persist the derived `DerivedKeyMaterial`** (or a canonical `r` / full signature) at registration time and re-hydrate from storage on cold start. Never re-sign for recovery.
>
> The SDK exposes neither the wallet signing call nor a determinism probe, so the choice above must be made at the integration layer.

> **Building the payload:** The SDK does not ship an EIP-712 payload builder. Integrators construct the typed data per the Signature-Based Derivation spec and present it to the wallet themselves — the SDK only consumes the resulting `(signature, signerAddress, revocableKeyIndex, addressHash)` tuple. Reference shape:
> - `domain.name = "Standardized Secret Derivation"`, `version = "1"`, `verifyingContract = 0x0…0`
> - `domain.salt = keccak256(APP_IDENTIFIER)` — app separator, prevents cross-app replay.
> - `primaryType = "SecretDerivation"`
> - `message.purpose` — human-readable string shown by the wallet.
> - `message.addressHash = keccak256(signerAddress)` — binds the signature to the signer.
> - `types.SecretDerivation = [{ name: "purpose", type: "string" }, { name: "addressHash", type: "bytes32" }]`

> **⚠ No signer recovery — payload determinism is the integrator's contract.** `deriveKeysFromSignature` does **not** call `recoverAddress`; it trusts the caller-supplied `(signature, signerAddress)` pair as a unit and only checks that the supplied `addressHash` equals `keccak256(signerAddress)` (an internal-consistency guard between caller-supplied fields, not a cryptographic binding). Two consequences:
>
> 1. **Captured-signature replay is undefended** at the SDK boundary — anyone holding the `(signature, signerAddress)` tuple can reproduce the same protocol keys. Adding signer recovery would not change this: the attacker recovers to the same legitimate signer the user does. Treat the signature as long-term key material; never log, persist, or transmit it. See also the "Threat model: signature compromise is total compromise" callout.
> 2. **Payload divergence yields different keys silently.** A wallet signing a *different* EIP-712 payload (typo in `domain.salt`, wrong `purpose`, mis-encoded `addressHash`, different `APP_IDENTIFIER`) produces a different `r`, and therefore a different key family. The SDK has no way to detect this — the resulting keys derive cleanly, the `addressHash` check passes if the caller keeps `signerAddress` and `addressHash` consistent with each other, and the user only discovers the divergence later when their notes can't be decrypted or their keystore proof can't be produced. This is not a steal-funds vector; it is a self-DoS and a cross-tool interoperability hazard.
>
> **Integrators MUST**:
> - Use the canonical payload shape **byte-for-byte** as defined in the "Building the payload" block above and the Signature-Based Derivation spec.
> - Use the **same payload across registration and recovery** within a single tool. An integrator that changes its payload between Day 1 (registration) and Day 2 (recovery) bricks the user's account locally; on-chain state is anchored to the keys derived from the original payload.
> - If interoperability across tools is required, agree on the canonical payload out of band. Two tools that build the payload differently derive different keys from the same wallet — they will not see each other's notes.

Two-stage HKDF-SHA256 (stays ephemeral — nothing persists beyond the returned keys):

```
r = signature[0..32]                                         // discard s, v

rootSecret = HKDF(ikm=r,          salt=signerAddress,  info="Standardized-Secret-Derivation-v1-Root", L=32)
appSecret  = HKDF(ikm=rootSecret, salt=APP_IDENTIFIER, info="Standardized-Secret-Derivation-v1-App",  L=32)

appSecret
  └── HKDF-Extract(salt="PP_V2") → masterPRK
        ├── HKDF-Expand("IDENTITY", 32) → identityPRK
        │     ├── HKDF-Expand("NULLIFYING", 48) → mod BN254 p → privateNullifyingKey
        │     └── HKDF-Expand("AUTH0:REVOCABLE" ‖ u64be(n), 48) → mod BN254 p → privateRevocableKey
        └── HKDF-Expand("VIEWING", 32) → viewingPRK
              └── HKDF-Expand("VIEWING_KEY", 32) → clamp (RFC 7748) → viewingPrivateKey (X25519)
```

All SDK-owned intermediates (internal `r` bytes, rootSecret, appSecret, PRKs, raw HKDF outputs) are zeroized after use.

> **Caller responsibility:** The `config.signature` parameter is an immutable JS string and cannot be zeroized by the SDK. Callers handling sensitive signatures SHOULD drop all references immediately after this call returns so the string becomes garbage-collectible.

> **⚠ Threat model: signature compromise is total compromise.** All three protocol keys (`privateNullifyingKey`, `privateRevocableKey`, `viewingPrivateKey`) are deterministic descendants of the same `r` (first 32 bytes of the ECDSA signature). Anyone who recovers `r` can reproduce the entire HKDF subtree on demand — decrypt every incoming note via the viewing key, compute every nullifier, and generate every spend proof. This is the cost of single-signature deterministic recovery; it is shared with HD-wallet schemes (BIP-32) and is intentional.
>
> **What revocable-key rotation does *not* defend against.** Rotating the revocable key (`HKDF-Expand("AUTH0:REVOCABLE" ‖ u64be(n+1), …)`) derives the new index from the **same** `r`. An attacker who holds `r` can derive index `n`, `n+1`, `n+2`, … just as the legitimate user can. Rotation is a defense against *leaf-key* leak (e.g., a witness or in-memory `privateRevocableKey` value escaping a single process), not against *root* compromise.
>
> **Mitigation surface lives at the integrator and contract layers:**
> - **Integrator:** never log, persist, or transmit `r` or the raw signature; treat the signing call as the sole boundary; drop the JS string immediately (see "Caller responsibility" above); prefer signers that don't expose ECDSA internals beyond the returned signature.
> - **Contract:** after rotation, the on-chain Keystore keeps the superseded root valid for `keystoreRootLiveness` seconds (see `contracts-tech-design.md`). During that window an attacker with the *old* keys can still settle a transact / withdraw against the old root. The window is an availability-vs-security tradeoff set by the deployer; calibrate it for the deployment's threat model.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `config.signature` | `Hex` | 65-byte ECDSA signature as 0x-prefixed hex. Only the first 32 bytes (`r`) are used. |
| `config.signerAddress` | `Address` | 20-byte EVM address that produced the signature. Used as HKDF salt in the root stage. |
| `config.revocableKeyIndex` | `Hex` _(required)_ | Rotation index `n` as 0x-prefixed hex; SDK encodes it as u64 big-endian in the revocable-key HKDF info string. Pass `"0x0"` for a fresh account; pass the persisted value on cold-start. The SDK does not discover the index from chain — integrator responsibility. Required at the type level so callers cannot silently fall back to index 0 after rotation. |
| `config.addressHash` | `Hex` _(optional)_ | Expected `keccak256(signerAddress)` from the signed EIP-712 payload. When provided, the SDK verifies it matches the hash of `signerAddress` before deriving — guards against phishing/replay where a payload crafted for a different address is fed in. Omitting the field skips the check (backward compatible). |

**Throws:**
- `PayloadAddressHashMismatch` (extends `KeyDerivationBaseError`) if `addressHash` is provided and does not equal `keccak256(signerAddress)`.

**Returns: `DerivedKeyMaterial`**

| Field | Type | Description |
| --- | --- | --- |
| `privateNullifyingKey` | `Secret` | Auth-agnostic identity anchor. Immutable after registration. |
| `privateRevocableKey` | `Secret` | Rotatable authorization credential at rotation index `n`. |
| `viewingPrivateKey` | `Secret` | X25519 (Curve25519) clamped scalar for ECDH-based note discovery. |
| `viewingPublicKey` | `Hex` | X25519 public key (32 bytes, no prefix byte). |

> `deriveKeys(appSecret, …)` is no longer part of the public API. The `appSecret` is ephemeral by design and must not cross the service boundary.

---

## Stellar support

Moved to [stellar-sdk/crypto-service.md](../stellar-sdk/crypto-service.md) — `StellarCryptoService` (`packages/stellar-sdk`) is a separate concrete implementation of `ICryptoService`, not part of this package. See that doc for its secp256k1 / ed25519-signature derivation, and [core-sdk/crypto-service.md](../core-sdk/crypto-service.md) for the shared `AbstractCryptoService` base both implementations extend.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.4.9 | 2026-09-16 — Doc split following the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` package split: this file now documents only the EVM `CryptoService`. The shared `AbstractCryptoService<TDeriveConfig>` contract moved to [core-sdk/crypto-service.md](../core-sdk/crypto-service.md); the Stellar-specific derivation (`StellarCryptoService`) moved to [stellar-sdk/crypto-service.md](../stellar-sdk/crypto-service.md). No code change. |
| 1.4.8 | 2026-09-08 — Added `StellarCryptoService`, a second `ICryptoService` implementation (Stellar/Soroban) extending the `AbstractCryptoService<TDeriveConfig>` base introduced in 1.4.7. Uses secp256k1 (not X25519) for `ecdh`/`generateEphemeralKeyPair`, deliberately non-interoperable with EVM's X25519 viewing keys. `deriveKeysFromSignature` derives rootSecret from a raw 64-byte ed25519 signature (`STELLAR_ROOT_SALT="PPV2_STELLAR"`, `STELLAR_ROOT_INFO="ROOT"`); appSecret and the layered HKDF tree reuse `AbstractCryptoService`'s inherited implementation as-is, including EVM's `APP_DERIVATION_INFO` — deliberate code reuse traded against byte-parity with the upstream reference implementation past rootSecret. Added `stellarAddressToField` (not part of `ICryptoService`) and the `StellarDeriveFromSignatureConfig` / `StellarSignatureSchema` / `StellarPublicKeySchema` types. No signature-to-signer binding check yet (tracked as future work). Supersedes the design-reference doc `stellar-crypto-service.md`, folded in above as "Stellar support". |
| 1.4.7 | 2026-09-08 — `ICryptoService` is now generic over a signature-derivation config type `TDeriveConfig` (defaults to `DeriveFromSignatureConfig`), and `deriveKeysFromSignature(config: DeriveFromSignatureConfig)` widened to `deriveKeysFromSignature(config: TDeriveConfig)`. This is the seam a future non-EVM (e.g. Stellar) crypto service plugs into, since it derives its root secret from an ed25519 signature rather than an ECDSA `r`; no such implementation exists yet, and the EVM default shape/behavior documented below is unchanged. `derivePaymentRequestKeyPair`'s `ownerAddress: Address` param was deliberately left concrete/EVM-only — the payment-request subsystem is a separate, already-documented EVM-only boundary, out of scope for this change. Doc-only impact for EVM callers. |
| 1.4.6 | 2026-05-26 — Added "No signer recovery — payload determinism is the integrator's contract" callout. Documents that `deriveKeysFromSignature` does not call `recoverAddress`; the `addressHash == keccak256(signerAddress)` check is internal-consistency only; captured-signature replay is undefended at the SDK boundary (and unfixable by signer recovery); payload divergence between registration and recovery silently produces different keys (self-DoS / cross-tool interop hazard, not a steal-funds vector). |
| 1.4.5 | 2026-05-22 — Added "Threat model: signature compromise is total compromise" callout to `deriveKeysFromSignature`. Documents that all three protocol keys descend from the same `r`, that revocable-key rotation does not defend against `r` leak (only against leaf-key leak), and that the on-chain `keystoreRootLiveness` window is the drain-after-rotate surface. Doc-only; no code change. |
| 1.4.4 | 2026-05-18 — Documented the determinism requirement for `deriveKeysFromSignature`: HKDF is keyed on the ECDSA `r`, so a non-RFC-6979 signer that randomizes `k` produces a different key family on re-sign, rendering prior notes undecryptable and unspendable. Integrators must either use a deterministic signer or persist the derived keys (audit M-4 line 454). |
| 1.4.3 | 2026-05-15 — Removed `buildSecretDerivationPayload` / `SECRET_DERIVATION_PURPOSE` / `SecretDerivationTypedData` from the SDK surface. EIP-712 payload construction now lives entirely on the integrator side, aligning with the "no key derivation in SDK; KeystoreManager takes raw keys only" contract. The reference payload shape stays documented above for integrators rebuilding the typed data themselves. |
| 1.4.2 | 2026-04-28 — `deriveKeysFromSignature` config: `revocableKeyIndex` is now REQUIRED (no default). Callers MUST explicitly pass `0n` for fresh accounts or the persisted index on cold-start. SDK does not provide a chain-side discovery mechanism — integrator persists the index. |
| 1.4.1 | Viewing key migrated from secp256k1 to Curve25519/X25519. HKDF-Expand output for `VIEWING_KEY` is now 32 bytes; the result is fed through RFC 7748 clamping to produce a clamped scalar. `viewingPublicKey` becomes 32 bytes (no compression prefix). `ecdh()` and `generateEphemeralKeyPair()` switch to X25519. Pre-migration testnet `viewingKeys` storage is incompatible — accounts must re-register. |
| 1.4.0 | `generateSecret` now returns a BN254 scalar field element (48 random bytes reduced mod `p` per RFC 9380 §5.1) — fixes a spec violation where raw 32 bytes could exceed `p` and break the field-element invariant for `noteSecret` / `depositSecret`. Added a separate `generateEphemeralKeyPair` spec entry; ephemeral keys are secp256k1 scalars (rejection-sampled to `[1, n−1]`), not BN254 field elements. (Grego AI #08) |
| 1.3.2 | `deriveKeysFromSignature` accepts optional `config.addressHash`; when supplied, verifies it equals `keccak256(signerAddress)` and throws `PayloadAddressHashMismatch` (extends `KeyDerivationBaseError`) on mismatch. Phishing/replay defence per Signature-Based Derivation Step 4. Backward compatible when omitted. |
| 1.3.1 | Documented `buildSecretDerivationPayload` / `SECRET_DERIVATION_PURPOSE` helper exported from `external.ts` for building the EIP-712 Step-2 payload consumed by `deriveKeysFromSignature`. |
| 1.3.0 | `deriveKeysFromSignature` now uses the signature-based derivation spec: 2-stage HKDF from `r` with `signerAddress` as salt, `APP_IDENTIFIER` as second-stage salt. `deriveKeys(appSecret)` removed from public API. |
| 1.2.0 | `deriveKeys` accepts optional `revocableKeyIndex` (u64) for deterministic key rotation. |
| 1.1.0 | Added `deriveKeys`, `deriveKeysFromSignature` (0XB-1065). |
| 1.0.0 | Initial spec. |