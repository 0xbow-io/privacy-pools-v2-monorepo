# CryptoService (Stellar)

### StellarCryptoService

`StellarCryptoService` (`packages/stellar-sdk/src/services/StellarCryptoService.ts`) implements `ICryptoService<StellarDeriveFromSignatureConfig>` for Stellar/Soroban integrators, extending the chain-agnostic `AbstractCryptoService<TDeriveConfig>` base defined in `packages/core-sdk` — see [core-sdk/crypto-service.md](../core-sdk/crypto-service.md) for the shared contract (`encrypt`/`decrypt`, `generateSecret`, and the appSecret-down HKDF tree). `StellarCryptoService` supplies chain-specific `ecdh`, `generateEphemeralKeyPair`, and the rootSecret stage of `deriveKeysFromSignature`; everything else is inherited. See [evm-sdk/crypto-service.md](../evm-sdk/crypto-service.md) for the sibling EVM `CryptoService` implementation (X25519 + ECDSA-signature derivation).

This doc supersedes the earlier design-reference draft [stellar-crypto-service.md](stellar-crypto-service.md), which is retained only for its historical derivation-tree diagram.

# Dependencies

None.

# Methods

Inherits `encrypt`, `decrypt`, and `generateSecret` unchanged from `AbstractCryptoService` — see [core-sdk/crypto-service.md](../core-sdk/crypto-service.md) for those. The methods below are Stellar-specific overrides or additions.

---

**secp256k1, not X25519 — a deliberate, chain-specific divergence.** `ecdh` and `generateEphemeralKeyPair` use secp256k1, matching the upstream reference implementation's own note-encryption scheme, and are **not interoperable** with EVM's X25519 viewing keys (a Stellar viewing key cannot ECDH against an EVM one, or vice versa). `viewingPublicKey` is a 33-byte compressed secp256k1 point (`StellarPublicKeySchema`), unlike EVM's 32-byte unprefixed X25519 key. This is a per-chain choice, not a regression of the EVM Curve25519/X25519 migration recorded in the EVM doc's version history — that migration was scoped to the EVM `CryptoService` only.

**Derivation tree: rootSecret diverges, appSecret and below are shared.** `deriveKeysFromSignature(config: StellarDeriveFromSignatureConfig)` overrides only the first HKDF stage:

```
rootSecret = HKDF-SHA256(ikm=signature, salt=STELLAR_ROOT_SALT="PPV2_STELLAR", info=STELLAR_ROOT_INFO="ROOT", L=32)
```

`config.signature` is the raw **64-byte ed25519** wallet signature (`StellarSignatureSchema`) over a fixed derivation message — not an EIP-712 ECDSA signature — so there is no `r`-extraction step; the full signature is the HKDF IKM directly.

Every stage after rootSecret — `appSecret = deriveAppSecret(rootSecret, config.appIdentifier)` and the full layered HKDF tree (`deriveKeys`) producing `privateNullifyingKey`, `privateRevocableKey`, and the viewing keypair — reuses `AbstractCryptoService`'s inherited implementation **as-is**, including EVM's `APP_DERIVATION_INFO` constant (`"Standardized-Secret-Derivation-v1-App"`). This is a deliberate maximize-code-reuse choice, confirmed cryptographically safe: by the time rootSecret is produced, the two chains' values are already unrelated (different signature scheme, different salt/info at stage 1), so sharing the appSecret-stage info string introduces no cross-chain key-collision risk.

**Trade-off:** `StellarCryptoService`'s derived keys are therefore **not byte-identical** to the upstream reference implementation past the rootSecret stage — that implementation uses its own `"APP"` info string for the appSecret stage instead of `APP_DERIVATION_INFO`. Integrators requiring byte-parity with the upstream reference derivation cannot get it from this SDK; the two agree only through rootSecret. (The earlier design-reference draft, `stellar-crypto-service.md`, proposed the opposite — reimplementing the appSecret stage with the upstream reference implementation's `"APP"` string to preserve parity — but the shipped implementation supersedes that draft with the reuse-over-parity choice described here.)

**`stellarAddressToField(stellarAddress) → Hex`.** Converts a Stellar StrKey address (e.g. `"G..."`) into a BN254 scalar-field element: `keccak256(utf8(stellarAddress)) % SNARK_SCALAR_FIELD`. Hashes the StrKey's raw ASCII text directly (not base32-decoded first), matching both the on-chain Soroban `address_to_field` computation and the upstream reference implementation's own `crypto.mjs` `addressToField` exactly. **Not part of `ICryptoService`** — it's a Stellar-only method on the concrete class, since EVM has no equivalent (an EVM address already fits as a field element, so the EVM address-field converter used elsewhere in the SDK — see [core-sdk/note-computation-service.md](../core-sdk/note-computation-service.md) `IAddressFieldConverter`/`EvmAddressFieldConverter` — is an identity function; `StellarCryptoService` does not itself implement `IAddressFieldConverter`).

**Config: `StellarDeriveFromSignatureConfig`**

| Field | Type | Description |
| --- | --- | --- |
| `signature` | `Hex` | Raw 64-byte ed25519 signature over a fixed derivation message, 0x-prefixed. |
| `appIdentifier` | `string` | HKDF salt for the shared appSecret stage — Stellar's analog of EVM's hardcoded `APP_IDENTIFIER`, but supplied per-call rather than baked in. Empty string is valid. |
| `revocableKeyIndex` | `Hex` _(required)_ | Same contract as EVM's field: u64 big-endian rotation index; no chain-side discovery, integrator persists it. |

New schemas: `StellarSignatureSchema` (validates the 64-byte signature) and `StellarPublicKeySchema` (validates a 33-byte compressed secp256k1 public key).

**Known gap: no signature-to-signer binding check.** Unlike EVM's optional `addressHash == keccak256(signerAddress)` guard, `StellarDeriveFromSignatureConfig` has **no signer-binding field**. The upstream reference implementation has none either, and the natural place to embed one — the fixed derivation message's exact wire format — is still-undesigned wallet-signing UX, tracked as future work. A caller supplying a signature intended for a different derivation is not currently guarded against. The "No signer recovery" and "Threat model: signature compromise is total compromise" callouts documented in [evm-sdk/crypto-service.md](../evm-sdk/crypto-service.md) apply equally here, with rootSecret (rather than `r`) as the load-bearing secret: anyone who recovers the raw signature can reproduce the entire derived key family.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.0.0 | 2026-09-16 — Split out of `evm-sdk/crypto-service.md` §"Stellar support" (added there in that doc's 1.4.8) following the `packages/sdk` → `core-sdk`/`evm-sdk`/`stellar-sdk` package split. No content change beyond retargeting cross-references. See [evm-sdk/crypto-service.md](../evm-sdk/crypto-service.md) for the full pre-split version history of `StellarCryptoService`'s introduction (1.4.7 generic seam, 1.4.8 landing). |
