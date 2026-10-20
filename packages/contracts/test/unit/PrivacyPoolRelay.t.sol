// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import {PrivacyPoolRelay} from 'contracts/PrivacyPoolRelay.sol';
import {IERC5564Announcer} from 'interfaces/IERC5564Announcer.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';
import {TransactProofParams, buildMockTransactProof} from 'test/unit/helpers/ProofUtils.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';
import {Constants} from 'utils/Constants.sol';

contract UnitPrivacyPoolRelay is TestUtils {
  PrivacyPoolRelay internal _relay;

  uint256 internal constant DEFAULT_MAX_RELAY_FEE = 1 ether;
  enum FailureType {
    REVERT,
    RETURN_FALSE
  }

  IPoolVault.NoteData[] internal _defaultNoteData;

  /// @dev Mock ERC-5564 Announcer address passed to the constructor (non-zero satisfies the guard).
  address internal _announcer = makeAddr('announcer');

  function setUp() external {
    // Constructor asserts _MAX_BATCH (10) < POOL.rootHistorySize(); mock a valid size (16, the deploy default).
    vm.mockCall(mockPoolVault, abi.encodeWithSignature('rootHistorySize()'), abi.encode(uint32(16)));
    _relay = new PrivacyPoolRelay(IPoolVault(mockPoolVault), IEntrypoint(mockEntrypoint), IERC5564Announcer(_announcer));
    _defaultNoteData.push(IPoolVault.NoteData({hint: keccak256('hint 0'), data: abi.encode(keccak256('note 0'))}));
    _defaultNoteData.push(IPoolVault.NoteData({hint: keccak256('hint 1'), data: abi.encode(keccak256('note 1'))}));
  }

  /// @dev Mocks asset config - only maxRelayFee is used by relay, other fields are arbitrary
  function _mockExpectAssetConfig(address _asset, uint256 _maxRelayFee) internal {
    IEntrypoint.AssetConfig memory _config = IEntrypoint.AssetConfig({
      enabled: true, // unused by relay
      minAmount: 0, // unused by relay
      vettingFeeBPS: 0, // unused by relay
      maxRelayFee: _maxRelayFee
    });
    _mockAndExpect(mockEntrypoint, abi.encodeCall(IEntrypoint.assets, (_asset)), abi.encode(_config));
  }

  /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

  function test_Constructor_WhenPoolIsAddressZero() external {
    // It should revert with PrivacyPoolRelay_ZeroPool
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_ZeroPool.selector);
    new PrivacyPoolRelay(IPoolVault(address(0)), IEntrypoint(mockEntrypoint), IERC5564Announcer(_announcer));
  }

  function test_Constructor_WhenEntrypointIsAddressZero() external {
    // It should revert with PrivacyPoolRelay_ZeroEntrypoint
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_ZeroEntrypoint.selector);
    new PrivacyPoolRelay(IPoolVault(mockPoolVault), IEntrypoint(address(0)), IERC5564Announcer(_announcer));
  }

  function test_Constructor_WhenAnnouncerIsAddressZero() external {
    // It should revert with PrivacyPoolRelay_ZeroAnnouncer
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_ZeroAnnouncer.selector);
    new PrivacyPoolRelay(IPoolVault(mockPoolVault), IEntrypoint(mockEntrypoint), IERC5564Announcer(address(0)));
  }

  function test_Constructor_WhenParamsAreValid(address _pool, address _entrypoint, address _newAnnouncer) external {
    _pool = address(uint160(bound(uint160(_pool), 1, type(uint160).max)));
    _entrypoint = address(uint160(bound(uint160(_entrypoint), 1, type(uint160).max)));
    _newAnnouncer = address(uint160(bound(uint160(_newAnnouncer), 1, type(uint160).max)));
    // The constructor now calls _pool.rootHistorySize(); exclude the cheatcode/precompile ranges so the
    // mock (not the VM dispatcher) answers.
    assumeNotPrecompile(_pool);
    assumeNotForgeAddress(_pool);
    vm.mockCall(_pool, abi.encodeWithSignature('rootHistorySize()'), abi.encode(uint32(16)));

    // It should set POOL immutable
    // It should set ENTRYPOINT immutable
    // It should set ANNOUNCER immutable
    PrivacyPoolRelay _newRelay =
      new PrivacyPoolRelay(IPoolVault(_pool), IEntrypoint(_entrypoint), IERC5564Announcer(_newAnnouncer));
    assertEq(address(_newRelay.POOL()), _pool);
    assertEq(address(_newRelay.ENTRYPOINT()), _entrypoint);
    assertEq(address(_newRelay.ANNOUNCER()), _newAnnouncer);
  }

  function test_Constructor_WhenRootHistoryNotAboveMaxBatch(uint32 _size) external {
    // rootHistorySize <= _MAX_BATCH (10) must revert: a full batch would evict the shared pre-batch root
    _size = uint32(bound(_size, 0, _relay.MAX_BATCH()));
    vm.mockCall(mockPoolVault, abi.encodeWithSignature('rootHistorySize()'), abi.encode(_size));
    // It should revert with PrivacyPoolRelay_RootHistoryTooSmall
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_RootHistoryTooSmall.selector);
    new PrivacyPoolRelay(IPoolVault(mockPoolVault), IEntrypoint(mockEntrypoint), IERC5564Announcer(_announcer));
  }

  /*///////////////////////////////////////////////////////////////
                            HELPERS
  //////////////////////////////////////////////////////////////*/

  struct RelayTransactParams {
    bool useRelayAsProcessor;
    address recipient;
    address feeRecipient;
    uint256 feeAmount;
    uint128 gasFunding;
  }

  function _buildRelayTransactParams(RelayTransactParams memory _relayParams)
    internal
    view
    returns (IPoolVault.TransactParams memory params_)
  {
    // A zero recipient is now rejected by PrivacyPoolRelay_ZeroRecipient. In the fuzz tests below the
    // recipient is a don't-care value, so coerce it to a valid non-zero address here. `_relayParams` is
    // a memory struct passed by reference, so this also fixes the caller's copy used in expectEmit.
    // The dedicated zero-recipient revert is covered by test_Relay_WhenRecipientIsZero (builds params inline).
    if (_relayParams.recipient == address(0)) _relayParams.recipient = address(0xBEEF);
    IPrivacyPoolRelay.PayoutRouting memory _payout = IPrivacyPoolRelay.PayoutRouting({
      recipient: _relayParams.recipient,
      feeRecipient: _relayParams.feeRecipient,
      feeAmount: _relayParams.feeAmount,
      nativeGas: _relayParams.gasFunding
    });
    address _processor = _relayParams.useRelayAsProcessor ? address(_relay) : address(0);
    params_ = IPoolVault.TransactParams({processor: _processor, data: abi.encode(_payout)});
  }

  /*///////////////////////////////////////////////////////////////
                            TESTS
  //////////////////////////////////////////////////////////////*/

  function test_Relay_WhenWithdrawnValueIsZero(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external {
    _relayParams.gasFunding = 0;
    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);

    // Withdrawn value is zero
    _fuzz.amountOut = 0;

    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should revert with PrivacyPoolRelay_ZeroWithdrawal
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_ZeroWithdrawal.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  function test_Relay_WhenRecipientIsZero(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external {
    // amountOut > 0 so the ZeroWithdrawal guard passes and execution reaches the ZeroRecipient guard.
    _fuzz.amountOut = bound(_fuzz.amountOut, 1, type(uint128).max);
    _relayParams.recipient = address(0); // build params inline (bypass the helper's non-zero coercion)
    IPrivacyPoolRelay.PayoutRouting memory _payout = IPrivacyPoolRelay.PayoutRouting({
      recipient: address(0),
      feeRecipient: _relayParams.feeRecipient,
      feeAmount: _relayParams.feeAmount,
      nativeGas: _relayParams.gasFunding
    });
    IPoolVault.TransactParams memory _params =
      IPoolVault.TransactParams({processor: address(_relay), data: abi.encode(_payout)});
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should revert with PrivacyPoolRelay_ZeroRecipient
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_ZeroRecipient.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  function test_Relay_WhenMsgValueDoesNotMatchNativeGas(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller,
    uint128 _msgValue
  ) external {
    _fuzz.amountOut = bound(_fuzz.amountOut, 1, type(uint128).max);
    vm.assume(_msgValue != _relayParams.gasFunding);

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    vm.deal(_caller, _msgValue);
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_NativeGasMismatch.selector);
    vm.prank(_caller);
    _relay.relay{value: _msgValue}(_proof, _params, _defaultNoteData);
  }

  function test_Relay_WhenFeeExceedsMaxRelayFee(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller,
    uint256 _maxRelayFee
  ) external {
    _relayParams.gasFunding = 0;
    // Ensure amountOut > 0 to pass the zero withdrawal check first
    _fuzz.amountOut = bound(_fuzz.amountOut, 1, type(uint128).max);
    // Max relay fee is less than fee amount. Bound the cap from 1 (a REAL cap): `maxRelayFee == 0` means
    // "no cap" (uncapped) — a 0 cap no longer reverts on a nonzero fee, so it must be excluded here.
    // The uncapped-with-0 path is covered by test_Relay_WhenMaxRelayFeeIsZeroUncapped.
    _maxRelayFee = bound(_maxRelayFee, 1, type(uint128).max - 1);
    _relayParams.feeAmount = bound(_relayParams.feeAmount, _maxRelayFee + 1, type(uint128).max);

    // Mock asset config with maxRelayFee
    _mockExpectAssetConfig(address(uint160(_fuzz.tokenIdOut)), _maxRelayFee);

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);

    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should revert with PrivacyPoolRelay_FeeExceedsMax
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_FeeExceedsMax.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  function test_Relay_WhenMaxRelayFeeIsZeroUncapped(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external assumeValidETHRecipient(_relayParams.recipient) assumeValidETHRecipient(_caller) {
    _relayParams.gasFunding = 0;
    // `maxRelayFee == 0` means "no cap" per IEntrypoint: a NONZERO fee must be ACCEPTED (not reverted with
    // PrivacyPoolRelay_FeeExceedsMax). Use a nonzero fee and amountOut > fee so the FeeExceedsWithdrawal
    // check also passes and the relay proceeds to the payout.
    _relayParams.feeAmount = bound(_relayParams.feeAmount, 1, type(uint128).max - 1);
    _fuzz.amountOut = bound(_fuzz.amountOut, _relayParams.feeAmount + 1, type(uint128).max);
    // feeRecipient zero defaults to msg.sender (_caller) so the fee is easy to assert on the caller balance.
    _relayParams.feeRecipient = address(0);
    // Keep recipient and caller distinct so their balance deltas don't overlap.
    vm.assume(_relayParams.recipient != _caller);

    uint256 _recipientAmount = _fuzz.amountOut - _relayParams.feeAmount;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    _fuzz.tokenIdOut = uint256(uint160(Constants.NATIVE_ASSET));

    // Uncapped: maxRelayFee == 0
    _mockExpectAssetConfig(Constants.NATIVE_ASSET, 0);

    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact (the relay proceeds; the nonzero fee is NOT rejected)
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    vm.deal(address(_relay), _fuzz.amountOut);

    uint256 _callerBalanceBefore = _caller.balance;
    uint256 _recipientBalanceBefore = _relayParams.recipient.balance;

    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);

    // It should pay the nonzero fee (to msg.sender) and the remainder to the recipient — proving the 0 cap
    // did not revert with PrivacyPoolRelay_FeeExceedsMax.
    assertEq(_caller.balance, _callerBalanceBefore + _relayParams.feeAmount);
    assertEq(_relayParams.recipient.balance, _recipientBalanceBefore + _recipientAmount);
  }

  function test_Relay_WhenFeeExceedsWithdrawnValue(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external {
    _relayParams.gasFunding = 0;
    // Ensure amountOut > 0 to pass the zero withdrawal check first
    _fuzz.amountOut = bound(_fuzz.amountOut, 1, type(uint128).max - 1);
    // Fee fee > amountOut
    _relayParams.feeAmount = bound(_relayParams.feeAmount, _fuzz.amountOut + 1, type(uint128).max);

    // Mock asset config with maxRelayFee high enough to pass that check
    _mockExpectAssetConfig(address(uint160(_fuzz.tokenIdOut)), _relayParams.feeAmount + 1);

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should revert with PrivacyPoolRelay_FeeExceedsWithdrawal
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_FeeExceedsWithdrawal.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  modifier assumeValidETHRecipient(address _recipient) {
    assumePayable(_recipient);
    assumeNotPrecompile(_recipient);
    vm.assume(_recipient != address(_relay));
    vm.assume(_recipient != Constants.NATIVE_ASSET);
    _;
  }

  function test_Relay_WhenFeeRecipientIsAddressZero(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external assumeValidETHRecipient(_relayParams.recipient) assumeValidETHRecipient(_caller) {
    _relayParams.gasFunding = 0;
    // Ensure fee > 0
    _relayParams.feeAmount = bound(_relayParams.feeAmount, 1, DEFAULT_MAX_RELAY_FEE);
    // Ensure amountOut >= feeAmount
    _fuzz.amountOut = bound(_fuzz.amountOut, _relayParams.feeAmount, type(uint128).max);
    // feeRecipient is address(0) - should default to msg.sender
    _relayParams.feeRecipient = address(0);
    // Ensure recipient is not the caller to avoid balance overlap
    vm.assume(_relayParams.recipient != _caller);

    uint256 _recipientAmount = _fuzz.amountOut - _relayParams.feeAmount;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    _fuzz.tokenIdOut = uint256(uint160(Constants.NATIVE_ASSET));

    // Mock asset config
    _mockExpectAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);

    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    vm.deal(address(_relay), _fuzz.amountOut);

    uint256 _callerBalanceBefore = _caller.balance;
    uint256 _recipientBalanceBefore = _relayParams.recipient.balance;

    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);

    // It should use msg sender as fee recipient
    assertEq(_caller.balance, _callerBalanceBefore + _relayParams.feeAmount);
    assertEq(_relayParams.recipient.balance, _recipientBalanceBefore + _recipientAmount);
  }

  /*///////////////////////////////////////////////////////////////
                        WHEN ASSET IS NATIVE
  //////////////////////////////////////////////////////////////*/

  modifier whenAssetIsNative(TransactProofParams memory _fuzz) {
    _fuzz.amountOut = bound(_fuzz.amountOut, 1, type(uint128).max);
    _fuzz.tokenIdOut = uint256(uint160(Constants.NATIVE_ASSET));
    _mockExpectAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);
    _;
  }

  function test_Relay_WhenETHTransferToRecipientFails(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external whenAssetIsNative(_fuzz) {
    _relayParams.gasFunding = 0;
    // Ensure feeAmount is valid
    _relayParams.feeAmount = bound(_relayParams.feeAmount, 0, DEFAULT_MAX_RELAY_FEE);
    // Ensure recipientAmount > 0 so that the transfer to recipient actually happens
    _fuzz.amountOut = bound(_fuzz.amountOut, _relayParams.feeAmount + 1, type(uint128).max);

    // Use a contract that rejects ETH as recipient
    address _rejecter = makeAddr('rejecter');
    vm.mockCallRevert(_rejecter, bytes(''), abi.encode('REJECTED'));
    _relayParams.recipient = _rejecter;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    vm.deal(address(_relay), _fuzz.amountOut);

    // It should revert with SafeTransferLib.ETHTransferFailed
    vm.expectRevert(SafeTransferLib.ETHTransferFailed.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  modifier whenFeeIsNotZero(TransactProofParams memory _fuzz, RelayTransactParams memory _relayParams) {
    // Fee is not zero
    _relayParams.feeAmount = bound(_relayParams.feeAmount, 1, DEFAULT_MAX_RELAY_FEE);
    // Ensure amountOut >= feeAmount
    _fuzz.amountOut = bound(_fuzz.amountOut, _relayParams.feeAmount, type(uint128).max);
    _;
  }

  function test_Relay_WhenETHFeeTransferFails(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external whenAssetIsNative(_fuzz) whenFeeIsNotZero(_fuzz, _relayParams) {
    _relayParams.gasFunding = 0;
    // Use known addresses: recipient accepts ETH, feeRecipient rejects ETH
    _relayParams.recipient = makeAddr('recipient');
    address _feeRejecter = makeAddr('feeRejecter');
    vm.mockCallRevert(_feeRejecter, bytes(''), abi.encode('REJECTED'));
    _relayParams.feeRecipient = _feeRejecter;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    vm.deal(address(_relay), _fuzz.amountOut);

    // It should revert with SafeTransferLib.ETHTransferFailed
    vm.expectRevert(SafeTransferLib.ETHTransferFailed.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  function test_Relay_WhenETHFeeTransferSucceeds(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  )
    external
    whenAssetIsNative(_fuzz)
    whenFeeIsNotZero(_fuzz, _relayParams)
    assumeValidETHRecipient(_relayParams.recipient)
  {
    // Mimic contract logic: feeRecipient defaults to msg.sender if zero
    address _actualFeeRecipient = _relayParams.feeRecipient != address(0) ? _relayParams.feeRecipient : _caller;
    // Ensure actual fee recipient can receive ETH
    assumePayable(_actualFeeRecipient);
    // Ensure fee recipient is not the relay (would mess up balance tracking)
    vm.assume(_actualFeeRecipient != address(_relay));
    // Ensure recipient and feeRecipient are distinct so balances don't overlap
    vm.assume(_relayParams.recipient != _actualFeeRecipient);
    vm.assume(_caller != _relayParams.recipient);
    vm.assume(_caller != _actualFeeRecipient);
    vm.assume(_caller != address(_relay));

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    vm.deal(address(_relay), _fuzz.amountOut);
    vm.deal(_caller, _relayParams.gasFunding);

    // It should emit Relayed event
    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(
      Constants.NATIVE_ASSET,
      _relayParams.recipient,
      _fuzz.amountOut - _relayParams.feeAmount,
      _actualFeeRecipient,
      _relayParams.feeAmount,
      _relayParams.gasFunding
    );

    uint256 _recipientBalanceBefore = _relayParams.recipient.balance;
    uint256 _feeRecipientBalanceBefore = _actualFeeRecipient.balance;

    vm.prank(_caller);
    _relay.relay{value: _relayParams.gasFunding}(_proof, _params, _defaultNoteData);

    // It should transfer recipient amount plus msg value to recipient
    assertEq(
      _relayParams.recipient.balance,
      _recipientBalanceBefore + _fuzz.amountOut - _relayParams.feeAmount + _relayParams.gasFunding
    );
    // It should transfer fee to fee recipient
    assertEq(_actualFeeRecipient.balance, _feeRecipientBalanceBefore + _relayParams.feeAmount);
  }

  function test_Relay_WhenFeeIsZero(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external whenAssetIsNative(_fuzz) assumeValidETHRecipient(_relayParams.recipient) {
    // Fee is zero
    _relayParams.feeAmount = 0;
    vm.assume(_caller != _relayParams.recipient);
    vm.assume(_caller != address(_relay));

    // Use a fee recipient that rejects ETH - this catches the `if (_feeAmount != 0)` => `if (true)` mutation
    // If the contract tries to send any ETH to the fee recipient, the test will fail
    address _feeRejecter = makeAddr('feeRejecter');
    vm.mockCallRevert(_feeRejecter, bytes(''), abi.encode('REJECTED'));
    _relayParams.feeRecipient = _feeRejecter;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    vm.deal(address(_relay), _fuzz.amountOut);
    vm.deal(_caller, _relayParams.gasFunding);

    uint256 _recipientBalanceBefore = _relayParams.recipient.balance;

    // It should emit Relayed event (fee is 0, feeRecipient is _feeRejecter)
    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(
      Constants.NATIVE_ASSET, _relayParams.recipient, _fuzz.amountOut, _feeRejecter, 0, _relayParams.gasFunding
    );

    vm.prank(_caller);
    _relay.relay{value: _relayParams.gasFunding}(_proof, _params, _defaultNoteData);

    // It should transfer full amount plus msg value to recipient
    assertEq(_relayParams.recipient.balance, _recipientBalanceBefore + _fuzz.amountOut + _relayParams.gasFunding);
    // It should not call fee transfer (if it did, the mockCallRevert would cause a revert)
  }

  /*///////////////////////////////////////////////////////////////
                        WHEN ASSET IS ERC20
  //////////////////////////////////////////////////////////////*/

  modifier whenAssetIsERC20(TransactProofParams memory _fuzz, RelayTransactParams memory _relayParams) {
    address _asset = address(uint160(_fuzz.tokenIdOut));
    vm.assume(_asset != Constants.NATIVE_ASSET);
    assumeNotPrecompile(_asset);
    assumeNotForgeAddress(_asset);
    // Recipient is a don't-care here; coerce a fuzzed zero to non-zero before later modifiers/body read it
    // (PrivacyPoolRelay_ZeroRecipient now rejects zero). Memory-by-reference propagates to the caller.
    if (_relayParams.recipient == address(0)) _relayParams.recipient = address(0xBEEF);
    _mockExpectAssetConfig(_asset, DEFAULT_MAX_RELAY_FEE);
    _relayParams.feeAmount = bound(_relayParams.feeAmount, 0, DEFAULT_MAX_RELAY_FEE);
    _fuzz.amountOut = bound(_fuzz.amountOut, _relayParams.feeAmount + 1, type(uint128).max);
    _;
  }

  modifier whenERC20TransferToRecipientFails(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    FailureType _failureType
  ) {
    uint256 _recipientAmount = _fuzz.amountOut - _relayParams.feeAmount;
    if (_failureType == FailureType.REVERT) {
      // Mock principal transfer reverts
      _mockAndExpectRevert(
        address(uint160(_fuzz.tokenIdOut)),
        abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _recipientAmount)),
        abi.encode('REVERT')
      );
    } else if (_failureType == FailureType.RETURN_FALSE) {
      // Mock principal transfer returns false
      _mockAndExpect(
        address(uint160(_fuzz.tokenIdOut)),
        abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _recipientAmount)),
        abi.encode(false)
      );
    } else {
      revert('I miss rust\'s match statement');
    }
    _;
  }

  function test_Relay_WhenReturningFalse(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  )
    external
    whenAssetIsERC20(_fuzz, _relayParams)
    whenERC20TransferToRecipientFails(_fuzz, _relayParams, FailureType.RETURN_FALSE)
  {
    _relayParams.gasFunding = 0;
    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );

    // It should revert with SafeTransferLib TransferFailed
    vm.expectRevert(SafeTransferLib.TransferFailed.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  function test_Relay_WhenReverting(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  )
    external
    whenAssetIsERC20(_fuzz, _relayParams)
    whenERC20TransferToRecipientFails(_fuzz, _relayParams, FailureType.REVERT)
  {
    _relayParams.gasFunding = 0;
    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );

    // It should revert with SafeTransferLib TransferFailed
    vm.expectRevert(SafeTransferLib.TransferFailed.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  modifier whenERC20FeeTransferFails(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    FailureType _failureType
  ) {
    if (_failureType == FailureType.REVERT) {
      // Mock fee transfer reverts
      _mockAndExpectRevert(
        address(uint160(_fuzz.tokenIdOut)),
        abi.encodeCall(IERC20.transfer, (_relayParams.feeRecipient, _relayParams.feeAmount)),
        abi.encode('REVERT')
      );
    } else if (_failureType == FailureType.RETURN_FALSE) {
      // Mock fee transfer returns false
      _mockAndExpect(
        address(uint160(_fuzz.tokenIdOut)),
        abi.encodeCall(IERC20.transfer, (_relayParams.feeRecipient, _relayParams.feeAmount)),
        abi.encode(false)
      );
    } else {
      revert('I miss rust\'s match statement');
    }
    _;
  }

  function test_Relay_WhenReturningFalse_WhenERC20FeeTransferFails(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  )
    external
    whenAssetIsERC20(_fuzz, _relayParams)
    whenFeeIsNotZero(_fuzz, _relayParams)
    whenERC20FeeTransferFails(_fuzz, _relayParams, FailureType.RETURN_FALSE)
  {
    _relayParams.gasFunding = 0;
    vm.assume(_relayParams.feeRecipient != address(0));
    vm.assume(_relayParams.recipient != _relayParams.feeRecipient);

    address _asset = address(uint160(_fuzz.tokenIdOut));
    uint256 _recipientAmount = _fuzz.amountOut - _relayParams.feeAmount;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );

    // Mock recipient transfer succeeds
    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _recipientAmount)), abi.encode(true)
    );

    // It should revert with SafeTransferLib TransferFailed
    vm.expectRevert(SafeTransferLib.TransferFailed.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  function test_Relay_WhenReverting_WhenERC20FeeTransferFails(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  )
    external
    whenAssetIsERC20(_fuzz, _relayParams)
    whenFeeIsNotZero(_fuzz, _relayParams)
    whenERC20FeeTransferFails(_fuzz, _relayParams, FailureType.REVERT)
  {
    _relayParams.gasFunding = 0;
    vm.assume(_relayParams.feeRecipient != address(0));
    vm.assume(_relayParams.recipient != _relayParams.feeRecipient);

    address _asset = address(uint160(_fuzz.tokenIdOut));
    uint256 _recipientAmount = _fuzz.amountOut - _relayParams.feeAmount;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );

    // Mock recipient transfer succeeds
    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _recipientAmount)), abi.encode(true)
    );

    // It should revert with SafeTransferLib TransferFailed
    vm.expectRevert(SafeTransferLib.TransferFailed.selector);
    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  modifier whenERC20TransfersSucceed() {
    // Tree branch marker — ERC20 transfer mocks configured as successful in each test body
    _;
  }

  function test_Relay_WhenMsgValueIsZero(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external whenAssetIsERC20(_fuzz, _relayParams) whenFeeIsNotZero(_fuzz, _relayParams) whenERC20TransfersSucceed {
    _relayParams.gasFunding = 0;
    // Mimic contract logic: feeRecipient defaults to msg.sender if zero
    address _actualFeeRecipient = _relayParams.feeRecipient != address(0) ? _relayParams.feeRecipient : _caller;
    address _asset = address(uint160(_fuzz.tokenIdOut));
    uint256 _recipientAmount = _fuzz.amountOut - _relayParams.feeAmount;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );

    // It should transfer recipient amount to recipient
    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _recipientAmount)), abi.encode(true)
    );

    // It should transfer fee to fee recipient
    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transfer, (_actualFeeRecipient, _relayParams.feeAmount)), abi.encode(true)
    );

    // It should emit Relayed event
    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(
      _asset, _relayParams.recipient, _recipientAmount, _actualFeeRecipient, _relayParams.feeAmount, 0
    );

    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
  }

  modifier whenMsgValueIsGreaterThanZero(RelayTransactParams memory _relayParams) {
    _relayParams.gasFunding = uint128(bound(_relayParams.gasFunding, 1, type(uint128).max));
    _;
  }

  function test_Relay_WhenETHMsgValueTransferToRecipientSucceeds(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  )
    external
    whenAssetIsERC20(_fuzz, _relayParams)
    whenFeeIsNotZero(_fuzz, _relayParams)
    whenERC20TransfersSucceed
    whenMsgValueIsGreaterThanZero(_relayParams)
  {
    assumePayable(_relayParams.recipient);
    assumeNotPrecompile(_relayParams.recipient);
    vm.assume(_relayParams.recipient != address(_relay));
    vm.assume(_relayParams.recipient != Constants.NATIVE_ASSET);

    address _asset = address(uint160(_fuzz.tokenIdOut));
    address _actualFeeRecipient = _relayParams.feeRecipient != address(0) ? _relayParams.feeRecipient : _caller;
    uint256 _recipientAmount = _fuzz.amountOut - _relayParams.feeAmount;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    // It should transfer recipient amount to recipient
    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _recipientAmount)), abi.encode(true)
    );
    // It should transfer fee to fee recipient
    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transfer, (_actualFeeRecipient, _relayParams.feeAmount)), abi.encode(true)
    );

    // It should emit Relayed event
    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(
      _asset,
      _relayParams.recipient,
      _recipientAmount,
      _actualFeeRecipient,
      _relayParams.feeAmount,
      _relayParams.gasFunding
    );

    uint256 _recipientBalanceBefore = _relayParams.recipient.balance;

    vm.deal(_caller, _relayParams.gasFunding);
    vm.prank(_caller);
    _relay.relay{value: _relayParams.gasFunding}(_proof, _params, _defaultNoteData);

    // It should transfer msg value to recipient
    assertEq(_relayParams.recipient.balance, _recipientBalanceBefore + _relayParams.gasFunding);
  }

  function test_Relay_WhenETHMsgValueTransferToRecipientFails(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  )
    external
    whenAssetIsERC20(_fuzz, _relayParams)
    whenFeeIsNotZero(_fuzz, _relayParams)
    whenERC20TransfersSucceed
    whenMsgValueIsGreaterThanZero(_relayParams)
  {
    _relayParams.recipient = makeAddr('ethRejecter');
    vm.mockCallRevert(_relayParams.recipient, bytes(''), abi.encode('REJECTED'));

    address _asset = address(uint160(_fuzz.tokenIdOut));
    address _actualFeeRecipient = _relayParams.feeRecipient != address(0) ? _relayParams.feeRecipient : _caller;
    uint256 _recipientAmount = _fuzz.amountOut - _relayParams.feeAmount;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _recipientAmount)), abi.encode(true)
    );
    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transfer, (_actualFeeRecipient, _relayParams.feeAmount)), abi.encode(true)
    );

    // It should revert with ETHTransferFailed
    vm.expectRevert(SafeTransferLib.ETHTransferFailed.selector);
    vm.deal(_caller, _relayParams.gasFunding);
    vm.prank(_caller);
    _relay.relay{value: _relayParams.gasFunding}(_proof, _params, _defaultNoteData);
  }

  modifier whenFeeIsZero(RelayTransactParams memory _relayParams) {
    _relayParams.feeAmount = 0;
    _;
  }

  function test_Relay_WhenMsgValueIsZero_WhenFeeIsZero(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external whenAssetIsERC20(_fuzz, _relayParams) whenFeeIsZero(_relayParams) {
    _relayParams.gasFunding = 0;
    address _asset = address(uint160(_fuzz.tokenIdOut));
    address _actualFeeRecipient = _relayParams.feeRecipient != address(0) ? _relayParams.feeRecipient : _caller;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    // It should transfer full amount to recipient
    _mockAndExpect(_asset, abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _fuzz.amountOut)), abi.encode(true));
    // This catches the `if (_feeAmount != 0)` => `if (true)` mutation
    vm.mockCallRevert(_asset, abi.encodeWithSelector(IERC20.transfer.selector), abi.encode('SHOULD_NOT_CALL'));

    // It should emit Relayed event (fee is 0)
    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(_asset, _relayParams.recipient, _fuzz.amountOut, _actualFeeRecipient, 0, 0);

    vm.prank(_caller);
    _relay.relay(_proof, _params, _defaultNoteData);
    // It should not call fee transfer (if it did, the mockCallRevert would cause a revert)
  }

  function test_Relay_WhenETHMsgValueTransferToRecipientSucceeds_WhenMsgValueIsGreaterThanZero(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  )
    external
    whenAssetIsERC20(_fuzz, _relayParams)
    whenFeeIsZero(_relayParams)
    whenMsgValueIsGreaterThanZero(_relayParams)
  {
    assumePayable(_relayParams.recipient);
    assumeNotPrecompile(_relayParams.recipient);
    vm.assume(_relayParams.recipient != address(_relay));
    vm.assume(_relayParams.recipient != Constants.NATIVE_ASSET);

    address _asset = address(uint160(_fuzz.tokenIdOut));
    address _actualFeeRecipient = _relayParams.feeRecipient != address(0) ? _relayParams.feeRecipient : _caller;

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    // It should transfer full amount to recipient
    _mockAndExpect(_asset, abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _fuzz.amountOut)), abi.encode(true));
    vm.mockCallRevert(_asset, abi.encodeWithSelector(IERC20.transfer.selector), abi.encode('SHOULD_NOT_CALL'));

    // It should emit Relayed event
    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(
      _asset, _relayParams.recipient, _fuzz.amountOut, _actualFeeRecipient, 0, _relayParams.gasFunding
    );

    uint256 _recipientBalanceBefore = _relayParams.recipient.balance;

    vm.deal(_caller, _relayParams.gasFunding);
    vm.prank(_caller);
    _relay.relay{value: _relayParams.gasFunding}(_proof, _params, _defaultNoteData);

    // It should transfer msg value to recipient
    assertEq(_relayParams.recipient.balance, _recipientBalanceBefore + _relayParams.gasFunding);
  }

  function test_Relay_WhenETHMsgValueTransferToRecipientFails_WhenMsgValueIsGreaterThanZero(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  )
    external
    whenAssetIsERC20(_fuzz, _relayParams)
    whenFeeIsZero(_relayParams)
    whenMsgValueIsGreaterThanZero(_relayParams)
  {
    _relayParams.recipient = makeAddr('ethRejecter');
    vm.mockCallRevert(_relayParams.recipient, bytes(''), abi.encode('REJECTED'));

    address _asset = address(uint160(_fuzz.tokenIdOut));

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    _mockAndExpect(_asset, abi.encodeCall(IERC20.transfer, (_relayParams.recipient, _fuzz.amountOut)), abi.encode(true));

    // It should revert with ETHTransferFailed
    vm.expectRevert(SafeTransferLib.ETHTransferFailed.selector);
    vm.deal(_caller, _relayParams.gasFunding);
    vm.prank(_caller);
    _relay.relay{value: _relayParams.gasFunding}(_proof, _params, _defaultNoteData);
  }

  /*///////////////////////////////////////////////////////////////
                          registerAndRelay
  //////////////////////////////////////////////////////////////*/

  function test_RegisterAndRelay_WhenTheKeystoreRegistrationReverts(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller,
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _deadline,
    bytes memory _signature
  ) external {
    _fuzz.amountOut = bound(_fuzz.amountOut, 1, type(uint128).max);
    _relayParams.gasFunding = 0;
    // A real registration always uses a non-zero nullifying key hash; keep it out of the idempotent
    // skip's equality with the mocked not-registered (0) sentinel.
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, type(uint256).max);
    address _keystore = makeAddr('keystore');

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // The relay resolves the keystore off the pool, then registration reverts
    _mockAndExpect(mockPoolVault, abi.encodeCall(IPoolVault.keystore, ()), abi.encode(_keystore));
    // registerAndRelay reads nullifyingKeys first (idempotent skip); 0 => not yet registered.
    vm.mockCall(_keystore, abi.encodeCall(IKeystore.nullifyingKeys, (_account)), abi.encode(uint256(0)));
    _mockAndExpectRevert(
      _keystore,
      abi.encodeCall(
        IKeystore.setAuthPolicyWithSig, (_account, _authDigest, _nullifyingKeyHash, _deadline, _signature)
      ),
      abi.encodeWithSelector(IKeystore.Keystore_InvalidSignature.selector)
    );

    // It should bubble up the revert and not relay (pool transact must never be called)
    vm.mockCallRevert(
      mockPoolVault, abi.encodeWithSelector(IPoolVault.transact.selector), abi.encode('SHOULD_NOT_RELAY')
    );

    vm.expectRevert(IKeystore.Keystore_InvalidSignature.selector);
    vm.prank(_caller);
    _relay.registerAndRelay(
      _account, _authDigest, _nullifyingKeyHash, _deadline, _signature, _proof, _params, _defaultNoteData
    );
  }

  function test_RegisterAndRelay_WhenRegistrationSucceeds(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller,
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _deadline,
    bytes memory _signature
  ) external whenAssetIsNative(_fuzz) assumeValidETHRecipient(_relayParams.recipient) {
    _relayParams.feeAmount = 0;
    _relayParams.gasFunding = 0;
    vm.assume(_caller != _relayParams.recipient);
    vm.assume(_caller != address(_relay));
    // A real registration always uses a non-zero nullifying key hash; keep it out of the idempotent
    // skip's equality with the mocked not-registered (0) sentinel.
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, type(uint256).max);
    address _keystore = makeAddr('keystore');

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should resolve the keystore off the pool, then register the account
    _mockAndExpect(mockPoolVault, abi.encodeCall(IPoolVault.keystore, ()), abi.encode(_keystore));
    // registerAndRelay reads nullifyingKeys first (idempotent skip); 0 => not yet registered.
    vm.mockCall(_keystore, abi.encodeCall(IKeystore.nullifyingKeys, (_account)), abi.encode(uint256(0)));
    _mockAndExpect(
      _keystore,
      abi.encodeCall(
        IKeystore.setAuthPolicyWithSig, (_account, _authDigest, _nullifyingKeyHash, _deadline, _signature)
      ),
      abi.encode()
    );
    // It should register the account before calling pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    vm.deal(address(_relay), _fuzz.amountOut);

    uint256 _recipientBalanceBefore = _relayParams.recipient.balance;

    vm.prank(_caller);
    _relay.registerAndRelay(
      _account, _authDigest, _nullifyingKeyHash, _deadline, _signature, _proof, _params, _defaultNoteData
    );

    // It should relay the withdrawal to the recipient
    assertEq(_relayParams.recipient.balance, _recipientBalanceBefore + _fuzz.amountOut);
  }

  /*///////////////////////////////////////////////////////////////
                          relayAndAnnounce
  //////////////////////////////////////////////////////////////*/

  /// @dev Sample ERC-5564 announcement fields (scheme 1 = SECP256k1, view-tag metadata).
  uint256 internal constant SCHEME_ID = 1;
  bytes internal constant EPHEMERAL_PUB_KEY = hex'0271c1e4b3a0f6e2d5c8b9a7f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4';
  bytes internal constant ANNOUNCE_METADATA = hex'aa';

  function test_RelayAndAnnounce_WhenParamsAreValid(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller
  ) external whenAssetIsNative(_fuzz) assumeValidETHRecipient(_relayParams.recipient) {
    // Full withdrawal to a stealth address (no fee, no gas funding) — keeps the payout math simple so the
    // test focuses on the relay+announce binding, not the fund-splitting already covered by relay tests.
    _relayParams.feeAmount = 0;
    _relayParams.gasFunding = 0;
    // feeRecipient zero -> defaults to msg.sender in the Relayed event (fee is 0, so nothing is sent there).
    _relayParams.feeRecipient = address(0);
    vm.assume(_caller != _relayParams.recipient);
    vm.assume(_caller != address(_relay));

    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    // The announced stealth address is bound to equal the payout recipient decoded from the params.
    address _stealth = _relayParams.recipient;
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should call pool transact
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _defaultNoteData)), abi.encode()
    );
    // The announcer's announce returns nothing; mock so the external call succeeds
    vm.mockCall(_announcer, abi.encodeWithSelector(IERC5564Announcer.announce.selector), abi.encode());
    vm.deal(address(_relay), _fuzz.amountOut);

    // It should call ANNOUNCER.announce with the exact announcement args
    vm.expectCall(
      _announcer,
      abi.encodeCall(IERC5564Announcer.announce, (SCHEME_ID, _stealth, EPHEMERAL_PUB_KEY, ANNOUNCE_METADATA))
    );

    // It should emit Relayed event (fee is 0, full amount to the stealth recipient)
    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(Constants.NATIVE_ASSET, _stealth, _fuzz.amountOut, _caller, 0, 0);

    uint256 _recipientBalanceBefore = _stealth.balance;

    vm.prank(_caller);
    _relay.relayAndAnnounce(
      _proof,
      _params,
      _defaultNoteData,
      IPrivacyPoolRelay.Announcement({
        schemeId: SCHEME_ID, stealthAddress: _stealth, ephemeralPubKey: EPHEMERAL_PUB_KEY, metadata: ANNOUNCE_METADATA
      })
    );

    // It should relay the withdrawal to the stealth recipient
    assertEq(_stealth.balance, _recipientBalanceBefore + _fuzz.amountOut);
  }

  function test_RelayAndAnnounce_WhenStealthAddressDoesNotMatchRecipient(
    TransactProofParams memory _fuzz,
    RelayTransactParams memory _relayParams,
    address _caller,
    address _stealth
  ) external {
    _fuzz.amountOut = bound(_fuzz.amountOut, 1, type(uint128).max);
    IPoolVault.TransactParams memory _params = _buildRelayTransactParams(_relayParams);
    // Announced stealth address differs from the PayoutRouting recipient the proof context commits to.
    vm.assume(_stealth != _relayParams.recipient);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);

    // It should NOT call pool transact (mismatch reverts before relaying)
    vm.mockCallRevert(
      mockPoolVault, abi.encodeWithSelector(IPoolVault.transact.selector), abi.encode('SHOULD_NOT_RELAY')
    );
    // It should NOT call the announcer
    vm.expectCall(_announcer, abi.encodeWithSelector(IERC5564Announcer.announce.selector), 0);

    // It should revert with PrivacyPoolRelay_AnnouncementRecipientMismatch
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_AnnouncementRecipientMismatch.selector);
    vm.prank(_caller);
    _relay.relayAndAnnounce(
      _proof,
      _params,
      _defaultNoteData,
      IPrivacyPoolRelay.Announcement({
        schemeId: SCHEME_ID, stealthAddress: _stealth, ephemeralPubKey: EPHEMERAL_PUB_KEY, metadata: ANNOUNCE_METADATA
      })
    );
  }

  /*///////////////////////////////////////////////////////////////
                              RECEIVE
  ///////////////////////////////////////////////////////////////*/

  function test_Receive_WhenSenderIsNotPool(address _sender, uint256 _amount) external {
    vm.assume(_sender != mockPoolVault);
    _amount = bound(_amount, 1, type(uint256).max);
    vm.deal(_sender, _amount);

    vm.prank(_sender);
    (bool _ok, bytes memory _ret) = address(_relay).call{value: _amount}('');
    assertFalse(_ok);
    assertEq(_ret, abi.encodeWithSelector(IPrivacyPoolRelay.PrivacyPoolRelay_OnlyPoolCanSendETH.selector));
  }

  function test_Receive_WhenSenderIsPool(uint256 _amount) external {
    _amount = bound(_amount, 1, type(uint256).max);
    vm.deal(mockPoolVault, _amount);

    uint256 _balanceBefore = address(_relay).balance;

    vm.prank(mockPoolVault);
    (bool _ok,) = address(_relay).call{value: _amount}('');
    assertTrue(_ok, 'ETH transfer from pool should succeed');
    assertEq(address(_relay).balance, _balanceBefore + _amount);
  }
}
