/**
 * HKDF-Extract salt — protocol-level domain separator (RFC 5869 §2.2). Public constant, not random.
 * Ensures keys derived here cannot collide with any other protocol using the same appSecret.
 * Only one Extract call is made in the entire derivation tree (single-Extract architecture).
 */
export const PROTOCOL_SALT = "PP_V2";

/**
 * HKDF-Expand info for the identity domain PRK (32-byte output).
 * Root for long-lived keys: nullifying key (auth-agnostic) and auth-scoped keys (AUTH0:, AUTH1:, …).
 */
export const IDENTITY_DOMAIN = "IDENTITY";

/**
 * HKDF-Expand info for the viewing domain PRK (32-byte output).
 * Root for the off-chain ECDH note-discovery key. Isolated so viewing-key disclosure
 * cannot aid attacks on identity keys.
 */
export const VIEWING_DOMAIN = "VIEWING";

/**
 * HKDF-Expand info for the auth-agnostic nullifying key (48-byte output → mod BN254 p).
 * Permanent identity anchor; used for nullifier derivation (Poseidon(privateNullifyingKey, commitment))
 * and authType-0 ownership verification. Immutable for the lifetime of the account.
 */
export const NULLIFYING_INFO = "NULLIFYING";

/**
 * HKDF-Expand info prefix for the authType-0 revocable key at rotation index n.
 * Full info = "AUTH0:REVOCABLE" ‖ n_u64be (8-byte big-endian, no separator).
 * Registered on-chain as Poseidon(privateRevocableKey) inside authorizerDigest.
 * Rotation increments n; all past versions remain recoverable from appSecret.
 */
export const AUTH0_REVOCABLE_PREFIX = "AUTH0:REVOCABLE";

/**
 * HKDF-Expand info for the off-chain note-discovery viewing key (32-byte output).
 * The 32 bytes are interpreted as a Curve25519 private scalar via RFC 7748 clamping
 * (bytes[0] &= 0xF8; bytes[31] &= 0x7F; bytes[31] |= 0x40).
 */
export const VIEWING_KEY_INFO = "VIEWING_KEY";

/**
 * BN254 scalar field modulus p. All identity and secret keys are reduced mod p before use as
 * Poseidon inputs. Per RFC 9380 §5.1, 48-byte HKDF outputs give statistical distance from
 * uniform ≤ 2^-128 (formula: L = ⌈(⌈log₂ p⌉ + 128) / 8⌉ = ⌈(254 + 128) / 8⌉ = 48).
 */
export const BN254_SCALAR_MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Application identifier used as HKDF salt for the second-stage appSecret derivation.
 * Final: every mainnet key is derived with this exact value. Changing it would invalidate all
 * derived keys, so it must never change.
 */
export const APP_IDENTIFIER = "TODO-privacy-pools-v2";

/**
 * HKDF-Expand info for the first-stage rootSecret derivation from the signature r value.
 * Stage 1: rootSecret = HKDF-SHA256(ikm=r, salt=signerAddress, info=ROOT_DERIVATION_INFO, L=32).
 * Follows the signature-based derivation spec (Notion: Signature-Based Derivation Implementation Guide).
 */
export const ROOT_DERIVATION_INFO = "Standardized-Secret-Derivation-v1-Root";

/**
 * HKDF-Expand info for the second-stage appSecret derivation from the rootSecret.
 * Stage 2: appSecret = HKDF-SHA256(ikm=rootSecret, salt=APP_IDENTIFIER, info=APP_DERIVATION_INFO, L=32).
 */
export const APP_DERIVATION_INFO = "Standardized-Secret-Derivation-v1-App";

/**
 * Prefix for the HKDF info string used to derive a payment-request X25519 key
 * from the viewing private key. The full info is `${PAYMENT_REQUEST_KEY_INFO}${paymentId}`,
 * binding the derived key to the specific request so it cannot be reused.
 */
export const PAYMENT_REQUEST_KEY_INFO = "payment-request-key/";

/**
 * HKDF-Expand salt for Stellar's first-stage rootSecret derivation from the raw ed25519
 * signature. This stage is genuinely chain-specific (different signature scheme, no r-value to
 * extract) and has no shared implementation with EVM.
 * Stage 1: rootSecret = HKDF-SHA256(ikm=signature, salt=STELLAR_ROOT_SALT,
 * info=STELLAR_ROOT_INFO, L=32).
 *
 * Every stage AFTER rootSecret — appSecret onward — reuses `AbstractCryptoService`'s shared
 * `deriveAppSecret`/`deriveKeys` as-is, including EVM's `APP_DERIVATION_INFO` info string. That
 * is a deliberate choice, not an oversight: the two chains' rootSecret values are already
 * cryptographically unrelated by this point (different signature scheme, different salt/info),
 * so sharing the appSecret-stage info string introduces no cross-chain key-collision risk.
 */
export const STELLAR_ROOT_SALT = "PPV2_STELLAR";

/** HKDF-Expand info for Stellar's first-stage rootSecret derivation. See {@link STELLAR_ROOT_SALT}. */
export const STELLAR_ROOT_INFO = "ROOT";

/**
 * `manage_data` key for the fixed, never-submitted transaction a Stellar wallet signs to produce
 * `StellarDeriveFromSignatureConfig.signature` — see `buildKeyDerivationTransaction`. Versioned
 * (`v1`) so the transaction shape can change later without silently deriving different keys
 * under an unchanged identifier.
 */
export const STELLAR_KEY_DERIVATION_DATA_KEY = "pp:keyderiv:v1";

/**
 * Fixed sequence number for the key-derivation transaction — deliberately NOT the account's real
 * sequence number, which changes over time and would otherwise change the signed transaction
 * bytes (and therefore the derived signature/keys) on every re-derivation.
 */
export const STELLAR_KEY_DERIVATION_SEQUENCE = "0";
