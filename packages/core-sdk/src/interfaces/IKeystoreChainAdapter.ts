import type { Address, Eip712TypedData, Hash, Hex, RelayedRegistrationAuthorization } from "../internal.js";

/**
 * Chain-specific mechanics for `KeystoreInteractor<TTx, TAddress>`: raw reads, event fetch +
 * decode, calldata/XDR encoding, and transaction submission. See `IPoolVaultChainAdapter`'s doc
 * comment for the split rationale and the `TTx`/`TAddress` generics (no `TProof` here — Keystore
 * operations never take a ZK proof) — `KeystoreInteractor` shares the identical leaf-cache
 * pattern, so the payoff here is the same as `PoolVaultInteractor`'s.
 *
 * Relayed registration is chain-neutral through `buildRegistrationAuthorization` /
 * `signRegistrationAuthorization`; `signTypedData` remains for EVM-only callers.
 */
export interface IKeystoreChainAdapter<TTx, TAddress = Address> {
    /** The on-chain Keystore contract address this adapter is bound to. */
    getAddress(): TAddress;

    getNullifyingKeyHashRaw(account: TAddress): Promise<Hash>;
    getViewingKeyRaw(account: TAddress): Promise<Hash>;
    isKnownRootRaw(root: Hash): Promise<boolean>;

    /** Current chain cursor (EVM: block number) — the upper bound for a leaf-delta fetch. */
    getCurrentCursor(): Promise<bigint>;

    /**
     * Fetches and decodes leaf deltas in `[fromCursor, toCursor]`, already validated into
     * `{leafIndex, newLeaf}` pairs, split into `inserted`/`updated` (matching the on-chain
     * `LeafInserted`/`LeafUpdated` event split) so `KeystoreInteractor` can apply inserts first
     * and bounds-check updates against the resulting size — same two-pass semantics as before,
     * just relocated. Both lists are in chronological log order.
     */
    fetchLeafDeltas(
        fromCursor: bigint | undefined,
        toCursor: bigint,
    ): Promise<{
        inserted: { leafIndex: number; newLeaf: Hash }[];
        updated: { leafIndex: number; newLeaf: Hash }[];
    }>;

    /** Latest `authDigest` for `account` from the auth-policy event history, or `null`. */
    getCurrentAuthorizerDigestRaw(account: TAddress): Promise<Hash | null>;

    /**
     * @param sequenceOffset - Chain-specific hint for adapters whose network enforces strict
     *   sequential submission (e.g. Soroban's account sequence numbers, which tolerate no
     *   mempool-style pending queue): how many submissions past the source account's current
     *   on-chain state this transaction should target, when the caller is building it before an
     *   earlier same-account transaction has confirmed. Defaults to `1` (the very next valid
     *   submission). EVM adapters ignore it — mempool nonce ordering already handles this.
     */
    encodeSetAuthPolicy(authDigest: Hash, nullifyingKeyHash: Hash, sequenceOffset?: number): Promise<TTx>;
    encodeUpdateAuthPolicy(
        oldAuthDigest: Hash,
        newAuthDigest: Hash,
        siblingNodes: Hash[],
    ): Promise<TTx>;
    /** @param sequenceOffset - See {@link encodeSetAuthPolicy}'s doc comment. */
    encodeSetViewingKey(viewingKey: Hex, sequenceOffset?: number): Promise<TTx>;

    /** Submits a prepared transaction through the attached wallet. */
    submit(tx: TTx): Promise<Hex>;

    /** Signs an EIP-712 typed-data payload through the attached wallet. */
    signTypedData(typedData: Eip712TypedData): Promise<Hex>;
    /**
     * Builds what `account` signs to let a relayer register it (`setAuthPolicyWithSig` /
     * `registerAndRelay` on EVM, `relay.register_and_relay` on Stellar) — EIP-712 typed data, or
     * an unsigned Soroban auth entry expiring at the ledger nearest `deadline`.
     */
    buildRegistrationAuthorization(args: {
        account: TAddress;
        nullifyingKeyHash: Hash;
        authDigest: Hash;
        deadline: Hex;
        chainId: number;
    }): Promise<RelayedRegistrationAuthorization>;
    /**
     * Signs a {@link buildRegistrationAuthorization} payload through the attached wallet: the
     * EIP-712 signature on EVM, the signed auth entry (hex of its XDR) on Stellar.
     */
    signRegistrationAuthorization(authorization: RelayedRegistrationAuthorization): Promise<Hex>;
}
