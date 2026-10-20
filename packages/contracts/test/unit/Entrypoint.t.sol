// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import {ERC1967Utils} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC165} from '@openzeppelin/contracts/utils/introspection/IERC165.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';
import {FeeCalculator} from 'src/abstracts/FeeCalculator.sol';
import {EntrypointHarness} from 'test/unit/helpers/EntrypointHarness.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';
import {Constants} from 'utils/Constants.sol';
import {ENTRYPOINT_MANAGER_ROLE, UPGRADER_ROLE} from 'utils/RolesConstants.sol';

contract UnitEntrypoint is TestUtils {
  EntrypointHarness public entrypoint;

  uint256 internal constant _MIN_AMOUNT = 0.01 ether;
  uint256 internal constant _VETTING_FEE_BPS = 100; // 1%
  uint256 internal constant _MAX_RELAY_FEE = 0.1 ether;
  bytes internal constant _EMPTY_CIPHERTEXT = '';
  IPoolVault.NoteData internal _defaultNoteData;

  function setUp() public {
    EntrypointHarness _harnessImpl = new EntrypointHarness(IAccessControl(mockAccessRouter));
    bytes memory initData = abi.encodeCall(Entrypoint.initialize, (IPoolVault(mockPoolVault)));
    ERC1967Proxy proxy = new ERC1967Proxy(address(_harnessImpl), initData);
    entrypoint = EntrypointHarness(payable(address(proxy)));
  }

  function _createDepositProof(
    address _asset,
    uint256 _value,
    uint256 _commitment
  ) internal pure returns (ProofLibV2.DepositProof memory proof_) {
    proof_.pubSignals[0] = _commitment;
    proof_.pubSignals[1] = uint256(uint160(_asset));
    proof_.pubSignals[2] = _value;
  }

  /*///////////////////////////////////////////////////////////////
                      Constructor
  ///////////////////////////////////////////////////////////////*/

  function test_Constructor_WhenAccessRouterIsInvalid(address _accessRouter) external {
    assumeNotPrecompile(_accessRouter);
    assumeNotForgeAddress(_accessRouter);
    vm.mockCall(
      _accessRouter, abi.encodeCall(IERC165.supportsInterface, (type(IAccessControl).interfaceId)), abi.encode(false)
    );
    vm.expectRevert(IPermissioned.Permissioned_InvalidAccessRouter.selector);
    new Entrypoint(IAccessControl(_accessRouter));
  }

  function test_Constructor_WhenCalled(address _newAccessRouter) external {
    // it sets the access router
    _mockAccessRouter(_newAccessRouter);
    Entrypoint _implementation = new Entrypoint(IAccessControl(_newAccessRouter));
    assertEq(address(_implementation.ACCESS_ROUTER()), _newAccessRouter);

    // It should disable initializers on implementation
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    _implementation.initialize(IPoolVault(mockPoolVault));
  }

  /*///////////////////////////////////////////////////////////////
                      INITIALIZE
  ///////////////////////////////////////////////////////////////*/

  function test_Initialize_GivenAlreadyInitialized() external {
    // It should revert with InvalidInitialization
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    entrypoint.initialize(IPoolVault(mockPoolVault));
  }

  function test_Initialize_GivenNotInitialized(address _newPoolVault, address _newAccessRouter) external {
    _mockAccessRouter(_newAccessRouter);
    Entrypoint _implementation = new Entrypoint(IAccessControl(_newAccessRouter));
    ERC1967Proxy _proxy = new ERC1967Proxy(address(_implementation), '');
    Entrypoint _newEntrypoint = Entrypoint(payable(address(_proxy)));

    // It should succeed
    _newEntrypoint.initialize(IPoolVault(_newPoolVault));
    // access router was set by constructor
    assertEq(address(_newEntrypoint.ACCESS_ROUTER()), _newAccessRouter);
    // it sets the pool vault
    assertEq(address(_newEntrypoint.poolVault()), _newPoolVault);
  }

  /*///////////////////////////////////////////////////////////////
                        SWEEP
  ///////////////////////////////////////////////////////////////*/

  function test_Sweep_GivenCallerDoesNotHaveENTRYPOINT_MANAGER_ROLE(
    address _caller,
    address _recipient,
    address _token
  ) external {
    _mockExpectHasRole(ENTRYPOINT_MANAGER_ROLE, _caller, false);

    // It should revert with Permissioned_NotAuthorized
    vm.prank(_caller);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    entrypoint.sweep(address(_token), _recipient);
  }

  modifier givenCallerIsEntrypointManager(address _caller) {
    _mockExpectHasRole(ENTRYPOINT_MANAGER_ROLE, _caller, true);
    _;
  }

  modifier whenAssetIsNative() {
    _;
  }

  function test_Sweep_GivenRecipientRejectsETH(
    address _caller,
    address _recipient,
    uint256 _amount
  ) external givenCallerIsEntrypointManager(_caller) whenAssetIsNative {
    // mockCallRevert on addresses with bytecode can leak into delegatecalls (foundry-rs/foundry#432),
    // so we restrict to codeless addresses. The mock itself simulates ETH rejection.
    vm.assume(_recipient.code.length == 0);
    vm.deal(address(entrypoint), _amount);
    vm.mockCallRevert(_recipient, bytes(''), abi.encode('ETH_REJECTED'));

    // It should revert with SafeTransferLib.ETHTransferFailed
    vm.prank(_caller);
    vm.expectRevert(SafeTransferLib.ETHTransferFailed.selector);

    entrypoint.sweep(Constants.NATIVE_ASSET, _recipient);
  }

  function test_Sweep_GivenRecipientAcceptsETH(
    uint256 _amount,
    address _caller,
    address _recipient
  ) external whenAssetIsNative {
    assumePayable(_recipient);
    assumeNotPrecompile(_recipient);
    vm.assume(_recipient != address(entrypoint));
    _mockExpectHasRole(ENTRYPOINT_MANAGER_ROLE, _caller, true);

    _amount = bound(_amount, 1, type(uint128).max);
    vm.deal(address(entrypoint), _amount);
    vm.deal(_recipient, 0);

    // It should emit Swept event
    vm.expectEmit();
    emit IEntrypoint.Swept(Constants.NATIVE_ASSET, _recipient, _amount);

    // It should transfer the native asset
    vm.prank(_caller);
    entrypoint.sweep(Constants.NATIVE_ASSET, _recipient);

    assertEq(address(entrypoint).balance, 0);
    assertEq(_recipient.balance, _amount);
  }

  function test_Sweep_WhenAssetIsERC20(
    address _caller,
    address _token,
    uint256 _amount,
    address _recipient
  ) external givenCallerIsEntrypointManager(_caller) {
    assumeNotForgeAddress(_token);
    vm.assume(_token != Constants.NATIVE_ASSET);
    _amount = bound(_amount, 1, type(uint128).max);

    // It should query the token balance
    _mockAndExpect(_token, abi.encodeCall(IERC20.balanceOf, (address(entrypoint))), abi.encode(_amount));
    // It should transfer the ERC20 tokens
    _mockAndExpect(_token, abi.encodeCall(IERC20.transfer, (_recipient, _amount)), abi.encode(true));

    // It should emit Swept event
    vm.expectEmit();
    emit IEntrypoint.Swept(_token, _recipient, _amount);

    vm.prank(_caller);
    entrypoint.sweep(address(_token), _recipient);
  }

  /*///////////////////////////////////////////////////////////////
                        SET ASSET CONFIGURATION
  ///////////////////////////////////////////////////////////////*/

  function test_SetAssetConfiguration_GivenCallerDoesNotHaveENTRYPOINT_MANAGER_ROLE(
    address _caller,
    address _asset,
    IEntrypoint.AssetConfig memory _config
  ) external {
    _mockExpectHasRole(ENTRYPOINT_MANAGER_ROLE, _caller, false);

    // It should revert with Permissioned_NotAuthorized
    vm.prank(_caller);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    entrypoint.setAssetConfiguration(_asset, _config);
  }

  function test_SetAssetConfiguration_WhenVettingFeeBPSIsGreaterThanOrEqualToMAXFEEBPS(
    address _caller,
    address _asset,
    IEntrypoint.AssetConfig memory _config
  ) external givenCallerIsEntrypointManager(_caller) {
    _config.vettingFeeBPS = bound(_config.vettingFeeBPS, FeeCalculator.MAX_FEE_BPS, type(uint256).max);

    // It should revert with Entrypoint_InvalidFeeBPS
    vm.prank(_caller);
    vm.expectRevert(IEntrypoint.Entrypoint_InvalidFeeBPS.selector);
    entrypoint.setAssetConfiguration(_asset, _config);
  }

  modifier whenVettingFeeBPSIsLessThanMAXFEEBPS(IEntrypoint.AssetConfig memory _config) {
    _config.vettingFeeBPS = bound(_config.vettingFeeBPS, 0, FeeCalculator.MAX_FEE_BPS - 1);
    _;
  }

  modifier whenEnablingAsset(IEntrypoint.AssetConfig memory _config) {
    _config.enabled = true;
    _;
  }

  function test_SetAssetConfiguration_WhenMinAmountIsZero(
    address _caller,
    address _asset,
    IEntrypoint.AssetConfig memory _config
  )
    external
    givenCallerIsEntrypointManager(_caller)
    whenVettingFeeBPSIsLessThanMAXFEEBPS(_config)
    whenEnablingAsset(_config)
  {
    _config.minAmount = 0;

    // It should revert with Entrypoint_InvalidMinAmount
    vm.prank(_caller);
    vm.expectRevert(IEntrypoint.Entrypoint_InvalidMinAmount.selector);
    entrypoint.setAssetConfiguration(_asset, _config);
  }

  modifier whenMinAmountIsGt0(IEntrypoint.AssetConfig memory _config) {
    _config.minAmount = bound(_config.minAmount, 1, type(uint256).max);
    _;
  }

  function test_SetAssetConfiguration_WhenAssetIsNative(
    address _caller,
    IEntrypoint.AssetConfig memory _config
  )
    external
    givenCallerIsEntrypointManager(_caller)
    whenVettingFeeBPSIsLessThanMAXFEEBPS(_config)
    whenEnablingAsset(_config)
    whenMinAmountIsGt0(_config)
    whenAssetIsNative
  {
    // It should emit AssetConfigurationSet event
    vm.expectEmit();
    emit IEntrypoint.AssetConfigurationSet(Constants.NATIVE_ASSET, _config);

    vm.prank(_caller);
    entrypoint.setAssetConfiguration(Constants.NATIVE_ASSET, _config);

    // It should set the asset configuration
    IEntrypoint.AssetConfig memory _storedConfig = entrypoint.assets(Constants.NATIVE_ASSET);
    assertEq(_storedConfig.enabled, _config.enabled);
    assertEq(_storedConfig.minAmount, _config.minAmount);
    assertEq(_storedConfig.vettingFeeBPS, _config.vettingFeeBPS);
    assertEq(_storedConfig.maxRelayFee, _config.maxRelayFee);
  }

  function test_SetAssetConfiguration_WhenAssetIsERC20(
    address _caller,
    address _asset,
    IEntrypoint.AssetConfig memory _config
  )
    external
    givenCallerIsEntrypointManager(_caller)
    whenVettingFeeBPSIsLessThanMAXFEEBPS(_config)
    whenEnablingAsset(_config)
    whenMinAmountIsGt0(_config)
    whenAssetIsERC20(_asset)
  {
    // It should approve pool vault for ERC20 assets
    _mockAndExpect(_asset, abi.encodeCall(IERC20.approve, (mockPoolVault, type(uint256).max)), abi.encode(true));

    // It should emit AssetConfigurationSet event
    vm.expectEmit();
    emit IEntrypoint.AssetConfigurationSet(_asset, _config);

    vm.prank(_caller);
    entrypoint.setAssetConfiguration(_asset, _config);

    // It should set the asset configuration
    IEntrypoint.AssetConfig memory _storedConfig = entrypoint.assets(_asset);
    assertEq(_storedConfig.enabled, _config.enabled);
    assertEq(_storedConfig.minAmount, _config.minAmount);
    assertEq(_storedConfig.vettingFeeBPS, _config.vettingFeeBPS);
    assertEq(_storedConfig.maxRelayFee, _config.maxRelayFee);
  }

  modifier whenDisablingAsset(IEntrypoint.AssetConfig memory _config) {
    _config.enabled = false;
    _;
  }

  function test_SetAssetConfiguration_WhenAssetIsNative_WhenDisablingAsset(
    address _caller,
    IEntrypoint.AssetConfig memory _config
  )
    external
    givenCallerIsEntrypointManager(_caller)
    whenVettingFeeBPSIsLessThanMAXFEEBPS(_config)
    whenDisablingAsset(_config)
    whenAssetIsNative
  {
    // It should emit AssetConfigurationSet event
    vm.expectEmit();
    emit IEntrypoint.AssetConfigurationSet(Constants.NATIVE_ASSET, _config);

    vm.prank(_caller);
    entrypoint.setAssetConfiguration(Constants.NATIVE_ASSET, _config);

    // It should set the asset configuration
    IEntrypoint.AssetConfig memory _storedConfig = entrypoint.assets(Constants.NATIVE_ASSET);
    assertEq(_storedConfig.enabled, _config.enabled);
    assertEq(_storedConfig.minAmount, _config.minAmount);
    assertEq(_storedConfig.vettingFeeBPS, _config.vettingFeeBPS);
    assertEq(_storedConfig.maxRelayFee, _config.maxRelayFee);
  }

  function test_SetAssetConfiguration_WhenAssetIsERC20_WhenDisablingAsset(
    address _caller,
    address _asset,
    IEntrypoint.AssetConfig memory _config
  )
    external
    givenCallerIsEntrypointManager(_caller)
    whenVettingFeeBPSIsLessThanMAXFEEBPS(_config)
    whenDisablingAsset(_config)
    whenAssetIsERC20(_asset)
  {
    // It should revoke pool vault approval
    _mockAndExpect(_asset, abi.encodeCall(IERC20.approve, (address(mockPoolVault), 0)), abi.encode(true));

    // It should emit AssetConfigurationSet event
    vm.expectEmit();
    emit IEntrypoint.AssetConfigurationSet(_asset, _config);

    vm.prank(_caller);
    entrypoint.setAssetConfiguration(_asset, _config);

    // It should set the asset configuration
    IEntrypoint.AssetConfig memory _storedConfig = entrypoint.assets(_asset);
    assertEq(_storedConfig.enabled, _config.enabled);
    assertEq(_storedConfig.minAmount, _config.minAmount);
    assertEq(_storedConfig.vettingFeeBPS, _config.vettingFeeBPS);
    assertEq(_storedConfig.maxRelayFee, _config.maxRelayFee);
  }

  /*///////////////////////////////////////////////////////////////
                          DEPOSIT
  ///////////////////////////////////////////////////////////////*/

  function test_Deposit_GivenAssetIsNotEnabled(address _asset, uint256 _value, uint256 _commitment) external {
    // Asset is not enabled by default (enabled = false)
    ProofLibV2.DepositProof memory _proof = _createDepositProof(_asset, _value, _commitment);

    // It should revert with Entrypoint_AssetNotEnabled
    vm.expectRevert(IEntrypoint.Entrypoint_AssetNotEnabled.selector);
    entrypoint.deposit(_proof, _defaultNoteData, _EMPTY_CIPHERTEXT);
  }

  function test_Deposit_GivenValueIsBelowMinimum(
    address _asset,
    uint256 _value,
    uint256 _commitment,
    uint256 _maxRelayFee
  ) external {
    assumeNotPrecompile(_asset);
    _value = bound(_value, 0, _MIN_AMOUNT - 1);
    entrypoint.setAssetConfigForTesting(
      _asset,
      IEntrypoint.AssetConfig({
        enabled: true, minAmount: _MIN_AMOUNT, vettingFeeBPS: _VETTING_FEE_BPS, maxRelayFee: _maxRelayFee
      })
    );

    ProofLibV2.DepositProof memory _proof = _createDepositProof(_asset, _value, _commitment);

    // It should revert with Entrypoint_BelowMinAmount
    vm.expectRevert(IEntrypoint.Entrypoint_BelowMinAmount.selector);
    entrypoint.deposit(_proof, _defaultNoteData, _EMPTY_CIPHERTEXT);
  }

  modifier givenAssetIsEnabledAndValueIsAboveMinimum() {
    _;
  }

  modifier whenAssetIsNativeDeposit() {
    entrypoint.setAssetConfigForTesting(
      Constants.NATIVE_ASSET,
      IEntrypoint.AssetConfig({
        enabled: true, minAmount: _MIN_AMOUNT, vettingFeeBPS: _VETTING_FEE_BPS, maxRelayFee: _MAX_RELAY_FEE
      })
    );
    _;
  }

  function _calculateFees(
    uint256 _value,
    uint256 _feeBPS
  ) internal pure returns (uint256 fee_, uint256 amountPlusFees_) {
    fee_ = (_value * _feeBPS) / FeeCalculator.MAX_FEE_BPS;
    amountPlusFees_ = _value + fee_;
  }

  function test_Deposit_GivenMsgValueDoesNotMatchAmountPlusFees(
    uint256 _value,
    uint256 _commitment,
    uint256 _wrongValue
  ) external givenAssetIsEnabledAndValueIsAboveMinimum whenAssetIsNativeDeposit {
    _value = bound(_value, _MIN_AMOUNT, type(uint128).max);

    (, uint256 _amountPlusFees) = _calculateFees(_value, _VETTING_FEE_BPS);
    _wrongValue = bound(_wrongValue, 0, type(uint128).max);
    vm.assume(_wrongValue != _amountPlusFees);

    ProofLibV2.DepositProof memory _proof = _createDepositProof(Constants.NATIVE_ASSET, _value, _commitment);

    // It should revert with Entrypoint_InvalidETHAmount
    vm.deal(address(this), _wrongValue);
    vm.expectRevert(IEntrypoint.Entrypoint_InvalidETHAmount.selector);
    entrypoint.deposit{value: _wrongValue}(_proof, _defaultNoteData, _EMPTY_CIPHERTEXT);
  }

  /// @dev No-op modifier for BTT compliance — test body must call deposit{value: amountPlusFees}
  modifier givenMsgValueMatchesAmountPlusFees() {
    _;
  }

  function test_Deposit_GivenMsgValueMatchesAmountPlusFees(
    uint256 _value,
    uint256 _commitment,
    address _caller
  ) external givenAssetIsEnabledAndValueIsAboveMinimum whenAssetIsNativeDeposit givenMsgValueMatchesAmountPlusFees {
    assumePayable(_caller);
    _value = bound(_value, _MIN_AMOUNT, type(uint128).max);

    (uint256 _fee, uint256 _amountPlusFees) = _calculateFees(_value, _VETTING_FEE_BPS);

    ProofLibV2.DepositProof memory _proof = _createDepositProof(Constants.NATIVE_ASSET, _value, _commitment);

    // It should call poolVault.deposit with correct value
    _mockAndExpect(mockPoolVault, _value, abi.encodeCall(IPoolVault.deposit, (_proof, _defaultNoteData)), abi.encode());

    // It should emit Deposited event
    vm.expectEmit();
    emit IEntrypoint.Deposited(Constants.NATIVE_ASSET, _caller, _value, _fee);

    vm.deal(_caller, _amountPlusFees);
    vm.prank(_caller);
    entrypoint.deposit{value: _amountPlusFees}(_proof, _defaultNoteData, _EMPTY_CIPHERTEXT);
  }

  function test_Deposit_WhenCiphertextIsEmpty(
    uint256 _value,
    uint256 _commitment,
    address _caller
  ) external givenAssetIsEnabledAndValueIsAboveMinimum whenAssetIsNativeDeposit givenMsgValueMatchesAmountPlusFees {
    assumePayable(_caller);
    _value = bound(_value, _MIN_AMOUNT, type(uint128).max);

    (, uint256 _amountPlusFees) = _calculateFees(_value, _VETTING_FEE_BPS);

    ProofLibV2.DepositProof memory _proof = _createDepositProof(Constants.NATIVE_ASSET, _value, _commitment);

    _mockAndExpect(mockPoolVault, _value, abi.encodeCall(IPoolVault.deposit, (_proof, _defaultNoteData)), abi.encode());

    // It should not call asp registry registerLabel
    vm.expectCall(mockAspRegistry, abi.encodeCall(IASPRegistry.registerLabel, (_EMPTY_CIPHERTEXT)), 0);

    vm.deal(_caller, _amountPlusFees);
    vm.prank(_caller);
    entrypoint.deposit{value: _amountPlusFees}(_proof, _defaultNoteData, _EMPTY_CIPHERTEXT);
  }

  function test_Deposit_WhenCiphertextIsNotEmpty(
    uint256 _value,
    uint256 _commitment,
    bytes calldata _ciphertext,
    address _caller
  ) external givenAssetIsEnabledAndValueIsAboveMinimum whenAssetIsNativeDeposit givenMsgValueMatchesAmountPlusFees {
    assumePayable(_caller);
    vm.assume(_ciphertext.length != 0);
    _value = bound(_value, _MIN_AMOUNT, type(uint128).max);

    (, uint256 _amountPlusFees) = _calculateFees(_value, _VETTING_FEE_BPS);

    ProofLibV2.DepositProof memory _proof = _createDepositProof(Constants.NATIVE_ASSET, _value, _commitment);

    _mockAndExpect(mockPoolVault, _value, abi.encodeCall(IPoolVault.deposit, (_proof, _defaultNoteData)), abi.encode());

    // It should read the authoritative ASP registry from poolVault
    _mockAndExpect(mockPoolVault, abi.encodeCall(IPoolVault.aspRegistry, ()), abi.encode(mockAspRegistry));
    // It should call asp registry registerLabel
    _mockAndExpect(mockAspRegistry, abi.encodeCall(IASPRegistry.registerLabel, (_ciphertext)), abi.encode());

    vm.deal(_caller, _amountPlusFees);
    vm.prank(_caller);
    entrypoint.deposit{value: _amountPlusFees}(_proof, _defaultNoteData, _ciphertext);
  }

  modifier whenAssetIsERC20(address _asset) {
    vm.assume(_asset != Constants.NATIVE_ASSET);
    assumeNotPrecompile(_asset);
    assumeNotForgeAddress(_asset);
    _;
  }

  function test_Deposit_WhenMsgValueIsNotZero(
    address _asset,
    uint256 _value,
    uint256 _commitment,
    address _caller,
    uint256 _msgValue
  ) external givenAssetIsEnabledAndValueIsAboveMinimum whenAssetIsERC20(_asset) {
    _value = bound(_value, _MIN_AMOUNT, type(uint128).max);
    _msgValue = bound(_msgValue, 1, type(uint128).max);
    entrypoint.setAssetConfigForTesting(
      _asset,
      IEntrypoint.AssetConfig({
        enabled: true, minAmount: _MIN_AMOUNT, vettingFeeBPS: _VETTING_FEE_BPS, maxRelayFee: _MAX_RELAY_FEE
      })
    );

    ProofLibV2.DepositProof memory _proof = _createDepositProof(_asset, _value, _commitment);

    // It should revert with Entrypoint_UnexpectedETHAmount
    vm.deal(_caller, _msgValue);
    vm.prank(_caller);
    vm.expectRevert(IEntrypoint.Entrypoint_UnexpectedETHAmount.selector);
    entrypoint.deposit{value: _msgValue}(_proof, _defaultNoteData, _EMPTY_CIPHERTEXT);
  }

  modifier whenMsgValueIsZero() {
    _;
  }

  function test_Deposit_WhenMsgValueIsZero(
    address _asset,
    uint256 _value,
    uint256 _commitment,
    address _caller,
    uint256 _minAmount,
    uint256 _vettingFeeBPS,
    uint256 _maxRelayFee
  ) external givenAssetIsEnabledAndValueIsAboveMinimum whenAssetIsERC20(_asset) whenMsgValueIsZero {
    _minAmount = bound(_minAmount, 1, 1 ether);
    _vettingFeeBPS = bound(_vettingFeeBPS, 0, FeeCalculator.MAX_FEE_BPS - 1);
    _value = bound(_value, _minAmount, type(uint128).max);
    entrypoint.setAssetConfigForTesting(
      _asset,
      IEntrypoint.AssetConfig({
        enabled: true, minAmount: _minAmount, vettingFeeBPS: _vettingFeeBPS, maxRelayFee: _maxRelayFee
      })
    );

    (uint256 _fee, uint256 _amountPlusFees) = _calculateFees(_value, _vettingFeeBPS);

    ProofLibV2.DepositProof memory _proof = _createDepositProof(_asset, _value, _commitment);

    // It should transfer tokens from caller
    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transferFrom, (_caller, address(entrypoint), _amountPlusFees)), abi.encode(true)
    );

    // It should call poolVault.deposit (already approved via setAssetConfiguration)
    _mockAndExpect(mockPoolVault, abi.encodeCall(IPoolVault.deposit, (_proof, _defaultNoteData)), abi.encode());

    // It should emit Deposited event
    vm.expectEmit();
    emit IEntrypoint.Deposited(_asset, _caller, _value, _fee);

    vm.prank(_caller);
    entrypoint.deposit{value: 0}(_proof, _defaultNoteData, _EMPTY_CIPHERTEXT);
  }

  function test_Deposit_WhenCiphertextIsEmpty_WhenMsgValueIsZero(
    address _asset,
    uint256 _value,
    uint256 _commitment,
    address _caller
  ) external givenAssetIsEnabledAndValueIsAboveMinimum whenAssetIsERC20(_asset) whenMsgValueIsZero {
    _value = bound(_value, _MIN_AMOUNT, type(uint128).max);
    entrypoint.setAssetConfigForTesting(
      _asset,
      IEntrypoint.AssetConfig({
        enabled: true, minAmount: _MIN_AMOUNT, vettingFeeBPS: _VETTING_FEE_BPS, maxRelayFee: _MAX_RELAY_FEE
      })
    );

    (, uint256 _amountPlusFees) = _calculateFees(_value, _VETTING_FEE_BPS);

    ProofLibV2.DepositProof memory _proof = _createDepositProof(_asset, _value, _commitment);

    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transferFrom, (_caller, address(entrypoint), _amountPlusFees)), abi.encode(true)
    );
    _mockAndExpect(mockPoolVault, abi.encodeCall(IPoolVault.deposit, (_proof, _defaultNoteData)), abi.encode());

    // It should not call asp registry registerLabel
    vm.expectCall(mockAspRegistry, abi.encodeCall(IASPRegistry.registerLabel, (_EMPTY_CIPHERTEXT)), 0);

    vm.prank(_caller);
    entrypoint.deposit{value: 0}(_proof, _defaultNoteData, _EMPTY_CIPHERTEXT);
  }

  function test_Deposit_WhenCiphertextIsNotEmpty_WhenMsgValueIsZero(
    address _asset,
    uint256 _value,
    uint256 _commitment,
    bytes calldata _ciphertext,
    address _caller
  ) external givenAssetIsEnabledAndValueIsAboveMinimum whenAssetIsERC20(_asset) whenMsgValueIsZero {
    vm.assume(_ciphertext.length != 0);
    _value = bound(_value, _MIN_AMOUNT, type(uint128).max);
    entrypoint.setAssetConfigForTesting(
      _asset,
      IEntrypoint.AssetConfig({
        enabled: true, minAmount: _MIN_AMOUNT, vettingFeeBPS: _VETTING_FEE_BPS, maxRelayFee: _MAX_RELAY_FEE
      })
    );

    (, uint256 _amountPlusFees) = _calculateFees(_value, _VETTING_FEE_BPS);

    ProofLibV2.DepositProof memory _proof = _createDepositProof(_asset, _value, _commitment);

    _mockAndExpect(
      _asset, abi.encodeCall(IERC20.transferFrom, (_caller, address(entrypoint), _amountPlusFees)), abi.encode(true)
    );
    _mockAndExpect(mockPoolVault, abi.encodeCall(IPoolVault.deposit, (_proof, _defaultNoteData)), abi.encode());

    // It should read the authoritative ASP registry from poolVault
    _mockAndExpect(mockPoolVault, abi.encodeCall(IPoolVault.aspRegistry, ()), abi.encode(mockAspRegistry));
    // It should call asp registry registerLabel
    _mockAndExpect(mockAspRegistry, abi.encodeCall(IASPRegistry.registerLabel, (_ciphertext)), abi.encode());

    vm.prank(_caller);
    entrypoint.deposit{value: 0}(_proof, _defaultNoteData, _ciphertext);
  }

  /*///////////////////////////////////////////////////////////////
                        UPGRADE TO AND CALL
  ///////////////////////////////////////////////////////////////*/

  function test_UpgradeToAndCall_GivenCallerDoesNotHaveUPGRADER_ROLE(
    address _caller,
    address _newImplementation
  ) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);

    // It should revert with Permissioned_NotAuthorized
    vm.prank(_caller);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    entrypoint.upgradeToAndCall(_newImplementation, '');
  }

  function test_UpgradeToAndCall_GivenCallerHasUPGRADER_ROLE(address _caller) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    Entrypoint newImplementation = new Entrypoint(IAccessControl(mockAccessRouter));

    // It should upgrade successfully
    vm.prank(_caller);
    entrypoint.upgradeToAndCall(address(newImplementation), '');

    assertEq(
      address(uint160(uint256(vm.load(address(entrypoint), ERC1967Utils.IMPLEMENTATION_SLOT)))),
      address(newImplementation)
    );
  }

  /*///////////////////////////////////////////////////////////////
                      SET POOL VAULT
  ///////////////////////////////////////////////////////////////*/

  function test_SetPoolVault_GivenCallerDoesNotHaveUPGRADER_ROLE(address _caller, address _newPoolVault) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);

    // It should revert with Permissioned_NotAuthorized
    vm.prank(_caller);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    entrypoint.setPoolVault(IPoolVault(_newPoolVault));
  }

  function test_SetPoolVault_GivenCallerHasUPGRADER_ROLE(address _caller, address _newPoolVault) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    // It should emit PoolVaultSet event
    vm.expectEmit();
    emit IEntrypoint.PoolVaultSet(mockPoolVault, _newPoolVault);

    vm.prank(_caller);
    entrypoint.setPoolVault(IPoolVault(_newPoolVault));

    // It should set the pool vault
    assertEq(address(entrypoint.poolVault()), _newPoolVault);
  }
}
