/** Base error class for all MerkleService-related errors. */
export class MerkleServiceBaseError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "MerkleServiceBaseError";
    }
}

export class LeafNotFound extends MerkleServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "LeafNotFound";
    }
}

export class InvalidLeaves extends MerkleServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidLeaves";
    }
}

export class InvalidLeaf extends MerkleServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidLeaf";
    }
}

export class TreeGenerationError extends MerkleServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "TreeGenerationError";
    }
}

export class InvalidMerkleProof extends MerkleServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidMerkleProof";
    }
}

export class MerkleProofVerificationFailed extends MerkleServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "MerkleProofVerificationFailed";
    }
}
