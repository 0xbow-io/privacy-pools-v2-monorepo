// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {UUPSUpgradeable} from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';
import {FeeCalculator} from 'src/abstracts/FeeCalculator.sol';
import {Permissioned} from 'src/abstracts/Permissioned.sol';
import {Constants} from 'src/utils/Constants.sol';
import {ENTRYPOINT_MANAGER_ROLE, UPGRADER_ROLE} from 'src/utils/RolesConstants.sol';

/// @title Entrypoint
/// @notice Main entry point for Privacy Pools V2 operations
contract Entrypoint is IEntrypoint, UUPSUpgradeable, Permissioned {
  using ProofLibV2 for ProofLibV2.DepositProof;
  using SafeTransferLib for address;

  /*///////////////////////////////////////////////////////////////
                              STORAGE
  ///////////////////////////////////////////////////////////////*/

  /// @notice ERC-7201 storage location for Entrypoint
  // keccak256(abi.encode(uint256(keccak256("privacypools.storage.Entrypoint")) - 1)) & ~bytes32(uint256(0xff))
  // solhint-disable-next-line private-vars-leading-underscore
  bytes32 private constant ENTRYPOINT_STORAGE_LOCATION =
    0x61fa3262fa493105ad395cc10b8413cae88ff4e1081692c2320663f8246ca400;

  /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  /// @notice Initializes the Entrypoint contract with immutable references
  /// @param _accessRouter The address of the access control router
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IAccessControl _accessRouter) Permissioned(_accessRouter) {
    _disableInitializers();
  }

  /*///////////////////////////////////////////////////////////////
                            INITIALIZER
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IEntrypoint
  function initialize(IPoolVault _poolVault) external initializer {
    __UUPSUpgradeable_init();
    _getEntrypointStorage().poolVault = _poolVault;
  }

  /*///////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IEntrypoint
  function deposit(
    ProofLibV2.DepositProof calldata _proof,
    IPoolVault.NoteData calldata _noteData,
    bytes calldata _aspCiphertext
  ) external payable {
    address _asset = _proof.tokenId();
    uint256 _value = _proof.value();
    EntrypointStorage storage $ = _getEntrypointStorage();
    AssetConfig storage _config = $.assetConfigs[_asset];

    // Validate asset configuration
    require(_config.enabled, Entrypoint_AssetNotEnabled());
    require(_value >= _config.minAmount, Entrypoint_BelowMinAmount());

    // Calculate vetting fee
    uint256 _fee = FeeCalculator.calcFee(_value, _config.vettingFeeBPS);
    uint256 _amountPlusFees = _value + _fee;

    if (_asset == Constants.NATIVE_ASSET) {
      // Native ETH deposit
      require(msg.value == _amountPlusFees, Entrypoint_InvalidETHAmount());
      // Forward deposit value to PoolVault (fees stay in Entrypoint)
      $.poolVault.deposit{value: _value}(_proof, _noteData);
    } else {
      // ERC20 deposit
      require(msg.value == 0, Entrypoint_UnexpectedETHAmount());
      // Pull deposit amount + fee from caller
      _asset.safeTransferFrom(msg.sender, address(this), _amountPlusFees);
      // Deposit into PoolVault (already approved via setAssetConfiguration)
      $.poolVault.deposit(_proof, _noteData);
    }

    emit Deposited({_asset: _asset, _depositor: msg.sender, _value: _value, _fee: _fee});
    // Read the authoritative ASP registry from PoolVault so there is a single source of truth.
    if (_aspCiphertext.length != 0) $.poolVault.aspRegistry().registerLabel(_aspCiphertext);
  }

  /// @inheritdoc IEntrypoint
  function sweep(address _asset, address _recipient) external checkAccess(ENTRYPOINT_MANAGER_ROLE) {
    uint256 _amount;

    if (_asset == Constants.NATIVE_ASSET) {
      _amount = address(this).balance;
      _recipient.safeTransferETH(_amount);
    } else {
      _amount = _asset.balanceOf(address(this));
      _asset.safeTransfer(_recipient, _amount);
    }

    emit Swept(_asset, _recipient, _amount);
  }

  /// @inheritdoc IEntrypoint
  function setAssetConfiguration(
    address _asset,
    AssetConfig calldata _config
  ) external checkAccess(ENTRYPOINT_MANAGER_ROLE) {
    require(_config.vettingFeeBPS < FeeCalculator.MAX_FEE_BPS, Entrypoint_InvalidFeeBPS());
    // Enforce a positive `minAmount` when the asset is enabled
    require(!_config.enabled || _config.minAmount != 0, Entrypoint_InvalidMinAmount());
    EntrypointStorage storage $ = _getEntrypointStorage();
    $.assetConfigs[_asset] = _config;

    // Manage PoolVault allowance for ERC20 assets
    if (_asset != Constants.NATIVE_ASSET) {
      if (_config.enabled) {
        _asset.safeApproveWithRetry(address($.poolVault), type(uint256).max);
      } else {
        _asset.safeApproveWithRetry(address($.poolVault), 0);
      }
    }

    emit AssetConfigurationSet(_asset, _config);
  }

  /// @inheritdoc IEntrypoint
  function setPoolVault(IPoolVault _poolVault) external checkAccess(UPGRADER_ROLE) {
    EntrypointStorage storage $ = _getEntrypointStorage();
    address _previous = address($.poolVault);
    $.poolVault = _poolVault;
    emit PoolVaultSet(_previous, address(_poolVault));
  }

  /// @inheritdoc IEntrypoint
  function assets(address _asset) external view returns (AssetConfig memory _config) {
    _config = _getEntrypointStorage().assetConfigs[_asset];
  }

  /// @inheritdoc IEntrypoint
  function poolVault() external view returns (IPoolVault _poolVault) {
    _poolVault = _getEntrypointStorage().poolVault;
  }

  /// @inheritdoc UUPSUpgradeable
  function _authorizeUpgrade(address) internal override checkAccess(UPGRADER_ROLE) {}

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Returns a pointer to the ERC-7201 namespaced storage for Entrypoint
  /// @return $ Storage pointer to EntrypointStorage
  function _getEntrypointStorage() internal pure returns (EntrypointStorage storage $) {
    assembly {
      $.slot := ENTRYPOINT_STORAGE_LOCATION
    }
  }
}
