// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import {PrivacyPoolRelay} from 'contracts/PrivacyPoolRelay.sol';
import {IERC5564Announcer} from 'interfaces/IERC5564Announcer.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {TransactProofParams, buildMockTransactProof} from 'test/unit/helpers/ProofUtils.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';
import {Constants} from 'utils/Constants.sol';

contract UnitPrivacyPoolRelayBatch is TestUtils {
  PrivacyPoolRelay internal _relay;

  uint256 internal constant DEFAULT_MAX_RELAY_FEE = 1 ether;

  address internal _recipient = makeAddr('recipient');
  address internal _feeRecipient = makeAddr('feeRecipient');
  address internal _caller = makeAddr('relayer');
  address internal _erc20 = makeAddr('token');

  IPoolVault.NoteData[] internal _defaultNoteData;

  function setUp() external {
    // Constructor asserts _MAX_BATCH (10) < POOL.rootHistorySize(); mock a valid size (16, the deploy default).
    vm.mockCall(mockPoolVault, abi.encodeWithSignature('rootHistorySize()'), abi.encode(uint32(16)));
    _relay = new PrivacyPoolRelay(
      IPoolVault(mockPoolVault), IEntrypoint(mockEntrypoint), IERC5564Announcer(makeAddr('announcer'))
    );
    _defaultNoteData.push(IPoolVault.NoteData({hint: keccak256('hint 0'), data: abi.encode(keccak256('note 0'))}));
    _defaultNoteData.push(IPoolVault.NoteData({hint: keccak256('hint 1'), data: abi.encode(keccak256('note 1'))}));
  }

  /*///////////////////////////////////////////////////////////////
                              HELPERS
  //////////////////////////////////////////////////////////////*/

  struct ItemSpec {
    uint256 salt; // makes each mock proof distinct
    address asset;
    address recipient;
    address feeRecipient;
    uint256 amountOut;
    uint256 feeAmount;
    uint128 nativeGas;
  }

  /// @dev Mocks asset config - only maxRelayFee is read by relayBatch
  function _mockAssetConfig(address _asset, uint256 _maxRelayFee) internal {
    IEntrypoint.AssetConfig memory _config =
      IEntrypoint.AssetConfig({enabled: true, minAmount: 0, vettingFeeBPS: 0, maxRelayFee: _maxRelayFee});
    _mockAndExpect(mockEntrypoint, abi.encodeCall(IEntrypoint.assets, (_asset)), abi.encode(_config));
  }

  function _buildItem(ItemSpec memory _spec)
    internal
    view
    returns (ProofLibV2.TransactProof memory _proof, IPoolVault.TransactParams memory _params)
  {
    IPrivacyPoolRelay.PayoutRouting memory _payout = IPrivacyPoolRelay.PayoutRouting({
      recipient: _spec.recipient,
      feeRecipient: _spec.feeRecipient,
      feeAmount: _spec.feeAmount,
      nativeGas: _spec.nativeGas
    });
    _params = IPoolVault.TransactParams({processor: address(_relay), data: abi.encode(_payout)});

    TransactProofParams memory _fuzz;
    _fuzz.amountOut = _spec.amountOut;
    _fuzz.tokenIdOut = uint256(uint160(_spec.asset));
    // Distinct nullifier per item so each mock proof (and the transact mock) is unique
    _fuzz.nullifierHashesLength = 1;
    _fuzz.nullifierHashes[0] = _spec.salt + 1;

    _proof = buildMockTransactProof(_fuzz, _params, _defaultNoteData);
  }

  /// @dev Builds n consistent items (same asset/recipient/feeRecipient) and optionally mocks each transact call
  function _buildBatch(
    uint256 _n,
    address _asset,
    address _rcpt,
    address _feeRcpt,
    uint256[] memory _amounts,
    uint256[] memory _fees,
    uint128[] memory _gas,
    bool _mockTransacts
  )
    internal
    returns (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    )
  {
    _proofs = new ProofLibV2.TransactProof[](_n);
    _params = new IPoolVault.TransactParams[](_n);
    _noteData = new IPoolVault.NoteData[][](_n);
    for (uint256 _i; _i < _n; ++_i) {
      (ProofLibV2.TransactProof memory _proof, IPoolVault.TransactParams memory _param) = _buildItem(
        ItemSpec({
          salt: _i,
          asset: _asset,
          recipient: _rcpt,
          feeRecipient: _feeRcpt,
          amountOut: _amounts[_i],
          feeAmount: _fees[_i],
          nativeGas: _gas[_i]
        })
      );
      _proofs[_i] = _proof;
      _params[_i] = _param;
      _noteData[_i] = _defaultNoteData;
      if (_mockTransacts) {
        _mockAndExpect(
          mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proofs[_i], _params[_i], _noteData[_i])), abi.encode()
        );
      }
    }
  }

  function _u(uint256 _a, uint256 _b, uint256 _c) internal pure returns (uint256[] memory _arr) {
    _arr = new uint256[](3);
    _arr[0] = _a;
    _arr[1] = _b;
    _arr[2] = _c;
  }

  function _g(uint128 _a, uint128 _b, uint128 _c) internal pure returns (uint128[] memory _arr) {
    _arr = new uint128[](3);
    _arr[0] = _a;
    _arr[1] = _b;
    _arr[2] = _c;
  }

  /*///////////////////////////////////////////////////////////////
                          VALIDATION REVERTS
  //////////////////////////////////////////////////////////////*/

  function test_RelayBatch_WhenBatchIsEmpty() external {
    ProofLibV2.TransactProof[] memory _proofs = new ProofLibV2.TransactProof[](0);
    IPoolVault.TransactParams[] memory _params = new IPoolVault.TransactParams[](0);
    IPoolVault.NoteData[][] memory _noteData = new IPoolVault.NoteData[][](0);

    // It should revert with PrivacyPoolRelay_EmptyBatch
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_EmptyBatch.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenBatchExceedsMaxBatch() external {
    uint256 _n = _relay.MAX_BATCH() + 1;
    ProofLibV2.TransactProof[] memory _proofs = new ProofLibV2.TransactProof[](_n);
    IPoolVault.TransactParams[] memory _params = new IPoolVault.TransactParams[](_n);
    IPoolVault.NoteData[][] memory _noteData = new IPoolVault.NoteData[][](_n);

    // It should revert with PrivacyPoolRelay_BatchTooLarge
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_BatchTooLarge.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenTransactParamsLengthMismatches() external {
    ProofLibV2.TransactProof[] memory _proofs = new ProofLibV2.TransactProof[](2);
    IPoolVault.TransactParams[] memory _params = new IPoolVault.TransactParams[](1);
    IPoolVault.NoteData[][] memory _noteData = new IPoolVault.NoteData[][](2);

    // It should revert with PrivacyPoolRelay_BatchLengthMismatch
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_BatchLengthMismatch.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenNoteDataLengthMismatches() external {
    ProofLibV2.TransactProof[] memory _proofs = new ProofLibV2.TransactProof[](2);
    IPoolVault.TransactParams[] memory _params = new IPoolVault.TransactParams[](2);
    IPoolVault.NoteData[][] memory _noteData = new IPoolVault.NoteData[][](1);

    // It should revert with PrivacyPoolRelay_BatchLengthMismatch
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_BatchLengthMismatch.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenAnItemHasZeroWithdrawal() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);
    // First item has amountOut == 0 so it reverts before any transact executes
    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(
      3, Constants.NATIVE_ASSET, _recipient, _feeRecipient, _u(0, 1 ether, 1 ether), _u(0, 0, 0), _g(0, 0, 0), false
    );

    // It should revert with PrivacyPoolRelay_ZeroWithdrawal
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_ZeroWithdrawal.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenRecipientIsZero() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);
    // Shared recipient is zero: the batch must revert before executing any transact.
    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(
      2, Constants.NATIVE_ASSET, address(0), _feeRecipient, _u(1 ether, 1 ether, 0), _u(0, 0, 0), _g(0, 0, 0), false
    );

    // It should revert with PrivacyPoolRelay_ZeroRecipient
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_ZeroRecipient.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenAnItemHasADifferentAsset() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);
    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(
      3,
      Constants.NATIVE_ASSET,
      _recipient,
      _feeRecipient,
      _u(1 ether, 1 ether, 1 ether),
      _u(0, 0, 0),
      _g(0, 0, 0),
      false
    );
    // Rebuild item 1 with a different asset
    (ProofLibV2.TransactProof memory _p1, IPoolVault.TransactParams memory _pp1) = _buildItem(
      ItemSpec({
        salt: 1,
        asset: _erc20,
        recipient: _recipient,
        feeRecipient: _feeRecipient,
        amountOut: 1 ether,
        feeAmount: 0,
        nativeGas: 0
      })
    );
    _proofs[1] = _p1;
    _params[1] = _pp1;
    // The first item transact happens before the asset check on item 1 reverts
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proofs[0], _params[0], _noteData[0])), abi.encode()
    );

    // It should revert with PrivacyPoolRelay_InconsistentAsset
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_InconsistentAsset.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenAnItemHasADifferentRecipient() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);
    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(
      3,
      Constants.NATIVE_ASSET,
      _recipient,
      _feeRecipient,
      _u(1 ether, 1 ether, 1 ether),
      _u(0, 0, 0),
      _g(0, 0, 0),
      false
    );
    // Rebuild item 1 with a different recipient
    (ProofLibV2.TransactProof memory _p1, IPoolVault.TransactParams memory _pp1) = _buildItem(
      ItemSpec({
        salt: 1,
        asset: Constants.NATIVE_ASSET,
        recipient: makeAddr('otherRecipient'),
        feeRecipient: _feeRecipient,
        amountOut: 1 ether,
        feeAmount: 0,
        nativeGas: 0
      })
    );
    _proofs[1] = _p1;
    _params[1] = _pp1;
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proofs[0], _params[0], _noteData[0])), abi.encode()
    );

    // It should revert with PrivacyPoolRelay_InconsistentRecipient
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_InconsistentRecipient.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenAnItemHasADifferentFeeRecipient() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);
    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(
      3,
      Constants.NATIVE_ASSET,
      _recipient,
      _feeRecipient,
      _u(1 ether, 1 ether, 1 ether),
      _u(0, 0, 0),
      _g(0, 0, 0),
      false
    );
    // Rebuild item 1 with a different fee recipient
    (ProofLibV2.TransactProof memory _p1, IPoolVault.TransactParams memory _pp1) = _buildItem(
      ItemSpec({
        salt: 1,
        asset: Constants.NATIVE_ASSET,
        recipient: _recipient,
        feeRecipient: makeAddr('otherFeeRecipient'),
        amountOut: 1 ether,
        feeAmount: 0,
        nativeGas: 0
      })
    );
    _proofs[1] = _p1;
    _params[1] = _pp1;
    _mockAndExpect(
      mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proofs[0], _params[0], _noteData[0])), abi.encode()
    );

    // It should revert with PrivacyPoolRelay_InconsistentRecipient
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_InconsistentRecipient.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenAnItemFeeExceedsMaxRelayFee() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);
    // Item 0 fee exceeds the max relay fee
    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(
      3,
      Constants.NATIVE_ASSET,
      _recipient,
      _feeRecipient,
      _u(2 ether, 1 ether, 1 ether),
      _u(DEFAULT_MAX_RELAY_FEE + 1, 0, 0),
      _g(0, 0, 0),
      false
    );

    // It should revert with PrivacyPoolRelay_FeeExceedsMax
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_FeeExceedsMax.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenAnItemFeeExceedsItsWithdrawal() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);
    // Item 0 fee (within max) exceeds its own amountOut
    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(
      3,
      Constants.NATIVE_ASSET,
      _recipient,
      _feeRecipient,
      _u(0.1 ether, 1 ether, 1 ether),
      _u(0.5 ether, 0, 0),
      _g(0, 0, 0),
      false
    );

    // It should revert with PrivacyPoolRelay_FeeExceedsWithdrawal
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_FeeExceedsWithdrawal.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  function test_RelayBatch_WhenMsgValueDoesNotMatchTotalNativeGas() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);
    // Total native gas = 6e15, but caller sends nothing
    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(
      3,
      Constants.NATIVE_ASSET,
      _recipient,
      _feeRecipient,
      _u(1 ether, 2 ether, 3 ether),
      _u(0, 0, 0),
      _g(1e15, 2e15, 3e15),
      true
    );

    // It should revert with PrivacyPoolRelay_NativeGasMismatch
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_NativeGasMismatch.selector);
    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  /*///////////////////////////////////////////////////////////////
                          NATIVE ASSET
  //////////////////////////////////////////////////////////////*/

  function test_RelayBatch_WhenAssetIsNativeWhenFeeIsLoadedOnASingleItem() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);

    uint256[] memory _amounts = _u(1 ether, 2 ether, 3 ether); // total 6 ether
    uint256[] memory _fees = _u(0, 0, 0.1 ether); // fee on the largest item
    uint128[] memory _gas = _g(1e15, 2e15, 3e15); // total 6e15
    uint256 _totalGas = 6e15;
    uint256 _totalAmount = 6 ether;
    uint256 _totalFee = 0.1 ether;
    uint256 _recipientAmount = _totalAmount - _totalFee;

    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(3, Constants.NATIVE_ASSET, _recipient, _feeRecipient, _amounts, _fees, _gas, true);

    // Relay holds the withdrawn funds (pool.transact is mocked); caller funds the gas
    vm.deal(address(_relay), _totalAmount);
    vm.deal(_caller, _totalGas);

    // It should emit RelayedBatch event
    vm.expectEmit();
    emit IPrivacyPoolRelay.RelayedBatch(
      Constants.NATIVE_ASSET, _recipient, _recipientAmount, _feeRecipient, _totalFee, _totalGas, 3
    );

    vm.prank(_caller);
    _relay.relayBatch{value: _totalGas}(_proofs, _params, _noteData);

    // It should transfer aggregate recipient amount plus gas funding to recipient
    assertEq(_recipient.balance, _recipientAmount + _totalGas);
    // It should transfer aggregate fee to fee recipient
    assertEq(_feeRecipient.balance, _totalFee);
  }

  function test_RelayBatch_WhenAssetIsNativeWhenFeeRecipientIsAddressZero() external {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);

    uint256[] memory _amounts = _u(1 ether, 2 ether, 3 ether);
    uint256[] memory _fees = _u(0, 0, 0.1 ether);
    uint128[] memory _gas = _g(0, 0, 0);
    uint256 _totalFee = 0.1 ether;
    uint256 _recipientAmount = 6 ether - _totalFee;

    // feeRecipient zero -> defaults to msg.sender (_caller)
    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(3, Constants.NATIVE_ASSET, _recipient, address(0), _amounts, _fees, _gas, true);

    vm.deal(address(_relay), 6 ether);
    uint256 _callerBefore = _caller.balance;

    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);

    // It should use msg sender as fee recipient
    assertEq(_caller.balance, _callerBefore + _totalFee);
    assertEq(_recipient.balance, _recipientAmount);
  }

  function test_RelayBatch_WhenMaxRelayFeeIsZeroUncapped() external {
    // `maxRelayFee == 0` means "no cap" per IEntrypoint: a NONZERO per-item fee must be ACCEPTED (not
    // reverted with PrivacyPoolRelay_FeeExceedsMax). The batch proceeds to the aggregate payout.
    _mockAssetConfig(Constants.NATIVE_ASSET, 0);

    uint256[] memory _amounts = _u(1 ether, 2 ether, 3 ether); // total 6 ether
    uint256[] memory _fees = _u(0, 0, 0.1 ether); // nonzero fee on the largest item
    uint128[] memory _gas = _g(0, 0, 0);
    uint256 _totalFee = 0.1 ether;
    uint256 _recipientAmount = 6 ether - _totalFee;

    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(3, Constants.NATIVE_ASSET, _recipient, _feeRecipient, _amounts, _fees, _gas, true);

    vm.deal(address(_relay), 6 ether);

    // It should emit RelayedBatch (the batch proceeds; the nonzero fee is NOT rejected under a 0 cap)
    vm.expectEmit();
    emit IPrivacyPoolRelay.RelayedBatch(
      Constants.NATIVE_ASSET, _recipient, _recipientAmount, _feeRecipient, _totalFee, 0, 3
    );

    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);

    // It should pay the aggregate recipient amount and the nonzero aggregate fee (no FeeExceedsMax revert)
    assertEq(_recipient.balance, _recipientAmount);
    assertEq(_feeRecipient.balance, _totalFee);
  }

  /*///////////////////////////////////////////////////////////////
                          ERC20 ASSET
  //////////////////////////////////////////////////////////////*/

  function test_RelayBatch_WhenAssetIsERC20() external {
    _mockAssetConfig(_erc20, DEFAULT_MAX_RELAY_FEE);

    uint256[] memory _amounts = _u(1 ether, 2 ether, 3 ether); // total 6 ether
    uint256[] memory _fees = _u(0, 0, 0.1 ether);
    uint128[] memory _gas = _g(1e15, 2e15, 3e15); // total 6e15 forwarded as ETH
    uint256 _totalGas = 6e15;
    uint256 _totalFee = 0.1 ether;
    uint256 _recipientAmount = 6 ether - _totalFee;

    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(3, _erc20, _recipient, _feeRecipient, _amounts, _fees, _gas, true);

    // It should transfer aggregate recipient amount to recipient
    _mockAndExpect(_erc20, abi.encodeCall(IERC20.transfer, (_recipient, _recipientAmount)), abi.encode(true));
    // It should transfer aggregate fee to fee recipient
    _mockAndExpect(_erc20, abi.encodeCall(IERC20.transfer, (_feeRecipient, _totalFee)), abi.encode(true));

    vm.deal(_caller, _totalGas);

    // It should emit RelayedBatch event
    vm.expectEmit();
    emit IPrivacyPoolRelay.RelayedBatch(_erc20, _recipient, _recipientAmount, _feeRecipient, _totalFee, _totalGas, 3);

    uint256 _recipientEthBefore = _recipient.balance;

    vm.prank(_caller);
    _relay.relayBatch{value: _totalGas}(_proofs, _params, _noteData);

    // It should forward gas funding to recipient
    assertEq(_recipient.balance, _recipientEthBefore + _totalGas);
  }

  /*///////////////////////////////////////////////////////////////
                          SINGLE ITEM
  //////////////////////////////////////////////////////////////*/

  function test_RelayBatch_WhenBatchHasASingleItem() external {
    _mockAssetConfig(_erc20, DEFAULT_MAX_RELAY_FEE);

    uint256[] memory _amounts = new uint256[](1);
    _amounts[0] = 5 ether;
    uint256[] memory _fees = new uint256[](1);
    _fees[0] = 0.2 ether;
    uint128[] memory _gas = new uint128[](1);
    _gas[0] = 0;
    uint256 _recipientAmount = 5 ether - 0.2 ether;

    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(1, _erc20, _recipient, _feeRecipient, _amounts, _fees, _gas, true);

    // It should pay the recipient and fee recipient
    _mockAndExpect(_erc20, abi.encodeCall(IERC20.transfer, (_recipient, _recipientAmount)), abi.encode(true));
    _mockAndExpect(_erc20, abi.encodeCall(IERC20.transfer, (_feeRecipient, 0.2 ether)), abi.encode(true));

    // It should emit RelayedBatch event
    vm.expectEmit();
    emit IPrivacyPoolRelay.RelayedBatch(_erc20, _recipient, _recipientAmount, _feeRecipient, 0.2 ether, 0, 1);

    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);
  }

  /*///////////////////////////////////////////////////////////////
                          BATCH SIZE BOUNDARIES
  //////////////////////////////////////////////////////////////*/

  function _uniformU(uint256 _n, uint256 _val) internal pure returns (uint256[] memory _arr) {
    _arr = new uint256[](_n);
    for (uint256 _i; _i < _n; ++_i) {
      _arr[_i] = _val;
    }
  }

  /// @dev Runs a full native batch of _n items (each 1 ether, whole fee on item 0) and asserts payout
  function _assertNativeBatchSucceeds(uint256 _n) internal {
    _mockAssetConfig(Constants.NATIVE_ASSET, DEFAULT_MAX_RELAY_FEE);

    uint256[] memory _amounts = _uniformU(_n, 1 ether);
    uint256[] memory _fees = new uint256[](_n);
    _fees[0] = 0.1 ether;
    uint128[] memory _gas = new uint128[](_n);

    uint256 _totalAmount = _n * 1 ether;
    uint256 _totalFee = 0.1 ether;
    uint256 _recipientAmount = _totalAmount - _totalFee;

    (
      ProofLibV2.TransactProof[] memory _proofs,
      IPoolVault.TransactParams[] memory _params,
      IPoolVault.NoteData[][] memory _noteData
    ) = _buildBatch(_n, Constants.NATIVE_ASSET, _recipient, _feeRecipient, _amounts, _fees, _gas, true);

    vm.deal(address(_relay), _totalAmount);

    vm.expectEmit();
    emit IPrivacyPoolRelay.RelayedBatch(
      Constants.NATIVE_ASSET, _recipient, _recipientAmount, _feeRecipient, _totalFee, 0, _n
    );

    vm.prank(_caller);
    _relay.relayBatch(_proofs, _params, _noteData);

    assertEq(_recipient.balance, _recipientAmount);
    assertEq(_feeRecipient.balance, _totalFee);
  }

  function test_RelayBatch_WhenBatchIsAtMaxBatch() external {
    // It should process a full MAX_BATCH batch (upper boundary, stresses the root-history margin)
    _assertNativeBatchSucceeds(_relay.MAX_BATCH());
  }

  function test_RelayBatch_WhenBatchIsMaxBatchMinusOne() external {
    // It should process a MAX_BATCH - 1 batch
    _assertNativeBatchSucceeds(_relay.MAX_BATCH() - 1);
  }
}
