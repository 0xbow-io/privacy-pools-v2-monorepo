/** Base error class for all contract interactor errors. */
export class ContractInteractorBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "ContractInteractorBaseError";
    }
}

/** Thrown when a contract read operation fails. */
export class ContractCallError extends ContractInteractorBaseError {
    /** @param reason - Short description (e.g. "execution reverted"). */
    constructor(reason: string) {
        super(`Contract call failed: ${reason}`);
        this.name = "ContractCallError";
    }
}

/** Thrown when the contract address provided to a constructor is invalid. */
export class InvalidInteractorAddress extends ContractInteractorBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid contract address: ${reason}`);
        this.name = "InvalidInteractorAddress";
    }
}

/** Thrown when an address argument passed to a method is invalid. */
export class InvalidAddressArgument extends ContractInteractorBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid address argument: ${reason}`);
        this.name = "InvalidAddressArgument";
    }
}

/** Thrown when a hex/hash argument passed to a method is invalid. */
export class InvalidHashArgument extends ContractInteractorBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid hash argument: ${reason}`);
        this.name = "InvalidHashArgument";
    }
}

/** Thrown when the result of a contract call is invalid. */
export class InvalidContractResult extends ContractInteractorBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid contract result: ${reason}`);
        this.name = "InvalidContractResult";
    }
}

/** Thrown when a write operation is attempted without a wallet interactor. */
export class WalletNotAvailable extends ContractInteractorBaseError {
    /** @param reason - Description of which interactor needs the wallet. */
    constructor(reason: string) {
        super(`Wallet not available: ${reason}`);
        this.name = "WalletNotAvailable";
    }
}
