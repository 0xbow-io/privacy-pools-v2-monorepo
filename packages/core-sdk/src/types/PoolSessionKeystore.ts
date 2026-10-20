import type { ZodType } from "zod";

import type {
    Address,
    DeriveFromSignatureConfig,
    Eip712TypedData,
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    IAddressFieldConverter,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    IMerkleService,
    INoteComputationService,
    IPreparedTxVerifier,
    ITxReceiptWaiter,
    PreparedTransaction,
    Secret,
    TxLog,
    TxReceipt,
} from "../internal.js";

/** Configuration for constructing a {@link PoolSessionKeystore}, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, raw receipt-log type `TLog`, and
 * signature-derivation config type `TDeriveConfig`. */
export interface PoolSessionKeystoreConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
    TDeriveConfig = DeriveFromSignatureConfig,
> {
    /** The account owner's address. */
    ownerAddress: TAddress;
    /** The chain ID this session is operating on. */
    chainId: number;
    /** KeystoreManager providing private key material. */
    keystoreManager: IKeystoreManager;
    /** KeystoreInteractor for querying on-chain registration state. */
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    /** NoteComputationService for computing the auth digest. */
    noteComputationService: INoteComputationService;
    /** HashService for computing the nullifying key hash (private helper). */
    hashService: IHashService;
    /** MerkleService for generating the keystore inclusion proof during rotation. */
    merkleService: IMerkleService;
    /** CryptoService for re-deriving keys during rotation and index recovery. */
    cryptoService: ICryptoService<TDeriveConfig>;
    /** RPC interactor for on-chain reads and awaiting transaction receipts. */
    rpcInteractor: ITxReceiptWaiter<TLog>;
    /** Verifies prepared transactions target the expected contract/operation before signing. */
    preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    /** Converts `TAddress` values into the field-sized `Hex` the Poseidon-hash layer expects. */
    addressFieldConverter: IAddressFieldConverter<TAddress>;
    /** Validates the `TAddress`-typed fields carried by this session's config. */
    addressSchema: ZodType<TAddress>;
}

/** Optional dependencies for {@link PoolSessionKeystore}. */
export interface PoolSessionKeystoreDependencies {
    logger?: ILogger;
}

/** Options for {@link IPoolSessionKeystore.prepareRegisterKeystore}. */
export interface RegisterKeystoreOptions {
    /**
     * Whether to also prepare calldata for registering the viewing key.
     * @default true
     */
    includeViewingKey?: boolean;
}

/** Result of {@link IPoolSessionKeystore.prepareRegisterKeystore}, generic over the chain's
 * prepared-transaction type `TTx`. */
export interface RegisterKeystoreResult<TTx = PreparedTransaction> {
    /** `true` if the account was already registered on-chain (calldata fields are `null`). */
    alreadyRegistered: boolean;
    /** Calldata for the `setAuthPolicy` transaction, or `null` if already registered. */
    keystoreCalldata: TTx | null;
    /**
     * Calldata for the `setViewingKey` transaction, or `null` if
     * `includeViewingKey` was `false` or already registered.
     */
    viewingKeyCalldata: TTx | null;
    /** Poseidon hash of the private nullifying key, stored on-chain. */
    nullifyingKeyHash: Hash;
    /** Poseidon(Poseidon(privateRevocableKey), 0) — the authorization digest. */
    authDigest: Hash;
}

/** Options for {@link IPoolSessionKeystore.prepareRelayedRegistration}. */
export interface RelayedRegistrationOptions {
    /**
     * Unix-seconds deadline after which the signed authorization is rejected on-chain
     * (`Keystore_SignatureExpired`), as 0x-prefixed hex. Bounds how long a signed-but-
     * unsubmitted registration stays usable.
     */
    deadline: Hex;
    /**
     * When `false`, the SDK returns the unsigned typed-data payload for the integrator to
     * sign externally (`signature` is `null`). When `true` (default), the SDK signs it with
     * the wired wallet.
     * @default true
     */
    sign?: boolean;
}

/**
 * Result of {@link IPoolSessionKeystore.prepareRelayedRegistration}: the values a relayer
 * needs to submit `setAuthPolicyWithSig` / `registerAndRelay` on the account's behalf, plus
 * the raw EIP-712 payload so an integrator can sign externally when `sign: false`. Generic
 * over the chain's address type `TAddress`.
 */
export interface PreparedRelayedRegistration<TAddress = Address> {
    /**
     * The chain's authorization payload that was (or should be) signed: EIP-712 `SetAuthPolicy`
     * typed data on EVM, an unsigned Soroban auth entry on Stellar (narrow on `"kind" in`).
     */
    typedData: RelayedRegistrationAuthorization;
    /** Account being registered (the signer). */
    account: TAddress;
    /** Poseidon hash of the private nullifying key, registered on-chain. */
    nullifyingKeyHash: Hash;
    /** Authorization digest registered on-chain. */
    authDigest: Hash;
    /** The signature deadline (echoed from options), as 0x-prefixed hex. */
    deadline: Hex;
    /**
     * The account's signature over `typedData`, or `null` when `sign: false` was requested
     * (the integrator signs `typedData` externally and supplies the signature to the relayer).
     * EVM: the EIP-712 signature. Stellar: the SIGNED auth entry itself, as hex of its XDR —
     * Soroban authorization travels as a whole entry (nonce, expiry ledger and invocation
     * included), not a detached signature.
     */
    signature: Hex | null;
}

/**
 * A Soroban authorization the account signs for a relayed registration (Stellar): an unsigned
 * `SorobanAuthorizationEntry` over `keystore.set_auth_policy(account, nullifyingKeyHash,
 * authDigest)`, the nested call `relay.register_and_relay` makes. The entry carries its own nonce
 * and expiry ledger, so a relayer holding it can submit that one invocation once and nothing else.
 */
export interface SorobanRegistrationAuthorization {
    /** Discriminator against {@link Eip712TypedData}. */
    kind: "sorobanAuthEntry";
    /** The unsigned entry, base64 XDR. */
    entryXdr: string;
    /** Last ledger the signed entry is valid for — the chain-native form of `deadline`. */
    validUntilLedger: number;
}

/** What an account signs to authorize a relayed registration, per chain. */
export type RelayedRegistrationAuthorization = Eip712TypedData | SorobanRegistrationAuthorization;

/**
 * EIP-712 typed-data payload for `Keystore.setAuthPolicyWithSig`, produced by
 * {@link IPoolSessionKeystore.buildSetAuthPolicyTypedData}. Hand it to a wallet's
 * `signTypedData`; the resulting signature authorizes the relayed registration and is
 * passed to {@link IPoolSessionWithdraw.registerAndWithdraw}.
 *
 * Deliberately NOT generic over `TAddress` — EIP-712 is an EVM-specific signing scheme (a
 * Stellar keystore registration would need an entirely different signing scheme, not just a
 * type substitution), so this stays concretely EVM-shaped by design, same as the SDK's other
 * "prepared-tx verifier"-style boundaries.
 *
 * `message` uses `bigint` for the `uint256` fields — the native EIP-712 representation
 * expected by wallet signers (viem/ethers) — rather than `Hex`. The struct field order
 * (account, authDigest, nullifyingKeyHash, deadline) MUST match `SET_AUTH_POLICY_TYPEHASH`
 * in `Keystore.sol` exactly, or the signature will not verify on-chain.
 */
export interface SetAuthPolicyTypedData {
    domain: {
        name: "PrivacyPoolsKeystore";
        version: "1";
        chainId: number;
        verifyingContract: Address;
    };
    types: {
        readonly SetAuthPolicy: readonly [
            { readonly name: "account"; readonly type: "address" },
            { readonly name: "authDigest"; readonly type: "uint256" },
            { readonly name: "nullifyingKeyHash"; readonly type: "uint256" },
            { readonly name: "deadline"; readonly type: "uint256" },
        ];
    };
    primaryType: "SetAuthPolicy";
    message: {
        account: Address;
        authDigest: bigint;
        nullifyingKeyHash: bigint;
        deadline: bigint;
    };
}

/**
 * Config for {@link IPoolSessionKeystore.rotateRevocableKey}. Same shape as the chain's own
 * signature-derivation config (`TDeriveConfig`, defaulting to EVM's {@link DeriveFromSignatureConfig})
 * minus `revocableKeyIndex` — the SDK increments the current index by one on every rotation.
 * Skipping ahead to an arbitrary index is intentionally not supported.
 */
export type RotateRevocableKeyConfig<TDeriveConfig = DeriveFromSignatureConfig> = Omit<
    TDeriveConfig,
    "revocableKeyIndex"
>;

/**
 * Internal handoff between the prepare-rotation and execute-rotation halves of
 * `PoolSessionKeystore.rotateRevocableKey`. Carries the freshly-derived
 * `privateRevocableKey` so the execute half can apply it to the in-memory
 * {@link IKeystoreManager} without re-running the HKDF tree. Generic over the chain's
 * prepared-transaction type `TTx`.
 *
 * The old/new auth digests are intentionally not fields here. The execute half
 * decodes them from `keystoreCalldata` after validating it, so a tampered result
 * cannot carry digests that disagree with what gets submitted.
 */
export interface RotateRevocableKeyResult<TTx = PreparedTransaction> {
    /** The prepared `updateAuthPolicy` transaction. */
    keystoreCalldata: TTx;
    /** Rotation index of the new revocable key, as 0x-prefixed hex. */
    newIndex: Hex;
    /** The newly derived `privateRevocableKey`. */
    newRevocableKey: Secret;
}

/**
 * Outcome of a successful revocable-key rotation. Returned by
 * {@link IPoolSessionKeystore.executeRotateRevocableKey} and the convenience
 * {@link IPoolSessionKeystore.rotateRevocableKey}.
 */
export interface RotateRevocableKeyOutcome<TLog = TxLog> {
    /** On-chain transaction receipt for the `updateAuthPolicy` submission. */
    receipt: TxReceipt<TLog>;
    /** Authorization digest that was superseded. */
    oldAuthorizerDigest: Hash;
    /** Authorization digest now active on-chain. */
    newAuthorizerDigest: Hash;
    /**
     * Rotation index of the newly active `privateRevocableKey`, as 0x-prefixed
     * hex. Persist together with `receipt`. The SDK advances its in-memory
     * index on receipt confirmation but does not own storage; without the
     * integrator-side write, the next session reads the stale index, derives
     * the wrong `privateRevocableKey`, and every proof fails until manual
     * recovery.
     */
    newRevocableKeyIndex: Hex;
}
