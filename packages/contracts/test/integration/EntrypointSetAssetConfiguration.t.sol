// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';

import {IntegrationBase} from './IntegrationBase.t.sol';
import {Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

contract EntrypointSetAssetConfigurationIntegration is IntegrationBase {
  using ProofLibV2 for ProofLibV2.DepositProof;
  using ProofLibV2 for ProofLibV2.TransactProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  function setUp() public override {
    super.setUp();
    alice = _registerInKeystore(alice);
    bob = _registerInKeystore(bob);
  }

  /*///////////////////////////////////////////////////////////////
                  UNCONFIGURED → CONFIGURE → DEPOSIT
  ///////////////////////////////////////////////////////////////*/

  function test_depositFailsThenSucceeds_nativeETH() external {
    _disableAsset(Constants.NATIVE_ASSET);

    uint256 _value = SAMPLE_VALUE;

    // 1. Deposit fails — asset not enabled
    ProofLibV2.DepositProof memory _proof = _generateDepositProof(Constants.NATIVE_ASSET, _value);

    vm.deal(alice.addr, _value);
    vm.prank(alice.addr);
    vm.expectRevert(IEntrypoint.Entrypoint_AssetNotEnabled.selector);
    _entrypoint.deposit{value: _value}(_proof, _defaultNoteData, bytes(''));

    // 2. Configure native ETH (0% fee)
    IEntrypoint.AssetConfig memory _assetCfg =
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max});

    vm.expectEmit();
    emit IEntrypoint.AssetConfigurationSet(Constants.NATIVE_ASSET, _assetCfg);

    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(Constants.NATIVE_ASSET, _assetCfg);

    // 3. Deposit succeeds
    vm.expectEmit();
    emit IEntrypoint.Deposited(Constants.NATIVE_ASSET, alice.addr, _value, 0);

    vm.prank(alice.addr);
    _entrypoint.deposit{value: _value}(_proof, _defaultNoteData, bytes(''));

    assertEq(address(_poolVault).balance, _value);
  }

  function test_depositFailsThenSucceeds_erc20() external {
    uint256 _value = 1000e18;
    MockERC20 _freshToken = new MockERC20('Fresh', 'FRESH', 18);

    // 1. Deposit fails — asset not enabled
    ProofLibV2.DepositProof memory _proof = _generateDepositProof(address(_freshToken), _value);

    deal(address(_freshToken), alice.addr, _value);
    vm.startPrank(alice.addr);
    SafeTransferLib.safeApprove(address(_freshToken), address(_entrypoint), _value);
    vm.expectRevert(IEntrypoint.Entrypoint_AssetNotEnabled.selector);
    _entrypoint.deposit(_proof, _defaultNoteData, bytes(''));
    vm.stopPrank();

    // 2. Configure ERC20 (0% fee)
    IEntrypoint.AssetConfig memory _assetCfg =
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max});

    vm.expectEmit();
    emit IEntrypoint.AssetConfigurationSet(address(_freshToken), _assetCfg);

    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(address(_freshToken), _assetCfg);

    // 3. Deposit succeeds
    vm.expectEmit();
    emit IEntrypoint.Deposited(address(_freshToken), alice.addr, _value, 0);

    vm.prank(alice.addr);
    _entrypoint.deposit(_proof, _defaultNoteData, bytes(''));

    assertEq(_balanceOf(address(_freshToken), address(_poolVault)), _value);
  }

  /*///////////////////////////////////////////////////////////////
                      MIN AMOUNT ENFORCEMENT
  ///////////////////////////////////////////////////////////////*/

  function test_deposit_revertsWhenBelowMinAmount() external {
    uint256 _minAmount = 0.5 ether;

    // Configure native ETH with minAmount = 0.5 ether, 0% fee
    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      Constants.NATIVE_ASSET,
      IEntrypoint.AssetConfig({enabled: true, minAmount: _minAmount, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    );

    // Deposit below minAmount should revert
    uint256 _value = _minAmount - 1;
    ProofLibV2.DepositProof memory _proof = _generateDepositProof(Constants.NATIVE_ASSET, _value);

    vm.deal(alice.addr, _value);
    vm.prank(alice.addr);
    vm.expectRevert(IEntrypoint.Entrypoint_BelowMinAmount.selector);
    _entrypoint.deposit{value: _value}(_proof, _defaultNoteData, bytes(''));

    // Deposit at exactly minAmount should succeed
    ProofLibV2.DepositProof memory _proofOk = _generateDepositProofWithSecrets(
      Constants.NATIVE_ASSET, _minAmount, alice.noteSecrets[1], alice.depositSecrets[1]
    );

    vm.deal(alice.addr, _minAmount);
    vm.prank(alice.addr);
    _entrypoint.deposit{value: _minAmount}(_proofOk, _defaultNoteData, bytes(''));

    assertEq(address(_poolVault).balance, _minAmount);
  }

  function test_deposit_revertsWhenBelowMinAmount_withFee() external {
    uint256 _minAmount = 1 ether;
    uint256 _feeBPS = _chainAssetConfig(Constants.NATIVE_ASSET).vettingFeeBPS;

    // Configure native ETH with minAmount = 1 ether and the chain registry fee
    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      Constants.NATIVE_ASSET,
      IEntrypoint.AssetConfig({
        enabled: true, minAmount: _minAmount, vettingFeeBPS: _feeBPS, maxRelayFee: type(uint256).max
      })
    );

    // Deposit below minAmount should revert even if msg.value covers fee
    uint256 _belowMin = _minAmount - 1;
    uint256 _fee = (_belowMin * _feeBPS) / 10_000;
    ProofLibV2.DepositProof memory _proof = _generateDepositProof(Constants.NATIVE_ASSET, _belowMin);

    vm.deal(alice.addr, _belowMin + _fee);
    vm.prank(alice.addr);
    vm.expectRevert(IEntrypoint.Entrypoint_BelowMinAmount.selector);
    _entrypoint.deposit{value: _belowMin + _fee}(_proof, _defaultNoteData, bytes(''));

    // Deposit at exactly minAmount with fee should succeed
    uint256 _feeAtMin = (_minAmount * _feeBPS) / 10_000;
    ProofLibV2.DepositProof memory _proofOk = _generateDepositProofWithSecrets(
      Constants.NATIVE_ASSET, _minAmount, alice.noteSecrets[1], alice.depositSecrets[1]
    );

    vm.deal(alice.addr, _minAmount + _feeAtMin);
    vm.prank(alice.addr);
    _entrypoint.deposit{value: _minAmount + _feeAtMin}(_proofOk, _defaultNoteData, bytes(''));

    assertEq(address(_poolVault).balance, _minAmount);
    assertEq(address(_entrypoint).balance, _feeAtMin);
  }

  /*///////////////////////////////////////////////////////////////
                          FEE VARIATIONS
  ///////////////////////////////////////////////////////////////*/

  function test_deposit_zeroFee() external {
    _configureNativeETH(0); // 0%

    uint256 _value = SAMPLE_VALUE;
    ProofLibV2.DepositProof memory _proof = _generateDepositProof(Constants.NATIVE_ASSET, _value);

    uint256 _totalRequired = _value; // no fee
    vm.deal(alice.addr, _totalRequired);

    vm.expectEmit();
    emit IEntrypoint.Deposited(Constants.NATIVE_ASSET, alice.addr, _value, 0);

    vm.prank(alice.addr);
    _entrypoint.deposit{value: _totalRequired}(_proof, _defaultNoteData, bytes(''));

    // All value goes to pool, nothing retained
    assertEq(address(_poolVault).balance, _value);
    assertEq(address(_entrypoint).balance, 0);
  }

  function test_deposit_halfPercentFee() external {
    _configureNativeETH(50); // 0.5% = 50 BPS

    uint256 _value = 10 ether;
    uint256 _expectedFee = 0.05 ether; // 10 * 50 / 10000
    ProofLibV2.DepositProof memory _proof = _generateDepositProof(Constants.NATIVE_ASSET, _value);

    uint256 _totalRequired = _value + _expectedFee;
    vm.deal(alice.addr, _totalRequired);

    vm.expectEmit();
    emit IEntrypoint.Deposited(Constants.NATIVE_ASSET, alice.addr, _value, _expectedFee);

    vm.prank(alice.addr);
    _entrypoint.deposit{value: _totalRequired}(_proof, _defaultNoteData, bytes(''));

    assertEq(address(_poolVault).balance, _value);
    assertEq(address(_entrypoint).balance, _expectedFee);
  }

  function test_deposit_onePercentFee() external {
    _configureNativeETH(100); // 1% = 100 BPS

    uint256 _value = SAMPLE_VALUE;
    uint256 _expectedFee = 0.01 ether; // 1 * 100 / 10000
    ProofLibV2.DepositProof memory _proof = _generateDepositProof(Constants.NATIVE_ASSET, _value);

    uint256 _totalRequired = _value + _expectedFee;
    vm.deal(alice.addr, _totalRequired);

    vm.expectEmit();
    emit IEntrypoint.Deposited(Constants.NATIVE_ASSET, alice.addr, _value, _expectedFee);

    vm.prank(alice.addr);
    _entrypoint.deposit{value: _totalRequired}(_proof, _defaultNoteData, bytes(''));

    assertEq(address(_poolVault).balance, _value);
    assertEq(address(_entrypoint).balance, _expectedFee);
  }

  function test_revertWhen_hundredPercentFee() external {
    // 100% fee (10_000 BPS) should be rejected by setAssetConfiguration
    vm.expectRevert(IEntrypoint.Entrypoint_InvalidFeeBPS.selector);
    _configureNativeETH(10_000);
  }

  function test_deposit_disableAfterDeposit_blocksNextDeposit() external {
    _configureNativeETH(100); // 1%

    uint256 _value = SAMPLE_VALUE;
    uint256 _fee = 0.01 ether;

    // First deposit succeeds
    ProofLibV2.DepositProof memory _proof1 = _generateDepositProof(Constants.NATIVE_ASSET, _value);
    vm.deal(alice.addr, _value + _fee);
    vm.prank(alice.addr);
    _entrypoint.deposit{value: _value + _fee}(_proof1, _defaultNoteData, bytes(''));

    // Disable native ETH
    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      Constants.NATIVE_ASSET, IEntrypoint.AssetConfig({enabled: false, minAmount: 0, vettingFeeBPS: 0, maxRelayFee: 0})
    );

    // Second deposit fails
    ProofLibV2.DepositProof memory _proof2 =
      _generateDepositProofWithSecrets(Constants.NATIVE_ASSET, _value, alice.noteSecrets[1], alice.depositSecrets[1]);
    vm.deal(alice.addr, _value + _fee);
    vm.prank(alice.addr);
    vm.expectRevert(IEntrypoint.Entrypoint_AssetNotEnabled.selector);
    _entrypoint.deposit{value: _value + _fee}(_proof2, _defaultNoteData, bytes(''));
  }

  function test_deposit_feeAccumulatesAcrossDeposits() external {
    _configureNativeETH(100); // 1%

    // First deposit
    uint256 _value1 = SAMPLE_VALUE;
    uint256 _fee1 = 0.01 ether;
    ProofLibV2.DepositProof memory _proof1 = _generateDepositProof(Constants.NATIVE_ASSET, _value1);
    vm.deal(alice.addr, _value1 + _fee1);
    vm.prank(alice.addr);
    _entrypoint.deposit{value: _value1 + _fee1}(_proof1, _defaultNoteData, bytes(''));

    // Second deposit (different secrets to avoid duplicate commitment)
    ProofLibV2.DepositProof memory _proof2 =
      _generateDepositProofWithSecrets(Constants.NATIVE_ASSET, _value1, alice.noteSecrets[1], alice.depositSecrets[1]);
    vm.deal(alice.addr, _value1 + _fee1);
    vm.prank(alice.addr);
    _entrypoint.deposit{value: _value1 + _fee1}(_proof2, _defaultNoteData, bytes(''));

    // Fees accumulate in entrypoint
    assertEq(address(_entrypoint).balance, _fee1 * 2);
    assertEq(address(_poolVault).balance, _value1 * 2);
  }

  /*///////////////////////////////////////////////////////////////
                    MAX RELAY FEE ENFORCEMENT
  ///////////////////////////////////////////////////////////////*/

  function test_relay_maxRelayFee_rejectsExcessiveFee() external {
    // Configure with the chain registry fee and maxRelayFee = 0.01 ether
    _configureNativeETHFull(_chainAssetConfig(Constants.NATIVE_ASSET).vettingFeeBPS, 0.01 ether);

    // Deposit + build transact proof for withdrawal via relay
    (ProofLibV2.TransactProof memory _txProof, IPoolVault.TransactParams memory _params) =
      _depositAndBuildRelayTransact(SAMPLE_VALUE, SAMPLE_VALUE, 0.02 ether, 0);

    // Relay reverts — fee (0.02) exceeds maxRelayFee (0.01)
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_FeeExceedsMax.selector);
    _privacyPoolRelay.relay(_txProof, _params, _defaultTransactNoteData);
  }

  function test_relay_maxRelayFee_acceptsFeeAtLimit() external {
    // Configure with maxRelayFee = 0.05 ether
    uint256 _feeAmount = 0.05 ether;
    _configureNativeETHFull(_chainAssetConfig(Constants.NATIVE_ASSET).vettingFeeBPS, _feeAmount);

    // Deposit + build transact with fee exactly at limit
    (ProofLibV2.TransactProof memory _txProof, IPoolVault.TransactParams memory _params) =
      _depositAndBuildRelayTransact(SAMPLE_VALUE, SAMPLE_VALUE, _feeAmount, 0);

    uint256 _bobBefore = bob.addr.balance;
    uint256 _charlieBefore = charlie.addr.balance;

    _privacyPoolRelay.relay(_txProof, _params, _defaultTransactNoteData);

    // Verify distribution is correct
    assertEq(address(_privacyPoolRelay).balance, 0, 'Relay should have forwarded all funds');
    assertEq(bob.addr.balance, _bobBefore + SAMPLE_VALUE - _feeAmount, 'Bob should receive withdrawal minus fee');
    assertEq(charlie.addr.balance, _charlieBefore + _feeAmount, 'Charlie should receive relay fee');
  }

  function test_relay_maxRelayFee_zeroMaxIsUncapped() external {
    // maxRelayFee == 0 means "no cap" per IEntrypoint (0 = no maximum) — a nonzero fee is
    // ACCEPTED, not blocked (matches RelaySwaps/MockPool/SDK; core sentinel fix).
    uint256 _feeAmount = 0.02 ether;
    _configureNativeETHFull(_chainAssetConfig(Constants.NATIVE_ASSET).vettingFeeBPS, 0);

    (ProofLibV2.TransactProof memory _txProof, IPoolVault.TransactParams memory _params) =
      _depositAndBuildRelayTransact(SAMPLE_VALUE, SAMPLE_VALUE, _feeAmount, 0);

    uint256 _bobBefore = bob.addr.balance;
    uint256 _charlieBefore = charlie.addr.balance;

    _privacyPoolRelay.relay(_txProof, _params, _defaultTransactNoteData);

    // Uncapped: the relay proceeds and distributes normally
    assertEq(address(_privacyPoolRelay).balance, 0, 'Relay should have forwarded all funds');
    assertEq(bob.addr.balance, _bobBefore + SAMPLE_VALUE - _feeAmount, 'Bob should receive withdrawal minus fee');
    assertEq(charlie.addr.balance, _charlieBefore + _feeAmount, 'Charlie should receive relay fee (uncapped)');
  }

  function test_relay_maxRelayFee_resetConfigIsUncapped() external {
    // Configure normally, deposit, then wipe the config so maxRelayFee = 0
    _configureNativeETHFull(_chainAssetConfig(Constants.NATIVE_ASSET).vettingFeeBPS, 0.1 ether);

    Note memory _note = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    // Wipe config (disable asset, all fields to zero)
    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      Constants.NATIVE_ASSET, IEntrypoint.AssetConfig({enabled: false, minAmount: 0, vettingFeeBPS: 0, maxRelayFee: 0})
    );

    // maxRelayFee == 0 now means "no cap" — a nonzero fee is accepted (relay does not read `enabled`).
    uint256 _feeAmount = 0.001 ether;
    (ProofLibV2.TransactProof memory _txProof, IPoolVault.TransactParams memory _params) =
      _buildRelayTransact(_note, SAMPLE_VALUE, SAMPLE_VALUE, _feeAmount, 0);

    uint256 _bobBefore = bob.addr.balance;
    uint256 _charlieBefore = charlie.addr.balance;

    _privacyPoolRelay.relay(_txProof, _params, _defaultTransactNoteData);

    assertEq(address(_privacyPoolRelay).balance, 0, 'Relay should have forwarded all funds');
    assertEq(bob.addr.balance, _bobBefore + SAMPLE_VALUE - _feeAmount, 'Bob should receive withdrawal minus fee');
    assertEq(charlie.addr.balance, _charlieBefore + _feeAmount, 'Charlie should receive relay fee (uncapped)');
  }

  /// @notice Withdrawals still work after disabling an asset — PoolVault.transact doesn't check Entrypoint config
  function test_withdrawalSucceeds_afterAssetDisabled() external {
    // Configure, deposit, then disable the asset
    _configureNativeETHFull(_chainAssetConfig(Constants.NATIVE_ASSET).vettingFeeBPS, 0.1 ether);

    Note memory _note = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      Constants.NATIVE_ASSET, IEntrypoint.AssetConfig({enabled: false, minAmount: 0, vettingFeeBPS: 0, maxRelayFee: 0})
    );

    // Relay with zero fee still works — funds reach recipient but relayer earns nothing
    (ProofLibV2.TransactProof memory _txProof, IPoolVault.TransactParams memory _params) =
      _buildRelayTransact(_note, SAMPLE_VALUE, SAMPLE_VALUE, 0, 0);

    uint256 _bobBefore = bob.addr.balance;
    _privacyPoolRelay.relay(_txProof, _params, _defaultTransactNoteData);
    assertEq(bob.addr.balance, _bobBefore + SAMPLE_VALUE, 'Bob should receive full withdrawal');
  }

  function test_relay_maxRelayFee_updatedConfigTakesEffect() external {
    // Start with maxRelayFee = 0.01 ether
    _configureNativeETHFull(_chainAssetConfig(Constants.NATIVE_ASSET).vettingFeeBPS, 0.01 ether);

    // Deposit
    Note memory _note = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    // Build relay transact with fee = 0.05 (above current max)
    uint256 _feeAmount = 0.05 ether;
    (ProofLibV2.TransactProof memory _txProof1, IPoolVault.TransactParams memory _params1) =
      _buildRelayTransact(_note, SAMPLE_VALUE, SAMPLE_VALUE, _feeAmount, 0);

    // Should fail with current config
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_FeeExceedsMax.selector);
    _privacyPoolRelay.relay(_txProof1, _params1, _defaultTransactNoteData);

    // Update maxRelayFee to 0.1 ether
    _configureNativeETHFull(_chainAssetConfig(Constants.NATIVE_ASSET).vettingFeeBPS, 0.1 ether);

    // Same relay now succeeds
    _privacyPoolRelay.relay(_txProof1, _params1, _defaultTransactNoteData);
  }

  /*///////////////////////////////////////////////////////////////
                    FORK TESTS: REAL TOKENS
  ///////////////////////////////////////////////////////////////*/

  function test_fork_depositFailsThenSucceeds_USDC() external {
    _disableAsset(_usdc);

    uint256 _value = 1000e6; // USDC has 6 decimals
    uint256 _feeBPS = _chainAssetConfig(_usdc).vettingFeeBPS;
    uint256 _fee = (_value * _feeBPS) / 10_000;

    // 1. Deposit fails — USDC not enabled
    ProofLibV2.DepositProof memory _proof = _generateDepositProof(_usdc, _value);

    deal(_usdc, alice.addr, _value + _fee);
    vm.startPrank(alice.addr);
    SafeTransferLib.safeApprove(_usdc, address(_entrypoint), _value + _fee);
    vm.expectRevert(IEntrypoint.Entrypoint_AssetNotEnabled.selector);
    _entrypoint.deposit(_proof, _defaultNoteData, bytes(''));
    vm.stopPrank();

    // 2. Configure USDC with the chain registry fee
    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      _usdc,
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: _feeBPS, maxRelayFee: type(uint256).max})
    );

    // 3. Deposit succeeds
    vm.prank(alice.addr);
    _entrypoint.deposit(_proof, _defaultNoteData, bytes(''));

    assertEq(_balanceOf(_usdc, address(_poolVault)), _value);
    assertEq(_balanceOf(_usdc, address(_entrypoint)), _fee);
  }

  function test_fork_depositFailsThenSucceeds_USDT() external {
    _disableAsset(_usdt);

    uint256 _value = 1000e6; // USDT has 6 decimals
    uint256 _feeBPS = _chainAssetConfig(_usdt).vettingFeeBPS;
    uint256 _fee = (_value * _feeBPS) / 10_000;

    // 1. Deposit fails — USDT not enabled
    ProofLibV2.DepositProof memory _proof = _generateDepositProof(_usdt, _value);

    deal(_usdt, alice.addr, _value + _fee);
    vm.startPrank(alice.addr);
    SafeTransferLib.safeApprove(_usdt, address(_entrypoint), _value + _fee);
    vm.expectRevert(IEntrypoint.Entrypoint_AssetNotEnabled.selector);
    _entrypoint.deposit(_proof, _defaultNoteData, bytes(''));
    vm.stopPrank();

    // 2. Configure USDT with the chain registry fee
    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      _usdt,
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: _feeBPS, maxRelayFee: type(uint256).max})
    );

    // 3. Deposit succeeds
    vm.prank(alice.addr);
    _entrypoint.deposit(_proof, _defaultNoteData, bytes(''));

    assertEq(_balanceOf(_usdt, address(_poolVault)), _value);
    assertEq(_balanceOf(_usdt, address(_entrypoint)), _fee);
  }

  /*///////////////////////////////////////////////////////////////
                          HELPERS
  ///////////////////////////////////////////////////////////////*/

  function _disableAsset(address _asset) internal {
    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      _asset, IEntrypoint.AssetConfig({enabled: false, minAmount: 0, vettingFeeBPS: 0, maxRelayFee: 0})
    );
  }

  function _configureNativeETH(uint256 _feeBPS) internal {
    _configureNativeETHFull(_feeBPS, type(uint256).max);
  }

  function _configureNativeETHFull(uint256 _feeBPS, uint256 _maxRelayFee) internal {
    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      Constants.NATIVE_ASSET,
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: _feeBPS, maxRelayFee: _maxRelayFee})
    );
  }

  function _generateDepositProof(address _asset, uint256 _value) internal returns (ProofLibV2.DepositProof memory) {
    return _generateDepositProofWithSecrets(_asset, _value, alice.noteSecrets[0], alice.depositSecrets[0]);
  }

  function _generateDepositProofWithSecrets(
    address _asset,
    uint256 _value,
    uint256 _noteSecret,
    uint256 _depositSecret
  ) internal returns (ProofLibV2.DepositProof memory) {
    uint256 _noteAddressHash = PoseidonT3.hash([alice.ownerAddress, _noteSecret]);
    uint256 _depositContext = uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD;
    return ProofGenerator.generateDepositProof(_asset, _value, _noteAddressHash, _depositSecret, _depositContext);
  }

  /// @dev Deposit + build a relay transact proof in one call
  function _depositAndBuildRelayTransact(
    uint256 _depositValue,
    uint256 _withdrawValue,
    uint256 _feeAmount,
    uint256 _nativeGas
  ) internal returns (ProofLibV2.TransactProof memory txProof_, IPoolVault.TransactParams memory params_) {
    Note memory _note = _deposit(alice, Constants.NATIVE_ASSET, _depositValue);
    return _buildRelayTransact(_note, _depositValue, _withdrawValue, _feeAmount, _nativeGas);
  }

  /// @dev Build relay transact proof from an existing deposit record
  /// @dev Uses _defaultTransactNoteData for note data array
  function _buildRelayTransact(
    Note memory _note,
    uint256 _value,
    uint256 _withdrawValue,
    uint256 _feeAmount,
    uint256 _nativeGas
  ) internal returns (ProofLibV2.TransactProof memory txProof_, IPoolVault.TransactParams memory params_) {
    // Use bob as recipient and charlie as fee recipient (both are EOAs from makeAddr)
    params_ = IPoolVault.TransactParams({
      processor: address(_privacyPoolRelay),
      data: abi.encode(
        IPrivacyPoolRelay.PayoutRouting({
          recipient: bob.addr, feeRecipient: charlie.addr, feeAmount: _feeAmount, nativeGas: _nativeGas
        })
      )
    });

    {
      Note[] memory _notes = new Note[](1);
      _notes[0] = _note;
      NoteCreationParams[] memory _p = new NoteCreationParams[](1);
      _p[0] = bob.receiveNote(_value - _withdrawValue, _note.inputLabel);
      txProof_ = _buildTransactProof({
        _notes: _notes,
        _spender: alice,
        _noteCreationParams: _p,
        _amountOut: _withdrawValue,
        _context: _hashTransactContext(params_, _defaultTransactNoteData)
      });
    }
  }
}
