import type { ZodType } from "zod";

import type {
    RelayedRegistrationAuthorization,
    Address,
    Eip712TypedData,
    Hash,
    Hex,
    IKeystoreChainAdapter,
    IKeystoreInteractor,
    LeafCacheSeed,
    PreparedTransaction,
} from "../../internal.js";
import {
    HexSchema,
    InvalidAddressArgument,
    InvalidContractResult,
    InvalidHashArgument,
} from "../../internal.js";

interface KeystoreInteractorConfig<TTx, TAddress> {
    adapter: IKeystoreChainAdapter<TTx, TAddress>;
    /** Earliest cursor to scan for contract events when no cache/seed exists. */
    deploymentBlock?: bigint;
    /** Validates an account address before it reaches the adapter. */
    addressSchema: ZodType<TAddress>;
}

interface KeystoreInteractorSeedDependencies {
    /** Pre-populates the keystore leaf cache — see {@link LeafCacheSeed}. */
    seed?: LeafCacheSeed;
}

/**
 * Interactions with a keystore-shaped contract, generic over the chain's prepared-transaction
 * type `TTx` and address type `TAddress` (no proof-type generic — Keystore operations never take
 * a ZK proof). Chain-specific mechanics live entirely in the injected
 * {@link IKeystoreChainAdapter} — this class owns input validation, error re-wrapping, and the
 * key-registry leaf-cache bookkeeping (identical pattern to `PoolVaultInteractor`'s — see that
 * class's doc comment for the full split rationale). None of the type parameters are ever
 * inspected here.
 *
 * Construct the EVM instantiation via `createEvmKeystoreInteractor` (in
 * `EvmKeystoreChainAdapter.ts`, not a static method here — kept out of this file so importing
 * `KeystoreInteractor` alone never pulls in viem/ABI constants for a Stellar-only bundle).
 */
export class KeystoreInteractor<TTx = PreparedTransaction, TAddress = Address>
    implements IKeystoreInteractor<TTx, TAddress>
{
    private readonly adapter: IKeystoreChainAdapter<TTx, TAddress>;
    private readonly deploymentBlock?: bigint;
    private readonly addressSchema: ZodType<TAddress>;

    /**
     * Keystore leaf cache — same pattern, same per-chain safety rationale as
     * `PoolVaultInteractor.cachedLeaves`: instance-scoped, delta-fetched from `cachedToBlock + 1`.
     * A `PoolSessionBuilder` constructs exactly one `KeystoreInteractor` per session, bound to
     * that session's own adapter — no pooling or reuse across chains.
     */
    private cachedLeaves: Hash[] = [];
    private cachedToBlock?: bigint;
    /** In-progress {@link getKeystoreLeaves} call, if any — shared by concurrent callers instead of racing two scans of the same range. */
    private inFlightFetch?: Promise<Hash[]>;

    constructor(
        config: KeystoreInteractorConfig<TTx, TAddress>,
        deps?: KeystoreInteractorSeedDependencies,
    ) {
        this.adapter = config.adapter;
        this.deploymentBlock = config.deploymentBlock;
        this.addressSchema = config.addressSchema;
        if (deps?.seed) {
            this.cachedLeaves = deps.seed.leaves.slice();
            this.cachedToBlock = deps.seed.toBlock;
        }
    }

    /** @inheritdoc IKeystoreInteractor.getAddress */
    getAddress(): TAddress {
        return this.adapter.getAddress();
    }

    /** @inheritdoc IKeystoreInteractor.getNullifyingKeyHash
     * @throws {InvalidAddressArgument} When the account address is invalid.
     */
    async getNullifyingKeyHash(account: TAddress): Promise<Hash> {
        const validatedAccount = this.addressSchema.safeParse(account);
        if (!validatedAccount.success) {
            throw new InvalidAddressArgument(validatedAccount.error.issues[0].message);
        }
        return this.adapter.getNullifyingKeyHashRaw(account);
    }

    /** @inheritdoc IKeystoreInteractor.getViewingKey
     * @throws {InvalidAddressArgument} When the account address is invalid.
     */
    async getViewingKey(account: TAddress): Promise<Hash> {
        const validatedAccount = this.addressSchema.safeParse(account);
        if (!validatedAccount.success) {
            throw new InvalidAddressArgument(validatedAccount.error.issues[0].message);
        }
        return this.adapter.getViewingKeyRaw(account);
    }

    /** @inheritdoc IKeystoreInteractor.isKnownRoot
     * @throws {InvalidHashArgument} When the root is not valid hex.
     */
    async isKnownRoot(root: Hash): Promise<boolean> {
        const validatedRoot = HexSchema.safeParse(root);
        if (!validatedRoot.success) {
            throw new InvalidHashArgument(validatedRoot.error.issues[0].message);
        }
        return this.adapter.isKnownRootRaw(root);
    }

    /** @inheritdoc IKeystoreInteractor.getKeystoreLeaves
     *
     * Delta-fetches from `cachedToBlock + 1` on every call after the first, instead of
     * re-scanning from `deploymentBlock` every time. Concurrent calls share the same in-flight
     * scan via `inFlightFetch`.
     */
    async getKeystoreLeaves(): Promise<Hash[]> {
        if (this.inFlightFetch) {
            return this.inFlightFetch;
        }
        const fetchPromise = this.fetchAndCacheLeaves();
        this.inFlightFetch = fetchPromise;
        try {
            return await fetchPromise;
        } finally {
            if (this.inFlightFetch === fetchPromise) {
                this.inFlightFetch = undefined;
            }
        }
    }

    /** @inheritdoc IKeystoreInteractor.exportLeafCache */
    exportLeafCache(): LeafCacheSeed | undefined {
        if (this.cachedToBlock === undefined) {
            return undefined;
        }
        return { toBlock: this.cachedToBlock, leaves: this.cachedLeaves.slice() };
    }

    /** @inheritdoc IKeystoreInteractor.getCurrentAuthorizerDigest
     * @throws {InvalidAddressArgument} When the account address is malformed.
     */
    async getCurrentAuthorizerDigest(account: TAddress): Promise<Hash | null> {
        const addrValidation = this.addressSchema.safeParse(account);
        if (!addrValidation.success) {
            throw new InvalidAddressArgument(addrValidation.error.issues[0].message);
        }
        return this.adapter.getCurrentAuthorizerDigestRaw(account);
    }

    /** @inheritdoc IKeystoreInteractor.encodeSetAuthPolicy */
    encodeSetAuthPolicy(authDigest: Hash, nullifyingKeyHash: Hash, sequenceOffset?: number): Promise<TTx> {
        return this.adapter.encodeSetAuthPolicy(authDigest, nullifyingKeyHash, sequenceOffset);
    }

    /** @inheritdoc IKeystoreInteractor.encodeUpdateAuthPolicy */
    encodeUpdateAuthPolicy(
        oldAuthDigest: Hash,
        newAuthDigest: Hash,
        siblingNodes: Hash[],
    ): Promise<TTx> {
        return this.adapter.encodeUpdateAuthPolicy(oldAuthDigest, newAuthDigest, siblingNodes);
    }

    /** @inheritdoc IKeystoreInteractor.encodeSetViewingKey
     * @throws {InvalidHashArgument} When the viewing key is not a valid 32-byte X25519 public key.
     */
    encodeSetViewingKey(viewingKey: Hex, sequenceOffset?: number): Promise<TTx> {
        const hex = viewingKey.slice(2);
        if (hex.length !== 64) {
            throw new InvalidHashArgument(
                `Expected a 32-byte X25519 public key, got ${viewingKey}`,
            );
        }
        return this.adapter.encodeSetViewingKey(viewingKey, sequenceOffset);
    }

    /** @inheritdoc IKeystoreInteractor.submitTransaction */
    async submitTransaction(tx: TTx): Promise<Hex> {
        return this.adapter.submit(tx);
    }

    /** @inheritdoc IKeystoreInteractor.signTypedData */
    async signTypedData(typedData: Eip712TypedData): Promise<Hex> {
        return this.adapter.signTypedData(typedData);
    }

    /** @inheritdoc IKeystoreInteractor.buildRegistrationAuthorization */
    async buildRegistrationAuthorization(args: {
        account: TAddress;
        nullifyingKeyHash: Hash;
        authDigest: Hash;
        deadline: Hex;
        chainId: number;
    }): Promise<RelayedRegistrationAuthorization> {
        return this.adapter.buildRegistrationAuthorization(args);
    }

    /** @inheritdoc IKeystoreInteractor.signRegistrationAuthorization */
    async signRegistrationAuthorization(authorization: RelayedRegistrationAuthorization): Promise<Hex> {
        return this.adapter.signRegistrationAuthorization(authorization);
    }

    /**
     * Reconstructs keystore leaves from the adapter's leaf deltas, merging them into the cache.
     * Inserts are applied first (sequential positions), then updates (in-place overwrites,
     * bounds-checked against the resulting size) — same two-pass semantics as before, to avoid
     * phantom "0x0" gaps. Only commits once the whole delta has parsed cleanly.
     */
    private async fetchAndCacheLeaves(): Promise<Hash[]> {
        const currentCursor = await this.adapter.getCurrentCursor();
        const fromCursor =
            this.cachedToBlock !== undefined ? this.cachedToBlock + 1n : this.deploymentBlock;

        if (
            this.cachedToBlock !== undefined &&
            fromCursor !== undefined &&
            fromCursor > currentCursor
        ) {
            return this.cachedLeaves;
        }

        const { inserted, updated } = await this.adapter.fetchLeafDeltas(
            fromCursor,
            currentCursor,
        );

        const leaves: Hash[] = this.cachedLeaves.slice();

        for (const { leafIndex, newLeaf } of inserted) {
            leaves[leafIndex] = newLeaf;
        }

        for (const { leafIndex, newLeaf } of updated) {
            if (leafIndex >= leaves.length) {
                throw new InvalidContractResult(
                    `LeafUpdated index ${leafIndex} is out of bounds (${leaves.length} leaves inserted)`,
                );
            }
            leaves[leafIndex] = newLeaf;
        }

        this.cachedLeaves = leaves;
        this.cachedToBlock = currentCursor;

        return leaves;
    }
}
