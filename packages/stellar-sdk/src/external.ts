// Re-export everything from the chain-agnostic core so a consumer that only needs
// @privacy-pools-v2/stellar-sdk does not also have to depend on @privacy-pools-v2/core-sdk directly.
export * from "@privacy-pools-v2/core-sdk";

// Stellar chain adapters + concrete contract interactors
export {
    StellarEntrypointChainAdapter,
    createStellarEntrypointInteractor,
    StellarPoolVaultChainAdapter,
    createStellarPoolVaultInteractor,
    StellarKeystoreChainAdapter,
    createStellarKeystoreInteractor,
    StellarASPRegistryInteractor,
    StellarYieldTokenInteractor,
    StellarYieldRouterInteractor,
} from "./internal.js";

// Stellar pool-session building blocks
export {
    StellarPoolSessionBuilder,
    createStellarPoolSession,
    StellarAddressEqualityComparator,
    StellarAddressFieldConverter,
    StellarContextHashService,
    StellarPayoutRoutingCodec,
    StellarPreparedTxVerifier,
    StellarRelayBatchCodec,
    StellarPoolSession,
    StellarYieldRouterCodec,
} from "./internal.js";

// RPC / wallet / crypto / proof / relayer services
export {
    SorobanRPCInteractor,
    createFreighterProvider,
    FreighterWalletInteractor,
    KeypairWalletInteractor,
    StellarCryptoService,
    StellarProofService,
    StellarRelayerInteractor,
} from "./internal.js";

// Constants
export { STELLAR_EMPTY_ADDRESS } from "./constant/common.js";

// Schemas — Stellar StrKey address validation and the relayer wire-format schemas.
export {
    StellarAddressSchema,
    StellarAddressOrEmptySchema,
} from "./schemas/common.js";
export {
    StellarWithdrawalFeeCommitmentWireSchema,
    StellarWithdrawalQuoteResponseWireSchema,
    StellarRelayResponseWireSchema,
} from "./schemas/StellarRelayerInteractor.js";

// Utils — ScVal encode/decode helpers, Soroban event decoding, key-derivation transaction, and
// error-message normalization. Needed by external consumers that build/decode raw Soroban
// contract calls or Stellar wallet-signing messages themselves, outside a PoolSession.
export {
    u256ScVal,
    u128ScVal,
    i128ScVal,
    u32ScVal,
    u64ScVal,
    boolScVal,
    addressScVal,
    bytesScVal,
    vecScVal,
    structScVal,
    groth16ProofScVal,
    noteDataScVal,
} from "./utils/StellarScVal.js";
export { decodeScVal, bufferToHex, ledgerClosedAtToUnixSeconds } from "./utils/StellarEventDecoding.js";
export { buildKeyDerivationTransaction } from "./utils/StellarKeyDerivationMessage.js";
export { stellarErrorMessage } from "./utils/StellarErrorMessage.js";

// Errors
export {
    StellarRPCInteractorBaseError,
    StellarSimulationFailed,
    StellarTransactionSendFailed,
    StellarTransactionFailed,
    StellarTransactionTimedOut,
    StellarEventRetentionWindowExceeded,
    StellarRPCCallTimedOut,
} from "./errors/StellarRPCInteractor.js";
export {
    StellarWalletInteractorBaseError,
    StellarWalletSignTransactionFailed,
    StellarWalletNoAccountsError,
    StellarWalletNotAvailable,
    StellarWalletNetworkMismatch,
} from "./errors/StellarWalletInteractor.js";

// Types (re-export all from internal, including the core-sdk re-export above)
export type * from "./internal.js";
