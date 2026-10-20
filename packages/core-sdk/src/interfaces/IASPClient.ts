import type { Hash, LabelStatus, MerkleProof, PublicKey } from "../internal.js";

/**
 * Client for interacting with an Association Set Provider.
 * Orchestrates data providers and local proof generation.
 */
export interface IASPClient {
    /**
     * Retrieves the current association set root.
     *
     * @returns The association set root hash.
     * @throws {ASPClientBaseError}
     */
    getAssociationSetRoot(): Promise<Hash>;

    /**
     * Retrieves all leaves of the association set.
     *
     * @returns Array of leaf hashes.
     * @throws {ASPClientBaseError}
     */
    getAssociationSetLeaves(): Promise<Hash[]>;

    /**
     * Generates a Merkle inclusion proof for the given label hash.
     * Fetches leaves from providers and generates the proof locally.
     *
     * @param labelHash - The label hash to prove inclusion for.
     * @returns The Merkle inclusion proof.
     * @throws {ASPClientBaseError}
     */
    getMerkleProof(labelHash: Hash): Promise<MerkleProof>;

    /**
     * Retrieves the status of a given label.
     *
     * NOT for note discovery, nor for anything else that runs over the labels a wallet
     * holds. The argument is one of the caller's own labels, so a sweep over a wallet's
     * notes asks the ASP, one request each, for exactly the deposits those notes descend
     * from — including both ends of a shielded transfer, from one client, in one burst.
     * `PoolSessionNoteDiscovery` answers label status from {@link getAssociationSetLeaves}
     * instead: the same information, published in bulk to everyone, so asking for it
     * identifies nothing about the caller.
     *
     * @param label - The label hash to query.
     * @returns The label status.
     * @throws {ASPClientBaseError}
     */
    getLabelStatus(label: Hash): Promise<LabelStatus>;

    /**
     * Retrieves the ASP's public key.
     *
     * This key encrypts the deposit registration payload (see
     * `PoolSessionDeposit.generateASPCipherText`), so whoever holds the
     * matching private key can read the deposit secret and amount. The ASP
     * is a trusted party in this protocol, so the key is not authenticated
     * against an on-chain commitment. Without a pinned key (see
     * `ASPClientConfig.publicKey`) the value comes from the first responding
     * provider over the configured transport. For production, pin the key and
     * use an `https` ASP URL so a network attacker cannot substitute it.
     *
     * @returns The ASP public key.
     * @throws {ASPClientBaseError}
     */
    getASPPublicKey(): Promise<PublicKey>;
}
