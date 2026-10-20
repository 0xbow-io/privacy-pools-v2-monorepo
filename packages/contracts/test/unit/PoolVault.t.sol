// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import {PausableUpgradeable} from '@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC165} from '@openzeppelin/contracts/utils/introspection/IERC165.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';

import {StdStorage, stdStorage} from 'forge-std/Test.sol';

import {PoolVault} from 'contracts/PoolVault.sol';
import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IDepositVerifier} from 'interfaces/IDepositVerifier.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IRagequitVerifier} from 'interfaces/IRagequitVerifier.sol';
import {IRootBuffer} from 'interfaces/IRootBuffer.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {ITreeUpdates} from 'interfaces/ITreeUpdates.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';
import {PoolVaultHarness} from 'test/unit/helpers/PoolVaultHarness.sol';
import {
  DepositProofParams,
  RagequitProofParams,
  TransactProofParams,
  buildMockDepositProof,
  buildMockRagequitProof,
  buildMockTransactProof
} from 'test/unit/helpers/ProofUtils.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';
import {Constants} from 'utils/Constants.sol';
import {Constants} from 'utils/Constants.sol';
import {DEPOSITOR_ROLE, PAUSER_ROLE, UNPAUSER_ROLE, UPGRADER_ROLE} from 'utils/RolesConstants.sol';

contract UnitPoolVault is TestUtils {
  using stdStorage for StdStorage;
  using ProofLibV2 for ProofLibV2.DepositProof;

  uint256 internal constant MAX_ARRAY_SIZE = 4;
  uint256 internal constant MAX_STATE_TREE_SIZE = 1 << 22;

  PoolVaultHarness internal poolVault;
  PoolVaultHarness internal implementation;

  uint32 internal constant ROOT_HISTORY_SIZE = 30;

  IPoolVault.TransactParams internal defaultParams;
  IPoolVault.NoteData internal defaultNoteData;

  IRagequitVerifier public mockRagequitVerifier = IRagequitVerifier(makeAddr('mockRagequitVerifier'));
  IDepositVerifier public mockDepositVerifier = IDepositVerifier(makeAddr('mockDepositVerifier'));

  function setUp() external {
    // Deploy implementation (harness) and proxy
    implementation = new PoolVaultHarness(IAccessControl(mockAccessRouter));
    ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), '');
    poolVault = PoolVaultHarness(payable(address(proxy)));
    poolVault.initialize(
      ROOT_HISTORY_SIZE,
      _emptyVerifierConfigs(),
      IASPRegistry(mockAspRegistry),
      IKeystore(mockKeystore),
      mockRagequitVerifier,
      mockDepositVerifier,
      MAX_STATE_TREE_SIZE
    );

    defaultParams = IPoolVault.TransactParams({processor: address(this), data: 'test processor data'});
  }

  /*///////////////////////////////////////////////////////////////
                          HELPERS
  //////////////////////////////////////////////////////////////*/

  function _emptyVerifierConfigs() internal pure returns (ITransactVerifierRouter.VerifierConfig[] memory configs_) {
    configs_ = new ITransactVerifierRouter.VerifierConfig[](0);
  }

  function _setNullifierSpent(uint256 _nullifierHash) internal {
    StdStorage storage _slot = stdstore.target(address(poolVault)).sig('spentNullifiers(uint256)');
    _slot.with_key(_nullifierHash).checked_write(uint256(1));
  }

  function _setCommitmentExists(uint256 _commitment) internal {
    poolVault.mockCommitmentInsertion(_commitment);
  }

  function _setPaused(bool _paused) internal {
    stdstore.target(address(poolVault)).sig('paused()').checked_write(_paused);
  }

  /// @notice Asserts that timestamped commitment and nullifier leaves were correctly inserted into the state tree
  /// @dev it is also coupled to the order, relying on commitments being inserted before nullifiers.
  /// @param _outputCommitments Fixed-size array of output commitments
  /// @param _outputCommitmentsLength Actual length to check for output commitments
  /// @param _nullifierHashes Fixed-size array of nullifier hashes
  /// @param _nullifierHashesLength Actual length to check for nullifier hashes
  /// @param _timestamp Expected timestamp used in hashing
  function _assertTimestampedLeaves(
    uint256[MAX_ARRAY_SIZE] memory _outputCommitments,
    uint256 _outputCommitmentsLength,
    uint256[MAX_ARRAY_SIZE] memory _nullifierHashes,
    uint256 _nullifierHashesLength,
    uint256 _timestamp
  ) internal view {
    for (uint256 i; i < _outputCommitmentsLength; ++i) {
      assertEq(
        poolVault.insertInTreeSpies(i),
        PoseidonT4.hash([Constants.COMMITMENT_LEAF_TAG, _outputCommitments[i], _timestamp])
      );
    }
    for (uint256 i; i < _nullifierHashesLength; ++i) {
      assertEq(
        poolVault.insertInTreeSpies(_outputCommitmentsLength + i),
        PoseidonT4.hash([Constants.NULLIFIER_LEAF_TAG, _nullifierHashes[i], _timestamp])
      );
    }
  }

  /// @notice Helper to build dynamic arrays from fixed-size arrays for event matching
  /// @dev Reduces stack depth by extracting array building logic
  function _toDynamicArrays(
    uint256[MAX_ARRAY_SIZE] memory _fixedCommitments,
    uint256 _commitmentsLength,
    uint256[MAX_ARRAY_SIZE] memory _fixedNullifiers,
    uint256 _nullifiersLength
  ) internal pure returns (uint256[] memory commitments_, uint256[] memory nullifiers_) {
    commitments_ = new uint256[](_commitmentsLength);
    for (uint256 i; i < _commitmentsLength; ++i) {
      commitments_[i] = _fixedCommitments[i];
    }
    nullifiers_ = new uint256[](_nullifiersLength);
    for (uint256 i; i < _nullifiersLength; ++i) {
      nullifiers_[i] = _fixedNullifiers[i];
    }
  }

  /// @notice Helper to build note data array matching the number of output commitments
  function _buildDefaultNoteData(uint256 _numOutputs) internal pure returns (IPoolVault.NoteData[] memory noteData_) {
    noteData_ = new IPoolVault.NoteData[](_numOutputs);
    for (uint256 i; i < _numOutputs; ++i) {
      noteData_[i] = IPoolVault.NoteData({
        hint: bytes32(keccak256(abi.encode('hint', i))), data: abi.encode(keccak256(abi.encode('note', i)))
      });
    }
  }

  /// @notice Helper to expect Note + Transacted events, reducing stack depth at call sites
  function _expectTransactEvents(
    TransactProofParams memory _fuzz,
    IPoolVault.NoteData[] memory _noteData,
    address _asset,
    address _caller
  ) internal {
    for (uint256 i; i < _noteData.length; ++i) {
      vm.expectEmit(address(poolVault));
      emit IPoolVault.Note(_noteData[i].hint, _noteData[i].data);
    }
    (uint256[] memory _outputCommitments, uint256[] memory _nullifierHashes) = _toDynamicArrays(
      _fuzz.outputCommitments, _fuzz.outputCommitmentsLength, _fuzz.nullifierHashes, _fuzz.nullifierHashesLength
    );
    vm.expectEmit(address(poolVault));
    emit IPoolVault.Transacted(_outputCommitments, _nullifierHashes, _asset, _fuzz.amountOut, _caller);
  }

  /// @notice Sets up valid mocks for a successful transact (roots valid, verifier passes)
  /// @dev Also bounds leaf values (outputCommitments, nullifierHashes) to be valid for LeanIMT
  ///      and ensures values are unique (LeanIMT doesn't allow duplicate leaves, can't spend same nullifier twice)
  /// @param _fuzz Fixed-size arrays and other fuzzed parameters
  function _setupValidTransact(TransactProofParams memory _fuzz) internal {
    _fuzz.stateRoot = bound(_fuzz.stateRoot, 1, SNARK_SCALAR_FIELD - 1);
    // Bound lengths to valid range
    _fuzz.outputCommitmentsLength = bound(_fuzz.outputCommitmentsLength, 0, MAX_ARRAY_SIZE);
    _fuzz.nullifierHashesLength = bound(_fuzz.nullifierHashesLength, 0, MAX_ARRAY_SIZE);

    // LeanIMT requires: leaf > 0 && leaf < SNARK_SCALAR_FIELD
    // Bound ALL values in the fixed array to valid range (not just used portion)
    for (uint256 i; i < MAX_ARRAY_SIZE; ++i) {
      _fuzz.outputCommitments[i] = bound(_fuzz.outputCommitments[i], 1, SNARK_SCALAR_FIELD - 1);
      _fuzz.nullifierHashes[i] = bound(_fuzz.nullifierHashes[i], 1, SNARK_SCALAR_FIELD - 1);
    }

    // Ensure ALL output commitments are unique across entire array
    for (uint256 i; i < MAX_ARRAY_SIZE; ++i) {
      for (uint256 j; j < i; ++j) {
        vm.assume(_fuzz.outputCommitments[j] != _fuzz.outputCommitments[i]);
        vm.assume(_fuzz.nullifierHashes[j] != _fuzz.nullifierHashes[i]);
      }
    }

    poolVault.exposed_updateRoot(_fuzz.stateRoot);
    _mockAndExpect(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keyRegistryRoot)), abi.encode(true));
    _mockAndExpect(mockAspRegistry, LATEST_ASP_ROOT_SELECTOR, abi.encode(_fuzz.aspRoot));
    poolVault.mockTransactVerifyResult(true);
  }

  /*///////////////////////////////////////////////////////////////
                        RAGEQUIT HELPERS
  //////////////////////////////////////////////////////////////*/

  /// @notice Mocks a commitment as existing in the state tree
  function _mockCommitment(uint256 _commitment) internal {
    poolVault.mockCommitmentInsertion(_commitment);
  }

  /// @notice Sets up valid state for a successful ragequit
  function _setupValidRagequit(RagequitProofParams memory _fuzz) internal {
    // Bound values to valid LeanIMT range
    _fuzz.commitment = bound(_fuzz.commitment, 1, SNARK_SCALAR_FIELD - 1);
    _fuzz.nullifierHash = bound(_fuzz.nullifierHash, 1, SNARK_SCALAR_FIELD - 1);
    // Ragequit rejects zero-value notes
    _fuzz.value = bound(_fuzz.value, 1, type(uint256).max);
    // Exclude addresses that can't receive ETH
    assumePayable(_fuzz.ownerAddress);

    // Mock commitment in state tree
    _mockCommitment(_fuzz.commitment);

    // Mock state tree insertion for nullifier leaf
    poolVault.mockRootInsertion(uint256(keccak256('ragequitRoot')));
    poolVault.mockInsertionIndex(0);

    // Mock keystore root as known (just mock, don't expect)
    vm.mockCall(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keystoreRoot)), abi.encode(true));
    // Mock ragequit verifier to return true (just mock, don't expect)
    vm.mockCall(
      address(mockRagequitVerifier), abi.encodeWithSelector(IRagequitVerifier.verifyProof.selector), abi.encode(true)
    );
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
    new PoolVault(IAccessControl(_accessRouter));
  }

  function test_Constructor_WhenCalled(address _newAccessRouter) external {
    _mockAccessRouter(_newAccessRouter);
    PoolVault _implementation = new PoolVault(IAccessControl(_newAccessRouter));
    // It should set the access router
    assertEq(address(_implementation.ACCESS_ROUTER()), _newAccessRouter);
  }

  /*///////////////////////////////////////////////////////////////
                          INITIALIZE
  //////////////////////////////////////////////////////////////*/

  function test_Initialize_WhenCalledOnImplementation() external {
    // It should revert with InvalidInitialization
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    implementation.initialize(
      ROOT_HISTORY_SIZE,
      _emptyVerifierConfigs(),
      IASPRegistry(mockAspRegistry),
      IKeystore(mockKeystore),
      mockRagequitVerifier,
      mockDepositVerifier,
      MAX_STATE_TREE_SIZE
    );
  }

  function test_Initialize_GivenAlreadyInitialized() external {
    // It should revert with InvalidInitialization
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    poolVault.initialize(
      ROOT_HISTORY_SIZE,
      _emptyVerifierConfigs(),
      IASPRegistry(mockAspRegistry),
      IKeystore(mockKeystore),
      mockRagequitVerifier,
      mockDepositVerifier,
      MAX_STATE_TREE_SIZE
    );
  }

  function test_Initialize_GivenNotInitialized(
    uint32 _rootHistorySize,
    ITransactVerifierRouter.VerifierConfig[] memory _verifiers,
    uint256 _maxStateTreeSize
  ) external {
    _boundVerifierConfig(_verifiers);
    // Deploy a fresh uninitialized proxy for this test
    ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), '');
    PoolVaultHarness newPoolVault = PoolVaultHarness(payable(address(proxy)));
    vm.assume(_rootHistorySize != 0);

    // It should initialize UUPSUpgradeable
    // It should initialize Pausable
    // It should initialize ReentrancyGuard
    // It should initialize RootBuffer with ROOT_HISTORY_SIZE
    // It should initialize TransactVerifierRouter with verifier configs
    newPoolVault.initialize(
      _rootHistorySize,
      _verifiers,
      IASPRegistry(mockAspRegistry),
      IKeystore(mockKeystore),
      mockRagequitVerifier,
      mockDepositVerifier,
      _maxStateTreeSize
    );

    // Verify RootBuffer initialized - currentRootIndex should be ROOT_HISTORY_SIZE - 1
    assertEq(newPoolVault.currentRootIndex(), _rootHistorySize - 1);
    assertEq(newPoolVault.rootHistorySize(), _rootHistorySize);

    // It should configure verifiers
    for (uint256 i = 0; i < _verifiers.length; i++) {
      bytes32 _key = keccak256(abi.encode(uint256(_verifiers[i].n), uint256(_verifiers[i].m)));
      ITransactVerifierRouter.Verifier memory _stored = newPoolVault.verifiers(_key);
      assertEq(_stored.addr, _verifiers[i].verifier.addr);
      assertEq(_stored.selector, _verifiers[i].verifier.selector);
    }

    // It should set the ASP registry
    assertEq(address(newPoolVault.aspRegistry()), mockAspRegistry);
    // It should set the keystore
    assertEq(address(newPoolVault.keystore()), mockKeystore);
    // It should set the ragequit verifier
    assertEq(address(newPoolVault.ragequitVerifier()), address(mockRagequitVerifier));
    // It should set the deposit verifier
    assertEq(address(newPoolVault.depositVerifier()), address(mockDepositVerifier));
    // It should set the max state tree size
    assertEq(newPoolVault.maxStateTreeSize(), _maxStateTreeSize);

    // It should not be paused
    assertFalse(newPoolVault.paused());
  }

  /*///////////////////////////////////////////////////////////////
                          DEPOSIT
  //////////////////////////////////////////////////////////////*/

  function test_Deposit_WhenContractIsPaused(DepositProofParams memory _fuzz, address _caller) external {
    // Pause the contract
    _mockExpectHasRole(PAUSER_ROLE, address(this), true);
    poolVault.pause();

    ProofLibV2.DepositProof memory proof = buildMockDepositProof(_fuzz);

    // It should revert with EnforcedPause
    vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
    vm.prank(_caller);
    poolVault.deposit(proof, defaultNoteData);
  }

  function test_Deposit_WhenCallerDoesNotHaveTheDEPOSITOR_ROLE(
    DepositProofParams memory _fuzz,
    address _caller
  ) external {
    _mockExpectHasRole(DEPOSITOR_ROLE, _caller, false);

    ProofLibV2.DepositProof memory proof = buildMockDepositProof(_fuzz);

    // It should revert with Permissioned_NotAuthorized
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(_caller);
    poolVault.deposit(proof, defaultNoteData);
  }

  // solhint-disable-next-line style-guide-casing
  modifier givenCallerHasTheDEPOSITOR_ROLE(address _who) {
    _mockExpectHasRole(DEPOSITOR_ROLE, _who, true);
    _;
  }

  function test_Deposit_WhenProofIsNotValid(
    ProofLibV2.DepositProof memory _proof
  ) external givenCallerHasTheDEPOSITOR_ROLE(address(this)) {
    _mockAndExpect(
      address(mockDepositVerifier),
      abi.encodeCall(IDepositVerifier.verifyProof, (_proof.pA, _proof.pB, _proof.pC, _proof.pubSignals)),
      abi.encode(false)
    );
    vm.expectRevert(IPoolVault.PoolVault_InvalidDepositProof.selector);
    poolVault.deposit(_proof, defaultNoteData);
  }

  function test_Deposit_WhenProofContextDoesNotMatchNoteData(DepositProofParams memory _fuzz)
    external
    givenCallerHasTheDEPOSITOR_ROLE(address(this))
  {
    ProofLibV2.DepositProof memory _proof = buildMockDepositProof(_fuzz);
    _proof.pubSignals[1] = uint256(uint160(Constants.NATIVE_ASSET));
    _proof.pubSignals[2] = bound(_proof.pubSignals[2], 0, type(uint128).max);
    // Set a valid context for defaultNoteData
    _setDepositContext(_proof);
    _mockValidProof(_proof);
    deal(address(this), _proof.value());

    // Use different note data to cause context mismatch
    IPoolVault.NoteData memory _wrongNoteData = IPoolVault.NoteData({hint: bytes32(uint256(1)), data: 'wrong'});

    // It should revert with PoolVault_ProofContextMismatch
    vm.expectRevert(IPoolVault.PoolVault_ProofContextMismatch.selector);
    poolVault.deposit{value: _proof.value()}(_proof, _wrongNoteData);
  }

  modifier givenProofIsValid(ProofLibV2.DepositProof memory _proof) {
    _mockValidProof(_proof);
    _;
  }

  /// @dev needed for the case where we mutate the proof in the function body, and invoking it as a modifier won't work
  function _mockValidProof(ProofLibV2.DepositProof memory _proof) internal {
    _mockAndExpect(
      address(mockDepositVerifier),
      abi.encodeCall(IDepositVerifier.verifyProof, (_proof.pA, _proof.pB, _proof.pC, _proof.pubSignals)),
      abi.encode(true)
    );
  }

  /// @dev Sets the deposit proof context to match the default deposit ciphertext
  function _setDepositContext(ProofLibV2.DepositProof memory _proof) internal view {
    _proof.pubSignals[3] = uint256(keccak256(abi.encode(defaultNoteData))) % SNARK_SCALAR_FIELD;
  }

  /// @dev Bounds the deposit value to a reasonable range, sets context, and mocks the proof as valid
  function _boundValueAndMockValid(ProofLibV2.DepositProof memory _proof) internal {
    _proof.pubSignals[2] = bound(_proof.pubSignals[2], 0, type(uint128).max);
    _setDepositContext(_proof);
    _mockValidProof(_proof);
  }

  function test_Deposit_WhenCommitmentWasAlreadyUsed(DepositProofParams memory _fuzz)
    external
    givenCallerHasTheDEPOSITOR_ROLE(address(this))
  {
    ProofLibV2.DepositProof memory proof = buildMockDepositProof(_fuzz);
    proof.pubSignals[1] = uint256(uint160(Constants.NATIVE_ASSET));
    _boundValueAndMockValid(proof);
    deal(address(this), proof.value());

    _setCommitmentExists(proof.outputCommitment());

    vm.expectRevert(IPoolVault.PoolVault_CommitmentAlreadyUsed.selector);
    poolVault.deposit{value: proof.value()}(proof, defaultNoteData);
  }

  function test_Deposit_GivenStateTreeIsAtCapacity(
    ProofLibV2.DepositProof memory _proof,
    address _caller
  ) external givenCallerHasTheDEPOSITOR_ROLE(_caller) givenAssetIsNative(_proof) {
    _boundValueAndMockValid(_proof);
    deal(_caller, _proof.value());
    poolVault.exposed_setStateTreeSize(MAX_STATE_TREE_SIZE);

    // It should revert with PoolVault_StateTreeFull
    vm.expectRevert(IPoolVault.PoolVault_StateTreeFull.selector);
    vm.prank(_caller);
    poolVault.deposit{value: _proof.value()}(_proof, defaultNoteData);
  }

  modifier givenAssetIsNative(ProofLibV2.DepositProof memory _proof) {
    _proof.pubSignals[1] = uint256(uint160(Constants.NATIVE_ASSET));
    _;
  }

  /// @dev not using givenProofIsValid modifier since we need to bound the asset before that (in givenAssetIsNative)
  function test_Deposit_WhenMsg_valueDoesNotEqualProof_value(
    ProofLibV2.DepositProof memory _proof,
    uint128 _value
  ) external givenCallerHasTheDEPOSITOR_ROLE(address(this)) givenAssetIsNative(_proof) {
    _setDepositContext(_proof);
    _mockValidProof(_proof);
    vm.assume(_proof.value() != _value);
    deal(address(this), _value);
    // It should revert with PoolVault_InvalidValue
    vm.expectRevert(IPoolVault.PoolVault_InvalidValue.selector);
    poolVault.deposit{value: _value}(_proof, defaultNoteData);
  }

  /// @dev not using givenProofIsValid modifier since we need to bound the value before that
  function test_Deposit_WhenMsg_valueEqualsProof_value(
    ProofLibV2.DepositProof memory _proof,
    address _caller,
    uint256 _mockedRoot,
    uint256 _mockedIndex,
    uint256 _mockedTimestamp
  ) external givenCallerHasTheDEPOSITOR_ROLE(_caller) givenAssetIsNative(_proof) {
    // Deliberately allow 0-value deposits, and bound to something reasonable we can then vm.deal
    _mockedRoot = bound(_mockedRoot, 1, type(uint256).max);
    _boundValueAndMockValid(_proof);
    vm.warp(_mockedTimestamp);

    uint256 _expectedLeaf =
      PoseidonT4.hash([Constants.COMMITMENT_LEAF_TAG, _proof.outputCommitment(), _mockedTimestamp]);

    poolVault.mockRootInsertion(_mockedRoot);
    poolVault.mockInsertionIndex(_mockedIndex);
    deal(_caller, _proof.value());
    // It should emit LeavesInserted event
    uint256[] memory _expectedLeaves = new uint256[](1);
    _expectedLeaves[0] = _expectedLeaf;
    vm.expectEmit(address(poolVault));
    emit ITreeUpdates.LeavesInserted(_expectedLeaves, _mockedRoot, _mockedIndex);
    // It should emit a Note event
    vm.expectEmit(address(poolVault));
    emit IPoolVault.Note(defaultNoteData.hint, defaultNoteData.data);
    // It should emit a Deposited event
    vm.expectEmit(address(poolVault));
    emit IPoolVault.Deposited(_proof.outputCommitment(), _proof.tokenId(), _proof.value(), _caller);
    vm.prank(_caller);
    poolVault.deposit{value: _proof.value()}(_proof, defaultNoteData);

    // It should insert the timestamped commitment into the state tree
    assertEq(poolVault.insertInTreeSpies(0), _expectedLeaf);

    // It should record the commitment creation timestamp
    assertEq(poolVault.commitments(_proof.outputCommitment()), _mockedTimestamp);

    // It should update the commitment tree root
    assertTrue(poolVault.isKnownRoot(_mockedRoot));
  }

  modifier givenAssetIsNotNative(ProofLibV2.DepositProof memory _proof) {
    _proof.pubSignals[1] = _proof.pubSignals[1] % (uint256(type(uint160).max) + 1);
    vm.assume(_proof.tokenId() != Constants.NATIVE_ASSET);
    assumeNotForgeAddress(_proof.tokenId());
    _;
  }

  function test_Deposit_WhenMsg_valueIsNotZero(
    ProofLibV2.DepositProof memory _proof,
    uint256 _msgValue
  ) external givenCallerHasTheDEPOSITOR_ROLE(address(this)) givenAssetIsNotNative(_proof) {
    _boundValueAndMockValid(_proof);
    _msgValue = bound(_msgValue, 1, type(uint128).max);
    deal(address(this), _msgValue);

    // It should revert with PoolVault_UnexpectedETHAmount
    vm.expectRevert(IPoolVault.PoolVault_UnexpectedETHAmount.selector);
    poolVault.deposit{value: _msgValue}(_proof, defaultNoteData);
  }

  function test_Deposit_WhenTransferringProof_valueAssetsToThePoolFailsByReturningFalse(
    ProofLibV2.DepositProof memory _proof,
    uint256 _mockedRoot,
    uint256 _mockedIndex
  ) external givenCallerHasTheDEPOSITOR_ROLE(address(this)) givenAssetIsNotNative(_proof) {
    _boundValueAndMockValid(_proof);
    address _token = _proof.tokenId();
    poolVault.mockRootInsertion(_mockedRoot);
    poolVault.mockInsertionIndex(_mockedIndex);

    _mockAndExpect(
      _token,
      abi.encodeCall(IERC20.transferFrom, (address(this), address(poolVault), _proof.value())),
      abi.encode(false)
    );
    // It should revert with TransferFromFailed
    vm.expectRevert(SafeTransferLib.TransferFromFailed.selector);
    poolVault.deposit(_proof, defaultNoteData);
  }

  function test_Deposit_WhenTransferringProof_valueAssetsToThePoolFailsByReverting(
    ProofLibV2.DepositProof memory _proof,
    bytes memory _erc20RevertData,
    uint256 _mockedRoot,
    uint256 _mockedIndex
  ) external givenCallerHasTheDEPOSITOR_ROLE(address(this)) givenAssetIsNotNative(_proof) {
    _boundValueAndMockValid(_proof);
    address _token = _proof.tokenId();
    poolVault.mockRootInsertion(_mockedRoot);
    poolVault.mockInsertionIndex(_mockedIndex);

    _mockAndExpectRevert(
      _token, abi.encodeCall(IERC20.transferFrom, (address(this), address(poolVault), _proof.value())), _erc20RevertData
    );
    // It should revert with TransferFromFailed (Solady wraps all transfer failures)
    vm.expectRevert(SafeTransferLib.TransferFromFailed.selector);
    poolVault.deposit(_proof, defaultNoteData);
  }

  function test_Deposit_WhenTransferringProof_valueAssetsToThePoolSucceeds(
    ProofLibV2.DepositProof memory _proof,
    address _caller,
    uint256 _mockedRoot,
    uint256 _mockedIndex,
    uint256 _mockedTimestamp
  ) external givenCallerHasTheDEPOSITOR_ROLE(_caller) givenAssetIsNotNative(_proof) {
    assumeNotForgeAddress(_caller);
    _mockedRoot = bound(_mockedRoot, 1, type(uint256).max);
    _boundValueAndMockValid(_proof);
    vm.warp(_mockedTimestamp);
    address _asset = _proof.tokenId();

    uint256 _expectedLeaf =
      PoseidonT4.hash([Constants.COMMITMENT_LEAF_TAG, _proof.outputCommitment(), _mockedTimestamp]);

    bytes memory transferData = abi.encodeCall(IERC20.transferFrom, (_caller, address(poolVault), _proof.value()));
    _mockAndExpect(_asset, transferData, abi.encode(true));

    poolVault.mockRootInsertion(_mockedRoot);
    poolVault.mockInsertionIndex(_mockedIndex);
    // It should emit LeavesInserted event
    uint256[] memory _expectedLeaves = new uint256[](1);
    _expectedLeaves[0] = _expectedLeaf;
    vm.expectEmit(address(poolVault));
    emit ITreeUpdates.LeavesInserted(_expectedLeaves, _mockedRoot, _mockedIndex);
    // It should emit a Note event
    vm.expectEmit(address(poolVault));
    emit IPoolVault.Note(defaultNoteData.hint, defaultNoteData.data);
    // It should emit a Deposited event
    vm.expectEmit(address(poolVault));
    emit IPoolVault.Deposited(_proof.outputCommitment(), _proof.tokenId(), _proof.value(), _caller);

    vm.prank(_caller);
    poolVault.deposit(_proof, defaultNoteData);

    // It should insert the timestamped commitment into the state tree
    assertEq(poolVault.insertInTreeSpies(0), _expectedLeaf);

    // It should record the commitment creation timestamp
    assertEq(poolVault.commitments(_proof.outputCommitment()), _mockedTimestamp);

    // It should update the commitment tree root
    assertTrue(poolVault.isKnownRoot(_mockedRoot));
  }
  /*///////////////////////////////////////////////////////////////
                          TRANSACT
  //////////////////////////////////////////////////////////////*/

  function test_Transact_GivenContractIsPaused(address _caller) external {
    // Mock pause role and pause
    _mockExpectHasRole(PAUSER_ROLE, address(this), true);
    poolVault.pause();

    ProofLibV2.TransactProof memory proof;

    // It should revert with EnforcedPause
    vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
    vm.prank(_caller);
    poolVault.transact(proof, defaultParams, new IPoolVault.NoteData[](0));
  }

  function test_Transact_WhenCallerIsNotProcessor(
    TransactProofParams memory _fuzz,
    address _processor,
    address _caller
  ) external {
    // Caller is Not Processor
    vm.assume(_processor != _caller);

    IPoolVault.TransactParams memory params = IPoolVault.TransactParams({processor: _processor, data: ''});

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, params, _noteData);

    // It should revert with PoolVault_InvalidProcessor
    vm.expectRevert(IPoolVault.PoolVault_InvalidProcessor.selector);
    vm.prank(_caller);
    poolVault.transact(proof, params, _noteData);
  }

  function test_Transact_WhenProofContextDoesNotMatch(TransactProofParams memory _fuzz) external {
    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    // Build proof with correct context, then use different params to cause mismatch
    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, defaultParams, _noteData);

    // Use different params to cause context mismatch (processor matches msg.sender so that check passes)
    IPoolVault.TransactParams memory wrongParams = IPoolVault.TransactParams({processor: address(this), data: 'wrong'});

    // Ensure the params are always different (context will mismatch)
    vm.assume(keccak256(abi.encode(defaultParams, _noteData)) != keccak256(abi.encode(wrongParams, _noteData)));

    // It should revert with PoolVault_ProofContextMismatch
    vm.expectRevert(IPoolVault.PoolVault_ProofContextMismatch.selector);
    poolVault.transact(proof, wrongParams, _noteData);
  }

  function test_Transact_GivenCommitmentStateTreeRootIsUnknown(TransactProofParams memory _fuzz) external {
    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, defaultParams, _noteData);

    // Don't add the merkle root to buffer - it should be unknown

    // It should revert with PoolVault_UnknownStateRoot
    vm.expectRevert(IPoolVault.PoolVault_UnknownStateRoot.selector);
    poolVault.transact(proof, defaultParams, _noteData);
  }

  function test_Transact_GivenKeystoreRootIsUnknown(TransactProofParams memory _fuzz) external {
    _fuzz.stateRoot = bound(_fuzz.stateRoot, 1, SNARK_SCALAR_FIELD - 1);

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, defaultParams, _noteData);

    // Add state root to buffer
    poolVault.exposed_updateRoot(_fuzz.stateRoot);

    // Mock keystore root as unknown
    _mockAndExpect(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keyRegistryRoot)), abi.encode(false));

    // It should revert with PoolVault_UnknownKeystoreRoot
    vm.expectRevert(IPoolVault.PoolVault_UnknownKeystoreRoot.selector);
    poolVault.transact(proof, defaultParams, _noteData);
  }

  function test_Transact_GivenASPRootDoesNotMatchLatest(
    TransactProofParams memory _fuzz,
    uint256 _latestAspRoot
  ) external {
    _fuzz.stateRoot = bound(_fuzz.stateRoot, 1, SNARK_SCALAR_FIELD - 1);
    // ASP Root does not match latest.
    vm.assume(_fuzz.aspRoot != _latestAspRoot);

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, defaultParams, _noteData);

    // Add state root to buffer
    poolVault.exposed_updateRoot(_fuzz.stateRoot);

    // Mock keystore root as known
    _mockAndExpect(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keyRegistryRoot)), abi.encode(true));

    // Mock ASP registry to return different root
    _mockAndExpect(mockAspRegistry, LATEST_ASP_ROOT_SELECTOR, abi.encode(_latestAspRoot));

    // It should revert with PoolVault_InvalidASPRoot
    vm.expectRevert(IPoolVault.PoolVault_InvalidASPRoot.selector);
    poolVault.transact(proof, defaultParams, _noteData);
  }

  function test_Transact_WhenTransactProofVerificationFails(TransactProofParams memory _fuzz) external {
    _fuzz.stateRoot = bound(_fuzz.stateRoot, 1, SNARK_SCALAR_FIELD - 1);

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, defaultParams, _noteData);

    // Setup valid roots
    poolVault.exposed_updateRoot(_fuzz.stateRoot);
    _mockAndExpect(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keyRegistryRoot)), abi.encode(true));
    _mockAndExpect(mockAspRegistry, LATEST_ASP_ROOT_SELECTOR, abi.encode(_fuzz.aspRoot));

    poolVault.mockTransactVerifyResult(false);

    // It should revert with PoolVault_InvalidTransactProof
    vm.expectRevert(IPoolVault.PoolVault_InvalidTransactProof.selector);
    poolVault.transact(proof, defaultParams, _noteData);
  }

  function test_Transact_GivenCommitmentAlreadyUsed(
    TransactProofParams memory _fuzz,
    uint256 _commitmentIndex
  ) external {
    _setupValidTransact(_fuzz);
    vm.assume(_fuzz.outputCommitmentsLength != 0);
    _commitmentIndex = bound(_commitmentIndex, 0, _fuzz.outputCommitmentsLength - 1);

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, defaultParams, _noteData);

    poolVault.mockRootInsertion(_fuzz.stateRoot);

    _setCommitmentExists(_fuzz.outputCommitments[_commitmentIndex]);

    // It should revert with PoolVault_CommitmentAlreadyUsed
    vm.expectRevert(IPoolVault.PoolVault_CommitmentAlreadyUsed.selector);
    poolVault.transact(proof, defaultParams, _noteData);
  }

  function test_Transact_GivenNullifierAlreadySpent(TransactProofParams memory _fuzz) external {
    _setupValidTransact(_fuzz);
    vm.assume(_fuzz.nullifierHashesLength != 0);

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, defaultParams, _noteData);

    // Mock root insertion since tree insert happens before nullifier check
    poolVault.mockRootInsertion(_fuzz.stateRoot);

    // Set first nullifier as already spent
    _setNullifierSpent(_fuzz.nullifierHashes[0]);

    // It should revert with PoolVault_NullifierAlreadySpent
    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    poolVault.transact(proof, defaultParams, _noteData);
  }

  function test_Transact_GivenStateTreeBatchWouldExceedCapacity(TransactProofParams memory _fuzz) external {
    _setupValidTransact(_fuzz);
    uint256 _numLeaves = _fuzz.outputCommitmentsLength + _fuzz.nullifierHashesLength;
    vm.assume(_numLeaves > 0);

    // Leave `_numLeaves - 1` free slots so the batch overflows by exactly 1
    poolVault.exposed_setStateTreeSize(MAX_STATE_TREE_SIZE - _numLeaves + 1);

    address _caller = makeAddr('caller');
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_fuzz.outputCommitmentsLength);
    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({processor: _caller, data: defaultParams.data});
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _noteData);

    // It should revert with PoolVault_StateTreeFull
    vm.expectRevert(IPoolVault.PoolVault_StateTreeFull.selector);
    vm.prank(_caller);
    poolVault.transact(_proof, _params, _noteData);
  }

  /// @dev Memory structs are passed by reference, so bounding _fuzz here affects the original in the test function
  modifier whenWithdrawnValueIsZero(TransactProofParams memory _fuzz) {
    _fuzz.stateRoot = bound(_fuzz.stateRoot, 1, SNARK_SCALAR_FIELD - 1);
    _fuzz.amountOut = 0;

    _setupValidTransact(_fuzz);
    _;
  }

  function test_Transact_WhenWithdrawnValueIsZero(
    TransactProofParams memory _fuzz,
    uint256 _mockedTimestamp,
    uint256 _newStateRoot,
    address _caller
  ) external whenWithdrawnValueIsZero(_fuzz) {
    _fuzz.tokenIdOut = 0;
    _newStateRoot = bound(_newStateRoot, 1, SNARK_SCALAR_FIELD - 1);
    vm.warp(_mockedTimestamp);

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    IPoolVault.TransactParams memory params = IPoolVault.TransactParams({processor: _caller, data: defaultParams.data});
    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, params, _noteData);

    poolVault.mockRootInsertion(_newStateRoot);

    uint256 vaultBalanceBefore = address(poolVault).balance;

    // It should emit Note + Transacted events (asset derived from tokenIdOut = address(0))
    _expectTransactEvents(_fuzz, _noteData, address(0), _caller);

    vm.prank(_caller);
    poolVault.transact(proof, params, _noteData);

    // It should append output commitments to commitments mapping
    for (uint256 i; i < _fuzz.outputCommitmentsLength; ++i) {
      assertEq(poolVault.commitments(_fuzz.outputCommitments[i]), _mockedTimestamp);
    }

    // It should insert timestamped output commitments into state tree
    // It should insert timestamped nullifiers into state tree
    _assertTimestampedLeaves(
      _fuzz.outputCommitments,
      _fuzz.outputCommitmentsLength,
      _fuzz.nullifierHashes,
      _fuzz.nullifierHashesLength,
      _mockedTimestamp
    );

    // It should update root buffer
    assertTrue(poolVault.isKnownRoot(_newStateRoot));

    // It should mark all nullifiers as spent at block.timestamp
    for (uint256 i; i < _fuzz.nullifierHashesLength; ++i) {
      assertEq(poolVault.spentNullifiers(_fuzz.nullifierHashes[i]), _mockedTimestamp);
    }

    // It should not transfer any tokens
    assertEq(address(poolVault).balance, vaultBalanceBefore);

    // It should call verifyProof with correct params
    PoolVaultHarness.VerifyProofCall memory _verifyCall = poolVault.verifyProofCalls(0);
    assertEq(_verifyCall.stateRoot, _fuzz.stateRoot);
    assertEq(_verifyCall.keystoreRoot, _fuzz.keyRegistryRoot);
    assertEq(_verifyCall.aspRoot, _fuzz.aspRoot);
    assertEq(_verifyCall.amountOut, _fuzz.amountOut);
    assertEq(_verifyCall.tokenId, 0);
    uint256 _expectedContext = uint256(keccak256(abi.encode(params, _noteData))) % SNARK_SCALAR_FIELD;
    assertEq(_verifyCall.context, _expectedContext);
    assertEq(_verifyCall.nullifiersSpent.length, _fuzz.nullifierHashesLength);
    for (uint256 i; i < _fuzz.nullifierHashesLength; ++i) {
      assertEq(_verifyCall.nullifiersSpent[i], _fuzz.nullifierHashes[i]);
    }
    assertEq(_verifyCall.commitmentsCreated.length, _fuzz.outputCommitmentsLength);
    for (uint256 i; i < _fuzz.outputCommitmentsLength; ++i) {
      assertEq(_verifyCall.commitmentsCreated[i], _fuzz.outputCommitments[i]);
    }
  }

  function test_Transact_WhenTokenIdOutIsNotZero(
    TransactProofParams memory _fuzz,
    uint256 _newStateRoot,
    address _caller
  ) external whenWithdrawnValueIsZero(_fuzz) {
    _fuzz.tokenIdOut = bound(_fuzz.tokenIdOut, 1, type(uint160).max);
    _newStateRoot = bound(_newStateRoot, 1, SNARK_SCALAR_FIELD - 1);

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({processor: _caller, data: defaultParams.data});
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _noteData);

    poolVault.mockRootInsertion(_newStateRoot);

    // It should revert with PoolVault_TokenIdMustBeZeroOnInternalTransfer
    vm.expectRevert(IPoolVault.PoolVault_TokenIdMustBeZeroOnInternalTransfer.selector);
    vm.prank(_caller);
    poolVault.transact(_proof, _params, _noteData);
  }

  modifier whenWithdrawnValueIsNotZero(TransactProofParams memory _fuzz) {
    _fuzz.stateRoot = bound(_fuzz.stateRoot, 1, SNARK_SCALAR_FIELD - 1);
    _fuzz.amountOut = bound(_fuzz.amountOut, 1, type(uint128).max);

    _setupValidTransact(_fuzz);
    _;
  }

  modifier whenAssetIsNative(TransactProofParams memory _fuzz) {
    _fuzz.tokenIdOut = uint256(uint160(Constants.NATIVE_ASSET));
    _;
  }

  function test_Transact_WhenTransferFails(
    TransactProofParams memory _fuzz,
    address _rejecter,
    uint256 _newStateRoot
  ) external whenWithdrawnValueIsNotZero(_fuzz) whenAssetIsNative(_fuzz) {
    _newStateRoot = bound(_newStateRoot, 1, SNARK_SCALAR_FIELD - 1);
    vm.assume(_rejecter != address(poolVault));
    vm.assume(_rejecter != address(implementation));

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    IPoolVault.TransactParams memory params =
      IPoolVault.TransactParams({processor: _rejecter, data: defaultParams.data});
    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, params, _noteData);

    poolVault.mockRootInsertion(_newStateRoot);
    vm.deal(address(poolVault), _fuzz.amountOut);

    // Mock _rejecter to reject any incoming call (simulates contract that rejects ETH)
    vm.mockCallRevert(_rejecter, bytes(''), abi.encode('REJECTED'));

    // It should revert with SafeTransferLib.ETHTransferFailed
    vm.expectRevert(SafeTransferLib.ETHTransferFailed.selector);
    vm.prank(_rejecter);
    poolVault.transact(proof, params, _noteData);
  }

  function test_Transact_WhenTransferSucceeds(
    TransactProofParams memory _fuzz,
    uint256 _mockedTimestamp,
    uint256 _newStateRoot
  ) external whenWithdrawnValueIsNotZero(_fuzz) whenAssetIsNative(_fuzz) {
    _newStateRoot = bound(_newStateRoot, 1, SNARK_SCALAR_FIELD - 1);
    vm.warp(_mockedTimestamp);
    // no need to fuzz here, we just need "when transfer succeeds"
    // if we fuzz we need to exclude a bunch of addresses that revert transfers
    address caller = makeAddr('caller');

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    IPoolVault.TransactParams memory params = IPoolVault.TransactParams({processor: caller, data: defaultParams.data});
    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, params, _noteData);

    vm.deal(address(poolVault), _fuzz.amountOut);
    poolVault.mockRootInsertion(_newStateRoot);

    // It should emit Note + Transacted events
    _expectTransactEvents(_fuzz, _noteData, Constants.NATIVE_ASSET, caller);

    vm.prank(caller);
    poolVault.transact(proof, params, _noteData);

    // It should append output commitments to commitments mapping
    for (uint256 i; i < _fuzz.outputCommitmentsLength; ++i) {
      assertEq(poolVault.commitments(_fuzz.outputCommitments[i]), _mockedTimestamp);
    }

    // It should insert timestamped output commitments into state tree
    // It should insert timestamped nullifiers into state tree
    _assertTimestampedLeaves(
      _fuzz.outputCommitments,
      _fuzz.outputCommitmentsLength,
      _fuzz.nullifierHashes,
      _fuzz.nullifierHashesLength,
      _mockedTimestamp
    );

    // It should update root buffer
    assertTrue(poolVault.isKnownRoot(_newStateRoot));

    // It should mark all nullifiers as spent at block.timestamp
    for (uint256 i; i < _fuzz.nullifierHashesLength; ++i) {
      assertEq(poolVault.spentNullifiers(_fuzz.nullifierHashes[i]), _mockedTimestamp);
    }

    // It should transfer ETH to caller
    assertEq(caller.balance, _fuzz.amountOut);
  }

  modifier whenTransactAssetIsERC20(TransactProofParams memory _fuzz) {
    _fuzz.tokenIdOut = uint256(uint160(mockErc20));
    _;
  }

  function test_Transact_WhenTransactAssetIsERC20(
    TransactProofParams memory _fuzz,
    address _caller,
    uint256 _mockedTimestamp,
    uint256 _newStateRoot
  ) external whenWithdrawnValueIsNotZero(_fuzz) whenTransactAssetIsERC20(_fuzz) {
    _newStateRoot = bound(_newStateRoot, 1, SNARK_SCALAR_FIELD - 1);
    vm.warp(_mockedTimestamp);

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);

    IPoolVault.TransactParams memory params = IPoolVault.TransactParams({processor: _caller, data: defaultParams.data});
    ProofLibV2.TransactProof memory proof = buildMockTransactProof(_fuzz, params, _noteData);

    poolVault.mockRootInsertion(_newStateRoot);

    // It should transfer ERC20 to caller (mockAndExpect asserts the call happens)
    _mockAndExpect(mockErc20, abi.encodeCall(IERC20.transfer, (_caller, _fuzz.amountOut)), abi.encode(true));

    // It should emit Note + Transacted events
    _expectTransactEvents(_fuzz, _noteData, mockErc20, _caller);

    vm.prank(_caller);
    poolVault.transact(proof, params, _noteData);

    // It should append output commitments to commitments mapping
    for (uint256 i; i < _fuzz.outputCommitmentsLength; ++i) {
      assertEq(poolVault.commitments(_fuzz.outputCommitments[i]), _mockedTimestamp);
    }

    // It should insert timestamped output commitments into state tree
    // It should insert timestamped nullifiers into state tree
    _assertTimestampedLeaves(
      _fuzz.outputCommitments,
      _fuzz.outputCommitmentsLength,
      _fuzz.nullifierHashes,
      _fuzz.nullifierHashesLength,
      _mockedTimestamp
    );

    // It should update root buffer
    assertTrue(poolVault.isKnownRoot(_newStateRoot));

    // It should mark all nullifiers as spent at block.timestamp
    for (uint256 i; i < _fuzz.nullifierHashesLength; ++i) {
      assertEq(poolVault.spentNullifiers(_fuzz.nullifierHashes[i]), _mockedTimestamp);
    }
  }

  /*///////////////////////////////////////////////////////////////
                            RAGEQUIT
  //////////////////////////////////////////////////////////////*/

  function test_Ragequit_WhenCallerDoesNotMatchOwnerAddressFromProof(
    RagequitProofParams memory _fuzz,
    address _caller
  ) external {
    vm.assume(_caller != _fuzz.ownerAddress);

    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    // It should revert with PoolVault_InvalidOwnerAddress
    vm.expectRevert(IPoolVault.PoolVault_InvalidOwnerAddress.selector);
    vm.prank(_caller);
    poolVault.ragequit(proof);
  }

  function test_Ragequit_WhenProofValueIsZero(RagequitProofParams memory _fuzz) external {
    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);
    // Override after building since `buildMockRagequitProof` bounds value > 0 by default
    proof.pubSignals[4] = 0;

    // It should revert with PoolVault_ZeroValueRagequit
    vm.expectRevert(IPoolVault.PoolVault_ZeroValueRagequit.selector);
    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(proof);
  }

  function test_Ragequit_GivenCommitmentDoesNotExistInStateTree(RagequitProofParams memory _fuzz) external {
    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    // Don't insert commitment - it should be unknown

    // It should revert with PoolVault_CommitmentNotFound
    vm.expectRevert(IPoolVault.PoolVault_CommitmentNotFound.selector);
    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(proof);
  }

  function test_Ragequit_GivenNullifierAlreadySpent(RagequitProofParams memory _fuzz)
    external
    whenAllChecksPass(_fuzz)
  {
    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    // Set nullifier as already spent
    _setNullifierSpent(_fuzz.nullifierHash);

    // It should revert with PoolVault_NullifierAlreadySpent
    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(proof);
  }

  function test_Ragequit_GivenKeystoreRootIsUnknown(RagequitProofParams memory _fuzz) external {
    _fuzz.commitment = bound(_fuzz.commitment, 1, SNARK_SCALAR_FIELD - 1);

    // Mock commitment in state tree
    _mockCommitment(_fuzz.commitment);

    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    // Mock keystore root as unknown
    _mockAndExpect(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keystoreRoot)), abi.encode(false));

    // It should revert with PoolVault_UnknownKeystoreRoot
    vm.expectRevert(IPoolVault.PoolVault_UnknownKeystoreRoot.selector);
    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(proof);
  }

  function test_Ragequit_WhenRagequitProofVerificationFails(RagequitProofParams memory _fuzz) external {
    _fuzz.commitment = bound(_fuzz.commitment, 1, SNARK_SCALAR_FIELD - 1);

    // Mock commitment in state tree
    _mockCommitment(_fuzz.commitment);

    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    // Mock keystore root as known
    _mockAndExpect(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keystoreRoot)), abi.encode(true));
    // Mock ragequit verifier to return false
    _mockAndExpect(
      address(mockRagequitVerifier), abi.encodeWithSelector(IRagequitVerifier.verifyProof.selector), abi.encode(false)
    );

    // It should revert with PoolVault_InvalidRagequitProof
    vm.expectRevert(IPoolVault.PoolVault_InvalidRagequitProof.selector);
    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(proof);
  }

  function test_Ragequit_GivenStateTreeIsAtCapacity(RagequitProofParams memory _fuzz)
    external
    whenAllChecksPass(_fuzz)
  {
    ProofLibV2.RagequitProof memory _proof = buildMockRagequitProof(_fuzz);
    poolVault.exposed_setStateTreeSize(MAX_STATE_TREE_SIZE);

    // It should revert with PoolVault_StateTreeFull
    vm.expectRevert(IPoolVault.PoolVault_StateTreeFull.selector);
    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(_proof);
  }

  modifier whenAllChecksPass(RagequitProofParams memory _fuzz) {
    _setupValidRagequit(_fuzz);
    _;
  }

  function test_Ragequit_WhenETHTransferFails(
    RagequitProofParams memory _fuzz,
    address _rejecter
  ) external whenAllChecksPass(_fuzz) {
    _fuzz.tokenId = uint256(uint160(Constants.NATIVE_ASSET));
    _fuzz.value = bound(_fuzz.value, 1, type(uint128).max);

    // Exclude addresses that would conflict with test setup
    vm.assume(_rejecter != address(poolVault));
    vm.assume(_rejecter != address(implementation));

    // Override ownerAddress to the rejecter
    _fuzz.ownerAddress = _rejecter;
    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    vm.deal(address(poolVault), _fuzz.value);

    // Mock _rejecter to reject any incoming call (simulates contract that rejects ETH)
    vm.mockCallRevert(_rejecter, bytes(''), abi.encode('REJECTED'));

    // It should revert with SafeTransferLib.ETHTransferFailed
    vm.expectRevert(SafeTransferLib.ETHTransferFailed.selector);
    vm.prank(_rejecter);
    poolVault.ragequit(proof);
  }

  function test_Ragequit_WhenETHTransferSucceeds(
    RagequitProofParams memory _fuzz,
    bool _paused
  ) external whenAllChecksPass(_fuzz) {
    _fuzz.tokenId = uint256(uint160(Constants.NATIVE_ASSET));
    _fuzz.value = bound(_fuzz.value, 1, type(uint128).max);

    // Exclude addresses that might not be able to receive ETH
    vm.assume(_fuzz.ownerAddress != address(poolVault));
    vm.assume(_fuzz.ownerAddress != address(implementation));

    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    vm.deal(address(poolVault), _fuzz.value);
    uint256 ownerBalanceBefore = _fuzz.ownerAddress.balance;

    // It should be callable regardless of pause state
    _setPaused(_paused);

    // It should call keystore to verify root
    vm.expectCall(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keystoreRoot)));

    // It should call verifier to verify proof
    vm.expectCall(address(mockRagequitVerifier), abi.encodeWithSelector(IRagequitVerifier.verifyProof.selector));

    // It should emit Ragequit event
    vm.expectEmit(address(poolVault));
    emit IPoolVault.Ragequit(
      _fuzz.ownerAddress, Constants.NATIVE_ASSET, _fuzz.value, _fuzz.commitment, _fuzz.nullifierHash, _fuzz.label
    );

    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(proof);

    // It should mark nullifier as spent at block.timestamp
    assertGt(poolVault.spentNullifiers(_fuzz.nullifierHash), 0);

    // It should insert timestamped nullifier into state tree
    uint256 _expectedLeaf = PoseidonT4.hash([Constants.NULLIFIER_LEAF_TAG, _fuzz.nullifierHash, vm.getBlockTimestamp()]);
    assertEq(poolVault.insertInTreeSpies(0), _expectedLeaf);

    // It should update root buffer
    assertTrue(poolVault.isKnownRoot(uint256(keccak256('ragequitRoot'))));

    // It should transfer ETH to owner
    assertEq(_fuzz.ownerAddress.balance, ownerBalanceBefore + _fuzz.value);
  }

  modifier whenRagequitAssetIsERC20(RagequitProofParams memory _fuzz) {
    _fuzz.tokenId = uint256(uint160(mockErc20));
    _;
  }

  function test_Ragequit_WhenTransferringAssetsFailsByReturningFalse(RagequitProofParams memory _fuzz)
    external
    whenAllChecksPass(_fuzz)
    whenRagequitAssetIsERC20(_fuzz)
  {
    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    _mockAndExpect(mockErc20, abi.encodeCall(IERC20.transfer, (_fuzz.ownerAddress, _fuzz.value)), abi.encode(false));

    // It should revert with TransferFailed
    vm.expectRevert(SafeTransferLib.TransferFailed.selector);
    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(proof);
  }

  function test_Ragequit_WhenTransferringAssetsFailsByReverting(
    RagequitProofParams memory _fuzz,
    bytes memory _erc20RevertData
  ) external whenAllChecksPass(_fuzz) whenRagequitAssetIsERC20(_fuzz) {
    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    _mockAndExpectRevert(
      mockErc20, abi.encodeCall(IERC20.transfer, (_fuzz.ownerAddress, _fuzz.value)), _erc20RevertData
    );

    // It should revert with TransferFailed (Solady wraps all transfer failures)
    vm.expectRevert(SafeTransferLib.TransferFailed.selector);
    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(proof);
  }

  function test_Ragequit_WhenTransferringAssetsSucceeds(
    RagequitProofParams memory _fuzz,
    bool _paused
  ) external whenAllChecksPass(_fuzz) whenRagequitAssetIsERC20(_fuzz) {
    _fuzz.tokenId = uint256(uint160(mockErc20));
    _fuzz.value = bound(_fuzz.value, 1, type(uint128).max);

    ProofLibV2.RagequitProof memory proof = buildMockRagequitProof(_fuzz);

    // It should be callable regardless of pause state
    _setPaused(_paused);

    // It should call keystore to verify root
    vm.expectCall(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keystoreRoot)));

    // It should call verifier to verify proof
    vm.expectCall(address(mockRagequitVerifier), abi.encodeWithSelector(IRagequitVerifier.verifyProof.selector));

    // It should transfer ERC20 to caller (mockAndExpect asserts the call happens)
    _mockAndExpect(mockErc20, abi.encodeCall(IERC20.transfer, (_fuzz.ownerAddress, _fuzz.value)), abi.encode(true));

    // It should emit Ragequit event
    vm.expectEmit(address(poolVault));
    emit IPoolVault.Ragequit(
      _fuzz.ownerAddress, mockErc20, _fuzz.value, _fuzz.commitment, _fuzz.nullifierHash, _fuzz.label
    );

    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(proof);

    // It should mark nullifier as spent at block.timestamp
    assertGt(poolVault.spentNullifiers(_fuzz.nullifierHash), 0);

    // It should insert timestamped nullifier into state tree
    uint256 _expectedLeaf = PoseidonT4.hash([Constants.NULLIFIER_LEAF_TAG, _fuzz.nullifierHash, vm.getBlockTimestamp()]);
    assertEq(poolVault.insertInTreeSpies(0), _expectedLeaf);

    // It should update root buffer
    assertTrue(poolVault.isKnownRoot(uint256(keccak256('ragequitRoot'))));
  }

  /*///////////////////////////////////////////////////////////////
                            PAUSE
  //////////////////////////////////////////////////////////////*/

  function test_Pause_GivenCallerDoesNotHavePAUSER_ROLE(address _caller) external {
    _mockExpectHasRole(PAUSER_ROLE, _caller, false);

    // It should revert with PoolVault_NotAuthorized
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(_caller);
    poolVault.pause();
  }

  function test_Pause_GivenCallerHasPAUSER_ROLE(address _caller) external {
    _mockExpectHasRole(PAUSER_ROLE, _caller, true);

    // It should emit Paused event
    vm.expectEmit(address(poolVault));
    emit PausableUpgradeable.Paused(_caller);

    vm.prank(_caller);
    poolVault.pause();

    // It should pause the contract
    assertTrue(poolVault.paused());
  }

  /*///////////////////////////////////////////////////////////////
                          UNPAUSE
  //////////////////////////////////////////////////////////////*/

  function test_Unpause_GivenCallerDoesNotHaveUNPAUSER_ROLE(address _caller) external {
    // First pause the contract
    _mockExpectHasRole(PAUSER_ROLE, address(this), true);
    poolVault.pause();

    _mockExpectHasRole(UNPAUSER_ROLE, _caller, false);

    // It should revert with PoolVault_NotAuthorized
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(_caller);
    poolVault.unpause();
  }

  function test_Unpause_GivenCallerHasUNPAUSER_ROLE(address _caller) external {
    // First pause the contract
    _mockExpectHasRole(PAUSER_ROLE, address(this), true);
    poolVault.pause();

    _mockExpectHasRole(UNPAUSER_ROLE, _caller, true);

    // It should unpause the contract
    // It should emit Unpaused event
    vm.expectEmit(address(poolVault));
    emit PausableUpgradeable.Unpaused(_caller);

    vm.prank(_caller);
    poolVault.unpause();

    assertFalse(poolVault.paused());
  }

  /*///////////////////////////////////////////////////////////////
                      UPGRADE TO AND CALL
  //////////////////////////////////////////////////////////////*/

  function test_UpgradeToAndCall_GivenCallerDoesNotHaveUPGRADER_ROLE(
    address _caller,
    address _newImplementation
  ) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);

    // It should revert with PoolVault_NotAuthorized
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(_caller);
    poolVault.upgradeToAndCall(_newImplementation, '');
  }

  function test_UpgradeToAndCall_GivenCallerHasUPGRADER_ROLE(address _caller) external {
    // Deploy new implementation
    PoolVault newImplementation = new PoolVault(IAccessControl(mockAccessRouter));

    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    // It should upgrade successfully
    vm.prank(_caller);
    poolVault.upgradeToAndCall(address(newImplementation), '');
  }

  /*///////////////////////////////////////////////////////////////
                    SET MAX STATE TREE SIZE
  //////////////////////////////////////////////////////////////*/

  function test_SetMaxStateTreeSize_GivenCallerDoesNotHaveUPGRADER_ROLE(address _caller, uint256 _newSize) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);

    vm.prank(_caller);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    poolVault.setMaxStateTreeSize(_newSize);
  }

  // solhint-disable-next-line style-guide-casing
  modifier givenCallerHasUPGRADER_ROLE() {
    _;
  }

  function test_SetMaxStateTreeSize_WhenNewMaxSizeIsLessThanOrEqualToCurrentTreeSize(
    address _caller,
    uint256 _treeSize,
    uint256 _newSize
  ) external givenCallerHasUPGRADER_ROLE {
    _treeSize = bound(_treeSize, 1, type(uint128).max);
    // covers both the strict `<` case and the `==` boundary
    _newSize = bound(_newSize, 0, _treeSize);
    poolVault.exposed_setStateTreeSize(_treeSize);

    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    vm.expectRevert(IPoolVault.PoolVault_InvalidMaxTreeSize.selector);
    vm.prank(_caller);
    poolVault.setMaxStateTreeSize(_newSize);
  }

  function test_SetMaxStateTreeSize_WhenNewMaxSizeIsGreaterThanCurrentTreeSize(
    address _caller,
    uint256 _treeSize,
    uint256 _newSize
  ) external givenCallerHasUPGRADER_ROLE {
    _treeSize = bound(_treeSize, 0, type(uint128).max);
    _newSize = bound(_newSize, _treeSize + 1, type(uint256).max);
    poolVault.exposed_setStateTreeSize(_treeSize);

    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    vm.expectEmit(address(poolVault));
    emit IPoolVault.MaxStateTreeSizeUpdated(MAX_STATE_TREE_SIZE, _newSize);

    vm.prank(_caller);
    poolVault.setMaxStateTreeSize(_newSize);

    assertEq(poolVault.maxStateTreeSize(), _newSize);
  }

  /*///////////////////////////////////////////////////////////////
                        SET ASP REGISTRY
  //////////////////////////////////////////////////////////////*/

  function test_SetAspRegistry_GivenCallerDoesNotHaveUPGRADER_ROLE(address _caller, address _newAspRegistry) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);

    vm.prank(_caller);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    poolVault.setAspRegistry(IASPRegistry(_newAspRegistry));
  }

  function test_SetAspRegistry_GivenCallerHasUPGRADER_ROLE(address _caller, address _newAspRegistry) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    // It should emit AspRegistrySet event
    vm.expectEmit(address(poolVault));
    emit IPoolVault.AspRegistrySet(mockAspRegistry, _newAspRegistry);

    vm.prank(_caller);
    poolVault.setAspRegistry(IASPRegistry(_newAspRegistry));

    // It should set the ASP registry
    assertEq(address(poolVault.aspRegistry()), _newAspRegistry);
  }

  /*///////////////////////////////////////////////////////////////
                        SET KEYSTORE
  //////////////////////////////////////////////////////////////*/

  function test_SetKeystore_GivenCallerDoesNotHaveUPGRADER_ROLE(address _caller, address _newKeystore) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);

    vm.prank(_caller);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    poolVault.setKeystore(IKeystore(_newKeystore));
  }

  function test_SetKeystore_GivenCallerHasUPGRADER_ROLE(address _caller, address _newKeystore) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    vm.expectEmit(address(poolVault));
    emit IPoolVault.KeystoreSet(mockKeystore, _newKeystore);

    vm.prank(_caller);
    poolVault.setKeystore(IKeystore(_newKeystore));

    assertEq(address(poolVault.keystore()), _newKeystore);
  }

  /*///////////////////////////////////////////////////////////////
                      SET RAGEQUIT VERIFIER
  //////////////////////////////////////////////////////////////*/

  function test_SetRagequitVerifier_GivenCallerDoesNotHaveUPGRADER_ROLE(
    address _caller,
    address _newVerifier
  ) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);

    vm.prank(_caller);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    poolVault.setRagequitVerifier(IRagequitVerifier(_newVerifier));
  }

  function test_SetRagequitVerifier_GivenCallerHasUPGRADER_ROLE(address _caller, address _newVerifier) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    vm.expectEmit(address(poolVault));
    emit IPoolVault.RagequitVerifierSet(address(mockRagequitVerifier), _newVerifier);

    vm.prank(_caller);
    poolVault.setRagequitVerifier(IRagequitVerifier(_newVerifier));

    assertEq(address(poolVault.ragequitVerifier()), _newVerifier);
  }

  /*///////////////////////////////////////////////////////////////
                      SET DEPOSIT VERIFIER
  //////////////////////////////////////////////////////////////*/

  function test_SetDepositVerifier_GivenCallerDoesNotHaveUPGRADER_ROLE(address _caller, address _newVerifier) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, false);

    vm.prank(_caller);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    poolVault.setDepositVerifier(IDepositVerifier(_newVerifier));
  }

  function test_SetDepositVerifier_GivenCallerHasUPGRADER_ROLE(address _caller, address _newVerifier) external {
    _mockExpectHasRole(UPGRADER_ROLE, _caller, true);

    vm.expectEmit(address(poolVault));
    emit IPoolVault.DepositVerifierSet(address(mockDepositVerifier), _newVerifier);

    vm.prank(_caller);
    poolVault.setDepositVerifier(IDepositVerifier(_newVerifier));

    assertEq(address(poolVault.depositVerifier()), _newVerifier);
  }

  /*///////////////////////////////////////////////////////////////
                  NON-CANONICAL tokenId REGRESSION
  //////////////////////////////////////////////////////////////*/

  function test_Deposit_WhenTokenIdIsNonCanonical(DepositProofParams memory _fuzz)
    external
    givenCallerHasTheDEPOSITOR_ROLE(address(this))
  {
    ProofLibV2.DepositProof memory _proof = buildMockDepositProof(_fuzz);
    uint256 _dirty = uint256(uint160(_fuzz.tokenId)) | (uint256(1) << 160);
    _proof.pubSignals[1] = _dirty;
    _setDepositContext(_proof);
    _mockValidProof(_proof);

    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _dirty));
    poolVault.deposit(_proof, defaultNoteData);
  }

  function test_Transact_WhenTokenIdOutIsNonCanonical(TransactProofParams memory _fuzz) external {
    _fuzz.stateRoot = bound(_fuzz.stateRoot, 1, SNARK_SCALAR_FIELD - 1);

    uint256 _numOutputs = _fuzz.outputCommitmentsLength % (MAX_ARRAY_SIZE + 1);
    IPoolVault.NoteData[] memory _noteData = _buildDefaultNoteData(_numOutputs);
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, defaultParams, _noteData);

    uint256 _dirty = uint256(uint160(_fuzz.tokenIdOut)) | (uint256(1) << 160);
    _proof.pubSignals[6][0] = _dirty;

    poolVault.exposed_updateRoot(_fuzz.stateRoot);
    vm.mockCall(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (_fuzz.keyRegistryRoot)), abi.encode(true));
    vm.mockCall(mockAspRegistry, LATEST_ASP_ROOT_SELECTOR, abi.encode(_fuzz.aspRoot));

    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _dirty));
    poolVault.transact(_proof, defaultParams, _noteData);
  }

  function test_Ragequit_WhenTokenIdIsNonCanonical(RagequitProofParams memory _fuzz) external whenAllChecksPass(_fuzz) {
    ProofLibV2.RagequitProof memory _proof = buildMockRagequitProof(_fuzz);

    uint256 _dirty = uint256(uint160(_fuzz.tokenId)) | (uint256(1) << 160);
    _proof.pubSignals[5] = _dirty;

    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _dirty));
    vm.prank(_fuzz.ownerAddress);
    poolVault.ragequit(_proof);
  }
}
