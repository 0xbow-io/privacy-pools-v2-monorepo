/** Base error class for all ProofService-related errors. */
export class ProofServiceBaseError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "ProofServiceBaseError";
    }
}

export class ProofGenerationFailed extends ProofServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "ProofGenerationFailed";
    }
}

export class ProofVerificationFailed extends ProofServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "ProofVerificationFailed";
    }
}

export class CircuitArtifactLoadFailed extends ProofServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "CircuitArtifactLoadFailed";
    }
}

/**
 * Thrown when SHA-256 of a fetched circuit artifact does not match the
 * multihash digest embedded in its CID. Subclass of
 * {@link CircuitArtifactLoadFailed} so the existing gateway-fallback loop
 * treats it like any other fetch failure and continues to the next gateway.
 */
export class CircuitArtifactMultihashMismatch extends CircuitArtifactLoadFailed {
    constructor(message: string) {
        super(message);
        this.name = "CircuitArtifactMultihashMismatch";
    }
}

export class CircuitNotAvailable extends ProofServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "CircuitNotAvailable";
    }
}

export class InvalidTransactDimensions extends ProofServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidTransactDimensions";
    }
}

export class InvalidWitness extends ProofServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidWitness";
    }
}

export class InvalidProof extends ProofServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidProof";
    }
}
