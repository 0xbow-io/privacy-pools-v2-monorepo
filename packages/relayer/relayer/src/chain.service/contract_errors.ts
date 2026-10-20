import { Abi } from "viem";
import { PP_RELAY_ABI } from "../sdk/relayer_abi";

/**
 * Combined error ABI entries from PoolVault, Entrypoint, Keystore, and PrivacyPoolRelay.
 * Used to decode hex revert data from failed simulations.
 *
 */
const POOL_VAULT_ERRORS = [
    { type: "error", name: "PoolVault_CommitmentAlreadyUsed", inputs: [] },
    { type: "error", name: "PoolVault_CommitmentNotFound", inputs: [] },
    { type: "error", name: "PoolVault_InvalidASPRoot", inputs: [] },
    { type: "error", name: "PoolVault_InvalidDepositProof", inputs: [] },
    { type: "error", name: "PoolVault_InvalidOwnerAddress", inputs: [] },
    { type: "error", name: "PoolVault_InvalidProcessor", inputs: [] },
    { type: "error", name: "PoolVault_InvalidRagequitProof", inputs: [] },
    { type: "error", name: "PoolVault_InvalidTransactProof", inputs: [] },
    { type: "error", name: "PoolVault_InvalidValue", inputs: [] },
    { type: "error", name: "PoolVault_NullifierAlreadySpent", inputs: [] },
    { type: "error", name: "PoolVault_ProofContextMismatch", inputs: [] },
    { type: "error", name: "PoolVault_UnknownKeystoreRoot", inputs: [] },
    { type: "error", name: "PoolVault_UnknownStateRoot", inputs: [] },
    { type: "error", name: "RootBuffer_InvalidSize", inputs: [] },
    {
        type: "error",
        name: "TransactVerifierRouter_UnsupportedCircuitConfiguration",
        inputs: [
            { name: "_nullifiersSpent", type: "uint256" },
            { name: "_commitmentsCreated", type: "uint256" },
        ],
    },
    {
        type: "error",
        name: "TransactVerifierRouter_VerifierCallReverted",
        inputs: [{ name: "_error", type: "bytes" }],
    },
    {
        type: "error",
        name: "TransactVerifierRouter_WrongSelector",
        inputs: [
            { name: "_expected", type: "bytes4" },
            { name: "_actual", type: "bytes4" },
        ],
    },
    { type: "error", name: "TransactVerifierRouter_InvalidZeroParameter", inputs: [] },
] as const;

const ENTRYPOINT_ERRORS = [
    { type: "error", name: "Entrypoint_AssetNotEnabled", inputs: [] },
    { type: "error", name: "Entrypoint_BelowMinAmount", inputs: [] },
    { type: "error", name: "Entrypoint_InvalidETHAmount", inputs: [] },
] as const;

const RELAY_SWAPS_ERRORS = [
    { type: "error", name: "RelaySwaps_ZapATokenMismatch", inputs: [] },
    { type: "error", name: "RelaySwaps_ZapUnderlyingMismatch", inputs: [] },
    { type: "error", name: "RelaySwaps_ZapShareNotPoolAsset", inputs: [] },
    { type: "error", name: "RelaySwaps_ZapInvalidUnderlying", inputs: [] },
    { type: "error", name: "RelaySwaps_InvalidZap", inputs: [] },
    { type: "error", name: "RelaySwaps_ZapShareMismatch", inputs: [] },
    { type: "error", name: "RelaySwaps_UnwrapZeroOutput", inputs: [] },
    { type: "error", name: "RelaySwaps_ZeroPool", inputs: [] },
    { type: "error", name: "RelaySwaps_ZeroEntrypoint", inputs: [] },
    { type: "error", name: "RelaySwaps_ZeroSwapTarget", inputs: [] },
    { type: "error", name: "RelaySwaps_ZeroApprovalAddress", inputs: [] },
    { type: "error", name: "RelaySwaps_InvalidSwapTarget", inputs: [] },
    { type: "error", name: "RelaySwaps_ZeroWithdrawal", inputs: [] },
    { type: "error", name: "RelaySwaps_ZeroFeeRecipient", inputs: [] },
    { type: "error", name: "RelaySwaps_ZeroDustRecipient", inputs: [] },
    { type: "error", name: "RelaySwaps_SwapFailed", inputs: [] },
    { type: "error", name: "RelaySwaps_InsufficientOutput", inputs: [] },
    { type: "error", name: "RelaySwaps_FeeExceedsMax", inputs: [] },
    { type: "error", name: "RelaySwaps_FeeExceedsWithdrawal", inputs: [] },
    { type: "error", name: "RelaySwaps_NativeGasMismatch", inputs: [] },
    { type: "error", name: "RelaySwaps_NativeGasWithoutRecipient", inputs: [] },
    { type: "error", name: "RelaySwaps_MinOutputWithoutRecipient", inputs: [] },
    { type: "error", name: "RelaySwaps_InvalidCalldata", inputs: [] },
] as const;
  
// Keystore custom errors (all zero-input) from packages/contracts/src/interfaces/IKeystore.sol.
// The registerAndRelay path calls Keystore.setAuthPolicyWithSig, so its registration-leg
// reverts surface here; without these entries they would decode only to a raw selector.
const KEYSTORE_ERRORS = [
    { type: "error", name: "Keystore_AuthPolicyAlreadySet", inputs: [] },
    { type: "error", name: "Keystore_AuthPolicyNotSet", inputs: [] },
    { type: "error", name: "Keystore_InvalidNullifyingKeyHash", inputs: [] },
    { type: "error", name: "Keystore_OutOfScalarField", inputs: [] },
    { type: "error", name: "Keystore_KeystoreTreeFull", inputs: [] },
    { type: "error", name: "Keystore_InvalidMaxTreeSize", inputs: [] },
    { type: "error", name: "Keystore_InvalidSignature", inputs: [] },
    { type: "error", name: "Keystore_SignatureExpired", inputs: [] },
] as const;

const SHARED_ERRORS = [
    { type: "error", name: "Permissioned_NotAuthorized", inputs: [] },
    { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
    { type: "error", name: "FailedCall", inputs: [] },
    { type: "error", name: "EnforcedPause", inputs: [] },
] as const;

export const ALL_CONTRACT_ERRORS: Abi = deduplicateErrorAbi([
    ...PP_RELAY_ABI.filter((e) => e.type === "error"),
    ...POOL_VAULT_ERRORS,
    ...ENTRYPOINT_ERRORS,
    ...RELAY_SWAPS_ERRORS,
    ...KEYSTORE_ERRORS,
    ...SHARED_ERRORS,
]);

function deduplicateErrorAbi(entries: readonly { type: string; name?: string }[]): Abi {
    const seen = new Set<string>();
    return entries.filter((e) => {
        const key = e.name ?? "";
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }) as unknown as Abi;
}
