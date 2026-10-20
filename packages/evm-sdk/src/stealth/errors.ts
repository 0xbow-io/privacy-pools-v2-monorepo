/**
 * Base class for every stealth-module error. Lets callers
 * `catch (e instanceof StealthAddressError)` to handle the family.
 */
export class StealthAddressError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StealthAddressError";
    }
}

/**
 * Thrown when ECDH, scalar multiplication, or hex decoding fails on the
 * derivation path.
 */
export class StealthAddressDeriveError extends StealthAddressError {
    constructor(message: string) {
        super(message);
        this.name = "StealthAddressDeriveError";
    }
}

/**
 * STLTH-01 + STLTH-19: an unrecognised scheme id reached the dispatch boundary.
 * Phase 2 supports canonical scheme 1 (`0x0001`) and the FluidKey variant
 * (`0xfffe` until STLTH-21 partnership registration lands).
 */
export class StealthAddressUnsupportedSchemeError extends StealthAddressError {
    constructor(received: number) {
        super(
            `Unsupported stealth scheme id 0x${received.toString(16)}. ` +
                `Recognised schemes: canonical (0x0001), FluidKey (0xfffe).`,
        );
        this.name = "StealthAddressUnsupportedSchemeError";
    }
}

/**
 * STLTH-19: the schemeId argument and the metaAddress.scheme field
 * disagreed. Hard-error at the dispatch boundary; no silent fallback.
 */
export class StealthAddressSchemeMismatchError extends StealthAddressError {
    constructor(metaScheme: number, argScheme: number) {
        super(
            `Scheme mismatch: meta-address declares scheme 0x${metaScheme.toString(16)} ` +
                `but caller passed scheme 0x${argScheme.toString(16)}. ` +
                `STLTH-19 forbids cross-scheme dispatch. Pass the matching schemeId.`,
        );
        this.name = "StealthAddressSchemeMismatchError";
    }
}

/**
 * Thrown when an announcement's encoded fields fail invariant checks
 * (e.g. metadata length != 1 byte under STLTH-12).
 */
export class StealthAddressAnnouncementError extends StealthAddressError {
    constructor(message: string) {
        super(message);
        this.name = "StealthAddressAnnouncementError";
    }
}

/**
 * Recipient-side: thrown by `deriveStealthPrivateKey` when the derived
 * stealth private key fails to control the announced stealth address.
 * Signals a Byzantine sender (mangled announcement) or scheme mismatch.
 */
export class StealthAddressScanIntegrityError extends StealthAddressError {
    constructor(message: string) {
        super(message);
        this.name = "StealthAddressScanIntegrityError";
    }
}
