import { Address } from "../internal.js";

/**
 * Base interface for all read-only contract interactors, generic over the chain's address type
 * `TAddress` (defaults to EVM's {@link Address}).
 */
export interface IContractInteractor<TAddress = Address> {
    /**
     * Returns the contract address this interactor is bound to.
     *
     * @returns The on-chain contract address.
     */
    getAddress(): TAddress;
}
