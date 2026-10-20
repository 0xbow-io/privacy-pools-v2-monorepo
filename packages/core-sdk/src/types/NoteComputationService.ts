import type { ZodType } from "zod";

import type { ICryptoService, IHashService, ILogger } from "../internal.js";

/**
 * Configuration for the NoteComputationService.
 */
export interface NoteComputationServiceConfig {
    /** The hash service used for Poseidon hash computations. */
    hashService: IHashService;
    /** The crypto service used for ephemeral key generation, ECDH, and encryption in generateNoteData. */
    cryptoService: ICryptoService;
    /**
     * Validates a decoded note payload's `tokenId` (a field-converted value —
     * `IAddressFieldConverter.toTokenIdField` — not a literal chain address). Defaults to the
     * EVM-shaped `AddressSchema` (exactly 20 bytes) when omitted, since EVM's converter is the
     * identity and a genuine EVM tokenId is never legitimately shorter. A chain whose converted
     * value can be legitimately shorter than its max width (e.g. Stellar's 160-bit mask) should
     * inject `TokenIdFieldSchema` instead.
     */
    tokenIdFieldSchema?: ZodType<string>;
}

/**
 * Optional dependencies for the NoteComputationService.
 */
export interface NoteComputationServiceDependencies {
    /** Optional logger for debug output. */
    logger?: ILogger;
}
