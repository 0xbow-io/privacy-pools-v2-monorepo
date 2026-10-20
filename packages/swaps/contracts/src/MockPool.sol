// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// @title MockPool
/// @notice Simplified pool for swap testing. Collapses Entrypoint + PoolVault + Relay into one contract.
///   Verifies deposit proofs via real Groth16 verifier but skips merkle trees, ASP, and keystore.
///   ABI-compatible with the real Entrypoint.deposit() and PrivacyPoolRelay.relay() so SDK interactors work.
contract MockPool {
    using SafeTransferLib for address;

    /*///////////////////////////////////////////////////////////////
                              STRUCTS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Groth16 proof for deposit circuit (matches ProofLibV2.DepositProof)
    struct DepositProof {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[4] pubSignals;
    }

    /// @notice Groth16 proof for transact circuit (matches ProofLibV2.TransactProof)
    struct TransactProof {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[][] pubSignals;
    }

    /// @notice Transact parameters (matches IPoolVault.TransactParams)
    struct TransactParams {
        address processor;
        bytes data;
    }

    /// @notice Discovery data for an output note (matches IPoolVault.NoteData)
    struct NoteData {
        bytes32 hint;
        bytes data;
    }

    /// @notice Routing of withdrawn amount (matches IPrivacyPoolRelay.PayoutRouting)
    struct PayoutRouting {
        address recipient;
        address feeRecipient;
        uint256 feeAmount;
        uint256 nativeGas;
    }

    /// @notice Per-asset config (matches IEntrypoint.AssetConfig)
    struct AssetConfig {
        bool enabled;
        uint256 minAmount;
        uint256 vettingFeeBPS;
        uint256 maxRelayFee;
    }

    /*///////////////////////////////////////////////////////////////
                              EVENTS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Emitted on successful deposit
    event Deposited(address indexed _asset, address indexed _depositor, uint256 _value);

    /// @notice Emitted on successful relay (matches IPrivacyPoolRelay.Relayed)
    event Relayed(
        address indexed _asset,
        address indexed _recipient,
        uint256 _recipientAmount,
        address indexed _feeRecipient,
        uint256 _fee,
        uint256 _gasFunding
    );

    /// @notice Emitted on successful transact (processor pattern)
    event Transacted(address indexed _asset, address indexed _processor, uint256 _value);

    /// @notice Emitted when a relayer approval changes
    event RelayerSet(address indexed _relayer, bool _approved);

    /// @notice Emitted when deposit verifier is updated
    event DepositVerifierSet(address indexed _previous, address indexed _current);

    /// @notice Emitted when an asset config is updated
    event AssetConfigSet(address indexed _asset, bool _enabled, uint256 _minAmount, uint256 _vettingFeeBPS, uint256 _maxRelayFee);

    /*///////////////////////////////////////////////////////////////
                              ERRORS
    ///////////////////////////////////////////////////////////////*/

    error MockPool_OnlyOwner();
    error MockPool_NotApprovedRelayer();
    error MockPool_ZeroWithdrawal();
    error MockPool_FeeExceedsWithdrawal();
    error MockPool_NativeGasMismatch();
    error MockPool_InsufficientBalance();
    error MockPool_NativeTransferFailed();
    error MockPool_InvalidDepositProof();
    error MockPool_NoDepositVerifier();
    error MockPool_InvalidDepositValue();
    error MockPool_AssetNotEnabled();
    error MockPool_BelowMinAmount();
    error MockPool_AboveMaxAmount();
    error MockPool_ExceedsMaxRelayFee();
    error MockPool_InvalidProcessor();

    /*///////////////////////////////////////////////////////////////
                          CONSTANTS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Native ETH sentinel (same as Constants.NATIVE_ASSET)
    address public constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /*///////////////////////////////////////////////////////////////
                          STATE VARIABLES
    ///////////////////////////////////////////////////////////////*/

    /// @notice Contract owner (can set relayers and verifier)
    address public owner;

    /// @notice Groth16 verifier for deposit proofs
    address public depositVerifier;

    /// @notice Approved relayer addresses
    mapping(address _relayer => bool _approved) public approvedRelayers;

    /// @notice Per-asset configuration (matches Entrypoint.assets())
    mapping(address _asset => AssetConfig _config) public assets;

    /// @notice Per-asset max amount (not part of assets() ABI, mock-only)
    mapping(address _asset => uint256 _maxAmount) public maxAmounts;

    /*///////////////////////////////////////////////////////////////
                            MODIFIERS
    ///////////////////////////////////////////////////////////////*/

    modifier onlyOwner() {
        require(msg.sender == owner, MockPool_OnlyOwner());
        _;
    }

    modifier onlyApprovedRelayer() {
        require(approvedRelayers[msg.sender], MockPool_NotApprovedRelayer());
        _;
    }

    /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
    ///////////////////////////////////////////////////////////////*/

    /// @notice Sets deployer as owner
    constructor() {
        owner = msg.sender;
    }

    /// @notice Allows contract to receive ETH
    receive() external payable {}

    /*///////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Deposit funds with Groth16 proof verification
    /// @dev ABI-compatible with Entrypoint.deposit(). Verifies proof, receives funds, ignores noteData/aspCiphertext.
    /// @param _proof The deposit proof (pubSignals: [commitment, tokenId, value, context])
    /// @param _noteData Discovery data (ignored by mock)
    /// @param _aspCiphertext ASP ciphertext (ignored by mock)
    function deposit(
        DepositProof calldata _proof,
        NoteData calldata _noteData,
        bytes calldata _aspCiphertext
    ) external payable {
        // Silence unused param warnings
        _noteData;
        _aspCiphertext;

        // Verify proof
        require(depositVerifier != address(0), MockPool_NoDepositVerifier());

        (bool _success, bytes memory _result) = depositVerifier.staticcall(
            abi.encodeWithSignature(
                "verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[4])",
                _proof.pA,
                _proof.pB,
                _proof.pC,
                _proof.pubSignals
            )
        );
        require(_success && abi.decode(_result, (bool)), MockPool_InvalidDepositProof());

        // Extract asset and value from pubSignals
        address _asset = address(uint160(_proof.pubSignals[1]));
        uint256 _value = _proof.pubSignals[2];
        require(_value > 0, MockPool_InvalidDepositValue());

        // Check asset config
        AssetConfig memory _assetConfig = assets[_asset];
        require(_assetConfig.enabled, MockPool_AssetNotEnabled());
        require(_value >= _assetConfig.minAmount, MockPool_BelowMinAmount());
        uint256 _maxAmount = maxAmounts[_asset];
        require(_maxAmount == 0 || _value <= _maxAmount, MockPool_AboveMaxAmount());

        // Receive funds (value + vetting fee, matching real Entrypoint behavior)
        uint256 _fee = (_value * _assetConfig.vettingFeeBPS) / 10000;
        uint256 _amountPlusFees = _value + _fee;
        if (_asset == NATIVE_ASSET) {
            require(msg.value == _amountPlusFees, MockPool_InvalidDepositValue());
        } else {
            _asset.safeTransferFrom(msg.sender, address(this), _amountPlusFees);
        }

        emit Deposited({_asset: _asset, _depositor: msg.sender, _value: _value});
    }

    /// @notice Relay a withdrawal with fee splitting
    /// @dev ABI-compatible with PrivacyPoolRelay.relay(). Decodes PayoutRouting from transactParams.data.
    ///   Skips transact proof verification (no state/keystore/ASP trees).
    /// @param _proof The transact proof (used to extract amountOut and tokenIdOut)
    /// @param _transactParams Transact params; .data must ABI-encode PayoutRouting
    /// @param _noteData Per-output discovery data (ignored by mock)
    function relay(
        TransactProof calldata _proof,
        TransactParams calldata _transactParams,
        NoteData[] calldata _noteData
    ) external payable onlyApprovedRelayer {
        _noteData;

        // Extract amountOut and tokenIdOut from pubSignals
        // pubSignals layout: [0]=nullifiers, [1]=commitments, [2]=[stateRoot],
        //   [3]=[keystoreRoot], [4]=[aspRoot], [5]=[amountOut], [6]=[tokenIdOut], [7]=[context]
        uint256 _withdrawnValue = _proof.pubSignals[5][0];
        require(_withdrawnValue > 0, MockPool_ZeroWithdrawal());

        address _asset = address(uint160(_proof.pubSignals[6][0]));

        // Check asset config
        AssetConfig memory _assetConfig = assets[_asset];
        require(_assetConfig.enabled, MockPool_AssetNotEnabled());
        require(_withdrawnValue >= _assetConfig.minAmount, MockPool_BelowMinAmount());
        uint256 _maxAmount = maxAmounts[_asset];
        require(_maxAmount == 0 || _withdrawnValue <= _maxAmount, MockPool_AboveMaxAmount());

        PayoutRouting memory _payout = abi.decode(_transactParams.data, (PayoutRouting));
        require(msg.value == _payout.nativeGas, MockPool_NativeGasMismatch());
        require(_withdrawnValue >= _payout.feeAmount, MockPool_FeeExceedsWithdrawal());
        require(_assetConfig.maxRelayFee == 0 || _payout.feeAmount <= _assetConfig.maxRelayFee, MockPool_ExceedsMaxRelayFee());

        address _feeRecipient = _payout.feeRecipient != address(0) ? _payout.feeRecipient : msg.sender;
        uint256 _recipientAmount = _withdrawnValue - _payout.feeAmount;

        // Distribute funds
        if (_asset == NATIVE_ASSET) {
            _payout.recipient.safeTransferETH(_recipientAmount + msg.value);
            if (_payout.feeAmount != 0) {
                _feeRecipient.safeTransferETH(_payout.feeAmount);
            }
        } else {
            _asset.safeTransfer(_payout.recipient, _recipientAmount);
            if (_payout.feeAmount != 0) {
                _asset.safeTransfer(_feeRecipient, _payout.feeAmount);
            }
            if (msg.value > 0) {
                _payout.recipient.safeTransferETH(msg.value);
            }
        }

        emit Relayed({
            _asset: _asset,
            _recipient: _payout.recipient,
            _recipientAmount: _recipientAmount,
            _feeRecipient: _feeRecipient,
            _fee: _payout.feeAmount,
            _gasFunding: msg.value
        });
    }

    /// @notice Process a withdrawal as an authorized processor (mimics PoolVault.transact())
    /// @dev Validates processor == msg.sender, transfers amountOut to msg.sender. No relay fee logic —
    ///   the processor handles distribution. Skips ZK proof verification (same as relay()).
    /// @param _proof The transact proof (pubSignals[5][0] = amountOut, [6][0] = tokenIdOut)
    /// @param _transactParams Transact params; processor must equal msg.sender
    /// @param _noteData Per-output discovery data (ignored by mock)
    function transact(
        TransactProof calldata _proof,
        TransactParams calldata _transactParams,
        NoteData[] calldata _noteData
    ) external {
        _noteData;

        // Processor validation (mimics PoolVault line 143)
        require(_transactParams.processor == msg.sender, MockPool_InvalidProcessor());

        // Extract amountOut and tokenIdOut from pubSignals
        uint256 _withdrawnValue = _proof.pubSignals[5][0];
        require(_withdrawnValue > 0, MockPool_ZeroWithdrawal());

        address _asset = address(uint160(_proof.pubSignals[6][0]));

        // Asset config checks
        AssetConfig memory _assetConfig = assets[_asset];
        require(_assetConfig.enabled, MockPool_AssetNotEnabled());
        require(_withdrawnValue >= _assetConfig.minAmount, MockPool_BelowMinAmount());
        uint256 _maxAmount = maxAmounts[_asset];
        require(_maxAmount == 0 || _withdrawnValue <= _maxAmount, MockPool_AboveMaxAmount());

        // Transfer to processor (msg.sender) — mimics PoolVault._transferAsset
        if (_asset == NATIVE_ASSET) {
            msg.sender.safeTransferETH(_withdrawnValue);
        } else {
            _asset.safeTransfer(msg.sender, _withdrawnValue);
        }

        emit Transacted({_asset: _asset, _processor: msg.sender, _value: _withdrawnValue});
    }

    /// @notice Set relayer approval
    /// @param _relayer Address to approve or revoke
    /// @param _approved Whether the relayer is approved
    function setRelayer(address _relayer, bool _approved) external onlyOwner {
        approvedRelayers[_relayer] = _approved;
        emit RelayerSet({_relayer: _relayer, _approved: _approved});
    }

    /// @notice Set asset config (matches Entrypoint.setAssetConfig pattern)
    /// @param _asset Token address (use NATIVE_ASSET for ETH)
    /// @param _enabled Whether deposits/withdrawals are allowed
    /// @param _minAmount Minimum amount per tx (0 = no minimum)
    /// @param _vettingFeeBPS Vetting fee in basis points (not enforced by mock, exposed for ABI compat)
    /// @param _maxRelayFee Maximum relay fee (0 = no maximum)
    /// @param _maxAmount Maximum deposit/withdrawal amount (0 = no maximum, not part of assets() ABI)
    function setAssetConfig(
        address _asset,
        bool _enabled,
        uint256 _minAmount,
        uint256 _vettingFeeBPS,
        uint256 _maxRelayFee,
        uint256 _maxAmount
    ) external onlyOwner {
        assets[_asset] = AssetConfig({enabled: _enabled, minAmount: _minAmount, vettingFeeBPS: _vettingFeeBPS, maxRelayFee: _maxRelayFee});
        maxAmounts[_asset] = _maxAmount;
        emit AssetConfigSet({_asset: _asset, _enabled: _enabled, _minAmount: _minAmount, _vettingFeeBPS: _vettingFeeBPS, _maxRelayFee: _maxRelayFee});
    }

    /// @notice Set the deposit proof verifier
    /// @param _verifier Address of the deployed Groth16 verifier contract
    function setDepositVerifier(address _verifier) external onlyOwner {
        address _previous = depositVerifier;
        depositVerifier = _verifier;
        emit DepositVerifierSet({_previous: _previous, _current: _verifier});
    }
}
