import type { ILogger, IRPCInteractor, IWalletInteractor } from "../internal.js";
import type { Address } from "./Address.js";
import type { Hash } from "./Hash.js";
import { Hex } from "./Hex.js";

/** Configuration for contract interactor services. */
export interface ContractInteractorConfig {
    /** Read-only RPC interactor for contract calls. */
    rpcInteractor: IRPCInteractor;
    /** Deployed contract address (0x-prefixed). */
    contractAddress: Address;
    /** Earliest block to scan for contract events. Skips empty blocks before deployment. When omitted, scans from block 0. */
    deploymentBlock?: bigint;
}

/** Optional write dependencies for contract interactors that support transaction submission. */
export interface ContractInteractorWriteDependencies {
    walletInteractor?: IWalletInteractor;
}

/** Optional dependencies for read-only contract interactors. */
export interface ContractInteractorReadDependencies {
    logger?: ILogger;
}

/**
 * A snapshot of a leaf-scan cache — portable across process/session
 * boundaries. Produced by `KeystoreInteractor.exportLeafCache()` /
 * `PoolVaultInteractor.exportLeafCache()`, and accepted back via each
 * class's `seed` constructor dependency to pre-populate `cachedLeaves`/
 * `cachedToBlock` so the first real call is already a delta-fetch instead
 * of a full from-`deploymentBlock` scan. The SDK never persists this
 * itself — storage (disk, IndexedDB, ...) is entirely the caller's concern.
 */
export interface LeafCacheSeed {
    /** Leaves scanned up to and including this block. */
    toBlock: bigint;
    /** Leaves, index-aligned with the live `getKeystoreLeaves()`/`getStateLeaves()` result. */
    leaves: Hash[];
}

/** Optional dependencies for KeystoreInteractor. */
export type KeystoreInteractorDependencies = ContractInteractorWriteDependencies & {
    /** Pre-populates the keystore leaf cache — see {@link LeafCacheSeed}. */
    seed?: LeafCacheSeed;
};

/** Optional dependencies for PoolVaultInteractor. */
export interface PoolVaultInteractorDependencies {
    logger?: ILogger;
    walletInteractor?: IWalletInteractor;
    /** Pre-populates the state-tree leaf cache — see {@link LeafCacheSeed}. */
    seed?: LeafCacheSeed;
}

/** On-chain asset configuration returned by Entrypoint.assets(). */
export interface AssetConfig {
    /** Whether deposits are enabled for this asset. */
    enabled: boolean;
    /** Minimum deposit amount in the token's smallest unit. */
    minAmount: Hex;
    /** Vetting fee in basis points (1 BPS = 0.01%). */
    vettingFeeBPS: Hex;
    /** Maximum relay fee in the token's smallest unit. */
    maxRelayFee: Hex;
}

/**
 * Parsed representation of an on-chain Transacted event emitted by PoolVault, generic over the
 * chain's address type `TAddress` (defaults to EVM's {@link Address}).
 * Each event corresponds to a single successful transact call (transfer or withdraw).
 */
export interface TransactedEvent<TAddress = Address> {
    /** Block number where the event was emitted. */
    blockNumber: Hex;
    /** Transaction hash that emitted the event. */
    txHash: Hash;
    /** Output note commitments inserted into the state tree by this transact call. */
    outputCommitments: Hex[];
    /** Nullifier hashes consumed by this transact call. */
    nullifierHashes: Hex[];
    /** Asset address (token or native ETH sentinel). */
    asset: TAddress;
    /** Amount withdrawn to the caller (0 for pure transfers). */
    withdrawnValue: Hex;
    /** Caller address that submitted the transact call (typically a relayer). */
    caller: TAddress;
}

/**
 * Parsed representation of an on-chain Deposited event emitted by PoolVault, generic over the
 * chain's address type `TAddress` (defaults to EVM's {@link Address}).
 * Each event corresponds to a single successful deposit and the resulting
 * state-tree leaf insertion.
 */
export interface DepositedEvent<TAddress = Address> {
    /** Block number where the event was emitted. */
    blockNumber: Hex;
    /** Transaction hash that emitted the event. */
    txHash: Hash;
    /** Output note commitment inserted into the state tree by this deposit. */
    outputCommitment: Hex;
    /** Asset address (token or native ETH sentinel). */
    asset: TAddress;
    /** Amount deposited into the pool (post-vetting-fee). */
    depositedValue: Hex;
    /** Caller address that submitted the deposit (typically the Entrypoint). */
    caller: TAddress;
}

/**
 * Parsed representation of an on-chain Ragequit event emitted by PoolVault, generic over the
 * chain's address type `TAddress` (defaults to EVM's {@link Address}).
 * Each event corresponds to a single successful ragequit call.
 */
export interface RagequitEvent<TAddress = Address> {
    /** Block number where the event was emitted. */
    blockNumber: Hex;
    /** Transaction hash that emitted the event. */
    txHash: Hash;
    /** Address of the account that ragequit. */
    ragequitter: TAddress;
    /** Asset address (token or native ETH sentinel). */
    asset: TAddress;
    /** Commitment of the note being ragequit. */
    commitment: Hex;
    /** Nullifier hash for the spent note. */
    nullifierHash: Hex;
    /** Label of the note lineage being ragequit. */
    label: Hex;
}
