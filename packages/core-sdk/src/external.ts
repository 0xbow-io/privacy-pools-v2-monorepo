// Utilities
import { decodeASPCipherText, encodeASPCipherText } from "./internal.js";

export {
    PoolSessionDeposit,
    EntrypointInteractor,
    KeystoreInteractor,
    KeystoreManager,
    PoseidonHashService,
    MerkleService,
    WitnessPreparationService,
    Groth16Prover,
    NoteManager,
    PoolVaultInteractor,
    TransactOrchestrator,
    BatchWithdrawOrchestrator,
    PoolSessionTransfer,
    PoolSessionWithdraw,
    PoolSessionBatchWithdraw,
    PoolSessionNoteManager,
    PoolSessionNoteDiscovery,
    NoteDiscoveryService,
    PoolSessionKeystore,
    PoolSessionRagequit,
    PoolSessionExport,
    ASPClient,
    HttpASPDataProvider,
    IpfsASPDataProvider,
    HTTPClient,
    PinoLogger,
    NoteComputationService,
    InMemoryStorageService,
    LocalStorageService,
    FileStorageService,
    EncryptedStorageService,
    NoteStorageAdapter,
    PaymentRequestService,
    PaymentRequestStorageAdapter,
    InMemoryCacheStore,
    NoteStatus,
    LocalCircuitArtifacts,
    IpfsCircuitArtifacts,
    PoolSessionWithdrawAndSwap,
    PoolSessionReshield,
    PoolSessionSwapDeposit,
    PoolSessionReshieldCrosschain,
    PoolSessionReshieldTransfer,
    PoolSessionReshieldTransferCrosschain,
    PoolSession,
    PoolSessionFactory,
    buildSetAuthPolicyTypedData,
} from "./internal.js";
// Abstract base classes — the intended extension point for each chain-sdk's own concrete
// CryptoService/ProofService (e.g. evm-sdk's viem/secp256k1-flavored CryptoService and
// snarkjs/Solidity-calldata-flavored ProofService both `extends` one of these).
export { AbstractCryptoService, AbstractProofService } from "./internal.js";

// Constants
export { CATCH_ALL_TAG } from "./constant/NoteDiscoveryService.js";
export { APP_IDENTIFIER, ROOT_DERIVATION_INFO, BN254_SCALAR_MODULUS } from "./constant/KeyDerivation.js";
// Stellar key-derivation domain constants — needed by stellar-sdk's StellarCryptoService /
// KeypairWalletInteractor / FreighterWalletInteractor, which derive protocol keys from a Stellar
// signature the same way evm-sdk's EVM path derives from an EIP-712 signature.
export {
    STELLAR_ROOT_SALT,
    STELLAR_ROOT_INFO,
    STELLAR_KEY_DERIVATION_DATA_KEY,
    STELLAR_KEY_DERIVATION_SEQUENCE,
} from "./constant/KeyDerivation.js";
export { DEFAULT_CIRCUIT_MANIFEST } from "./constant/CircuitArtifacts.js";
export { MAX_BATCH } from "./constant/BatchWithdraw.js";
// IPFS gateway defaults — needed by evm-sdk/stellar-sdk builders that construct
// IpfsCircuitArtifacts / IpfsASPDataProvider without pinning their own gateway list.
export { DEFAULT_IPFS_GATEWAY_URLS } from "./constant/CircuitArtifacts.js";
// Sentinel "no address" value shared across EVM entrypoint/asset config and note handling.
// Value-exported (not just a type) since evm-sdk/stellar-sdk builders compare against it directly.
export { EMPTY_ADDRESS, CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM } from "./constant/common.js";
// Canonical native-coin sentinel address (0xEeee…EEeE) used in entrypoint asset config, notes,
// and RelaySwaps — needed by evm-sdk's LiFi/token-identity helpers.
export { NATIVE_ASSET_ADDRESS, EMPTY_NOTE_DATA } from "./constant/PoolSession.js";
// Keystore write-path ABI and transact dimension bounds — needed by any chain-sdk's own tests
// reconstructing a keystore write calldata check or a batch-withdraw dimension check outside the
// classes that use them internally.
export { KEYSTORE_WRITE_ABI } from "./constant/PoolSessionKeystore.js";
export { MIN_INPUTS, MAX_INPUTS, MIN_OUTPUTS, MAX_OUTPUTS } from "./constant/ProofService.js";
// Witness-building domain-separation tags/depths — needed by any chain-sdk's own tests/tooling
// that reconstruct a state-tree timestamped leaf (Poseidon(COMMITMENT_LEAF_TAG, commitment,
// timestamp)) or a keystore/state/ASP leaf outside WitnessPreparationService itself.
export {
    AUTH_TYPE_DIRECT_KEY,
    METADATA_STANDARD,
    COMMITMENT_LEAF_TAG,
    KEYSTORE_MAX_DEPTH,
    STATE_MAX_DEPTH,
    ASSOCIATION_SET_MAX_DEPTH,
} from "./constant/WitnessPreparationService.js";
// Safe-filename validation regex shared by FileStorageService and any chain-sdk's own
// PoolSessionBuilder-style config schema that re-validates a persistent-storage filename.
export { SAFE_STORAGE_FILENAME_PATTERN } from "./constant/StorageAdapter.js";
// Core validation schemas (address/hex shape) and the relayer-info schema — needed by any
// chain-sdk's own config schemas (e.g. evm-sdk/stellar-sdk PoolSessionBuilder config validation).
// Value-exported (zod schemas are runtime values, not just types).
export { AddressSchema, HexSchema, BigIntSchema, BooleanSchema, TokenIdFieldSchema } from "./schemas/common.js";
export { TxHashSchema } from "./schemas/DataService.js";
export { PublicKeySchema, ViewingPrivateKeySchema } from "./schemas/CryptoService.js";
export { SignatureSchema } from "./schemas/KeyDerivation.js";
// Stellar's own public-key/signature validation — needed by stellar-sdk's config schemas
// (StellarCryptoService, KeypairWalletInteractor) the same way PublicKeySchema/SignatureSchema
// serve the EVM path.
export { StellarPublicKeySchema } from "./schemas/CryptoService.js";
export { StellarSignatureSchema } from "./schemas/KeyDerivation.js";
// EVM-default pre-built schema instances (their `make*Schema<TAddress>` factories are already
// exported below) — needed by any chain-sdk's own tests validating a pending note or a transact
// witness-input shape without rebuilding the schema from the factory.
export { PendingNoteSchema } from "./schemas/NoteManager.js";
export { BuildTransactWitnessInputsSchema } from "./schemas/WitnessPreparationService.js";
// Contract-interactor config/event-log schemas — needed by any chain-sdk's own concrete contract
// interactors/chain adapters (e.g. evm-sdk's Evm*ChainAdapter, ASPRegistryInteractor,
// PPRouterInteractor, PPYieldTokenInteractor, PPYieldTokenZapInteractor).
export {
    ContractInteractorConfigSchema,
    AllowanceArgsSchema,
    AssetConfigSchema,
    KeystoreEventLogArgsSchema,
    KeystoreAuthEventLogArgsSchema,
    LeavesInsertedEventArgsSchema,
    NoteDataSchema,
    RagequitEventArgsSchema,
    DepositedEventArgsSchema,
    TransactedEventArgsSchema,
} from "./schemas/ContractInteractor.js";
export {
    RelayerChainDetailsSchema,
    RelayerInfoSchema,
    RelayerYieldWrapperSchema,
    makeRelayerAddressSchemas,
    makeRelayerChainDetailsSchemas,
    BatchWithdrawalRelayerQuoteSchema,
    BatchWithdrawalRelayParamsSchema,
    SwapRelayerQuoteSchema,
    UncommittedQuoteSchema,
    WithdrawalRelayParamsSchema,
} from "./schemas/RelayerInteractor.js";
// bigintToHex — needed by any chain-sdk's own contract interactors (e.g. evm-sdk's
// ASPRegistryInteractor) that were not genericized into core-sdk.
export { bigintToHex } from "./utils/BigInt.js";
// CID parsing/verification — needed by any chain-sdk's own config schema/circuit-artifacts
// wiring (e.g. evm-sdk's PoolSessionBuilder config schema validates pinned CIDs).
export { parseCID, verifyBytesAgainstCID } from "./utils/IPFSContent.js";
// Relayer-quote helpers — needed by any chain-sdk's own concrete RelayerInteractor
// (e.g. evm-sdk's RelayerInteractor, which was not genericized into core-sdk).
export {
    assertFeeCommitmentLive,
    settleRelayerQuotes,
    settleTransferRelayerQuotes,
    settleWithdrawRelayerQuotes,
} from "./utils/RelayerQuotes.js";
export { relayerCapsFromDetails } from "./utils/RelayerCaps.js";
// The two payment-request time bounds. Deliberately asymmetric and both public: a wallet
// showing a payment request needs the deadline it will refuse to pay past
// (DEFAULT_REQUEST_EXPIRY_MS, when `requestExpiryMs` is not overridden) AND the longer window
// the recipient keeps scanning for (SCAN_EXPIRY_GRACE_MS), or its copy will misstate one of
// them. Value-exported so they are defined at runtime, not type-only.
export { DEFAULT_REQUEST_EXPIRY_MS, SCAN_EXPIRY_GRACE_MS } from "./constant/PaymentRequest.js";

// Functions
// Batch fee model — dogfooded by the relayer to charge each item a normal
// single-tx fee for the per-item PayoutRouting[] it signs into the fee commitment.
export { computeBatchFees, computeBatchItemFee } from "./services/poolSessions/computeBatchFees.js";
// Partitions an asset's full active balance into per-transact note groups; the
// runtime entry point for building a batch withdrawal outside a PoolSession.
export { selectNotesForFullWithdraw } from "./services/poolSessions/selectNotesForFullWithdraw.js";
// Yield earned on a share position. The pure entry point and the snapshot converter that
// builds its `events` input: `YieldEarnedInput` documents the latter by name, so without
// these exports the types point a consumer at functions the package does not hand out.
export {
    computeYieldEarned,
    yieldEarnedEventsFromSnapshot,
} from "./services/poolSessions/yieldEarned.js";
export {
    MIN_PLAUSIBLE_NOTE_TIMESTAMP,
    YIELD_FEED_MAX_PAGES,
    YIELD_FEED_PAGE_SIZE,
} from "./constant/YieldFeeds.js";
// Chain-agnostic yield sessions: each chain sdk supplies its own share-token/router interactors and
// an IYieldRouterCodec (evm-sdk: ABI + ERC-20 approvals; stellar-sdk: Soroban XDR).
export {
    PoolSessionYieldDeposit,
    defaultMaxUnderlyingIn,
    inferVettingFeeBps,
    ppmHeadroom,
} from "./services/poolSessions/PoolSessionYieldDeposit.js";
export { PoolSessionYieldWithdraw } from "./services/poolSessions/PoolSessionYieldWithdraw.js";
export { PoolSessionYieldEarned, noteTimestamp } from "./services/poolSessions/PoolSessionYieldEarned.js";
export {
    YIELD_BPS_DENOMINATOR,
    WITHDRAW_SLIPPAGE_BPS,
    YIELD_PPM_DENOMINATOR,
    DEPOSIT_RATE_HEADROOM_PPM,
} from "./constant/Yield.js";
// Chain-agnostic PayoutRouting comparison — needed by any chain-sdk's own decode-then-assert
// wrapper (e.g. evm-sdk's assertPayoutRoutingMatchesQuote, which ABI-decodes then delegates here).
export {
    assertDecodedPayoutRoutingMatchesQuote,
} from "./services/poolSessions/payoutRoutingGuard.js";
// Curve25519 clamping — needed by any chain-sdk's own concrete CryptoService (e.g. evm-sdk's,
// not genericized into core-sdk) for viewing-key derivation.
export { clampToCurve25519 } from "./utils/KeyDerivationHelpers.js";
// Big-endian bytes -> bigint — needed by stellar-sdk's StellarContextHashService /
// StellarAddressFieldConverter, which derive a field element from raw Stellar key/address bytes.
export { bytesToBigIntBE } from "./utils/KeyDerivationHelpers.js";
// Generic async delay — needed by any chain-sdk's own RPC interactor polling loop (e.g.
// stellar-sdk's SorobanRPCInteractor backing off between submit-status polls).
export { sleep } from "./utils/sleep.js";
export { planApprovals } from "./utils/Erc20Approval.js";
export { yieldSwapDepositTargetFor } from "./utils/YieldSwapOutput.js";
// Splits/joins a Note event's opaque `data` field into {ephemeralPubKey, encryptedPayload}
// — needed by external consumers reconstructing a NoteEvent from raw on-chain calldata
// (e.g. recovering a stealth deposit's note without going through the ASP event feed).
export { decodeNoteData, encodeNoteData } from "./utils/NoteDataCodec.js";

// Points: per-epoch accrual plus a live estimate, and the ASP's public points feed.
export { POINTS_COHORT_EDGE_SENTINEL, POINTS_DECIMALS } from "./constant/Points.js";
export {
    assertPointsEpochParams,
    cliffOverlap,
    cohortBpsAt,
    computePoints,
    notePointsForEpoch,
} from "./services/points/computePoints.js";
export { epochParamsFromRateLeaves, liveEpochParams } from "./services/points/epochParams.js";
export { HttpPointsDataProvider } from "./services/points/HttpPointsDataProvider.js";

// Errors
// Batch-withdraw errors — value-exported (not just `export type *`) so consumers can
// `instanceof` them at runtime when catching from prepareBatchWithdraw / the batch session.
export {
    BatchWithdrawBaseError,
    EmptyBatchSelection,
    BatchTooLarge,
    InfeasibleBatchFee,
    BatchRoutingMismatch,
    BatchRoutingInvalid,
} from "./errors/BatchWithdraw.js";
export {
    InvalidAddNoteParams,
    InvalidMarkNoteExitedParams,
    InvalidMarkNoteSpentParams,
    NoteCommitmentNotMined,
    PoolSessionNoteManagerBaseError,
} from "./errors/PoolSessionNoteManager.js";
// Payment-request errors — value-exported (not just `export type *`) so consumers can
// `instanceof` them at runtime. This matters most for `PaymentRequestExpired`: the whole point
// of enforcing expiry in the SDK rather than the UI is that the caller can tell "this link
// lapsed, ask for a new one" apart from a validation failure, and a type-only export collapses
// both into an indistinguishable `Error`. The siblings go with it — discriminating among them
// is exactly what a `catch` around prepareFulfillPaymentRequest has to do.
export {
    PaymentRequestBaseError,
    InvalidPaymentRequestParams,
    PaymentRequestNotFoundError,
    InvalidPaymentRequestState,
    PaymentRequestExpired,
} from "./errors/PaymentRequest.js";
// At-rest storage errors — same reason. A caller opening an encrypted store has to tell a wrong
// passphrase (retryable, prompt again) from a tampered or transplanted record (not retryable).
export {
    EncryptedStorageBaseError,
    InvalidAtRestPassphrase,
    AtRestDecryptionError,
    InvalidEncryptedRecord,
} from "./errors/EncryptedStorage.js";
// Contract-interactor / RPC / wallet-interactor / prepared-transaction errors — value-exported
// (not just `export type *`) so a chain-sdk's own concrete interactors/wallet-interactors
// (e.g. evm-sdk's ASPRegistryInteractor, ViemRPCInteractor, EIP1193WalletInteractor,
// ViemWalletInteractor, PreparedTxValidation) can throw/instanceof them at runtime. These
// classes are already chain-agnostic by name; only their concrete throwers are per-chain.
export {
    ContractInteractorBaseError,
    ContractCallError,
    InvalidInteractorAddress,
    InvalidAddressArgument,
    InvalidHashArgument,
    InvalidContractResult,
    WalletNotAvailable,
} from "./errors/ContractInteractor.js";
export {
    RPCInteractorBaseError,
    ContractReadError,
    InvalidRpcUrl,
    InvalidViemRPCInteractorConfig,
    InvalidChain,
    InvalidContractAddress,
    InvalidABIFunctionName,
    GetBlockNumberError,
    WaitForReceiptError,
    EventReadError,
} from "./errors/RPCInteractor.js";
export {
    WalletInteractorBaseError,
    WalletSendTransactionFailed,
    WalletSignTypedDataFailed,
    WalletNoAccountsError,
    WalletChainMismatch,
} from "./errors/WalletInteractor.js";
export {
    PreparedTransactionBaseError,
    UnexpectedTransactionTarget,
} from "./errors/PreparedTransaction.js";
export {
    RelayerInteractorBaseError,
    InvalidRelayerConfig,
    RelayerRequestFailed,
    RelayerQuoteUnavailable,
    RelayerRejected,
    FeeCommitmentExpired,
} from "./errors/RelayerInteractor.js";
export {
    CryptoServiceBaseError,
    InvalidSecret,
    InvalidCipherText,
    InvalidPrivateKey,
    InvalidPublicKey,
    ECDHComputationError,
} from "./errors/CryptoService.js";
export {
    KeyDerivationBaseError,
    InvalidSignature,
    InvalidAddress,
    PayloadAddressHashMismatch,
} from "./errors/KeyDerivation.js";
// Transact-param errors used directly by evm-sdk's evmPayoutRoutingGuard (InvalidTransactParams)
// and swap-routing verification (SwapQuoteMismatch) — not otherwise curated since most of this
// hierarchy's throwers stayed generic session classes already exported above.
export { InvalidTransactParams, SwapQuoteMismatch } from "./errors/PoolSessionTransact.js";
export {
    PoolSessionBuilderBaseError,
    InvalidBuilderConfig,
    UnsupportedChainId,
} from "./errors/PoolSessionBuilder.js";
// Yield-session errors — value-exported so each chain-sdk's yield codecs and interactors (and
// consumers) can throw/instanceof them.
export {
    YieldSessionBaseError,
    UnexpectedDepositCalldata,
    UnexpectedWithdrawCalldata,
    InvalidYieldAmount,
    InvalidYieldAddress,
    DuplicateYieldDeployment,
} from "./errors/Yield.js";
// Swap-quote-provider errors — value-exported so any chain-sdk's own concrete swap-quote
// provider (e.g. evm-sdk's LiFiSwapQuoteProvider) can throw/instanceof them.
export {
    SwapQuoteProviderBaseError,
    SwapQuoteFailed,
    SwapStatusFailed,
    UnallowedLiFiAddress,
    RelaySwapsLayoutMismatch,
    LiFiDepositCalldataNotFound,
    LiFiDepositTargetNotFound,
    LiFiRecipientNotFound,
    SwapRouteUnavailable,
} from "./errors/SwapQuoteProvider.js";
// Every remaining error class defined under src/errors/ — value-exported (not left to the
// type-only `export type * from "./internal.js"` catch-all below), covering the same class of
// bug already found and fixed for constants/schemas (COMMITMENT_LEAF_TAG, bytesToBigIntBE,
// sleep, several STELLAR_* constants): a symbol that's declared in the bundled .d.ts (so tsc
// resolves it fine) but genuinely absent from the runtime `export {...}` in the bundled .js,
// because only an explicit named value export survives tree-shaking here. The earlier partial
// curation assumed most of these error hierarchies "stay generic session classes" fully
// contained within core-sdk and never need instanceof-checking from outside it — but a test
// file that now lives in a SIBLING package (e.g. evm-sdk, testing a core-sdk class wired up
// with EVM adapters) imports through this exact public surface, and `.rejects.toThrow(X)` with
// `X` silently `undefined` does not fail — it just stops checking the error's actual type.
export {
    ASPClientBaseError,
    InvalidASPClientConfig,
    ASPUnavailable,
    LabelNotInSet,
    InvalidASPProof,
    IPFSFetchFailed,
    InvalidASPCipherText,
    InvalidASPCID,
    ASPLeavesRootMismatch,
} from "./errors/ASPClient.js";
export { AssetNotRelayable } from "./errors/BatchWithdraw.js";
export {
    PointsBaseError,
    InvalidPointsEpochParams,
    InvalidPointsInput,
    InvalidPointsDataProviderConfig,
    PointsDataUnavailable,
} from "./errors/Points.js";
export {
    DataServiceBaseError,
    InvalidTxHash,
    GetBlockNumberFailed,
    WaitForTransactionFailed,
} from "./errors/DataService.js";
export {
    HTTPClientBaseError,
    HTTPRequestFailed,
    HTTPResponseError,
} from "./errors/HTTPClient.js";
export {
    HashServiceBaseError,
    InvalidHashInputs,
    FailedToHashInputs,
    HashServiceNotInitialized,
    FailedToInitializePoseidon,
} from "./errors/HashService.js";
export {
    IPFSContentBaseError,
    InvalidCIDFormat,
    CIDDigestMismatch,
} from "./errors/IPFSContent.js";
export {
    KeystoreManagerError,
    InvalidKeystoreManagerConfig,
    AlreadyRegistered,
    InvalidRotationIndex,
} from "./errors/KeystoreManager.js";
export {
    MerkleServiceBaseError,
    LeafNotFound,
    InvalidLeaves,
    InvalidLeaf,
    TreeGenerationError,
    InvalidMerkleProof,
    MerkleProofVerificationFailed,
} from "./errors/MerkleService.js";
export {
    NoteComputationServiceBaseError,
    PayloadEncodeError,
    PayloadDecodeError,
} from "./errors/NoteComputationService.js";
export {
    NoteDiscoveryServiceBaseError,
    DecryptionError,
    PayloadParseError,
} from "./errors/NoteDiscoveryService.js";
export {
    NoteManagerBaseError,
    NoteNotFoundError,
    InvalidStatusTransitionError,
    InvalidNoteError,
    NoteConflictError,
    InvalidLineageError,
} from "./errors/NoteManager.js";
export {
    PoolSessionDepositBaseError,
    InvalidPoolSessionConfig,
    InvalidDepositParams,
    AssetNotEnabled,
    BelowMinimumAmount,
    DepositWitnessFailed,
    DepositProofFailed,
    AllowanceCheckFailed,
    DepositRecipientViewingKeyUnregistered,
} from "./errors/PoolSessionDeposit.js";
export {
    PoolSessionExportBaseError,
    AccountExportMismatch,
} from "./errors/PoolSessionExport.js";
export {
    PoolSessionKeystoreBaseError,
    InvalidPoolSessionKeystoreConfig,
    RegistrationDeadlineInPast,
    RegistrationCheckFailed,
    KeystoreAlreadyRegistered,
    KeystoreNotRegistered,
    CurrentLeafNotFound,
    RotationKeyMismatch,
    RevocableKeyIndexNotFound,
} from "./errors/PoolSessionKeystore.js";
export { PoolSessionLeafCacheBaseError } from "./errors/PoolSessionLeafCache.js";
export {
    PoolSessionNoteDiscoveryBaseError,
    NoteDiscoveryScanFailed,
    StateInvariantViolation,
} from "./errors/PoolSessionNoteDiscovery.js";
export {
    PoolSessionRagequitBaseError,
    InvalidPoolSessionRagequitConfig,
    InvalidRageQuitParams,
    RagequitNoteAlreadyExitedError,
    RagequitAddresslessNoteError,
} from "./errors/PoolSessionRagequit.js";
export {
    PoolSessionSwapDepositBaseError,
    InvalidSwapAndDepositParams,
    SwapAndDepositQuoteFailed,
} from "./errors/PoolSessionSwapDeposit.js";
export {
    PoolSessionTransactBaseError,
    InvalidPoolSessionTransactConfig,
    TransactNoteNotActive,
    InsufficientTransactValue,
    InsufficientChangeValueForFee,
    CrossChainReshieldNotImplemented,
    RecipientViewingKeyUnregistered,
    AssetNotSupported,
    DepositBelowMinimum,
    RelayFeeExceedsMax,
    SwapValueExceedsRelayerCap,
    DestinationCallsUnsupported,
    DepositTargetMismatch,
    DestinationChainNotSupported,
    DestinationDepositTargetMismatch,
    DustRescueRecipientConflict,
    DestinationDepositUnaffordable,
    NativeDestinationDepositUnsupported,
    NativeSwapDepositUnavailable,
    YieldTargetNotConfigured,
} from "./errors/PoolSessionTransact.js";
export {
    ProofServiceBaseError,
    ProofGenerationFailed,
    ProofVerificationFailed,
    CircuitArtifactLoadFailed,
    CircuitArtifactMultihashMismatch,
    CircuitNotAvailable,
    InvalidTransactDimensions,
    InvalidWitness,
    InvalidProof,
} from "./errors/ProofService.js";
export {
    StorageAdapterBaseError,
    StorageQuotaError,
    InvalidStorageStateError,
    InvalidStorageFilename,
    UnreadableStorageFile,
} from "./errors/StorageAdapter.js";
export {
    WitnessPreparationServiceError,
    InvalidDepositWitnessInputs,
    InvalidTransactWitnessInputs,
    InvalidRagequitWitnessInputs,
    WitnessPreparationFailed,
} from "./errors/WitnessPreparationService.js";

// The structured-amounts guard is a FUNCTION, so it has to be value-exported: under the
// `export type *` at the bottom of this file it would type-check at every call site and be
// `undefined` at runtime (see publicBarrel.test.ts). `ErrorAmounts`/`AmountErrorCode` are
// types and ride along with that re-export.
export { hasErrorAmounts } from "./errors/amounts.js";
// Capability flags, so a consumer that vendors a prebuilt tarball can tell what it got.
export { SDK_FEATURES } from "./constant/common.js";

// Types (re-export all from internal)
export type * from "./internal.js";

export const utils = {
    encodeASPCipherText,
    decodeASPCipherText,
};
