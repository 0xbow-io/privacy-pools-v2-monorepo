// Re-export everything from the chain-agnostic core so a consumer that only needs
// @privacy-pools-v2/evm-sdk does not also have to depend on @privacy-pools-v2/core-sdk directly.
export * from "@privacy-pools-v2/core-sdk";

// EVM chain adapters + concrete contract interactors
export {
    EvmEntrypointChainAdapter,
    createEvmEntrypointInteractor,
    EvmPoolVaultChainAdapter,
    createEvmPoolVaultInteractor,
    EvmKeystoreChainAdapter,
    createEvmKeystoreInteractor,
    PPRouterInteractor,
    PPYieldTokenInteractor,
    PPYieldTokenZapInteractor,
} from "./internal.js";

// EVM pool-session building blocks
export {
    PoolSessionBuilder,
    createEvmPoolSession,
    EvmPoolSession,
    EvmAddressEqualityComparator,
    EvmAddressFieldConverter,
    EvmContextHashService,
    EvmPayoutRoutingCodec,
    EvmPreparedTxVerifier,
    EvmRelayBatchCodec,
    EvmSwapChainAdapter,
    EvmYieldRouterCodec,
    EvmPoolSessionYieldDeposit,
    EvmPoolSessionYieldWithdraw,
    EvmPoolSessionYieldEarned,
    toYieldDeploymentConfig,
} from "./internal.js";

// RPC / wallet / swap-quote / crypto / proof / relayer / note-discovery services
export {
    ViemRPCInteractor,
    EvmNoteDiscoveryService,
    EIP1193WalletInteractor,
    ViemWalletInteractor,
    LiFiSwapQuoteProvider,
    CryptoService,
    ProofService,
    RelayerInteractor,
    ASPRegistryInteractor,
} from "./internal.js";

// Constants
export { DEPLOYMENTS, SEPOLIA_CHAIN_ID } from "./constant/deployments.js";
export {
    PP_YIELD_TOKEN_ABI,
    PP_YIELD_TOKEN_REDEEM_ABI,
    PP_YIELD_TOKEN_ZAP_REDEEM_ABI,
    PP_ROUTER_ABI,
    PP_ROUTER_DEPOSIT_ABI,
    PP_ROUTER_DEPOSIT_NATIVE_ABI,
    PP_ROUTER_WITHDRAW_ABI,
    DEPOSIT_SHARES_DISCOUNT_BPS,
    DEPOSIT_SLIPPAGE_BPS,
    ZAP_SUPPLY_BUFFER_UNITS,
    YIELD_DEPLOYMENTS,
    LOCAL_FORK_YIELD_DEPLOYMENT,
    YIELD_DISPLAY_SYMBOL,
    YIELD_DISPLAY_BADGE,
    getYieldDeployment,
    isYieldToken,
    isPpUsdcSymbol,
} from "./constant/Yield.js";
// relayBatch ABI — needed by external consumers that self-submit a batch (build the
// PrivacyPoolRelay.relayBatch calldata themselves via prepareSelfSubmitBatch).
export { PP_RELAY_BATCH_ABI } from "./constant/ContractInteractor.js";
// Entrypoint.deposit ABI — needed by external consumers that build or decode a raw
// Entrypoint.deposit(proof, noteData, aspCiphertext) call themselves, outside a PoolSession.
export { ENTRYPOINT_DEPOSIT_ABI } from "./constant/ContractInteractor.js";
// PayoutRouting ABIs — needed by external consumers that decode the relayer's signed
// fee-commitment `data` (a PayoutRouting[]) or build a single routing. Value-exported (not just
// `export type *`) so they are defined at runtime.
export { PAYOUT_ROUTING_ABI, PAYOUT_ROUTING_ARRAY_ABI, RELAY_SWAP_ROUTING_ABI } from "./constant/PoolSessionTransact.js";

// Utils
export { decodeStargateDestBudget } from "./utils/StargateCalldata.js";
export { assertDepositEmbeddedInLiFiCalldata } from "./utils/LiFiContainmentCheck.js";
// LiFi Executor screening: an arbitrary-call contract that must never be a spender or a swap target.
export { isLiFiExecutor, isLiFiExecutorCall } from "./utils/LiFiExecutor.js";
export { LIFI_EXECUTOR_SCREENING_ABI } from "./constant/LiFiSwapQuoteProvider.js";
export { isSameToken, canonicalTokenAddress, LIFI_NATIVE_TOKEN_ADDRESS } from "./utils/TokenIdentity.js";
// Relayer /v1/details discovery helpers and the share-output (yield swap-deposit) helpers.
export {
    relayerInfoFromDetails,
    yieldDeploymentsFromDetails,
    relaySwapsAddressFromDetails,
} from "./utils/RelayerDetails.js";
export {
    prepareYieldSwapDeposit,
    yieldDepositTargetFor,
    yieldDepositFundingToken,
    assertYieldDepositMatches,
    toYieldSwapDepositTarget,
} from "./utils/YieldSwapOutput.js";

// Types (re-export all from internal, including the core-sdk re-export above)
export type * from "./internal.js";
