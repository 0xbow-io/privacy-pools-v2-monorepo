# CryptoService (shared contract)

### AbstractCryptoService / ICryptoService&lt;TDeriveConfig&gt;

`AbstractCryptoService<TDeriveConfig>` (`packages/core-sdk`) is the chain-agnostic base every concrete `ICryptoService` implementation extends. It holds every curve-independent piece of the note-encryption/key-derivation scheme; each concrete subclass supplies only its curve-specific `ecdh`, `generateEphemeralKeyPair`, and the root-secret stage of `deriveKeysFromSignature`.

Two concrete implementations exist today:

| Implementation | Package | Curve (`ecdh`/ephemeral keys) | Root-secret input |
| --- | --- | --- | --- |
| `CryptoService` | `packages/evm-sdk` | X25519 (Curve25519) | ECDSA signature `r` — see [evm-sdk/crypto-service.md](../evm-sdk/crypto-service.md) |
| `StellarCryptoService` | `packages/stellar-sdk` | secp256k1 | raw ed25519 signature — see [stellar-sdk/crypto-service.md](../stellar-sdk/crypto-service.md) |

`ICryptoService` is generic over the signature-derivation config type `TDeriveConfig` (EVM defaults to `DeriveFromSignatureConfig`; Stellar uses `StellarDeriveFromSignatureConfig`) — this is the seam each concrete class plugs its chain-specific signature scheme into.

# Dependencies

None. `AbstractCryptoService` is stateless with no injected dependencies; it operates on raw keys and data passed per-call.

# Shared (inherited) behavior

These pieces are curve-independent and implemented once on `AbstractCryptoService`; every concrete subclass gets them unchanged:

- **`encrypt(data, sharedSecret) → Hex`** / **`decrypt(ciphertext, sharedSecret) → Uint8Array`** — symmetric encryption/decryption of note payloads using a shared secret from `ecdh`.
- **`generateSecret() → Secret`** — a cryptographically secure random BN254 scalar field element, used for `noteSecret` / `depositSecret` (circuit-consumed values).
- **The appSecret-down HKDF tree** — once a concrete implementation's `deriveKeysFromSignature` produces `rootSecret` and `appSecret`, the remaining layered HKDF derivation (`identityPRK` → `privateNullifyingKey` / `privateRevocableKey`; `viewingPRK` → the viewing keypair) is shared logic on the base class, keyed by the same salts/info strings (`PP_V2`, `IDENTITY`, `VIEWING`, `NULLIFYING`, `AUTH0:REVOCABLE`) regardless of chain.

# Per-implementation (overridden) behavior

Each concrete class supplies:

- **`ecdh(privateKey, publicKey) → Secret`** — curve-specific Diffie-Hellman.
- **`generateEphemeralKeyPair() → KeyPair`** — a single-use keypair on the same curve as `ecdh`.
- **The root-secret stage of `deriveKeysFromSignature(config: TDeriveConfig)`** — how the chain's wallet signature is turned into `rootSecret` (and, from there, `appSecret` via the shared `deriveAppSecret` helper).

See the linked per-chain docs above for the concrete method signatures, wire formats, threat-model callouts, and version histories — this page only documents the shared contract.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.0 | 2026-09-16 — Split out of `sdk/crypto-service.md` as part of the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` package split. Documents only the shared `AbstractCryptoService`/`ICryptoService<TDeriveConfig>` contract; the two concrete implementations' full histories live in [evm-sdk/crypto-service.md](../evm-sdk/crypto-service.md) (primary lineage — the original doc's 1.0.0–1.4.9 history) and [stellar-sdk/crypto-service.md](../stellar-sdk/crypto-service.md). |
