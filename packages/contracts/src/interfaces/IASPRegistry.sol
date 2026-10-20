// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IPermissioned} from 'interfaces/IPermissioned.sol';

interface IASPRegistry is IPermissioned {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  //////////////////////////////////////////////////////////////*/

  /// @notice Data stored for each association set
  /// @param root The ASP Merkle root
  /// @param ipfsCID IPFS CID pointing to the full association set data
  struct AssociationSetData {
    uint256 root;
    bytes ipfsCID;
  }

  /// @notice ERC-7201 namespaced storage for the ASP registry
  /// @param associationSets Append-only array of all previous ASP roots and their IPFS CIDs
  /// @custom:storage-location erc7201:privacypools.storage.ASPRegistry
  struct ASPRegistryStorage {
    AssociationSetData[] associationSets;
  }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  //////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a new ASP root is added to the registry
  /// @param _root The new ASP root value
  /// @param _ipfsCID The IPFS CID pointing to the full association set data
  event ASPRootUpdated(uint256 indexed _root, bytes _ipfsCID);

  /// @notice Emitted when label-registration ciphertext is published for the ASP
  /// @param _ciphertext Same encoding as `registerLabel`
  event LabelRegistered(bytes _ciphertext);

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /// @notice Thrown when attempting to update with a zero ASP root
  error ASPRegistry_EmptyASPRoot();

  /// @notice Thrown when attempting to update with an empty IPFS CID
  error ASPRegistry_EmptyIPFSCID();

  /// @notice Thrown when the submitted root is not a valid BN254 scalar field element
  error ASPRegistry_RootOutOfField();

  /// @notice Thrown when querying latest data from an empty association set
  error ASPRegistry_EmptyAssociationSet();

  /*///////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Initializes the ASP registry
  function initialize() external;

  /// @notice Add a new asp root
  /// @dev Only callable by POSTMAN_ROLE
  /// @param _aspRoot New root of the association set provider to save
  /// @param _ipfsCID Where to find the rest of the tree
  function updateASPRoot(uint256 _aspRoot, bytes calldata _ipfsCID) external;

  /// @notice Register a label with encrypted ciphertext - emits ciphertext that only the ASP can read
  /// @param _ciphertext The encrypted label data to register
  /// @dev Permissionless. _ciphertext is encrypted by the user, using the ASP's public key.
  /// It contains `{label, deposit_commitment, registrationSecret}`
  /// so the ASP can verify the label and decide whether to add it to the association set.
  function registerLabel(bytes calldata _ciphertext) external;

  /// @notice Append-only array of all previous ASP Roots
  /// @param _index Requested root
  /// @return _data Root and ipfsCID data for the requested root
  function associationSets(uint256 _index) external view returns (AssociationSetData memory _data);

  /// @notice Used by the poolvault to know if proofs point to approved roots
  /// @dev Will revert if ASP set is empty
  /// @return _root The latest ASP root
  function latestASPRoot() external view returns (uint256 _root);

  /// @notice Returns the IPFS CID of the latest association set
  /// @dev Will revert if ASP set is empty
  /// @return _ipfsCID The IPFS CID of the latest association set
  function latestIPFSCID() external view returns (bytes memory _ipfsCID);
}
