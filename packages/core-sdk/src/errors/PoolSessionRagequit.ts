import type { Hash } from "../internal.js";

/** Base error class for all PoolSessionRagequit errors. */
export class PoolSessionRagequitBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionRagequitBaseError";
    }
}

/** Thrown when the constructor config (poolAddress) is invalid. */
export class InvalidPoolSessionRagequitConfig extends PoolSessionRagequitBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid pool session ragequit config: ${reason}`);
        this.name = "InvalidPoolSessionRagequitConfig";
    }
}

/** Thrown when ragequit parameters fail input validation. */
export class InvalidRageQuitParams extends PoolSessionRagequitBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid ragequit params: ${reason}`);
        this.name = "InvalidRageQuitParams";
    }
}

/** Thrown when attempting to ragequit a note that has already been exited. */
export class RagequitNoteAlreadyExitedError extends PoolSessionRagequitBaseError {
    /** @param commitment - The commitment of the already-exited note. */
    constructor(commitment: Hash) {
        super(`Ragequit failed: note ${commitment} has already been exited`);
        this.name = "RagequitNoteAlreadyExitedError";
    }
}

/**
 * Thrown when a note has no owner EVM address (ownerAddress is the zero address) so it cannot
 * ragequit. The note's on-chain commitment binds the zero address, and `PoolVault.ragequit`
 * pays `msg.sender == proof.ownerAddress`, which the zero address can never satisfy. These are
 * payment-key / addressless recipient notes. Spending them is a Milestone 2 capability.
 */
export class RagequitAddresslessNoteError extends PoolSessionRagequitBaseError {
    /** @param commitment - The commitment of the addressless note. */
    constructor(commitment: Hash) {
        super(
            `Ragequit failed: note ${commitment} has no owner address (received via an ` +
                `addressless / payment-key flow). Such notes cannot ragequit yet.`,
        );
        this.name = "RagequitAddresslessNoteError";
    }
}
