import { Address } from "./Address.js";
import { Hash } from "./Hash.js";
import { Hex } from "./Hex.js";
import { Label } from "./Label.js";
import { NoteStatus } from "./NoteStatus.js";
import { Secret } from "./Secret.js";

/**
 * A single UTXO inside the shielded pool, generic over the chain's address type `TAddress`
 * (defaults to EVM's {@link Address}).
 * Identified by its commitment hash which binds
 * owner, value, token, and label without on-chain exposure.
 */
export type Note<TAddress = Address> = PendingNote<TAddress> & {
    /**
     * The on-chain `block.timestamp` (unix seconds) of the block that inserted the commitment,
     * NOT a block number despite the name. The state-tree leaf is
     * `Poseidon(commitment, block.timestamp)` and `WitnessPreparationService` recomputes it from
     * this field, so every producer (deposit, transact, discovery) stores the timestamp read back
     * from `PoolVault.commitments(commitment)`. The name is kept for storage and export
     * compatibility. A legacy export may still carry a real block number here; a reader that
     * needs a time treats any value below 1e9 as missing rather than interpreting it.
     */
    createdAtBlock: Hex;
    /**
     * Block number when the nullifier was published. Null if unspent. Best effort: when the
     * spend event carried no block number, discovery stores the scan's own `fromBlock` here, so
     * this is a status stamp, not a reliable spend time.
     */
    spentAtBlock: Hex | null;
    /** Transaction hash of the note creation. */
    txHash: Hash;
};

/** A pending (not yet confirmed) note, generic over the chain's address type `TAddress`. */
export interface PendingNote<TAddress = Address> {
    /** Poseidon(ownerAddress, noteSecret). Unique on-chain address. */
    noteAddressHash: Hash;
    /** Poseidon(precommitment, label). Unique on-chain commitment. */
    commitment: Hash;
    /** Token amount in smallest unit. */
    value: Hex;
    /** Token identifier. 0xEeee...EEeE = native ETH, ERC-20 contract address for tokens. */
    tokenId: TAddress;
    /** Poseidon(precommitment, depositSecret). Shared by all notes in the same lineage. */
    label: Label;
    /** Current lifecycle status. */
    status: NoteStatus;
    /** Address of the note owner. */
    ownerAddress: TAddress;
    /** Random secret for noteAddressHash = Poseidon(ownerAddress, noteSecret). */
    noteSecret: Secret;
    /** Whether this note is owned by the current user. */
    isOwned: boolean;
    /**
     * Secret bound into `label = Poseidon(precommitment, depositSecret)` at
     * deposit time. Present only on the note that originated its lineage;
     * absent on every note inherited via transfer, payment request, or
     * discovery, because only the original depositor ever held the value.
     */
    depositSecret?: Secret;
}

export interface NoteData { hint: Hex; data: Hex }
