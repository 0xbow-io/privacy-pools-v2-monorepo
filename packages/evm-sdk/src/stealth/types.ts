/**
 * Two ERC-5564 schemes ship in v1.0:
 *   - SCHEME_CANONICAL (`0x0001`): point-addition variant per EIP-5564. ECDH
 *     against the recipient's viewing pub key; classical view/spend separation.
 *   - SCHEME_FLUIDKEY (`0xfffe`): point-multiplication variant per FluidKey's
 *     deployed kit. ECDH against the spending pub key (STLTH-17 trust
 *     deviation). `0xfffe` is unallocated by EIP-5564; STLTH-21 tracks the
 *     partnership work to register FluidKey's variant under a permanent ID,
 *     at which point this constant moves to that value in a single edit.
 *
 * Dispatch happens on `metaAddress.scheme` (STLTH-19) with `assertNever` in
 * the default arm, so adding a third scheme is a compiler-enforced sweep.
 */
export const SCHEME_CANONICAL = 0x0001 as const;
export const SCHEME_FLUIDKEY = 0xfffe as const;
export type SchemeId = typeof SCHEME_CANONICAL | typeof SCHEME_FLUIDKEY;

/**
 * Generic hex string (0x-prefixed, lowercase). Used as the carrier type for
 * the more specific branded sub-types below. Direct consumption should be
 * rare; downstream code should require the specific branded form to catch
 * arg-order swaps at compile time.
 */
export type Hex = string & { readonly __brand: "Hex" };

/** 33-byte secp256k1 compressed public key (0x02 or 0x03 prefix + 32-byte X). */
export type CompressedPubKey = string & { readonly __brand: "CompressedPubKey" };

/** 65-byte secp256k1 uncompressed public key (0x04 prefix + 32-byte X + 32-byte Y). */
export type UncompressedPubKey = string & { readonly __brand: "UncompressedPubKey" };

/** 32-byte secp256k1 scalar (private key or hash output) as lowercase 0x-prefixed hex. */
export type Scalar32 = string & { readonly __brand: "Scalar32" };

/** 20-byte EVM address as lowercase 0x-prefixed hex. */
export type EvmAddress = string & { readonly __brand: "EvmAddress" };

/**
 * Canonical EIP-5564 meta-address: a tagged pair of compressed pub keys.
 * Encoded on the wire as `st:eth:0x<spending_compressed><viewing_compressed>`
 * (66 bytes hex). The recipient holds the corresponding (spending_priv,
 * viewing_priv) pair; viewing_priv suffices for scanning, spending_priv for
 * spending. Classical view/spend separation.
 */
export interface CanonicalMetaAddress {
    readonly scheme: typeof SCHEME_CANONICAL;
    readonly spendingPubKey: CompressedPubKey;
    readonly viewingPubKey: CompressedPubKey;
}

/**
 * FluidKey-variant meta-address: a single uncompressed spending pub key.
 * The viewing key is not part of the wire format; STLTH-17 documents why
 * the scanner only needs spending_priv (the ECDH is against spending_pub,
 * not viewing_pub, in this variant).
 */
export interface FluidKeyMetaAddress {
    readonly scheme: typeof SCHEME_FLUIDKEY;
    readonly spendingPubKey: UncompressedPubKey;
}

/**
 * Discriminated union of supported meta-address shapes. Every public SDK
 * entry point dispatches on `metaAddress.scheme` per STLTH-19; the compiler
 * enforces exhaustive switch via `assertNever` in the default arm.
 */
export type MetaAddress = CanonicalMetaAddress | FluidKeyMetaAddress;

/**
 * Per-withdrawal CSPRNG-fresh keypair. The public format differs per scheme
 * (canonical uses compressed 33 bytes, FluidKey uses uncompressed 65 bytes),
 * so the type carries both branded options; the scheme-specific derive
 * function generates the right shape and the type-system tolerates either.
 *
 * STLTH-13: the private half MUST come from a CSPRNG, never from a
 * deterministic derivation.
 */
export interface EphemeralKeyPair {
    readonly privateKey: Scalar32;
    readonly publicKey: CompressedPubKey | UncompressedPubKey;
}

/**
 * ERC-5564 announcement payload. STLTH-12: metadata is the 1-byte view tag
 * only. STLTH-09: view tag is exactly 1 byte. Per-scheme discriminated union
 * so the bundle composer + scan path both know whether ephemeralPubKey is
 * compressed or uncompressed.
 */
export interface CanonicalAnnouncement {
    readonly schemeId: typeof SCHEME_CANONICAL;
    readonly stealthAddress: EvmAddress;
    readonly ephemeralPubKey: CompressedPubKey;
    /** Exactly 1 byte: in [0, 256). */
    readonly viewTag: number;
}

export interface FluidKeyAnnouncement {
    readonly schemeId: typeof SCHEME_FLUIDKEY;
    readonly stealthAddress: EvmAddress;
    readonly ephemeralPubKey: UncompressedPubKey;
    readonly viewTag: number;
}

export type Announcement = CanonicalAnnouncement | FluidKeyAnnouncement;

/**
 * Sender-side derivation output: the destination address and the
 * announcement payload that MUST accompany the withdrawal atomically
 * (STLTH-02, STLTH-03).
 */
export interface StealthDerivation {
    readonly stealthAddress: EvmAddress;
    readonly announcement: Announcement;
}

/**
 * Exhaustiveness helper. The TS compiler infers the type of the argument as
 * `never` when every union case has been handled in a preceding branch; if
 * an unhandled case slips in, this gets called with a real value and the
 * type-check fails. Used in dispatch boundaries per STLTH-19.
 */
export const assertNever = (x: never): never => {
    throw new Error(`Unhandled dispatch case: ${JSON.stringify(x)}`);
};
