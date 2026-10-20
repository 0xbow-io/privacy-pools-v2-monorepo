// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {ITreeUpdates} from 'interfaces/ITreeUpdates.sol';
import {LeanIMTData} from 'lean-imt/LeanIMT.sol';

/// @title IKeystore
/// @notice Interface for the Keystore contract that manages authentication policies
/// @dev Uses a Lean Incremental Merkle Tree to store auth policy leaves.
///      Each superseded root stores an absolute `validUntil` deadline at supersession time
interface IKeystore is IPermissioned, ITreeUpdates {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  //////////////////////////////////////////////////////////////*/

  /// @notice ERC-7201 namespaced storage for Keystore root tracking
  /// @param currentRoot The latest keystore Merkle root
  /// @param keystoreRootLiveness Grace window (seconds) during which a superseded root remains valid
  /// @param maxKeystoreTreeSize Maximum number of leaves the keystore Merkle tree can hold (`2^keystoreMaxDepth`)
  /// @param previousRoots Mapping from superseded root to its expiry deadline
  /// @param keystoreTree LeanIMT storing auth policy leaves
  /// @param nullifyingKeys Mapping of account address to its nullifying key hash
  /// @param viewingKeys Mapping of account address to its viewing key
  /// @custom:storage-location erc7201:privacypools.storage.KeystoreRoot
  struct KeystoreRootStorage {
    uint256 currentRoot;
    uint256 keystoreRootLiveness;
    uint256 maxKeystoreTreeSize;
    mapping(uint256 root => uint256 validUntil) previousRoots;
    LeanIMTData keystoreTree;
    mapping(address account => uint256 nullifyingKeyHash) nullifyingKeys;
    mapping(address account => bytes32 viewingKey) viewingKeys;
  }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  //////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a user sets their authentication policy
  /// @param _account The address of the user setting the policy
  /// @param _nullifyingKeyHash The hash of the nullifying key
  /// @param _authDigest The authentication digest
  event AuthPolicySet(address indexed _account, uint256 _nullifyingKeyHash, uint256 _authDigest);

  /// @notice Emitted when a user updates their authentication policy
  /// @param _account The address of the user updating the policy
  /// @param _oldAuthDigest The previous authentication digest
  /// @param _authDigest The new authentication digest
  event AuthPolicyUpdated(address indexed _account, uint256 _oldAuthDigest, uint256 _authDigest);

  /// @notice Emitted when a user sets or updates their viewing key
  /// @param _account The address of the user
  /// @param _oldViewingKey The previous viewing key (bytes32(0) if first time)
  /// @param _newViewingKey The new viewing key
  event ViewingKeySet(address indexed _account, bytes32 _oldViewingKey, bytes32 _newViewingKey);

  /// @notice Emitted when a new root replaces the current one
  /// @param _oldRoot The root that was superseded (0 on first insertion)
  /// @param _newRoot The root that is now current
  /// @param _oldRootValidUntil Expiry deadline for `_oldRoot` (accepted by `isKnownRoot` while
  ///        `block.timestamp < _oldRootValidUntil`); 0 on first insertion (no prior root to supersede)
  event RootSuperseded(uint256 indexed _oldRoot, uint256 indexed _newRoot, uint256 _oldRootValidUntil);

  /// @notice Emitted when the keystore root liveness window is updated
  /// @param _previousLiveness The old liveness value in seconds
  /// @param _newLiveness The new liveness value in seconds
  event KeystoreRootLivenessUpdated(uint256 _previousLiveness, uint256 _newLiveness);

  /// @notice Emitted when the max keystore tree size is updated
  /// @param _previousSize The old maximum size
  /// @param _newSize The new maximum size
  event MaxKeystoreTreeSizeUpdated(uint256 _previousSize, uint256 _newSize);

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /// @notice Thrown when a user attempts to set an auth policy when one already exists
  error Keystore_AuthPolicyAlreadySet();

  /// @notice Thrown when a user attempts to update an auth policy before registering one via setAuthPolicy
  error Keystore_AuthPolicyNotSet();

  /// @notice Thrown when nullifying key hash is zero
  error Keystore_InvalidNullifyingKeyHash();

  /// @notice Thrown when a value exceeds the snark scalar field
  error Keystore_OutOfScalarField();

  /// @notice Thrown when a keystore tree insertion would exceed `maxKeystoreTreeSize` capacity
  error Keystore_KeystoreTreeFull();

  /// @notice Thrown when `setMaxKeystoreTreeSize` is called with a value `<=` the current tree size
  error Keystore_InvalidMaxTreeSize();

  /// @notice Thrown when the EIP-712 signature in `setAuthPolicyWithSig` is not valid for `_account`
  error Keystore_InvalidSignature();

  /// @notice Thrown when `setAuthPolicyWithSig` is called after the signed `_deadline`
  error Keystore_SignatureExpired();

  /*///////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Initializes the Keystore contract
  /// @param _keystoreRootLiveness The grace window (in seconds) during which a superseded root remains valid
  /// @param _maxKeystoreTreeSize The initial maximum keystore tree size cap (`2^keystoreMaxDepth`)
  function initialize(uint256 _keystoreRootLiveness, uint256 _maxKeystoreTreeSize) external;

  /// @notice Initializes the EIP-712 domain on an already-deployed proxy
  /// @dev `reinitializer(2)` upgrade hook for proxies initialized before `setAuthPolicyWithSig` existed.
  ///      Sets the domain (name `PrivacyPoolsKeystore`, version `1`) so relayed signatures verify
  ///      against the correct separator. Fresh deploys get the domain from `initialize`; this is a no-op
  ///      for them since `initializer` already consumed version 1.
  function initializeEIP712() external;

  /// @notice Sets the authentication policy for the caller
  /// @dev Can only be called once per address. Computes the auth leaf as:
  ///      PoseidonT4(msg.sender, nullifyingKeyHash, authDigest)
  /// @param _authDigest The authentication digest
  /// @param _nullifyingKeyHash The hash of the nullifying key
  function setAuthPolicy(uint256 _authDigest, uint256 _nullifyingKeyHash) external;

  /// @notice Sets the authentication policy for `_account` on its behalf, authorized by an EIP-712 signature
  /// @dev Lets any caller pay gas to register `_account` (e.g. a fresh, unfunded recipient address). The leaf
  ///      still binds `_account` because its signature authorizes the exact key material. Computes the auth leaf as:
  ///      PoseidonT4(_account, nullifyingKeyHash, authDigest), identical to `setAuthPolicy`. Verification uses
  ///      `SignatureChecker`, so `_account` may be an EOA or an EIP-1271 contract wallet. The one-time
  ///      `nullifyingKeys[_account] == 0` guard prevents replay after a successful registration, and the signed
  ///      `_deadline` bounds how long a signed-but-unsubmitted authorization can be used to bind `_account` to a
  ///      possibly-abandoned key (staleness protection); no per-account nonce is needed.
  /// @param _account The account being registered (leaf owner and signer)
  /// @param _authDigest The authentication digest
  /// @param _nullifyingKeyHash The hash of the nullifying key
  /// @param _deadline The unix timestamp after which the signature is no longer valid
  /// @param _signature The EIP-712 signature by `_account` over `SET_AUTH_POLICY_TYPEHASH`
  function setAuthPolicyWithSig(
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _deadline,
    bytes calldata _signature
  ) external;

  /// @notice Updates the authentication policy for the caller
  /// @dev Can only be called if an auth policy has already been set. Recomputes the old leaf as:
  ///      PoseidonT4(msg.sender, nullifyingKeyHash[msg.sender], _oldAuthDigest)
  ///      This ensures the caller can only update their own leaf.
  /// @param _oldAuthDigest The previous authentication digest
  /// @param _updatedAuthDigest The new authentication digest
  /// @param _siblingNodes Inclusion proof of the old auth leaf
  function updateAuthPolicy(
    uint256 _oldAuthDigest,
    uint256 _updatedAuthDigest,
    uint256[] calldata _siblingNodes
  ) external;

  /// @notice Sets or updates the viewing key for the caller
  /// @param _viewingKey The new viewing key, or `bytes32(0)` to disable
  function setViewingKey(bytes32 _viewingKey) external;

  /// @notice Updates the keystore root liveness window
  /// @dev Only callable by addresses with UPGRADER_ROLE.
  ///      Applies to supersessions that happen after this call; roots already in
  ///      `previousRoots` retain the `validUntil` frozen at their supersession time.
  /// @param _keystoreRootLiveness The new liveness value in seconds
  function setKeystoreRootLiveness(uint256 _keystoreRootLiveness) external;

  /// @notice Updates the maximum keystore tree size cap
  /// @dev Only callable by addresses with UPGRADER_ROLE. Must stay in lockstep with the circuit
  ///      parameter `keystoreMaxDepth` (`2^keystoreMaxDepth`); raising the cap above the circuit
  ///      capacity leaves proofs beyond the circuit limit unverifiable. Reverts with
  ///      `Keystore_InvalidMaxTreeSize` if the new cap is `<=` the current tree size.
  /// @param _maxKeystoreTreeSize The new maximum size (typically a power of two)
  function setMaxKeystoreTreeSize(uint256 _maxKeystoreTreeSize) external;

  /*///////////////////////////////////////////////////////////////
                        EXTERNAL VIEW FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice The EIP-712 type hash for a relayed `setAuthPolicyWithSig` authorization
  /// @return _typeHash The `SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)` type hash
  function SET_AUTH_POLICY_TYPEHASH() external view returns (bytes32 _typeHash);

  /// @notice Maximum number of leaves the keystore Merkle tree can hold
  /// @dev Must stay in lockstep with the circuit parameter (`2^keystoreMaxDepth`).
  /// @return _maxSize The configured cap
  function maxKeystoreTreeSize() external view returns (uint256 _maxSize);

  /// @notice Returns the nullifying key hash for an account
  /// @param _account The account to query
  /// @return _nullifyingKeyHash The nullifying key hash (0 if not set)
  function nullifyingKeys(address _account) external view returns (uint256 _nullifyingKeyHash);

  /// @notice Returns the viewing key for an account
  /// @param _account The account to query
  /// @return _viewingKey The viewing key (bytes32(0) if not set)
  function viewingKeys(address _account) external view returns (bytes32 _viewingKey);

  /// @notice Returns the latest keystore Merkle root
  /// @return _root The current root
  function currentRoot() external view returns (uint256 _root);

  /// @notice Returns the `validUntil` deadline for a superseded root (0 if never superseded)
  /// @param _root The root to query
  /// @return _validUntil The expiry deadline (accepted by `isKnownRoot` while `block.timestamp < _validUntil`)
  function previousRoots(uint256 _root) external view returns (uint256 _validUntil);

  /// @notice Returns the liveness window for superseded roots
  /// @return _liveness The grace period in seconds
  function keystoreRootLiveness() external view returns (uint256 _liveness);

  /// @notice Checks if a root is valid (current or within its `validUntil` deadline)
  /// @param _root The root to check
  /// @return _isKnown True if the root is valid
  function isKnownRoot(uint256 _root) external view returns (bool _isKnown);
}
