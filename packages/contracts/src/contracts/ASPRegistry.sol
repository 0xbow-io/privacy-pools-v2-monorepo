// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {UUPSUpgradeable} from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {Permissioned} from 'src/abstracts/Permissioned.sol';
import {POSTMAN_ROLE, UPGRADER_ROLE} from 'src/utils/RolesConstants.sol';

import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';

/// @title ASPRegistry
/// @notice Permanent repository of current and previous Association Set
/// Provider roots, where Postman submit new ones and Pools fetch the latest
/// one to validate their usage as the end node of inclusion proofs.
contract ASPRegistry is IASPRegistry, UUPSUpgradeable, Permissioned {
  /*///////////////////////////////////////////////////////////////
                              STORAGE
  //////////////////////////////////////////////////////////////*/

  /// @notice ERC-7201 storage location for ASPRegistry
  // keccak256(abi.encode(uint256(keccak256("privacypools.storage.ASPRegistry")) - 1)) & ~bytes32(uint256(0xff))
  // solhint-disable-next-line private-vars-leading-underscore
  bytes32 private constant ASP_REGISTRY_STORAGE_LOCATION =
    0x890ea4c131a660a04ac8f6acc2619f7fa794af4d37681fd0760d8f3edb520900;

  /*///////////////////////////////////////////////////////////////
                            CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

  /// @notice Initializes the ASPRegistry contract with immutable references
  /// @param _accessRouter The address of the access control router
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IAccessControl _accessRouter) Permissioned(_accessRouter) {
    _disableInitializers();
  }

  /*///////////////////////////////////////////////////////////////
                            INITIALIZER
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IASPRegistry
  function initialize() external initializer {
    __UUPSUpgradeable_init();
  }

  /*///////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IASPRegistry
  function updateASPRoot(uint256 _aspRoot, bytes calldata _ipfsCID) external override checkAccess(POSTMAN_ROLE) {
    require(_aspRoot != 0, ASPRegistry_EmptyASPRoot());
    require(_aspRoot < SNARK_SCALAR_FIELD, ASPRegistry_RootOutOfField());
    require(_ipfsCID.length != 0, ASPRegistry_EmptyIPFSCID());

    _getASPRegistryStorage().associationSets.push(AssociationSetData({root: _aspRoot, ipfsCID: _ipfsCID}));
    emit ASPRootUpdated(_aspRoot, _ipfsCID);
  }

  /// @inheritdoc IASPRegistry
  function registerLabel(bytes calldata _ciphertext) external override {
    emit LabelRegistered(_ciphertext);
  }

  /// @inheritdoc IASPRegistry
  function latestASPRoot() external view override returns (uint256 _root) {
    AssociationSetData[] storage _associationSets = _getASPRegistryStorage().associationSets;
    require(_associationSets.length != 0, ASPRegistry_EmptyAssociationSet());
    _root = _associationSets[_associationSets.length - 1].root;
  }

  /// @inheritdoc IASPRegistry
  function latestIPFSCID() external view override returns (bytes memory _ipfsCID) {
    AssociationSetData[] storage _associationSets = _getASPRegistryStorage().associationSets;
    require(_associationSets.length != 0, ASPRegistry_EmptyAssociationSet());
    _ipfsCID = _associationSets[_associationSets.length - 1].ipfsCID;
  }

  /// @inheritdoc IASPRegistry
  function associationSets(uint256 _index) external view returns (AssociationSetData memory _data) {
    _data = _getASPRegistryStorage().associationSets[_index];
  }

  /*///////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc UUPSUpgradeable
  function _authorizeUpgrade(address) internal override checkAccess(UPGRADER_ROLE) {}

  /// @notice Returns a pointer to the ERC-7201 namespaced storage for ASPRegistry
  /// @return $ Storage pointer to ASPRegistryStorage
  function _getASPRegistryStorage() internal pure returns (ASPRegistryStorage storage $) {
    assembly {
      $.slot := ASP_REGISTRY_STORAGE_LOCATION
    }
  }
}

