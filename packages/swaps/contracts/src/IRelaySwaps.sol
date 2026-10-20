// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {ProofLibV2} from "main_contracts_libs/ProofLibV2.sol";

/// @title IPool
/// @notice Minimal interface for PoolVault.transact()
interface IPool {
    struct TransactParams {
        address processor;
        bytes data;
    }

    struct NoteData {
        bytes32 hint;
        bytes data;
    }

    function transact(
        ProofLibV2.TransactProof calldata _proof,
        TransactParams calldata _transactParams,
        NoteData[] calldata _noteData
    ) external;
}

/// @title IEntrypoint
/// @notice Minimal interface for Entrypoint asset config lookup
interface IEntrypoint {
    struct AssetConfig {
        bool enabled;
        uint256 minAmount;
        uint256 vettingFeeBPS;
        uint256 maxRelayFee;
    }

    function assets(address _asset) external view returns (AssetConfig memory);
}

/// @title IRelaySwaps
/// @notice Interface for RelaySwaps — houses the proof-bound SwapRouting struct
///   and describes the contract's external surface (execute, router allowlist).
interface IRelaySwaps {
    /*///////////////////////////////////////////////////////////////
                              STRUCTS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Opt-in cross-chain "dust rescue" — the relayer MAY (at its own discretion,
    ///   once it independently observes the destination-chain leftover) submit a rescue
    ///   deposit for it. Proof-bound like every other SwapRouting field, so the relayer
    ///   cannot attach or alter it after the proof is generated (RC-10 — previously this
    ///   travelled on the unsigned relay request body with no such anchor).
    /// @dev chainId == 0 means no dust rescue was requested — every other field is then
    ///   meaningless and left zero/empty. spendingPubKey/viewingPubKey mirror the SDK's
    ///   StealthRecipientIdentifier discriminated union: viewingPubKey is empty unless
    ///   isCanonical is true.
    struct DustRescue {
        uint256 chainId;
        address tokenId;
        bool isCanonical;
        bytes spendingPubKey;
        bytes viewingPubKey;
    }

    /// @notice Routing config — ABI-encoded into TransactParams.data,
    ///   committed in the ZK proof via context hash. Relayer cannot modify any field.
    /// @dev For same-chain swap: recipient receives output via LiFi, nativeGas forwarded,
    ///   minOutputAmount enforced via recipient balance delta.
    ///   recipient = address(0) means no source-chain recipient — reshield (LiFi deposits
    ///   via contractCalls) or cross-chain swap (output delivered on destination chain).
    ///   In that mode nativeGas and minOutputAmount MUST be 0 (enforced); output delivery
    ///   is verified elsewhere (Entrypoint.deposit revert / LiFi destination executor).
    ///   swapTarget is proof-bound — allows different DEX aggregators/Diamond versions.
    ///   swapCalldata is the full LiFi calldata, committed via the proof context hash.
    struct SwapRouting {
        address swapTarget;
        address approvalAddress;
        address outputToken;
        address recipient;
        address feeRecipient;
        address fallbackAddress;
        address dustRecipient;
        uint256 feeAmount;
        uint256 minOutputAmount;
        uint256 nativeGas;
        // --- B2: self-funded bridge msg.value (Mainnet-destination reshield). See
        //   RelaySwaps.sol for full semantics. swapValue == 0 => B2 path skipped. ---
        uint256 swapValue;
        uint256 gasSwapMaxInput;
        bytes gasSwapCalldata;
        bytes swapCalldata;
        // Not read or validated by RelaySwaps itself — see DustRescue above. Carried here
        // purely so it inherits this struct's existing proof-binding for free.
        DustRescue dustRescue;
    }

    /*///////////////////////////////////////////////////////////////
                              ERRORS
    ///////////////////////////////////////////////////////////////*/

    error RelaySwaps_ZeroPool();
    error RelaySwaps_ZeroEntrypoint();
    error RelaySwaps_ZeroSwapTarget();
    error RelaySwaps_ZeroApprovalAddress();
    error RelaySwaps_InvalidSwapTarget();
    error RelaySwaps_InvalidApprovalAddress();
    error RelaySwaps_ZeroWithdrawal();
    error RelaySwaps_ZeroFeeRecipient();
    error RelaySwaps_ZeroDustRecipient();
    error RelaySwaps_SwapFailed();
    error RelaySwaps_InsufficientOutput();
    error RelaySwaps_FeeExceedsMax();
    error RelaySwaps_FeeExceedsWithdrawal();
    error RelaySwaps_NativeGasMismatch();
    error RelaySwaps_NativeGasWithoutRecipient();
    error RelaySwaps_MinOutputWithoutRecipient();
    error RelaySwaps_RenounceDisabled();
    error RelaySwaps_GasSwapInsufficient();
    error RelaySwaps_GasSwapNativeInput();
    error RelaySwaps_ZapATokenMismatch();
    error RelaySwaps_ZapUnderlyingMismatch();
    error RelaySwaps_ZapShareNotPoolAsset();
    error RelaySwaps_ZapInvalidUnderlying();
    error RelaySwaps_InvalidZap();
    error RelaySwaps_ZapShareMismatch();
    error RelaySwaps_UnwrapZeroOutput();

    /*///////////////////////////////////////////////////////////////
                              EVENTS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Emitted on successful execute
    event Executed(
        address indexed inputToken,
        address indexed outputToken,
        uint256 inputAmount,
        address feeRecipient,
        uint256 feeAmount
    );

    event RouterAdded(address indexed _routerAddress);
    event RouterRemoved(address indexed _routerAddress);
    event ZapApproved(address indexed zap, address indexed share, address indexed underlying);
    event ZapRemoved(address indexed zap);
    event Unwrapped(
        address indexed share,
        address indexed underlying,
        uint256 shares,
        uint256 underlyingOut,
        uint256 feeUnderlying
    );

    /*///////////////////////////////////////////////////////////////
                              FUNCTIONS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Native ETH sentinel (same as Constants.NATIVE_ASSET)
    function NATIVE_ASSET() external view returns (address);

    /// @notice Pool contract (PoolVault — exposes transact())
    function POOL() external view returns (IPool);

    /// @notice Entrypoint contract — for maxRelayFee lookup
    function ENTRYPOINT() external view returns (IEntrypoint);

    /// @notice Whether a swap/approval target is on the vetted router allowlist
    function approvedRouters(address _routerAddress) external view returns (bool);

    /// @notice keccak256 of SwapRouting's EIP-712-style encodeType string — a self-describing
    ///   identifier for the struct's field list, types and order (RC-32: five of six live
    ///   RelaySwaps deployments were found silently decoding an older SwapRouting shape than
    ///   the SDK/relayer encoders emitted, panicking mid-decode after a proof was already
    ///   generated). Callers read this off-chain before encoding a SwapRouting payload and
    ///   refuse to proceed on a mismatch, catching the incompatibility before it costs a proof.
    /// @dev See RelaySwaps.sol for the string and RoutingLayout.t.sol for the drift guard that
    ///   keeps it honest against the struct's actual compiled shape.
    function ROUTING_TYPEHASH() external pure returns (bytes32);

    /// @notice adds a contract to the list of allowed routers
    /// @param _routerAddress address of the whitelisted contract.
    function approveRouter(address _routerAddress) external;

    /// @notice removes a contract from the list of allowed routers
    /// @param _routerAddress address of the contract to be removed from accepted list.
    function removeRouter(address _routerAddress) external;

    /// @notice Whether a PPYieldTokenZap may be used by executeUnwrapped().
    function approvedZaps(address _zap) external view returns (bool);

    /// @notice The full list of currently-allowlisted zaps (unordered). For an off-chain
    ///   boot-time read — a consumer resolves each zap's share via zap.VAULT().
    function approvedZapList() external view returns (address[] memory);

    /// @notice Allowlists a zap after cross-checking it against its share and aToken (owner only).
    function approveZap(address _zap) external;

    /// @notice Removes a zap from the allowlist (owner only).
    function removeZap(address _zap) external;

    /// @notice Unified withdraw + swap. Pulls tokens via POOL.transact(), forwards to LiFi.
    /// @param _proof The transact proof (pubSignals[5][0] = amountOut, [6][0] = tokenIdOut)
    /// @param _transactParams Transact params with processor = address(this), data = abi.encode(SwapRouting)
    /// @param _noteData Per-output discovery data
    function execute(
        ProofLibV2.TransactProof calldata _proof,
        IPool.TransactParams calldata _transactParams,
        IPool.NoteData[] calldata _noteData
    ) external payable;

    /// @notice execute() for a yield note: redeems the withdrawn shares through `_zap`
    ///   (allowlisted; `_zap.VAULT()` must equal tokenIdOut) before the swap.
    function executeUnwrapped(
        ProofLibV2.TransactProof calldata _proof,
        IPool.TransactParams calldata _transactParams,
        IPool.NoteData[] calldata _noteData,
        address _zap
    ) external payable;
}
