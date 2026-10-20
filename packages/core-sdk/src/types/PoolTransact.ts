import type { Address, Hash, Hex } from "../index.js";

/** Parameters for prepareTransfer, generic over the chain's address type `TAddress`. */
export interface PrepareTransactBase<TAddress = Address> {
    /** Commitment hashes of the input notes to spend. All must be ACTIVE. */
    inputCommitments: Hash[];
    /** Amount to transfer to the recipient (becomes an output note inside the pool). */
    amount: Hex;
    /** Token identifier for the transferred asset. */
    tokenId: TAddress;
    /** Relay address. */
    relayAddress?: TAddress;
    /** Fee amount to pay the relayer. */
    feeAmount?: Hex;
    /**
     * Processor bound into the transact proof. On-chain, `PoolVault.transact`
     * requires `processor == msg.sender`, so only this address can submit the
     * proof. Relayed flows always override it with the relayer's processor
     * address. When omitted, the default differs by entry point:
     * `prepareTransfer` uses the owner's address — self-submit works, but the
     * owner is visible as the on-chain sender, so that transfer is not private.
     * `prepareWithdraw` and `prepareColdStartTransfer` use the zero address,
     * so their self-submit calldata always reverts with
     * `PoolVault_InvalidProcessor`.
     */
    processorAddress?: TAddress;
    /**
     * Native ETH the caller commits to attach with the relay call
     * (`PayoutRouting.nativeGas`). PrivacyPoolRelay enforces
     * `msg.value == nativeGas`. Defaults to `0x0` (no gas funding).
     */
    nativeGas?: Hex;
    /**
     * Optional fee recipient override (`PayoutRouting.feeRecipient`). When
     * omitted, the self-relay path uses `relayAddress`; pass `EMPTY_ADDRESS`
     * to fall back to `msg.sender` on-chain.
     */
    feeRecipient?: TAddress;
}
