// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {UUPSUpgradeable} from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';
import {EIP712Upgradeable} from '@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {SignatureChecker} from '@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol';

import {LeanIMT, LeanIMTData} from '@lean-imt/LeanIMT.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';

import {IKeystore} from 'interfaces/IKeystore.sol';
import {Permissioned} from 'src/abstracts/Permissioned.sol';

import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {UPGRADER_ROLE} from 'utils/RolesConstants.sol';

/// @title Keystore
/// @notice Contract for managing user authentication policies in a Merkle tree
/// @dev Root history uses a liveness-gated scheme: each superseded root remains valid
///   for `keystoreRootLiveness` seconds after replacement (set as `ValidUntil` at the moment of supersession)
contract Keystore is IKeystore, UUPSUpgradeable, EIP712Upgradeable, Permissioned {
  using LeanIMT for LeanIMTData;

  /*///////////////////////////////////////////////////////////////
                              CONSTANTS
  //////////////////////////////////////////////////////////////*/

  /// @dev The domain separator (name `PrivacyPoolsKeystore`, version `1`) binds `chainId` and
  ///   `verifyingContract`; the struct carries the key material being registered plus a `deadline` that
  ///   bounds how long a signed-but-unsubmitted authorization stays usable (staleness protection).
  /// @inheritdoc IKeystore
  bytes32 public constant SET_AUTH_POLICY_TYPEHASH =
    keccak256('SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)');

  /*///////////////////////////////////////////////////////////////
                            ERC-7201 STORAGE
  //////////////////////////////////////////////////////////////*/

  /// @notice ERC-7201 storage location for KeystoreRoot
  // keccak256(abi.encode(uint256(keccak256("privacypools.storage.KeystoreRoot")) - 1)) & ~bytes32(uint256(0xff))
  // solhint-disable-next-line private-vars-leading-underscore
  bytes32 private constant KEYSTORE_ROOT_STORAGE_LOCATION =
    0xd7904822708f6928a6dec4844279bbaadb35de7dca8467240c2eea392971fc00;

  /*///////////////////////////////////////////////////////////////
                              CONSTRUCTOR
  //////////////////////////////////////////////////////////////*/

  /// @notice Initializes the Keystore contract with immutable references
  /// @param _accessRouter The address of the access control router
  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(IAccessControl _accessRouter) Permissioned(_accessRouter) {
    _disableInitializers();
  }

  /*///////////////////////////////////////////////////////////////
                              INITIALIZER
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IKeystore
  function initialize(uint256 _keystoreRootLiveness, uint256 _maxKeystoreTreeSize) external initializer {
    __UUPSUpgradeable_init();
    __EIP712_init('PrivacyPoolsKeystore', '1');
    KeystoreRootStorage storage $ = _getKeystoreRootStorage();
    $.keystoreRootLiveness = _keystoreRootLiveness;
    $.maxKeystoreTreeSize = _maxKeystoreTreeSize;
  }

  /// @inheritdoc IKeystore
  function initializeEIP712() external reinitializer(2) {
    __EIP712_init('PrivacyPoolsKeystore', '1');
  }

  /*///////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IKeystore
  function setAuthPolicy(uint256 _authDigest, uint256 _nullifyingKeyHash) external {
    _setAuthPolicy(msg.sender, _authDigest, _nullifyingKeyHash);
  }

  /// @inheritdoc IKeystore
  function setAuthPolicyWithSig(
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _deadline,
    bytes calldata _signature
  ) external {
    require(block.timestamp <= _deadline, Keystore_SignatureExpired());
    bytes32 _digest = _hashTypedDataV4(
      keccak256(abi.encode(SET_AUTH_POLICY_TYPEHASH, _account, _authDigest, _nullifyingKeyHash, _deadline))
    );
    require(SignatureChecker.isValidSignatureNow(_account, _digest, _signature), Keystore_InvalidSignature());
    _setAuthPolicy(_account, _authDigest, _nullifyingKeyHash);
  }

  /// @inheritdoc IKeystore
  function updateAuthPolicy(
    uint256 _oldAuthDigest,
    uint256 _updatedAuthDigest,
    uint256[] calldata _siblingNodes
  ) external {
    require(_oldAuthDigest < SNARK_SCALAR_FIELD, Keystore_OutOfScalarField());
    require(_updatedAuthDigest < SNARK_SCALAR_FIELD, Keystore_OutOfScalarField());
    uint256 _nullifyingKeyHash = _getKeystoreRootStorage().nullifyingKeys[msg.sender];
    require(_nullifyingKeyHash != 0, Keystore_AuthPolicyNotSet());

    uint256 _oldAuthLeaf = PoseidonT4.hash([uint256(uint160(msg.sender)), _nullifyingKeyHash, _oldAuthDigest]);
    uint256 _newAuthLeaf = PoseidonT4.hash([uint256(uint160(msg.sender)), _nullifyingKeyHash, _updatedAuthDigest]);
    (uint256 _root, uint256 _index) = _updateTree(_oldAuthLeaf, _newAuthLeaf, _siblingNodes);

    _updateRoot(_root);

    emit LeafUpdated(_newAuthLeaf, _root, _index);
    emit AuthPolicyUpdated(msg.sender, _oldAuthDigest, _updatedAuthDigest);
  }

  /// @inheritdoc IKeystore
  function setViewingKey(bytes32 _viewingKey) external {
    KeystoreRootStorage storage $ = _getKeystoreRootStorage();
    bytes32 _oldKey = $.viewingKeys[msg.sender];
    $.viewingKeys[msg.sender] = _viewingKey;
    emit ViewingKeySet(msg.sender, _oldKey, _viewingKey);
  }

  /// @inheritdoc IKeystore
  function setKeystoreRootLiveness(uint256 _keystoreRootLiveness) external checkAccess(UPGRADER_ROLE) {
    KeystoreRootStorage storage $ = _getKeystoreRootStorage();
    uint256 _previous = $.keystoreRootLiveness;
    $.keystoreRootLiveness = _keystoreRootLiveness;
    emit KeystoreRootLivenessUpdated(_previous, _keystoreRootLiveness);
  }

  /// @inheritdoc IKeystore
  function setMaxKeystoreTreeSize(uint256 _maxKeystoreTreeSize) external checkAccess(UPGRADER_ROLE) {
    KeystoreRootStorage storage $ = _getKeystoreRootStorage();
    require(_maxKeystoreTreeSize > $.keystoreTree.size, Keystore_InvalidMaxTreeSize());
    uint256 _previous = $.maxKeystoreTreeSize;
    $.maxKeystoreTreeSize = _maxKeystoreTreeSize;
    emit MaxKeystoreTreeSizeUpdated(_previous, _maxKeystoreTreeSize);
  }

  /*///////////////////////////////////////////////////////////////
                        EXTERNAL VIEW FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IKeystore
  function currentRoot() external view returns (uint256 _root) {
    _root = _getKeystoreRootStorage().currentRoot;
  }

  /// @inheritdoc IKeystore
  function previousRoots(uint256 _root) external view returns (uint256 _validUntil) {
    _validUntil = _getKeystoreRootStorage().previousRoots[_root];
  }

  /// @inheritdoc IKeystore
  function keystoreRootLiveness() external view returns (uint256 _liveness) {
    _liveness = _getKeystoreRootStorage().keystoreRootLiveness;
  }

  /// @inheritdoc IKeystore
  function maxKeystoreTreeSize() external view returns (uint256 _maxSize) {
    _maxSize = _getKeystoreRootStorage().maxKeystoreTreeSize;
  }

  /// @inheritdoc IKeystore
  function nullifyingKeys(address _account) external view returns (uint256 _nullifyingKeyHash) {
    _nullifyingKeyHash = _getKeystoreRootStorage().nullifyingKeys[_account];
  }

  /// @inheritdoc IKeystore
  function viewingKeys(address _account) external view returns (bytes32 _viewingKey) {
    _viewingKey = _getKeystoreRootStorage().viewingKeys[_account];
  }

  /// @inheritdoc IKeystore
  function isKnownRoot(uint256 _root) external view returns (bool _isKnown) {
    // _isKnown defaults to false when _root == 0 or is an unknown root
    if (_root != 0) {
      KeystoreRootStorage storage $ = _getKeystoreRootStorage();
      _isKnown = _root == $.currentRoot || block.timestamp < $.previousRoots[_root];
    }
  }

  /*///////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc UUPSUpgradeable
  function _authorizeUpgrade(address) internal override checkAccess(UPGRADER_ROLE) {}

  /// @notice Registers an auth policy leaf for `_account`, shared by the direct and relayed paths
  /// @dev Every guard, the leaf, and the emitted event are keyed on `_account` (not `msg.sender`),
  ///   so the relayed path produces an on-chain result indistinguishable from self-registration.
  /// @param _account The account being registered (leaf owner)
  /// @param _authDigest The authentication digest
  /// @param _nullifyingKeyHash The hash of the nullifying key
  function _setAuthPolicy(address _account, uint256 _authDigest, uint256 _nullifyingKeyHash) internal {
    require(_authDigest < SNARK_SCALAR_FIELD, Keystore_OutOfScalarField());
    require(_nullifyingKeyHash < SNARK_SCALAR_FIELD, Keystore_OutOfScalarField());
    KeystoreRootStorage storage $ = _getKeystoreRootStorage();
    require($.nullifyingKeys[_account] == 0, Keystore_AuthPolicyAlreadySet());
    require(_nullifyingKeyHash != 0, Keystore_InvalidNullifyingKeyHash());

    uint256 _authLeaf = PoseidonT4.hash([uint256(uint160(_account)), _nullifyingKeyHash, _authDigest]);

    require($.keystoreTree.size + 1 <= $.maxKeystoreTreeSize, Keystore_KeystoreTreeFull());
    (uint256 _root, uint256 _index) = _insertInTree(_authLeaf);

    _updateRoot(_root);

    $.nullifyingKeys[_account] = _nullifyingKeyHash;

    emit LeafInserted(_authLeaf, _root, _index);
    emit AuthPolicySet(_account, _nullifyingKeyHash, _authDigest);
  }

  /// @notice Stores a new root, superseding the current one
  /// @dev Stamps `previousRoots[currentRoot] = block.timestamp + keystoreRootLiveness` for the old root,
  ///   clears `previousRoots[_newRoot]` in case of root re-insertion, then sets `currentRoot`.
  /// @param _newRoot The new merkle root
  function _updateRoot(uint256 _newRoot) internal {
    KeystoreRootStorage storage $ = _getKeystoreRootStorage();
    uint256 _oldRoot = $.currentRoot;
    uint256 _validUntil;

    if (_oldRoot != 0) {
      _validUntil = block.timestamp + $.keystoreRootLiveness;
      $.previousRoots[_oldRoot] = _validUntil;
    }

    delete $.previousRoots[_newRoot];
    $.currentRoot = _newRoot;

    emit RootSuperseded(_oldRoot, _newRoot, _validUntil);
  }

  /// @notice Updates an existing leaf in the keystore tree
  /// @param _oldLeaf The existing leaf value to be replaced
  /// @param _newLeaf The new leaf value to insert
  /// @param _inclusionProof Sibling nodes proving inclusion of the old leaf in the current tree
  /// @return _newRoot The new root of the tree after the update
  /// @return _index The index of the updated leaf in the tree
  function _updateTree(
    uint256 _oldLeaf,
    uint256 _newLeaf,
    uint256[] calldata _inclusionProof
  ) internal virtual returns (uint256 _newRoot, uint256 _index) {
    LeanIMTData storage _tree = _getKeystoreRootStorage().keystoreTree;
    _newRoot = _tree.update(_oldLeaf, _newLeaf, _inclusionProof);
    _index = _tree.indexOf(_newLeaf);
  }

  /// @notice Inserts a new leaf into the keystore tree
  /// @param _newLeaf The leaf value to insert
  /// @return _newRoot The new root of the tree after insertion
  /// @return _index The index of the inserted leaf in the tree
  function _insertInTree(uint256 _newLeaf) internal virtual returns (uint256 _newRoot, uint256 _index) {
    LeanIMTData storage _tree = _getKeystoreRootStorage().keystoreTree;
    _newRoot = _tree.insert(_newLeaf);
    _index = _tree.indexOf(_newLeaf);
  }

  /// @notice Returns a pointer to the ERC-7201 namespaced storage for KeystoreRoot
  /// @return $ The KeystoreRoot namespaced storage pointer
  function _getKeystoreRootStorage() internal pure returns (KeystoreRootStorage storage $) {
    bytes32 _location = KEYSTORE_ROOT_STORAGE_LOCATION;
    assembly {
      $.slot := _location
    }
  }
}

