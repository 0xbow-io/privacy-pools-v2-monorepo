// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';

import {IERC5564Announcer} from 'interfaces/IERC5564Announcer.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {Constants} from 'utils/Constants.sol';

/// @title PrivacyPoolRelay
/// @notice Relays private withdrawals: relayer pays gas; withdrawn funds go to recipient with optional fee routing
contract PrivacyPoolRelay is IPrivacyPoolRelay {
  using ProofLibV2 for ProofLibV2.TransactProof;
  using SafeTransferLib for address;

  /*///////////////////////////////////////////////////////////////
                            CONSTANTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Maximum number of transacts allowed in a single relayBatch call
  /// @dev Kept strictly below the pool's deployed rootHistorySize (16) so every batched transact
  ///   validates against the shared pre-batch root snapshot. Exposed via the MAX_BATCH() getter
  ///   rather than a public constant to avoid a solc constant-getter member-access compiler bug.
  uint256 internal constant _MAX_BATCH = 10;

  /*///////////////////////////////////////////////////////////////
                            IMMUTABLES
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPrivacyPoolRelay
  IPoolVault public immutable POOL;

  /// @inheritdoc IPrivacyPoolRelay
  IEntrypoint public immutable ENTRYPOINT;

  /// @inheritdoc IPrivacyPoolRelay
  IERC5564Announcer public immutable ANNOUNCER;

  /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  /// @notice Initializes the PrivacyPoolRelay contract with immutable references
  /// @param _pool Address of the pool vault contract
  /// @param _entrypoint Address of the entrypoint contract for asset config
  /// @param _announcer Address of the canonical ERC-5564 Announcer used by relayAndAnnounce
  constructor(IPoolVault _pool, IEntrypoint _entrypoint, IERC5564Announcer _announcer) {
    require(address(_pool) != address(0), PrivacyPoolRelay_ZeroPool());
    require(address(_entrypoint) != address(0), PrivacyPoolRelay_ZeroEntrypoint());
    require(address(_announcer) != address(0), PrivacyPoolRelay_ZeroAnnouncer());
    // Enforce the batch/root-history coupling at deploy time: every batched transact anchors to the
    // shared pre-batch state root, so the pool's root buffer must hold strictly more than a full batch
    // or later items would evict that snapshot and revert. Cheap one-time guard against a misconfigured pool.
    require(_MAX_BATCH < _pool.rootHistorySize(), PrivacyPoolRelay_RootHistoryTooSmall());
    POOL = _pool;
    ENTRYPOINT = _entrypoint;
    ANNOUNCER = _announcer;
  }

  /// @notice Allows the contract to receive ETH from the pool vault on withdrawal
  receive() external payable {
    require(msg.sender == address(POOL), PrivacyPoolRelay_OnlyPoolCanSendETH());
  }

  /*///////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPrivacyPoolRelay
  function relay(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData
  ) external payable {
    _relay(_proof, _transactParams, _noteData);
  }

  /// @inheritdoc IPrivacyPoolRelay
  function registerAndRelay(
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _deadline,
    bytes calldata _signature,
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData
  ) external payable {
    // Step 1: register the account in the keystore the pool will verify against, UNLESS it is already
    // registered with the exact requested nullifying key. Resolving the keystore off the pool (rather
    // than caching it) guarantees registration targets the exact tree `transact` reads. The skip makes
    // the atomic bundle robust to front-running: an attacker who submits the account's OWN signed
    // registration directly would otherwise force this bundle to revert `Keystore_AuthPolicyAlreadySet`
    // for zero gain — instead it degrades to a plain relay. Safe because (a) the sig only authorizes the
    // registration, which is now already done with the intended key, and (b) the withdrawal is gated by
    // the proof, whose predicted post-registration keystore root equals the actual root in this case. A
    // mismatched existing key still reverts (the `setAuthPolicyWithSig` one-time guard fires).
    IKeystore _keystore = POOL.keystore();
    if (_keystore.nullifyingKeys(_account) != _nullifyingKeyHash) {
      _keystore.setAuthPolicyWithSig({
        _account: _account,
        _authDigest: _authDigest,
        _nullifyingKeyHash: _nullifyingKeyHash,
        _deadline: _deadline,
        _signature: _signature
      });
    }
    // Step 2: relay the withdrawal whose proof anchors to the post-registration keystore root.
    _relay(_proof, _transactParams, _noteData);
  }

  /// @inheritdoc IPrivacyPoolRelay
  function relayAndAnnounce(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData,
    Announcement calldata _announcement
  ) external payable {
    // Bind the announced stealth address to THIS withdrawal: it must equal the payout recipient the
    // proof context commits to (decoded from the same PayoutRouting `_relay` uses), so the announcement
    // cannot name an address this withdrawal never funds — the on-chain half of STLTH-18. Only the
    // address is enforced; the other announcement fields are forwarded as-is (a wrong ephemeral key only
    // breaks off-chain discovery of a correctly-funded payment and is recoverable by re-announcing).
    PayoutRouting memory _payout = abi.decode(_transactParams.data, (PayoutRouting));
    require(_announcement.stealthAddress == _payout.recipient, PrivacyPoolRelay_AnnouncementRecipientMismatch());

    // Relay first (funds land at the stealth address), then announce. The external announce call is the
    // LAST action and this contract holds no persistent state, so there is no reentrancy surface (CEI).
    _relay(_proof, _transactParams, _noteData);
    ANNOUNCER.announce({
      _schemeId: _announcement.schemeId,
      _stealthAddress: _announcement.stealthAddress,
      _ephemeralPubKey: _announcement.ephemeralPubKey,
      _metadata: _announcement.metadata
    });
  }

  /// @inheritdoc IPrivacyPoolRelay
  function relayBatch(
    ProofLibV2.TransactProof[] calldata _proofs,
    IPoolVault.TransactParams[] calldata _transactParams,
    IPoolVault.NoteData[][] calldata _noteData
  ) external payable {
    uint256 _count = _proofs.length;
    require(_count != 0, PrivacyPoolRelay_EmptyBatch());
    require(_count <= _MAX_BATCH, PrivacyPoolRelay_BatchTooLarge());
    require(_transactParams.length == _count && _noteData.length == _count, PrivacyPoolRelay_BatchLengthMismatch());

    // The first item fixes the shared asset, recipient, and fee recipient for the whole batch
    address _asset = _proofs[0].tokenIdOut();
    uint256 _maxRelayFee = ENTRYPOINT.assets(_asset).maxRelayFee;
    PayoutRouting memory _ref = abi.decode(_transactParams[0].data, (PayoutRouting));
    // Every item shares _ref.recipient (enforced below), so one check covers the batch. Mirrors _relay.
    require(_ref.recipient != address(0), PrivacyPoolRelay_ZeroRecipient());

    uint256 _totalAmountOut;
    uint256 _totalFee;
    uint256 _totalNativeGas;

    for (uint256 _i; _i < _count; ++_i) {
      uint256 _amountOut = _proofs[_i].amountOut();
      require(_amountOut > 0, PrivacyPoolRelay_ZeroWithdrawal());
      require(_proofs[_i].tokenIdOut() == _asset, PrivacyPoolRelay_InconsistentAsset());

      // Reuse the already-decoded _ref for item 0 (avoids a redundant abi.decode of the same calldata)
      PayoutRouting memory _payout = _i == 0 ? _ref : abi.decode(_transactParams[_i].data, (PayoutRouting));
      require(
        _payout.recipient == _ref.recipient && _payout.feeRecipient == _ref.feeRecipient,
        PrivacyPoolRelay_InconsistentRecipient()
      );
      // `maxRelayFee == 0` means "no cap" per IEntrypoint (nominal amount, 0 = no maximum) — matches
      // RelaySwaps/MockPool/SDK; without the sentinel a 0-config would revert every nonzero relay fee.
      require(_maxRelayFee == 0 || _payout.feeAmount <= _maxRelayFee, PrivacyPoolRelay_FeeExceedsMax());
      require(_amountOut >= _payout.feeAmount, PrivacyPoolRelay_FeeExceedsWithdrawal());

      _totalAmountOut += _amountOut;
      _totalFee += _payout.feeAmount;
      _totalNativeGas += _payout.nativeGas;

      POOL.transact(_proofs[_i], _transactParams[_i], _noteData[_i]);
    }

    require(msg.value == _totalNativeGas, PrivacyPoolRelay_NativeGasMismatch());

    address _feeRecipient = _ref.feeRecipient != address(0) ? _ref.feeRecipient : msg.sender;
    uint256 _recipientAmount = _totalAmountOut - _totalFee;

    _distribute({
      _asset: _asset,
      _recipient: _ref.recipient,
      _recipientAmount: _recipientAmount,
      _feeRecipient: _feeRecipient,
      _feeAmount: _totalFee,
      _gasFunding: msg.value
    });

    emit RelayedBatch({
      _asset: _asset,
      _recipient: _ref.recipient,
      _recipientAmount: _recipientAmount,
      _feeRecipient: _feeRecipient,
      _fee: _totalFee,
      _gasFunding: msg.value,
      _count: _count
    });
  }

  /*///////////////////////////////////////////////////////////////
                      EXTERNAL VIEW FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPrivacyPoolRelay
  function MAX_BATCH() external pure returns (uint256 _maxBatch) {
    _maxBatch = _MAX_BATCH;
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Shared relay logic: relayer pays gas, pool transacts, funds routed to recipient and optional fee
  /// @param _proof The Groth16 proof with public signals (uses amountOut and tokenIdOut)
  /// @param _transactParams Transact params; `.data` must ABI-encode `PayoutRouting`
  /// @param _noteData Per-output discovery data (hint + encrypted payload)
  function _relay(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData
  ) internal {
    uint256 _withdrawnValue = _proof.amountOut();
    require(_withdrawnValue > 0, PrivacyPoolRelay_ZeroWithdrawal());

    PayoutRouting memory _payout = abi.decode(_transactParams.data, (PayoutRouting));
    require(_payout.recipient != address(0), PrivacyPoolRelay_ZeroRecipient());
    require(msg.value == _payout.nativeGas, PrivacyPoolRelay_NativeGasMismatch());

    address _asset = _proof.tokenIdOut();

    uint256 _maxRelayFee = ENTRYPOINT.assets(_asset).maxRelayFee;
    // `maxRelayFee == 0` means "no cap" per IEntrypoint (0 = no maximum) — matches RelaySwaps/MockPool/SDK.
    require(_maxRelayFee == 0 || _payout.feeAmount <= _maxRelayFee, PrivacyPoolRelay_FeeExceedsMax());
    require(_withdrawnValue >= _payout.feeAmount, PrivacyPoolRelay_FeeExceedsWithdrawal());

    address _feeRecipient = _payout.feeRecipient != address(0) ? _payout.feeRecipient : msg.sender;
    uint256 _recipientAmount = _withdrawnValue - _payout.feeAmount;

    POOL.transact(_proof, _transactParams, _noteData);

    _distribute({
      _asset: _asset,
      _recipient: _payout.recipient,
      _recipientAmount: _recipientAmount,
      _feeRecipient: _feeRecipient,
      _feeAmount: _payout.feeAmount,
      _gasFunding: msg.value
    });

    emit Relayed({
      _asset: _asset,
      _recipient: _payout.recipient,
      _recipientAmount: _recipientAmount,
      _feeRecipient: _feeRecipient,
      _fee: _payout.feeAmount,
      _gasFunding: msg.value
    });
  }

  /// @notice Distributes withdrawn funds to the recipient and fee recipient
  /// @dev For the native asset, gas funding is added to the recipient transfer. For ERC-20, any gas
  ///   funding is forwarded to the recipient as ETH after the token transfers.
  /// @param _asset The withdrawn asset (or NATIVE_ASSET for ETH)
  /// @param _recipient Address to receive the net amount
  /// @param _recipientAmount Net amount to send to the recipient
  /// @param _feeRecipient Address to receive the fee (already resolved from zero to msg.sender)
  /// @param _feeAmount Fee amount to send to the fee recipient
  /// @param _gasFunding Native ETH attached by the relayer, forwarded to the recipient
  function _distribute(
    address _asset,
    address _recipient,
    uint256 _recipientAmount,
    address _feeRecipient,
    uint256 _feeAmount,
    uint256 _gasFunding
  ) internal {
    if (_asset == Constants.NATIVE_ASSET) {
      _recipient.safeTransferETH(_recipientAmount + _gasFunding);
      if (_feeAmount != 0) {
        _feeRecipient.safeTransferETH(_feeAmount);
      }
    } else {
      _asset.safeTransfer(_recipient, _recipientAmount);
      if (_feeAmount != 0) {
        _asset.safeTransfer(_feeRecipient, _feeAmount);
      }
      if (_gasFunding > 0) {
        _recipient.safeTransferETH(_gasFunding);
      }
    }
  }
}
