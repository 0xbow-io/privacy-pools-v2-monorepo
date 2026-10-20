// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {EnumerableSetLib} from "solady/utils/EnumerableSetLib.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import {ProofLibV2} from 'main_contracts_libs/ProofLibV2.sol';
import {ROUTING_ENCODE_TYPE} from "./generated/RoutingTypehash.sol";

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

/// @title IYieldZap
/// @notice Minimal interface for PPYieldTokenZap (stateless share <-> underlying router).
///   Only the getters approveZap()/executeUnwrapped() cross-check and the redeem entry point.
interface IYieldZap {
    function VAULT() external view returns (address);
    function UNDERLYING() external view returns (address);
    function A_TOKEN() external view returns (address);
    function redeemToUnderlying(uint256 _shares, address _receiver) external returns (uint256 _underlyingOut);
}

/// @title IERC4626Asset
/// @notice The one ERC-4626 view approveZap() needs from the share token.
interface IERC4626Asset {
    function asset() external view returns (address);
}

/// @title IATokenUnderlying
/// @notice The one Aave aToken view approveZap() needs.
interface IATokenUnderlying {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}

/// @title RelaySwaps
/// @notice Unified processor for relayer-mediated withdraw-and-swap operations.
///   Handles both swap-to-recipient and reshield (swap+deposit) via a single execute().
///   LiFi handles all post-swap actions (direct transfer or Entrypoint.deposit via contractCalls).
///   Swap calldata is proof-bound via the proof context hash — relayer cannot tamper with routing, slippage, or deposit.
contract RelaySwaps is ReentrancyGuard, Ownable {
    using SafeTransferLib for address;

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
        // --- B2: self-funded bridge msg.value (Mainnet-destination reshield) ---
        //   swapValue: exact native wei forwarded as msg.value to the main swap/bridge
        //     call (step 10). 0 => the B2 gas-swap path is skipped entirely and execute()
        //     behaves byte-for-byte as before. Only valid on the ERC-20 input branch
        //     (native-ETH input => swapValue MUST be 0, enforced).
        //   gasSwapMaxInput: upper bound on input-token units the contract may approve for
        //     the gas swap (step 9.5) — bounds a subverted gasSwapCalldata to the
        //     SDK-sized slice, since the contract cannot parse aggregator calldata. Enforced
        //     on-chain against this withdrawal's own net proceeds, _amount - feeAmount
        //     (RelaySwaps_GasSwapMaxInputExceedsWithdrawal); the actual floor against
        //     stranded-balance drainage is the RelaySwaps_InputBalanceDeficit check after
        //     step 10, since this bound alone does not stop step 10 from re-approving its
        //     full _swapAmount regardless of what step 9.5 already consumed.
        //   gasSwapCalldata: same-chain swap calldata (input token -> native ETH), run
        //     against swapTarget with the approval to approvalAddress — the same
        //     allowlisted router as the main swap. Proof-bound via the same context hash
        //     as swapCalldata. The gas swap must yield >= swapValue wei to address(this)
        //     or the whole tx reverts (RelaySwaps_GasSwapInsufficient); the overshoot is
        //     swept to dustRecipient by the delta-only sweep in step 13.
        uint256 swapValue;
        uint256 gasSwapMaxInput;
        bytes gasSwapCalldata;
        bytes swapCalldata;
        // Not read or validated by RelaySwaps itself — see DustRescue above. Carried here
        // purely so it inherits this struct's existing proof-binding for free.
        DustRescue dustRescue;
    }


    /*///////////////////////////////////////////////////////////////
                              USING
    ///////////////////////////////////////////////////////////////*/
    using ProofLibV2 for ProofLibV2.TransactProof;
    using EnumerableSetLib for EnumerableSetLib.AddressSet;

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
    error RelaySwaps_ZeroMinOutputWithRecipient();
    error RelaySwaps_RenounceDisabled();
    /// @notice The B2 gas swap produced fewer native wei than SwapRouting.swapValue.
    error RelaySwaps_GasSwapInsufficient();
    /// @notice SwapRouting.gasSwapMaxInput exceeds this withdrawal's own net proceeds
    ///   (_amount - feeAmount). Defense-in-depth: makes the gasSwapMaxInput NatSpec's
    ///   claimed bound ("SDK-sized slice" of the withdrawal) actually true on-chain. Does
    ///   not by itself prevent RelaySwaps_InputBalanceDeficit — the main swap (step 10)
    ///   still re-approves the full _swapAmount regardless of what the gas swap consumed.
    error RelaySwaps_GasSwapMaxInputExceedsWithdrawal();
    /// @notice execute() would end holding less of the input token than it held before
    ///   this call started. Guards against the B2 gas swap (step 9.5) and the main swap
    ///   (step 10) jointly pulling more input token than this call's own withdrawal, which
    ///   would otherwise consume a balance stranded in the contract by another user (e.g. an
    ///   async bridge refund) rather than just this withdrawal's proceeds.
    error RelaySwaps_InputBalanceDeficit();
    /// @notice SwapRouting.swapValue > 0 with a native-ETH input note — unsupported (see execute() step 4).
    error RelaySwaps_GasSwapNativeInput();
    /// @notice approveZap(): zap.A_TOKEN() != share.asset().
    error RelaySwaps_ZapATokenMismatch();
    /// @notice approveZap(): zap.UNDERLYING() != aToken.UNDERLYING_ASSET_ADDRESS().
    error RelaySwaps_ZapUnderlyingMismatch();
    /// @notice approveZap(): the zap's share (VAULT) is not an enabled Entrypoint asset.
    error RelaySwaps_ZapShareNotPoolAsset();
    /// @notice approveZap(): the zap's underlying is the native sentinel, zero, or has no code.
    error RelaySwaps_ZapInvalidUnderlying();
    /// @notice executeUnwrapped(): zap is not on the allowlist.
    error RelaySwaps_InvalidZap();
    /// @notice executeUnwrapped(): zap.VAULT() != the proof's tokenIdOut.
    error RelaySwaps_ZapShareMismatch();
    /// @notice execute(): the Zap redeemed the shares to zero underlying.
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
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event ZapApproved(address indexed zap, address indexed share, address indexed underlying);
    event ZapRemoved(address indexed zap);
    /// @notice execute() redeemed `shares` of `share` into `underlyingOut` of `underlying`;
    ///   `feeUnderlying` is the pro-rata relay fee actually paid (fee committed in shares).
    event Unwrapped(
        address indexed share,
        address indexed underlying,
        uint256 shares,
        uint256 underlyingOut,
        uint256 feeUnderlying
    );

    /*///////////////////////////////////////////////////////////////
                            CONSTANTS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Native ETH sentinel (same as Constants.NATIVE_ASSET)
    address public constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice keccak256 of SwapRouting's EIP-712-style encodeType string — see
    ///   IRelaySwaps.ROUTING_TYPEHASH for why this exists (RC-32).
    /// @dev Implemented as a `pure` function rather than `public constant`: solc 0.8.32 throws
    ///   an internal compiler error when a Foundry test calls a `public constant` getter
    ///   through a contract instance (`relaySwaps.NATIVE_ASSET()` above hits the same issue —
    ///   see MockPool.t.sol's note on it — immutables are unaffected). A `pure` function sidesteps
    ///   it while keeping the same external call shape.
    ///   ROUTING_ENCODE_TYPE (src/generated/RoutingTypehash.sol) is generated, not hand-typed —
    ///   see that file's header for the regeneration command. RoutingLayout.t.sol fails the
    ///   build if it and the struct's actual compiled shape (read from solc's own AST) ever
    ///   disagree, which is the signal to regenerate rather than hand-edit either file.
    function ROUTING_TYPEHASH() external pure returns (bytes32) {
        return keccak256(bytes(ROUTING_ENCODE_TYPE));
    }

    /*///////////////////////////////////////////////////////////////
                            IMMUTABLES
    ///////////////////////////////////////////////////////////////*/

    /// @notice Pool contract (PoolVault — exposes transact())
    IPool public immutable POOL;

    /// @notice Entrypoint contract — for maxRelayFee lookup
    IEntrypoint public immutable ENTRYPOINT;

    /*///////////////////////////////////////////////////////////////
                            PERMISSIONED ROUTER WHITELIST
    ///////////////////////////////////////////////////////////////*/
    mapping(address => bool) public approvedRouters;

    /*///////////////////////////////////////////////////////////////
                          PERMISSIONED ZAP WHITELIST
    ///////////////////////////////////////////////////////////////*/

    /// @notice PPYieldTokenZaps executeUnwrapped() may redeem through. Owner-managed like
    ///   approvedRouters; approveZap() cross-checks the zap against its share and aToken so a
    ///   mis-wired or hostile zap cannot be listed. The share a zap serves is fixed by
    ///   zap.VAULT(), which executeUnwrapped() re-checks against the proof-bound tokenIdOut.
    /// @dev Held as an enumerable set so an off-chain consumer (the relayer at boot) can read
    ///   the whole allowlist in one call via approvedZapList() and treat it as the source of
    ///   truth, instead of each operator hand-copying zap addresses into its own config.
    EnumerableSetLib.AddressSet private _approvedZaps;

    /// @notice Whether a PPYieldTokenZap may be used by executeUnwrapped(). Kept as an explicit
    ///   getter (not a public mapping) because the backing store is an enumerable set.
    /// @param _zap The zap to check.
    function approvedZaps(address _zap) external view returns (bool) {
        return _approvedZaps.contains(_zap);
    }

    /// @notice The full list of currently-allowlisted zaps. Order is not guaranteed and shifts
    ///   as entries are removed. Intended for an off-chain boot-time read, not on-chain use.
    function approvedZapList() external view returns (address[] memory) {
        return _approvedZaps.values();
    }

    /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
    ///////////////////////////////////////////////////////////////*/

    /// @param _pool Address of the pool contract
    /// @param _entrypoint Address of the entrypoint contract
    constructor(
                IPool _pool,
                IEntrypoint _entrypoint,
                address _intendedOwner,
                address _allowedRouter
    ) Ownable(_intendedOwner) {
        require(address(_pool) != address(0), RelaySwaps_ZeroPool());
        require(address(_entrypoint) != address(0), RelaySwaps_ZeroEntrypoint());
        POOL = _pool;
        ENTRYPOINT = _entrypoint;

        // add the first approved router
        approvedRouters[_allowedRouter] = true;
    }

    /// @notice Accept ETH from POOL (native withdrawals), LiFi (swap refunds/residue),
    ///   and async bridge refunds. Pre-existing ETH is NOT swept by execute() (delta-only
    ///   baseline); use rescue() to recover ETH stranded outside an execute() window.
    receive() external payable {}

    /*///////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS
    ///////////////////////////////////////////////////////////////*/

    /// @notice adds a contract to the list of allowed routers
    /// @param routerAddress address of the whitelisted contract.
    function approveRouter(address routerAddress) public onlyOwner {
        approvedRouters[routerAddress] = true;
        emit RouterAdded(routerAddress);
    }

    /// @notice adds a contract to the list of allowed routers
    /// @param routerAddress address of the contract to be removed from accepted list.
    function removeRouter(address routerAddress) public onlyOwner {
        approvedRouters[routerAddress] = false;
        emit RouterRemoved(routerAddress);
    }

    /// @notice Allowlists a PPYieldTokenZap for executeUnwrapped(). Everything is derived and
    ///   cross-checked on-chain across three independent contracts (zap, share, aToken):
    ///   zap.A_TOKEN() == share.asset() and zap.UNDERLYING() == aToken.UNDERLYING_ASSET_ADDRESS(),
    ///   where share = zap.VAULT(); the share must be an enabled Entrypoint asset and the
    ///   underlying a real, non-native ERC-20. Same trust class as approveRouter (the zap
    ///   receives the withdrawn shares), so the owner should be a multisig in production.
    /// @param _zap The wrapper's PPYieldTokenZap.
    function approveZap(address _zap) external onlyOwner {
        address _share = IYieldZap(_zap).VAULT();
        address _aToken = IERC4626Asset(_share).asset();
        require(IYieldZap(_zap).A_TOKEN() == _aToken, RelaySwaps_ZapATokenMismatch());
        address _underlying = IATokenUnderlying(_aToken).UNDERLYING_ASSET_ADDRESS();
        require(IYieldZap(_zap).UNDERLYING() == _underlying, RelaySwaps_ZapUnderlyingMismatch());
        require(
            _underlying != NATIVE_ASSET && _underlying != address(0) && _underlying.code.length != 0,
            RelaySwaps_ZapInvalidUnderlying()
        );
        require(ENTRYPOINT.assets(_share).enabled, RelaySwaps_ZapShareNotPoolAsset());
        _approvedZaps.add(_zap);
        emit ZapApproved(_zap, _share, _underlying);
    }

    /// @notice Removes a zap from the allowlist. Only affects executeUnwrapped(); an in-flight
    ///   proof built for it simply reverts (RelaySwaps_InvalidZap), it can never be misrouted.
    /// @param _zap The zap to remove.
    function removeZap(address _zap) external onlyOwner {
        _approvedZaps.remove(_zap);
        emit ZapRemoved(_zap);
    }

    // Allow ownership transfer
    function changeOwnership(address newOwner) public onlyOwner {
        transferOwnership(newOwner);
    }

    /// @notice Disables ownership renouncement.
    /// @dev Renouncing would permanently freeze the router allowlist, leaving no way to
    ///   remove a compromised router. Override reverts to keep the owner in control.
    /// @inheritdoc Ownable
    function renounceOwnership() public view override onlyOwner {
        revert RelaySwaps_RenounceDisabled();
    }

    /// @notice Transfers ETH or ERC20 tokens stranded outside an execute() window.
    /// @dev Safe: execute() is atomic and nonReentrant, so rescue cannot interleave with
    ///   a live execute(). Pre-existing balances are excluded from the delta-only sweep,
    ///   making this the only exit path for async bridge refunds and stray transfers.
    ///   Use NATIVE_ASSET as _token to rescue ETH.
    /// @param _token Token to rescue; use NATIVE_ASSET for ETH.
    /// @param _to Recipient address (must not be zero).
    /// @param _amount Amount to transfer.
    function rescue(address _token, address _to, uint256 _amount) external onlyOwner {
        require(_to != address(0));
        if (_token == NATIVE_ASSET) {
            _to.safeTransferETH(_amount);
        } else {
            _token.safeTransfer(_to, _amount);
        }
        emit Rescued(_token, _to, _amount);
    }

    /// @notice Unified withdraw + swap. Pulls tokens via POOL.transact(), forwards to LiFi.
    ///   LiFi calldata handles all post-swap routing (direct to recipient, or deposit via contractCalls).
    ///   Swap calldata is proof-bound — it lives in SwapRouting.swapCalldata, committed via the proof context hash.
    /// @param _proof The transact proof (pubSignals[5][0] = amountOut, [6][0] = tokenIdOut)
    /// @param _transactParams Transact params with processor = address(this), data = abi.encode(SwapRouting)
    /// @param _noteData Per-output discovery data
    function execute(
        ProofLibV2.TransactProof calldata _proof,
        IPool.TransactParams calldata _transactParams,
        IPool.NoteData[] calldata _noteData
    ) external payable {
        _execute(_proof, _transactParams, _noteData, address(0));
    }

    /// @notice execute() for a yield note: the withdrawn PPYieldToken shares are redeemed into
    ///   their underlying through `_zap` (allowlisted, and `_zap.VAULT()` must equal the
    ///   proof's tokenIdOut) right after the pool pays them out, then the underlying is
    ///   swapped exactly as in execute(). The relay fee stays committed in shares (proof-bound,
    ///   capped by Entrypoint.maxRelayFee in shares) and is paid pro-rata in the underlying.
    ///   The unwrap is an explicit caller choice, never inferred from state: de-listing a zap
    ///   makes this revert, it cannot change what an in-flight proof does.
    /// @param _zap The PPYieldTokenZap for the withdrawn share (see approveZap()).
    function executeUnwrapped(
        ProofLibV2.TransactProof calldata _proof,
        IPool.TransactParams calldata _transactParams,
        IPool.NoteData[] calldata _noteData,
        address _zap
    ) external payable {
        require(_zap != address(0), RelaySwaps_InvalidZap());
        _execute(_proof, _transactParams, _noteData, _zap);
    }

    /// @dev Shared body of execute() / executeUnwrapped(). `_zap == address(0)` is the plain path.
    function _execute(
        ProofLibV2.TransactProof calldata _proof,
        IPool.TransactParams calldata _transactParams,
        IPool.NoteData[] calldata _noteData,
        address _zap
    ) internal nonReentrant {
        // 1. Extract withdrawn token and amount from proof pubSignals
        address _token = address(_proof.tokenIdOut());
        uint256 _amount = _proof.amountOut();
        require(_amount > 0, RelaySwaps_ZeroWithdrawal());

        // 2. Decode routing (committed in proof via context hash)
        SwapRouting memory _r = abi.decode(_transactParams.data, (SwapRouting));

        // 3. Validate swap target, approval address, dust recipient (proof-bound)
        require(_r.swapTarget != address(0), RelaySwaps_ZeroSwapTarget());
        require(_r.approvalAddress != address(0), RelaySwaps_ZeroApprovalAddress());
        require(_r.dustRecipient != address(0), RelaySwaps_ZeroDustRecipient());

        // Swap target should be a known router.
        require(
            approvedRouters[ _r.swapTarget ],
            RelaySwaps_InvalidSwapTarget()
        );

        // approvalAddress receives the scoped ERC20 approval (below); pin it to the same
        // vetted allowlist as swapTarget so a subverted quote cannot route the approval to
        // an un-vetted address. The owner approves the Diamond and, for LiFi v4, its separate
        // ERC20Proxy. Enforced for both native and ERC20 paths (native does not approve, but
        // the field is proof-bound, so the check is harmless and keeps the invariant uniform).
        require(
            approvedRouters[ _r.approvalAddress ],
            RelaySwaps_InvalidApprovalAddress()
        );

        // B2: the in-contract gas swap (input token -> native ETH, to fund a bridge
        // msg.value) is only meaningful on the ERC-20 input branch — a native-ETH note
        // already holds ETH, and growing the native branch's forwarded value is a separate
        // follow-up. Reject the combination loudly rather than silently mis-forwarding.
        require(_token != NATIVE_ASSET || _r.swapValue == 0, RelaySwaps_GasSwapNativeInput());

        // 4. Validate native gas funding
        require(msg.value == _r.nativeGas, RelaySwaps_NativeGasMismatch());
        // recipient == 0 means no source-chain recipient (reshield or cross-chain swap):
        // nativeGas has nowhere to go (would fall through to the dust sweep), and
        // minOutputAmount cannot be enforced (no local balance to check) — reject both
        // loudly instead of silently ignoring them.
        require(_r.recipient != address(0) || _r.nativeGas == 0, RelaySwaps_NativeGasWithoutRecipient());
        require(_r.recipient != address(0) || _r.minOutputAmount == 0, RelaySwaps_MinOutputWithoutRecipient());
        // F-960: with a real recipient the balance-delta guard MUST be armed — a quote
        // returning minOutputAmount = 0 disables the guard entirely, allowing the swap
        // calldata to route output to an attacker. Reshield / cross-chain paths carry
        // recipient = address(0), so that path is exempted by the condition above.
        require(_r.recipient == address(0) || _r.minOutputAmount > 0, RelaySwaps_ZeroMinOutputWithRecipient());

        // 5. Validate fee against entrypoint maxRelayFee
        {
            uint256 _maxFee = ENTRYPOINT.assets(_token).maxRelayFee;
            require(_maxFee == 0 || _r.feeAmount <= _maxFee, RelaySwaps_FeeExceedsMax());
        }
        require(_r.feeAmount <= _amount, RelaySwaps_FeeExceedsWithdrawal());
        // Fee actually paid in the token that reaches the swap. Equals feeAmount unless the
        // input is a registered share, in which case step 8b converts it pro-rata.
        uint256 _fee = _r.feeAmount;

        // 6. Snapshot balances before pool withdrawal (for safe dust sweep)
        uint256 _ethBefore = address(this).balance - msg.value;
        uint256 _inputBefore;
        uint256 _outputBefore;
        if (_token != NATIVE_ASSET) {
            _inputBefore = _token.balanceOf(address(this));
        }
        if (_r.outputToken != NATIVE_ASSET && _r.outputToken != _token) {
            _outputBefore = _r.outputToken.balanceOf(address(this));
        }
        // 6b. Yield input (executeUnwrapped): validate the zap against the allowlist and the
        //   proof-bound share, and take the underlying's baseline here — before transact — with
        //   the same delta-only rule as every other token (pre-existing balance is never swept,
        //   only rescue()d). The plain path pays one address compare for the feature.
        uint256 _underlyingBefore;
        if (_zap != address(0)) {
            require(_approvedZaps.contains(_zap), RelaySwaps_InvalidZap());
            require(IYieldZap(_zap).VAULT() == _token, RelaySwaps_ZapShareMismatch());
            _underlyingBefore = IYieldZap(_zap).UNDERLYING().balanceOf(address(this));
        }

        // 7b. Snapshot recipient's output token balance (for minOutputAmount enforcement)
        uint256 _recipientOutputBefore;
        if (_r.recipient != address(0) && _r.minOutputAmount > 0) {
            _recipientOutputBefore = (_r.outputToken == NATIVE_ASSET)
                ? _r.recipient.balance
                : _r.outputToken.balanceOf(_r.recipient);
        }

        // 8. Pull tokens from pool
        POOL.transact(_proof, _transactParams, _noteData);

        // 8b. Yield input: redeem the shares into their underlying before anything else
        //   touches them. From here on `_token`/`_amount`/`_fee` describe the underlying; the
        //   realised redeem output is used (never a preview), so a rate move between quote
        //   and execution either leaves surplus for the delta sweep (rate up) or makes the
        //   proof-bound swap pull exceed the approval and revert (rate down) — no path pays
        //   less than the calldata promised without reverting.
        if (_zap != address(0)) {
            (_token, _amount, _fee) = _unwrap(_zap, _token, _amount, _r.feeAmount);
            _inputBefore = _underlyingBefore;
        }

        // 9. Pay relay fee (in the token that reached the swap; committed in shares for a
        //   yield input, see step 8b — a fee that rounds to 0 underlying is simply skipped)
        if (_fee > 0) {
            require(_r.feeRecipient != address(0), RelaySwaps_ZeroFeeRecipient());
            if (_token == NATIVE_ASSET) {
                _r.feeRecipient.safeTransferETH(_fee);
            } else {
                _token.safeTransfer(_r.feeRecipient, _fee);
            }
        } else if (_r.feeAmount > 0) {
            require(_r.feeRecipient != address(0), RelaySwaps_ZeroFeeRecipient());
        }

        // 9.5. B2 gas swap — mint the bridge's native messaging fee in-contract from a
        //   bounded slice of the withdrawn input token, so the relayer does not have to
        //   front source-chain ETH. gasSwapCalldata is proof-bound (same context hash as
        //   swapCalldata); swapTarget / approvalAddress are the same allowlisted router
        //   validated in step 3. The approval is capped at gasSwapMaxInput. The resulting
        //   ETH lands in address(this).balance; step 10 forwards {value: swapValue} and the
        //   delta-only sweep in step 13 sends any overshoot to dustRecipient.
        //   swapValue == 0 (every non-Mainnet-destination reshield and same-chain swap)
        //   skips this block entirely.
        if (_r.swapValue > 0) {
            // Defense-in-depth: keep the field's own NatSpec claim true on-chain. Does not
            // close RelaySwaps_InputBalanceDeficit by itself — see that error's doc.
            require(_r.gasSwapMaxInput <= _amount - _fee, RelaySwaps_GasSwapMaxInputExceedsWithdrawal());
            uint256 _ethPreGasSwap = address(this).balance;
            _token.safeApprove(_r.approvalAddress, _r.gasSwapMaxInput);
            (bool _gasOk,) = _r.swapTarget.call(_r.gasSwapCalldata);
            require(_gasOk, RelaySwaps_SwapFailed());
            _token.safeApprove(_r.approvalAddress, 0);
            require(
                address(this).balance - _ethPreGasSwap >= _r.swapValue,
                RelaySwaps_GasSwapInsufficient()
            );
        }

        // 10. Execute swap — LiFi handles all post-swap routing
        //   approvalAddress may differ from swapTarget (e.g. LiFi v4 ERC20Proxy).
        uint256 _swapAmount = _amount - _fee;
        if (_token == NATIVE_ASSET) {
            // Forwarding arbitrary calldata to a vetted router is safe by construction:
            // swapTarget AND approvalAddress are allowlisted (approvedRouters), and the full
            // swapCalldata is proof-bound via the transact context hash — the relayer can
            // change neither the target nor the calldata after the user proves. The SDK
            // independently verifies both addresses against approvedRouters before proving
            // (defense in depth). On-chain parsing of aggregator calldata is infeasible for
            // a generic swap and unnecessary given those two guarantees.
            (bool _ok,) = _r.swapTarget.call{value: _swapAmount}(_r.swapCalldata);
            require(_ok, RelaySwaps_SwapFailed());
        } else {
            _token.safeApprove(_r.approvalAddress, _swapAmount);
            // B2: forward the native fee minted by the step-9.5 gas swap. swapValue is 0
            // on every non-Mainnet-destination reshield and same-chain swap, so this is
            // byte-identical to the prior `call(_r.swapCalldata)` there.
            (bool _ok,) = _r.swapTarget.call{value: _r.swapValue}(_r.swapCalldata);
            require(_ok, RelaySwaps_SwapFailed());
            _token.safeApprove(_r.approvalAddress, 0);
        }

        // 10.5. Floor invariant — this call must never leave the contract holding less of
        //   the input token than it held before it started. The B2 gas swap (step 9.5) and
        //   this swap both draw against the whole contract balance, not just this call's own
        //   withdrawal, so bounding gasSwapMaxInput alone would not be sufficient: step 10
        //   above re-approves the full _swapAmount regardless of what step 9.5 already
        //   consumed. This assertion is what actually closes the gap, for either swap step.
        if (_token != NATIVE_ASSET) {
            require(_token.balanceOf(address(this)) >= _inputBefore, RelaySwaps_InputBalanceDeficit());
        }

        // 11. Enforce minOutputAmount via recipient balance delta
        if (_r.recipient != address(0) && _r.minOutputAmount > 0) {
            uint256 _recipientOutputAfter = (_r.outputToken == NATIVE_ASSET)
                ? _r.recipient.balance
                : _r.outputToken.balanceOf(_r.recipient);
            require(
                _recipientOutputAfter - _recipientOutputBefore >= _r.minOutputAmount,
                RelaySwaps_InsufficientOutput()
            );
        }

        // 12. Forward native gas to recipient
        if (_r.nativeGas > 0 && _r.recipient != address(0)) {
            _r.recipient.safeTransferETH(_r.nativeGas);
        }

        // 13. Sweep dust using balance deltas
        _sweepDust(_token, _r.outputToken, _r.dustRecipient, _ethBefore, _inputBefore, _outputBefore);

        emit Executed(_token, _r.outputToken, _swapAmount, _r.feeRecipient, _fee);
    }

    /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Redeems `_shares` of a registered share token into its underlying via the
    ///   wrapper's Zap and converts the share-denominated relay fee pro-rata to the realised
    ///   output (floor, i.e. rounding toward the user). The Zap pulls exactly `_shares`, so the
    ///   approval is fully consumed; a revert anywhere in the redeem path (paused wrapper,
    ///   Aave illiquid / frozen) unwinds the whole execute(), leaving the nullifiers unspent.
    /// @param _zap The allowlisted zap for `_share` (validated in step 6b).
    /// @param _share The share token (proof-bound tokenIdOut).
    /// @param _shares Shares withdrawn from the pool (proof-bound amountOut).
    /// @param _feeShares Relay fee committed in shares (proof-bound SwapRouting.feeAmount).
    /// @return _underlying The underlying token the shares redeemed into.
    /// @return _out Underlying actually received.
    /// @return _feeUnderlying Relay fee to pay in underlying.
    function _unwrap(address _zap, address _share, uint256 _shares, uint256 _feeShares)
        internal
        returns (address _underlying, uint256 _out, uint256 _feeUnderlying)
    {
        _underlying = IYieldZap(_zap).UNDERLYING();
        _share.safeApprove(_zap, _shares);
        _out = IYieldZap(_zap).redeemToUnderlying(_shares, address(this));
        require(_out > 0, RelaySwaps_UnwrapZeroOutput());
        _feeUnderlying = (_out * _feeShares) / _shares;
        emit Unwrapped(_share, _underlying, _shares, _out, _feeUnderlying);
    }

    /// @notice Sweeps dust using balance deltas to avoid draining tokens from parallel executions.
    ///   Only sweeps the difference between current balance and the pre-execution snapshot.
    function _sweepDust(
        address _inputToken,
        address _outputToken,
        address _dustRecipient,
        uint256 _ethBefore,
        uint256 _inputBefore,
        uint256 _outputBefore
    ) internal {
        // Sweep ETH dust (delta only)
        uint256 _ethNow = address(this).balance;
        if (_ethNow > _ethBefore) {
            _dustRecipient.safeTransferETH(_ethNow - _ethBefore);
        }

        // Sweep input token dust (ERC20 only, delta only)
        if (_inputToken != NATIVE_ASSET) {
            uint256 _inputNow = _inputToken.balanceOf(address(this));
            if (_inputNow > _inputBefore) {
                _inputToken.safeTransfer(_dustRecipient, _inputNow - _inputBefore);
            }
        }

        // Sweep output token dust (ERC20 only, skip if same as input — already swept)
        if (_outputToken != NATIVE_ASSET && _outputToken != _inputToken) {
            uint256 _outputNow = _outputToken.balanceOf(address(this));
            if (_outputNow > _outputBefore) {
                _outputToken.safeTransfer(_dustRecipient, _outputNow - _outputBefore);
            }
        }
    }
}
