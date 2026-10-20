// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import {ITreeUpdates} from 'interfaces/ITreeUpdates.sol';

import {TestUtils} from 'test/unit/helpers/TestUtils.sol';

import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';

import {IERC165} from '@openzeppelin/contracts/utils/introspection/IERC165.sol';
import {Keystore} from 'contracts/Keystore.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {KeystoreHarness} from 'test/unit/helpers/KeystoreHarness.sol';
import {UPGRADER_ROLE} from 'utils/RolesConstants.sol';

contract UnitKeystore is TestUtils {
  KeystoreHarness internal keystore;
  address internal user = makeAddr('user');
  uint256 internal constant KEYSTORE_ROOT_LIVENESS = 600;
  uint256 internal constant MAX_KEYSTORE_TREE_SIZE = 1 << 18;

  function setUp() external {
    KeystoreHarness implementation = new KeystoreHarness(IAccessControl(mockAccessRouter));
    ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), '');
    keystore = KeystoreHarness(address(proxy));
    keystore.initialize(KEYSTORE_ROOT_LIVENESS, MAX_KEYSTORE_TREE_SIZE);
  }

  /*///////////////////////////////////////////////////////////////
                            constructor
  //////////////////////////////////////////////////////////////*/
  function test_Constructor_WhenAccessRouterIsInvalid(address _accessRouter) external {
    assumeNotPrecompile(_accessRouter);
    assumeNotForgeAddress(_accessRouter);
    vm.mockCall(
      _accessRouter, abi.encodeCall(IERC165.supportsInterface, (type(IAccessControl).interfaceId)), abi.encode(false)
    );
    vm.expectRevert(IPermissioned.Permissioned_InvalidAccessRouter.selector);
    new Keystore(IAccessControl(_accessRouter));
  }

  function test_Constructor_WhenCalled(address newAccessRouter) external {
    // it sets the access router
    _mockAccessRouter(newAccessRouter);
    Keystore implementation_ = new Keystore(IAccessControl(newAccessRouter));
    assertEq(address(implementation_.ACCESS_ROUTER()), newAccessRouter);
  }

  /*///////////////////////////////////////////////////////////////
                            initialize
  //////////////////////////////////////////////////////////////*/

  function test_Initialize_WhenCalledOnTheImplementation(
    uint256 _keystoreRootLiveness,
    uint256 _maxKeystoreTreeSize
  ) external {
    Keystore implementation = new Keystore(IAccessControl(mockAccessRouter));

    // It should revert with InvalidInitialization
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    implementation.initialize(_keystoreRootLiveness, _maxKeystoreTreeSize);
  }

  /// @dev contract is initialized in setup function
  function test_Initialize_WhenAlreadyInitialized(
    uint256 _keystoreRootLiveness,
    uint256 _maxKeystoreTreeSize
  ) external {
    // It should revert with InvalidInitialization
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    keystore.initialize(_keystoreRootLiveness, _maxKeystoreTreeSize);
  }

  function test_Initialize_WhenNotInitialized(uint256 _keystoreRootLiveness, uint256 _maxKeystoreTreeSize) external {
    KeystoreHarness implementation = new KeystoreHarness(IAccessControl(mockAccessRouter));
    ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), '');
    KeystoreHarness _keystore = KeystoreHarness(address(proxy));

    _keystore.initialize(_keystoreRootLiveness, _maxKeystoreTreeSize);

    // It should initialize UUPS
    // It should initialize with correct liveness
    assertEq(_keystore.keystoreRootLiveness(), _keystoreRootLiveness);
    // It should initialize with correct max size
    assertEq(_keystore.maxKeystoreTreeSize(), _maxKeystoreTreeSize);
    // should be set by constructor
    assertEq(address(_keystore.ACCESS_ROUTER()), mockAccessRouter);
  }

  /*///////////////////////////////////////////////////////////////
                          setAuthPolicy
  //////////////////////////////////////////////////////////////*/

  function test_SetAuthPolicy_WhenAuthDigestIsOutOfScalarField(
    address _caller,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash
  ) external {
    _authDigest = bound(_authDigest, SNARK_SCALAR_FIELD, type(uint256).max);
    // It should revert with Keystore_OutOfScalarField
    vm.expectRevert(IKeystore.Keystore_OutOfScalarField.selector);
    vm.prank(_caller);
    keystore.setAuthPolicy(_authDigest, _nullifyingKeyHash);
  }

  function test_SetAuthPolicy_WhenNullifyingKeyHashIsOutOfScalarField(
    address _caller,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, SNARK_SCALAR_FIELD, type(uint256).max);
    // It should revert with Keystore_OutOfScalarField
    vm.expectRevert(IKeystore.Keystore_OutOfScalarField.selector);
    vm.prank(_caller);
    keystore.setAuthPolicy(_authDigest, _nullifyingKeyHash);
  }

  function test_SetAuthPolicy_WhenCallerAlreadyHasAnAuthPolicy(
    address _caller,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _existingNullifyingKeyHash
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _existingNullifyingKeyHash = bound(_existingNullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);

    // Set caller's auth policy
    keystore.setNullifyingKeyForTesting(_caller, _existingNullifyingKeyHash);

    // It should revert with Keystore_AuthPolicyAlreadySet
    vm.expectRevert(IKeystore.Keystore_AuthPolicyAlreadySet.selector);
    vm.prank(_caller);
    keystore.setAuthPolicy(_authDigest, _nullifyingKeyHash);
  }

  function test_SetAuthPolicy_WhenNullifyingKeyHashIsZero(address _caller, uint256 _authDigest) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    // It should revert with Keystore_InvalidNullifyingKeyHash
    vm.expectRevert(IKeystore.Keystore_InvalidNullifyingKeyHash.selector);
    vm.prank(_caller);
    keystore.setAuthPolicy(_authDigest, 0);
  }

  function test_SetAuthPolicy_GivenKeystoreTreeIsAtCapacity(uint256 _authDigest, uint256 _nullifyingKeyHash) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    keystore.exposed_setKeystoreTreeSize(MAX_KEYSTORE_TREE_SIZE);

    vm.expectRevert(IKeystore.Keystore_KeystoreTreeFull.selector);
    keystore.setAuthPolicy(_authDigest, _nullifyingKeyHash);
  }

  function test_SetAuthPolicy_WhenCallerDoesNotHaveAnAuthPolicy(
    address _caller,
    uint256 _authDigest,
    uint256 _returnedIndex,
    uint256 _returnedRoot,
    uint256 _nullifyingKeyHash
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _returnedRoot = bound(_returnedRoot, 1, type(uint256).max);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    // Compute expected hash independently - for a single leaf in LeanIMT, root equals the leaf
    uint256 expectedAuthLeaf = PoseidonT4.hash([uint256(uint160(_caller)), _nullifyingKeyHash, _authDigest]);
    keystore.mockInsertionIndex(_returnedIndex);
    keystore.mockRootInsertion(_returnedRoot);

    // It should emit LeafInserted event
    vm.expectEmit(address(keystore));
    emit ITreeUpdates.LeafInserted(expectedAuthLeaf, _returnedRoot, _returnedIndex);
    // It should emit AuthPolicySet event
    vm.expectEmit(address(keystore));
    emit IKeystore.AuthPolicySet(_caller, _nullifyingKeyHash, _authDigest);

    vm.prank(_caller);
    keystore.setAuthPolicy(_authDigest, _nullifyingKeyHash);

    // It should insert the auth leaf into the keystore tree
    // It should update the root
    assertEq(keystore.currentRoot(), _returnedRoot);
    assertTrue(keystore.isKnownRoot(_returnedRoot));

    // It should store the nullifying key hash for caller
    assertEq(keystore.nullifyingKeys(_caller), _nullifyingKeyHash);
  }

  /*///////////////////////////////////////////////////////////////
                      setAuthPolicyWithSig
  //////////////////////////////////////////////////////////////*/

  /// @dev Produces a valid EIP-712 signature by `_pk` over the SetAuthPolicy struct, returning the
  ///      far-future `_deadline` it signed so callers can thread it into `setAuthPolicyWithSig`.
  function _signAuthPolicy(
    uint256 _pk,
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash
  ) internal view returns (bytes memory _signature, uint256 _deadline) {
    _deadline = block.timestamp + 1 days;
    _signature = _signAuthPolicyWithDeadline(_pk, _account, _authDigest, _nullifyingKeyHash, _deadline);
  }

  /// @dev Produces a valid EIP-712 signature by `_pk` over the SetAuthPolicy struct with an explicit
  ///      `_deadline` (used by the expiry test).
  function _signAuthPolicyWithDeadline(
    uint256 _pk,
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _deadline
  ) internal view returns (bytes memory _signature) {
    bytes32 _structHash = keccak256(
      abi.encode(
        keccak256('SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)'),
        _account,
        _authDigest,
        _nullifyingKeyHash,
        _deadline
      )
    );
    bytes32 _digest = keystore.exposed_hashTypedDataV4(_structHash);
    (uint8 _v, bytes32 _r, bytes32 _s) = vm.sign(_pk, _digest);
    _signature = abi.encodePacked(_r, _s, _v);
  }

  function test_SetAuthPolicyWithSig_WhenTheSignatureIsNotValidForTheAccount(
    address _relayer,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _wrongPk
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    (address _account,) = makeAddrAndKey('account');
    _wrongPk = boundPrivateKey(_wrongPk);
    // Sign with a key that does not correspond to `_account`
    (bytes memory _signature, uint256 _deadline) = _signAuthPolicy(_wrongPk, _account, _authDigest, _nullifyingKeyHash);

    vm.expectRevert(IKeystore.Keystore_InvalidSignature.selector);
    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, _deadline, _signature);
  }

  function test_SetAuthPolicyWithSig_WhenTheDeadlineHasPassed(
    address _relayer,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    (address _account, uint256 _pk) = makeAddrAndKey('account');

    // Sign over a deadline that has already elapsed by the time the tx lands.
    vm.warp(1_000_000);
    uint256 _deadline = block.timestamp - 1;
    bytes memory _signature = _signAuthPolicyWithDeadline(_pk, _account, _authDigest, _nullifyingKeyHash, _deadline);

    // It should revert once the signed deadline has passed
    vm.expectRevert(IKeystore.Keystore_SignatureExpired.selector);
    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, _deadline, _signature);
  }

  function test_SetAuthPolicyWithSig_WhenCalledExactlyAtTheDeadline(
    address _relayer,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _returnedIndex,
    uint256 _returnedRoot
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    _returnedRoot = bound(_returnedRoot, 1, type(uint256).max);
    (address _account, uint256 _pk) = makeAddrAndKey('account');
    vm.assume(_relayer != _account);

    // block.timestamp == deadline is inclusive (require uses <=), so registration must still succeed.
    vm.warp(1_000_000);
    uint256 _deadline = block.timestamp;
    keystore.mockInsertionIndex(_returnedIndex);
    keystore.mockRootInsertion(_returnedRoot);
    bytes memory _signature = _signAuthPolicyWithDeadline(_pk, _account, _authDigest, _nullifyingKeyHash, _deadline);

    // It should register the account at the exact deadline boundary
    vm.expectEmit(address(keystore));
    emit IKeystore.AuthPolicySet(_account, _nullifyingKeyHash, _authDigest);
    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, _deadline, _signature);

    assertEq(keystore.nullifyingKeys(_account), _nullifyingKeyHash);
  }

  function test_SetAuthPolicyWithSig_WhenAuthDigestIsOutOfScalarField(
    address _relayer,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash
  ) external {
    _authDigest = bound(_authDigest, SNARK_SCALAR_FIELD, type(uint256).max);
    (address _account, uint256 _pk) = makeAddrAndKey('account');
    (bytes memory _signature, uint256 _deadline) = _signAuthPolicy(_pk, _account, _authDigest, _nullifyingKeyHash);

    vm.expectRevert(IKeystore.Keystore_OutOfScalarField.selector);
    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, _deadline, _signature);
  }

  function test_SetAuthPolicyWithSig_WhenNullifyingKeyHashIsOutOfScalarField(
    address _relayer,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, SNARK_SCALAR_FIELD, type(uint256).max);
    (address _account, uint256 _pk) = makeAddrAndKey('account');
    (bytes memory _signature, uint256 _deadline) = _signAuthPolicy(_pk, _account, _authDigest, _nullifyingKeyHash);

    vm.expectRevert(IKeystore.Keystore_OutOfScalarField.selector);
    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, _deadline, _signature);
  }

  function test_SetAuthPolicyWithSig_WhenTheAccountAlreadyHasAnAuthPolicy(
    address _relayer,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _existingNullifyingKeyHash
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _existingNullifyingKeyHash = bound(_existingNullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    (address _account, uint256 _pk) = makeAddrAndKey('account');
    keystore.setNullifyingKeyForTesting(_account, _existingNullifyingKeyHash);
    (bytes memory _signature, uint256 _deadline) = _signAuthPolicy(_pk, _account, _authDigest, _nullifyingKeyHash);

    vm.expectRevert(IKeystore.Keystore_AuthPolicyAlreadySet.selector);
    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, _deadline, _signature);
  }

  function test_SetAuthPolicyWithSig_WhenNullifyingKeyHashIsZero(address _relayer, uint256 _authDigest) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    (address _account, uint256 _pk) = makeAddrAndKey('account');
    (bytes memory _signature, uint256 _deadline) = _signAuthPolicy(_pk, _account, _authDigest, 0);

    vm.expectRevert(IKeystore.Keystore_InvalidNullifyingKeyHash.selector);
    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, 0, _deadline, _signature);
  }

  function test_SetAuthPolicyWithSig_GivenKeystoreTreeIsAtCapacity(
    address _relayer,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    (address _account, uint256 _pk) = makeAddrAndKey('account');
    keystore.exposed_setKeystoreTreeSize(MAX_KEYSTORE_TREE_SIZE);
    (bytes memory _signature, uint256 _deadline) = _signAuthPolicy(_pk, _account, _authDigest, _nullifyingKeyHash);

    vm.expectRevert(IKeystore.Keystore_KeystoreTreeFull.selector);
    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, _deadline, _signature);
  }

  function test_SetAuthPolicyWithSig_WhenTheAccountIsAnEIP_1271ContractWallet(
    address _relayer,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _returnedIndex,
    uint256 _returnedRoot,
    bytes memory _signature
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    _returnedRoot = bound(_returnedRoot, 1, type(uint256).max);

    // Deploy a contract wallet that validates any signature (forces the EIP-1271 branch via code.length > 0)
    MockERC1271Wallet _wallet = new MockERC1271Wallet();
    address _account = address(_wallet);

    keystore.mockInsertionIndex(_returnedIndex);
    keystore.mockRootInsertion(_returnedRoot);

    // It should register the account when the wallet validates the signature
    vm.expectEmit(address(keystore));
    emit IKeystore.AuthPolicySet(_account, _nullifyingKeyHash, _authDigest);

    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, block.timestamp + 1 days, _signature);

    assertEq(keystore.nullifyingKeys(_account), _nullifyingKeyHash);
  }

  function test_SetAuthPolicyWithSig_WhenTheSignatureIsValidForTheAccount(
    address _relayer,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _returnedIndex,
    uint256 _returnedRoot
  ) external {
    _authDigest = bound(_authDigest, 0, SNARK_SCALAR_FIELD - 1);
    _nullifyingKeyHash = bound(_nullifyingKeyHash, 1, SNARK_SCALAR_FIELD - 1);
    _returnedRoot = bound(_returnedRoot, 1, type(uint256).max);
    (address _account, uint256 _pk) = makeAddrAndKey('account');
    // Relayer is a different party than the registered account
    vm.assume(_relayer != _account);

    uint256 _expectedAuthLeaf = PoseidonT4.hash([uint256(uint160(_account)), _nullifyingKeyHash, _authDigest]);
    keystore.mockInsertionIndex(_returnedIndex);
    keystore.mockRootInsertion(_returnedRoot);
    (bytes memory _signature, uint256 _deadline) = _signAuthPolicy(_pk, _account, _authDigest, _nullifyingKeyHash);

    // It should emit LeafInserted event
    vm.expectEmit(address(keystore));
    emit ITreeUpdates.LeafInserted(_expectedAuthLeaf, _returnedRoot, _returnedIndex);
    // It should emit AuthPolicySet event with the account (not the relayer)
    vm.expectEmit(address(keystore));
    emit IKeystore.AuthPolicySet(_account, _nullifyingKeyHash, _authDigest);

    // Called by the relayer, registering the account
    vm.prank(_relayer);
    keystore.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, _deadline, _signature);

    // It should insert the auth leaf for the account not the caller / update the root
    assertEq(keystore.currentRoot(), _returnedRoot);
    assertTrue(keystore.isKnownRoot(_returnedRoot));
    // It should store the nullifying key hash for the account
    assertEq(keystore.nullifyingKeys(_account), _nullifyingKeyHash);
    // The relayer itself is never registered
    assertEq(keystore.nullifyingKeys(_relayer), 0);
  }

  /*///////////////////////////////////////////////////////////////
                      initializeEIP712
  //////////////////////////////////////////////////////////////*/

  function test_InitializeEIP712_WhenAlreadyInitializedAtVersion2() external {
    // The proxy in setUp ran `initialize` (version 1) which already set the EIP-712 domain.
    // A fresh `reinitializer(2)` call is permitted once; calling it again must revert.
    keystore.initializeEIP712();
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    keystore.initializeEIP712();
  }

  function test_InitializeEIP712_WhenCalledOnAVersion1Proxy() external {
    // Simulate a proxy initialized before `setAuthPolicyWithSig` existed: only `__UUPSUpgradeable_init`
    // and the root scheme were set (no EIP-712 domain). We model that by deploying a fresh proxy and
    // running the reinitializer to populate the domain.
    KeystoreHarness _impl = new KeystoreHarness(IAccessControl(mockAccessRouter));
    ERC1967Proxy _proxy = new ERC1967Proxy(address(_impl), '');
    KeystoreHarness _keystore = KeystoreHarness(address(_proxy));

    _keystore.initializeEIP712();

    // It should set the EIP-712 domain: a digest is computable and non-zero
    bytes32 _digest = _keystore.exposed_hashTypedDataV4(keccak256('test'));
    assertTrue(_digest != bytes32(0));
  }

  /*///////////////////////////////////////////////////////////////
                      updateAuthPolicy
  //////////////////////////////////////////////////////////////*/

  function test_UpdateAuthPolicy_WhenOldAuthDigestIsOutOfScalarField(
    uint256 _oldAuthDigest,
    uint256 _updatedAuthDigest,
    uint256[] memory _siblingNodes,
    address _caller
  ) external {
    _oldAuthDigest = bound(_oldAuthDigest, SNARK_SCALAR_FIELD, type(uint256).max);
    // It should revert with Keystore_OutOfScalarField
    vm.expectRevert(IKeystore.Keystore_OutOfScalarField.selector);
    vm.prank(_caller);
    keystore.updateAuthPolicy(_oldAuthDigest, _updatedAuthDigest, _siblingNodes);
  }

  function test_UpdateAuthPolicy_WhenUpdatedAuthDigestIsOutOfScalarField(
    uint256 _oldAuthDigest,
    uint256 _updatedAuthDigest,
    uint256[] memory _siblingNodes,
    address _caller
  ) external {
    _oldAuthDigest = bound(_oldAuthDigest, 0, SNARK_SCALAR_FIELD - 1);
    _updatedAuthDigest = bound(_updatedAuthDigest, SNARK_SCALAR_FIELD, type(uint256).max);
    // It should revert with Keystore_OutOfScalarField
    vm.expectRevert(IKeystore.Keystore_OutOfScalarField.selector);
    vm.prank(_caller);
    keystore.updateAuthPolicy(_oldAuthDigest, _updatedAuthDigest, _siblingNodes);
  }

  function test_UpdateAuthPolicy_WhenCallerDoesntAlreadyHaveAnAuthPolicy(
    uint248 _oldAuthLeaf,
    uint248 _updatedAuthDigest,
    uint256[] memory _siblingNodes,
    address _caller
  ) external {
    // It should revert with Keystore_AuthPolicyNotSet
    vm.expectRevert(IKeystore.Keystore_AuthPolicyNotSet.selector);
    // the default value is for the key to be empty
    vm.prank(_caller);
    keystore.updateAuthPolicy(_oldAuthLeaf, _updatedAuthDigest, _siblingNodes);
  }

  function test_UpdateAuthPolicy_WhenCallerAlreadyHasAnAuthPolicySet(
    uint248 _oldAuthDigest,
    uint248 _updatedAuthDigest,
    uint256[] memory _siblingNodes,
    uint256 _nullifyingKey,
    uint256 _newRoot,
    uint256 _insertionIndex,
    address _caller
  ) external {
    _nullifyingKey = bound(_nullifyingKey, 1, SNARK_SCALAR_FIELD - 1);
    _newRoot = bound(_newRoot, 1, type(uint256).max);
    keystore.setNullifyingKeyForTesting(_caller, _nullifyingKey);
    keystore.mockRootInsertion(_newRoot);
    keystore.mockInsertionIndex(_insertionIndex);
    uint256 _oldAuthLeaf = PoseidonT4.hash([uint256(uint160(_caller)), _nullifyingKey, _oldAuthDigest]);
    uint256 _newAuthLeaf = PoseidonT4.hash([uint256(uint160(_caller)), _nullifyingKey, _updatedAuthDigest]);

    // It should emit LeafUpdated event
    vm.expectEmit(address(keystore));
    emit ITreeUpdates.LeafUpdated(_newAuthLeaf, _newRoot, _insertionIndex);
    // It should emit AuthPolicyUpdated event
    vm.expectEmit(address(keystore));
    emit IKeystore.AuthPolicyUpdated(_caller, _oldAuthDigest, _updatedAuthDigest);
    vm.prank(_caller);
    keystore.updateAuthPolicy(_oldAuthDigest, _updatedAuthDigest, _siblingNodes);

    KeystoreHarness.UpdateTreeSpy memory spy = keystore.updateTreeSpies(0);
    // It should recompute the old auth leaf from msg.sender, _oldAuthDigest and nullifyingKey
    assertEq(spy.oldLeaf, _oldAuthLeaf);
    // It should insert the new auth leaf into the keystore tree
    for (uint256 i = 0; i < _siblingNodes.length; i++) {
      assertEq(spy.inclusionProof[i], _siblingNodes[i]);
    }
    assertEq(spy.newLeaf, _newAuthLeaf);

    // It should update the root
    assertEq(keystore.currentRoot(), _newRoot);
  }

  /*///////////////////////////////////////////////////////////////
                        setViewingKey
  //////////////////////////////////////////////////////////////*/

  function test_SetViewingKey_WhenCalled(address _caller, bytes32 _oldViewingKey, bytes32 _newViewingKey) external {
    // Mock existing viewing key (can be bytes32(0) for first time)
    keystore.setViewingKeyForTesting(_caller, _oldViewingKey);

    // It should emit ViewingKeySet with correct old and new keys
    vm.expectEmit(address(keystore));
    emit IKeystore.ViewingKeySet(_caller, _oldViewingKey, _newViewingKey);

    vm.prank(_caller);
    keystore.setViewingKey(_newViewingKey);

    // It should set the viewing key
    assertEq(keystore.viewingKeys(_caller), _newViewingKey);
  }

  /*///////////////////////////////////////////////////////////////
                      _authorizeUpgrade
  //////////////////////////////////////////////////////////////*/

  function test__authorizeUpgrade_WhenCallerDoesNotHaveUPGRADER_ROLE(
    address _caller,
    address _newImplementation
  ) external {
    _mockAndExpect(
      address(mockAccessRouter), abi.encodeCall(IAccessControl.hasRole, (UPGRADER_ROLE, _caller)), abi.encode(false)
    );

    // It should revert with Permissioned_NotAuthorized
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(_caller);
    keystore.upgradeToAndCall(_newImplementation, '');
  }

  function test__authorizeUpgrade_WhenCallerHasUPGRADER_ROLE(address _caller) external {
    Keystore newImplementation = new Keystore(IAccessControl(mockAccessRouter));

    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    // It should not revert
    vm.prank(_caller);
    keystore.upgradeToAndCall(address(newImplementation), '');
  }

  /*///////////////////////////////////////////////////////////////
                    setKeystoreRootLiveness
  //////////////////////////////////////////////////////////////*/

  function test_SetKeystoreRootLiveness_WhenCallerDoesNotHaveUpgraderRole(
    address _caller,
    uint256 _newLiveness
  ) external {
    _mockAndExpect(
      address(mockAccessRouter), abi.encodeCall(IAccessControl.hasRole, (UPGRADER_ROLE, _caller)), abi.encode(false)
    );

    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(_caller);
    keystore.setKeystoreRootLiveness(_newLiveness);
  }

  function test_SetKeystoreRootLiveness_WhenCallerHasUpgraderRole(address _caller, uint256 _newLiveness) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    vm.expectEmit(address(keystore));
    emit IKeystore.KeystoreRootLivenessUpdated(KEYSTORE_ROOT_LIVENESS, _newLiveness);

    vm.prank(_caller);
    keystore.setKeystoreRootLiveness(_newLiveness);

    assertEq(keystore.keystoreRootLiveness(), _newLiveness);
  }

  /*///////////////////////////////////////////////////////////////
                    setMaxKeystoreTreeSize
  //////////////////////////////////////////////////////////////*/

  function test_SetMaxKeystoreTreeSize_WhenCallerDoesNotHaveUpgraderRole(address _caller, uint256 _newSize) external {
    _mockAndExpect(
      address(mockAccessRouter), abi.encodeCall(IAccessControl.hasRole, (UPGRADER_ROLE, _caller)), abi.encode(false)
    );

    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(_caller);
    keystore.setMaxKeystoreTreeSize(_newSize);
  }

  modifier whenCallerHasUpgraderRole() {
    _;
  }

  function test_SetMaxKeystoreTreeSize_WhenNewMaxSizeIsLessThanOrEqualToCurrentTreeSize(
    address _caller,
    uint256 _treeSize,
    uint256 _newSize
  ) external whenCallerHasUpgraderRole {
    _treeSize = bound(_treeSize, 1, type(uint128).max);
    // covers both the strict `<` case and the `==` boundary
    _newSize = bound(_newSize, 0, _treeSize);
    keystore.exposed_setKeystoreTreeSize(_treeSize);

    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    vm.expectRevert(IKeystore.Keystore_InvalidMaxTreeSize.selector);
    vm.prank(_caller);
    keystore.setMaxKeystoreTreeSize(_newSize);
  }

  function test_SetMaxKeystoreTreeSize_WhenNewMaxSizeIsGreaterThanCurrentTreeSize(
    address _caller,
    uint256 _treeSize,
    uint256 _newSize
  ) external whenCallerHasUpgraderRole {
    _treeSize = bound(_treeSize, 0, type(uint128).max);
    _newSize = bound(_newSize, _treeSize + 1, type(uint256).max);
    keystore.exposed_setKeystoreTreeSize(_treeSize);

    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    vm.expectEmit(address(keystore));
    emit IKeystore.MaxKeystoreTreeSizeUpdated(MAX_KEYSTORE_TREE_SIZE, _newSize);

    vm.prank(_caller);
    keystore.setMaxKeystoreTreeSize(_newSize);

    assertEq(keystore.maxKeystoreTreeSize(), _newSize);
  }

  /*///////////////////////////////////////////////////////////////
                          _updateRoot
  //////////////////////////////////////////////////////////////*/

  function test__updateRoot_GivenOldRootIsZero(uint256 _newRoot) external {
    _newRoot = bound(_newRoot, 1, type(uint256).max);

    assertEq(keystore.currentRoot(), 0);

    // On first insertion there is no prior root to supersede: emit `validUntil == 0`
    vm.expectEmit(address(keystore));
    emit IKeystore.RootSuperseded(0, _newRoot, 0);

    keystore.exposed_updateRoot(_newRoot);

    // It should not stamp any previous roots
    assertEq(keystore.previousRoots(0), 0);
    // It should set current root
    assertEq(keystore.currentRoot(), _newRoot);
  }

  modifier givenOldRootIsNotZero(uint256 _oldRoot) {
    _oldRoot = bound(_oldRoot, 1, type(uint256).max);
    keystore.exposed_setCurrentRoot(_oldRoot);
    _;
  }

  function test__updateRoot_WhenNewRootIsFresh(
    uint256 _oldRoot,
    uint256 _newRoot
  ) external givenOldRootIsNotZero(_oldRoot) {
    // Re-read after modifier sets a nonzero currentRoot
    _oldRoot = keystore.currentRoot();
    _newRoot = bound(_newRoot, 1, type(uint256).max);
    vm.assume(_newRoot != _oldRoot);

    uint256 _expectedValidUntil = block.timestamp + KEYSTORE_ROOT_LIVENESS;

    vm.expectEmit(address(keystore));
    emit IKeystore.RootSuperseded(_oldRoot, _newRoot, _expectedValidUntil);

    keystore.exposed_updateRoot(_newRoot);

    // It should set old root validUntil to block.timestamp + keystoreRootLiveness
    assertEq(keystore.previousRoots(_oldRoot), _expectedValidUntil);
    // It should set current root
    assertEq(keystore.currentRoot(), _newRoot);
  }

  function test__updateRoot_WhenNewRootWasPreviouslySuperseded(
    uint256 _oldRoot,
    uint256 _newRoot,
    uint256 _staleValidUntil
  ) external givenOldRootIsNotZero(_oldRoot) {
    // Re-read after modifier sets a nonzero currentRoot
    _oldRoot = keystore.currentRoot();
    _newRoot = bound(_newRoot, 1, type(uint256).max);
    _staleValidUntil = bound(_staleValidUntil, 1, type(uint128).max);
    vm.assume(_newRoot != _oldRoot);

    // Simulate _newRoot having been a previous currentRoot that was already superseded
    keystore.exposed_setPreviousRoot(_newRoot, _staleValidUntil);
    assertEq(keystore.previousRoots(_newRoot), _staleValidUntil);

    uint256 _expectedValidUntil = block.timestamp + KEYSTORE_ROOT_LIVENESS;

    vm.expectEmit(address(keystore));
    emit IKeystore.RootSuperseded(_oldRoot, _newRoot, _expectedValidUntil);

    // Promote _newRoot back to currentRoot (re-insertion)
    keystore.exposed_updateRoot(_newRoot);

    // It should set old root validUntil to block.timestamp + keystoreRootLiveness
    assertEq(keystore.previousRoots(_oldRoot), _expectedValidUntil);
    // It should clear the stale previous roots entry
    assertEq(keystore.previousRoots(_newRoot), 0);
    // It should set current root
    assertEq(keystore.currentRoot(), _newRoot);
  }

  /*///////////////////////////////////////////////////////////////
                          isKnownRoot
  //////////////////////////////////////////////////////////////*/

  function test_IsKnownRoot_WhenRootIsZero() external {
    // 0 is not a known root
    assertFalse(keystore.isKnownRoot(0));
    // even when we manually set it as a "known root"
    keystore.exposed_setCurrentRoot(0);
    assertFalse(keystore.isKnownRoot(0));
    // or any other number
    keystore.exposed_setCurrentRoot(1);
    assertFalse(keystore.isKnownRoot(0));
  }

  function test_IsKnownRoot_WhenRootIsCurrentRoot(uint256 _root) external {
    _root = bound(_root, 1, type(uint256).max);
    keystore.exposed_setCurrentRoot(_root);
    assertTrue(keystore.isKnownRoot(_root));
  }

  modifier givenRootWasSuperseded() {
    _;
  }

  function _arrangeSupersededRoot(uint256 _root1, uint256 _root2) internal {
    keystore.exposed_setCurrentRoot(_root1);
    keystore.exposed_updateRoot(_root2);
  }

  function test_IsKnownRoot_WhenBeforeValidUntil(uint256 _root1, uint256 _root2) external givenRootWasSuperseded {
    _root1 = bound(_root1, 1, type(uint256).max);
    _root2 = bound(_root2, 1, type(uint256).max);
    vm.assume(_root1 != _root2);

    _arrangeSupersededRoot(_root1, _root2);
    uint256 _validUntil = keystore.previousRoots(_root1);
    // _root1 is valid strictly while block.timestamp < validUntil
    vm.warp(_validUntil - 1);
    assertTrue(keystore.isKnownRoot(_root1));
  }

  function test_IsKnownRoot_WhenAtOrAfterValidUntil(
    uint256 _root1,
    uint256 _root2,
    uint256 _elapsedAfter
  ) external givenRootWasSuperseded {
    _root1 = bound(_root1, 1, type(uint256).max);
    _root2 = bound(_root2, 1, type(uint256).max);
    vm.assume(_root1 != _root2);

    _arrangeSupersededRoot(_root1, _root2);
    uint256 _validUntil = keystore.previousRoots(_root1);
    // cover the inclusive boundary (==) and any later time
    _elapsedAfter = bound(_elapsedAfter, 0, type(uint128).max);

    vm.warp(_validUntil + _elapsedAfter);
    assertFalse(keystore.isKnownRoot(_root1));
  }

  function test_IsKnownRoot_WhenRootWasNeverSeen(uint256 _unknownRoot) external view {
    _unknownRoot = bound(_unknownRoot, 1, type(uint256).max);
    assertFalse(keystore.isKnownRoot(_unknownRoot));
  }
}

/// @notice Minimal EIP-1271 wallet that validates any signature, used to exercise the contract-wallet path
contract MockERC1271Wallet {
  /// @dev Returns the ERC-1271 magic value for any input
  function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
    return 0x1626ba7e;
  }
}
