// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {UUPSUpgradeable} from '@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol';
import {PausableUpgradeable} from '@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol';
import {
  ReentrancyGuardTransientUpgradeable
} from '@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';

import {Permissioned} from 'abstracts/Permissioned.sol';
import {RootBufferUpgradeable} from 'abstracts/RootBufferUpgradeable.sol';
import {TransactVerifierRouter} from 'abstracts/TransactVerifierRouter.sol';
import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IDepositVerifier} from 'interfaces/IDepositVerifier.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IRagequitVerifier} from 'interfaces/IRagequitVerifier.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {LeanIMT, LeanIMTData} from 'lean-imt/LeanIMT.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';
import {Constants} from 'utils/Constants.sol';
import {DEPOSITOR_ROLE, PAUSER_ROLE, UNPAUSER_ROLE, UPGRADER_ROLE} from 'utils/RolesConstants.sol';

/// @title PoolVault
/// @notice Core vault contract for Privacy Pools V2 handling private transactions
contract PoolVault is
  UUPSUpgradeable,
  PausableUpgradeable,
  ReentrancyGuardTransientUpgradeable,
  RootBufferUpgradeable,
  TransactVerifierRouter,
  IPoolVault
{
  using LeanIMT for LeanIMTData;
  using ProofLibV2 for ProofLibV2.DepositProof;
  using ProofLibV2 for ProofLibV2.RagequitProof;
  using ProofLibV2 for ProofLibV2.TransactProof;
  using SafeTransferLib for address;
  using ProofLibV2 for IDepositVerifier;

  /*///////////////////////////////////////////////////////////////
                              STORAGE
  ///////////////////////////////////////////////////////////////*/

  /// @notice ERC-7201 storage location for PoolVault
  // keccak256(abi.encode(uint256(keccak256("privacypools.storage.PoolVault")) - 1)) & ~bytes32(uint256(0xff))
  // solhint-disable-next-line private-vars-leading-underscore
  bytes32 private constant POOL_VAULT_STORAGE_LOCATION =
    0x04f94a259c17773cffd4d392dc6f19667d3afc5d3a6a5212bdd6519d43e5e100;

  /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  /// @notice Initializes the PoolVault contract with immutable references
  /// @param _accessRouter The access control contract
  constructor(IAccessControl _accessRouter) Permissioned(_accessRouter) {
    _disableInitializers();
  }

  /*///////////////////////////////////////////////////////////////
                          INITIALIZER
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPoolVault
  function initialize(
    uint32 _rootHistorySize,
    VerifierConfig[] calldata _verifierConfigs,
    IASPRegistry _aspRegistry,
    IKeystore _keystore,
    IRagequitVerifier _ragequitVerifier,
    IDepositVerifier _depositVerifier,
    uint256 _maxStateTreeSize
  ) external initializer {
    __UUPSUpgradeable_init();
    __Pausable_init();
    __ReentrancyGuardTransient_init();
    __RootBufferUpgradeable_init(_rootHistorySize);
    __TransactVerifierRouter_init(_verifierConfigs);

    PoolVaultStorage storage $ = _getPoolVaultStorage();
    $.aspRegistry = _aspRegistry;
    $.keystore = _keystore;
    $.ragequitVerifier = _ragequitVerifier;
    $.depositVerifier = _depositVerifier;
    $.maxStateTreeSize = _maxStateTreeSize;
  }

  /*///////////////////////////////////////////////////////////////
                      EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPoolVault
  function deposit(
    ProofLibV2.DepositProof calldata _proof,
    NoteData calldata _noteData
  ) external payable whenNotPaused checkAccess(DEPOSITOR_ROLE) {
    PoolVaultStorage storage $ = _getPoolVaultStorage();
    require($.depositVerifier.verify(_proof), PoolVault_InvalidDepositProof());

    // Verify context binds proof to note data
    require(
      _proof.context() == uint256(keccak256(abi.encode(_noteData))) % SNARK_SCALAR_FIELD,
      PoolVault_ProofContextMismatch()
    );

    address _asset = _proof.tokenId();
    uint256 _value = _proof.value();
    uint256 _commitment = _proof.outputCommitment();

    if (_asset == Constants.NATIVE_ASSET) {
      require(msg.value == _value, PoolVault_InvalidValue());
    } else {
      require(msg.value == 0, PoolVault_UnexpectedETHAmount());
      _asset.safeTransferFrom(msg.sender, address(this), _value);
    }

    require(!_commitmentExists(_commitment), PoolVault_CommitmentAlreadyUsed());
    $.commitments[_commitment] = block.timestamp;

    uint256 _leafValue = PoseidonT4.hash([Constants.COMMITMENT_LEAF_TAG, _commitment, block.timestamp]);
    require($.stateTree.size + 1 <= $.maxStateTreeSize, PoolVault_StateTreeFull());
    (uint256 _root, uint256 _index) = _insertInStateTree(_leafValue);
    _updateRoot(_root);

    uint256[] memory _leaves = new uint256[](1);
    _leaves[0] = _leafValue;
    emit LeavesInserted(_leaves, _root, _index);
    emit Note(_noteData.hint, _noteData.data);
    emit Deposited({outputCommitment: _commitment, asset: _asset, depositedValue: _value, caller: msg.sender});
  }

  /// @inheritdoc IPoolVault
  function transact(
    ProofLibV2.TransactProof calldata _proof,
    TransactParams calldata _transactParams,
    NoteData[] calldata _noteData
  ) external whenNotPaused nonReentrant {
    // Validate processor
    require(_transactParams.processor == msg.sender, PoolVault_InvalidProcessor());

    // Verify context binds proof to transaction params and note data
    require(
      _proof.context() == uint256(keccak256(abi.encode(_transactParams, _noteData))) % SNARK_SCALAR_FIELD,
      PoolVault_ProofContextMismatch()
    );

    // Validate roots and verify proof
    _validateAndVerify(_proof);

    // Track commitments, nullify spent nullifiers, and build timestamped leaves for state tree
    {
      uint256[] calldata _outputCommitments = _proof.outputCommitments();
      uint256[] calldata _nullifierHashes = _proof.nullifierHashes();
      uint256 _numCommitments = _outputCommitments.length;
      uint256 _numNullifiers = _nullifierHashes.length;
      uint256[] memory _leaves = new uint256[](_numCommitments + _numNullifiers);
      address _asset;
      PoolVaultStorage storage $ = _getPoolVaultStorage();

      for (uint256 i; i < _numCommitments; ++i) {
        require(!_commitmentExists(_outputCommitments[i]), PoolVault_CommitmentAlreadyUsed());
        $.commitments[_outputCommitments[i]] = block.timestamp;
        _leaves[i] = PoseidonT4.hash([Constants.COMMITMENT_LEAF_TAG, _outputCommitments[i], block.timestamp]);
      }

      for (uint256 i; i < _numNullifiers; ++i) {
        uint256 _nullifierHash = _nullifierHashes[i];
        require(!_nullifierSpent(_nullifierHash), PoolVault_NullifierAlreadySpent());
        $.spentNullifiers[_nullifierHash] = block.timestamp;
        _leaves[_numCommitments + i] = PoseidonT4.hash([Constants.NULLIFIER_LEAF_TAG, _nullifierHash, block.timestamp]);
      }

      require($.stateTree.size + _leaves.length <= $.maxStateTreeSize, PoolVault_StateTreeFull());
      (uint256 _root, uint256 _startIndex) = _insertInStateTree(_leaves);
      _updateRoot(_root);
      emit LeavesInserted(_leaves, _root, _startIndex);

      // Transfer amountOut to msg.sender (can be processor contract or direct caller)
      uint256 _withdrawnValue = _proof.amountOut();
      if (_withdrawnValue > 0) {
        _asset = _proof.tokenIdOut();
        _transferAsset(_asset, _withdrawnValue);
      } else {
        require(_proof.tokenIdOut() == address(0), PoolVault_TokenIdMustBeZeroOnInternalTransfer());
      }

      // Emit note discovery events (independent of commitments count)
      for (uint256 i; i < _noteData.length; ++i) {
        emit Note(_noteData[i].hint, _noteData[i].data);
      }
      emit Transacted({
        outputCommitments: _outputCommitments,
        nullifierHashes: _nullifierHashes,
        asset: _asset,
        withdrawnValue: _withdrawnValue,
        caller: msg.sender
      });
    }
  }

  /// @inheritdoc IPoolVault
  function ragequit(ProofLibV2.RagequitProof calldata _proof) external nonReentrant {
    PoolVaultStorage storage $ = _getPoolVaultStorage();
    require(msg.sender == _proof.ownerAddress(), PoolVault_InvalidOwnerAddress());
    require(_proof.value() != 0, PoolVault_ZeroValueRagequit());
    require(_commitmentExists(_proof.commitment()), PoolVault_CommitmentNotFound());

    uint256 _nullifierHash = _proof.nullifierHash();
    require(!_nullifierSpent(_nullifierHash), PoolVault_NullifierAlreadySpent());
    require($.keystore.isKnownRoot(_proof.keystoreRoot()), PoolVault_UnknownKeystoreRoot());
    require(
      $.ragequitVerifier.verifyProof({_pA: _proof.pA, _pB: _proof.pB, _pC: _proof.pC, _pubSignals: _proof.pubSignals}),
      PoolVault_InvalidRagequitProof()
    );

    $.spentNullifiers[_nullifierHash] = block.timestamp;

    // Insert timestamped nullifier into state tree (consistent with transact pattern)
    uint256 _nullifierLeaf = PoseidonT4.hash([Constants.NULLIFIER_LEAF_TAG, _nullifierHash, block.timestamp]);
    require($.stateTree.size + 1 <= $.maxStateTreeSize, PoolVault_StateTreeFull());
    (uint256 _root, uint256 _index) = _insertInStateTree(_nullifierLeaf);
    _updateRoot(_root);

    uint256[] memory _leaves = new uint256[](1);
    _leaves[0] = _nullifierLeaf;
    emit LeavesInserted(_leaves, _root, _index);

    uint256 _value = _proof.value();
    address _asset = _proof.tokenId();
    _transferAsset(_asset, _value);

    emit Ragequit({
      ragequitter: msg.sender,
      asset: _asset,
      value: _value,
      commitment: _proof.commitment(),
      nullifierHash: _nullifierHash,
      label: _proof.label()
    });
  }

  /// @inheritdoc IPoolVault
  function pause() external checkAccess(PAUSER_ROLE) {
    _pause();
  }

  /// @inheritdoc IPoolVault
  function unpause() external checkAccess(UNPAUSER_ROLE) {
    _unpause();
  }

  /// @inheritdoc IPoolVault
  function setAspRegistry(IASPRegistry _aspRegistry) external checkAccess(UPGRADER_ROLE) {
    PoolVaultStorage storage $ = _getPoolVaultStorage();
    address _previous = address($.aspRegistry);
    $.aspRegistry = _aspRegistry;
    emit AspRegistrySet(_previous, address(_aspRegistry));
  }

  /// @inheritdoc IPoolVault
  function setKeystore(IKeystore _keystore) external checkAccess(UPGRADER_ROLE) {
    PoolVaultStorage storage $ = _getPoolVaultStorage();
    address _previous = address($.keystore);
    $.keystore = _keystore;
    emit KeystoreSet(_previous, address(_keystore));
  }

  /// @inheritdoc IPoolVault
  function setRagequitVerifier(IRagequitVerifier _ragequitVerifier) external checkAccess(UPGRADER_ROLE) {
    PoolVaultStorage storage $ = _getPoolVaultStorage();
    address _previous = address($.ragequitVerifier);
    $.ragequitVerifier = _ragequitVerifier;
    emit RagequitVerifierSet(_previous, address(_ragequitVerifier));
  }

  /// @inheritdoc IPoolVault
  function setDepositVerifier(IDepositVerifier _depositVerifier) external checkAccess(UPGRADER_ROLE) {
    PoolVaultStorage storage $ = _getPoolVaultStorage();
    address _previous = address($.depositVerifier);
    $.depositVerifier = _depositVerifier;
    emit DepositVerifierSet(_previous, address(_depositVerifier));
  }

  /// @inheritdoc IPoolVault
  function setMaxStateTreeSize(uint256 _maxStateTreeSize) external checkAccess(UPGRADER_ROLE) {
    PoolVaultStorage storage $ = _getPoolVaultStorage();
    require(_maxStateTreeSize > $.stateTree.size, PoolVault_InvalidMaxTreeSize());
    uint256 _previous = $.maxStateTreeSize;
    $.maxStateTreeSize = _maxStateTreeSize;
    emit MaxStateTreeSizeUpdated(_previous, _maxStateTreeSize);
  }

  /*///////////////////////////////////////////////////////////////
                      EXTERNAL VIEW FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPoolVault
  function aspRegistry() external view returns (IASPRegistry _aspRegistry) {
    _aspRegistry = _getPoolVaultStorage().aspRegistry;
  }

  /// @inheritdoc IPoolVault
  function keystore() external view returns (IKeystore _keystore) {
    _keystore = _getPoolVaultStorage().keystore;
  }

  /// @inheritdoc IPoolVault
  function ragequitVerifier() external view returns (IRagequitVerifier _verifier) {
    _verifier = _getPoolVaultStorage().ragequitVerifier;
  }

  /// @inheritdoc IPoolVault
  function depositVerifier() external view returns (IDepositVerifier _verifier) {
    _verifier = _getPoolVaultStorage().depositVerifier;
  }

  /// @inheritdoc IPoolVault
  function maxStateTreeSize() external view returns (uint256 _maxSize) {
    _maxSize = _getPoolVaultStorage().maxStateTreeSize;
  }

  /// @inheritdoc IPoolVault
  function spentNullifiers(uint256 _nullifierHash) external view returns (uint256 _spentAt) {
    _spentAt = _getPoolVaultStorage().spentNullifiers[_nullifierHash];
  }

  /// @inheritdoc IPoolVault
  function commitments(uint256 _commitmentHash) external view returns (uint256 _createdAt) {
    _createdAt = _getPoolVaultStorage().commitments[_commitmentHash];
  }

  /*///////////////////////////////////////////////////////////////
                       PUBLIC FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPoolVault
  function paused() public view override(IPoolVault, PausableUpgradeable) returns (bool) {
    return super.paused();
  }

  /*///////////////////////////////////////////////////////////////
                       INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Validates roots and verifies the transact proof
  /// @dev Extracted to reduce stack depth
  /// @param _proof The transact proof to validate and verify
  function _validateAndVerify(ProofLibV2.TransactProof calldata _proof) internal {
    PoolVaultStorage storage $ = _getPoolVaultStorage();
    require(isKnownRoot(_proof.stateRoot()), PoolVault_UnknownStateRoot());
    require($.keystore.isKnownRoot(_proof.keyRegistryRoot()), PoolVault_UnknownKeystoreRoot());
    require(_proof.associationSetRoot() == $.aspRegistry.latestASPRoot(), PoolVault_InvalidASPRoot());

    require(
      _verifyProof({
        _proof: _proof.toGroth16Proof(),
        _stateRoot: _proof.stateRoot(),
        _keystoreRoot: _proof.keyRegistryRoot(),
        _aspRoot: _proof.associationSetRoot(),
        _amountOut: _proof.amountOut(),
        _tokenId: uint256(uint160(_proof.tokenIdOut())),
        _context: _proof.context(),
        _nullifiersSpent: _proof.nullifierHashes(),
        _commitmentsCreated: _proof.outputCommitments()
      }),
      PoolVault_InvalidTransactProof()
    );
  }

  /// @notice Inserts a single leaf into the state tree
  /// @param _newLeaf The leaf value to insert
  /// @return _newRoot The new root after insertion
  /// @return _index The index of the inserted leaf
  function _insertInStateTree(uint256 _newLeaf) internal virtual returns (uint256 _newRoot, uint256 _index) {
    LeanIMTData storage _tree = _getPoolVaultStorage().stateTree;
    _index = _tree.size;
    _newRoot = _tree.insert(_newLeaf);
  }

  /// @notice Inserts multiple leaves into the state tree
  /// @param _newLeaves The leaf values to insert
  /// @return _newRoot The new root after all insertions
  /// @return _startIndex The index of the first inserted leaf
  function _insertInStateTree(uint256[] memory _newLeaves)
    internal
    virtual
    returns (uint256 _newRoot, uint256 _startIndex)
  {
    LeanIMTData storage _tree = _getPoolVaultStorage().stateTree;
    _startIndex = _tree.size;
    _newRoot = _tree.insertMany(_newLeaves);
  }

  /// @notice Transfers assets (native ETH or ERC20) to the caller
  /// @param _asset The asset address (Constants.NATIVE_ASSET for ETH)
  /// @param _value The amount to transfer
  function _transferAsset(address _asset, uint256 _value) internal {
    if (_asset == Constants.NATIVE_ASSET) {
      msg.sender.safeTransferETH(_value);
    } else {
      _asset.safeTransfer(msg.sender, _value);
    }
  }

  /// @inheritdoc UUPSUpgradeable
  function _authorizeUpgrade(address) internal override checkAccess(UPGRADER_ROLE) {}

  /// @notice Checks if a commitment has been recorded
  /// @dev Uses the mapping instead of the state tree because the tree stores
  ///      timestamped hashes — hash(commitment, timestamp) — not raw commitments.
  /// @param _commitment The commitment to check
  /// @return True if the commitment exists
  function _commitmentExists(uint256 _commitment) internal view virtual returns (bool) {
    return _getPoolVaultStorage().commitments[_commitment] != 0;
  }

  /// @notice Checks if a nullifier has been spent
  /// @param _nullifierHash The nullifier hash to check
  /// @return True if the nullifier has been spent
  function _nullifierSpent(uint256 _nullifierHash) internal view virtual returns (bool) {
    return _getPoolVaultStorage().spentNullifiers[_nullifierHash] != 0;
  }

  /// @notice Returns a pointer to the ERC-7201 namespaced storage for PoolVault
  /// @return $ Storage pointer to PoolVaultStorage
  function _getPoolVaultStorage() internal pure returns (PoolVaultStorage storage $) {
    assembly {
      $.slot := POOL_VAULT_STORAGE_LOCATION
    }
  }
}
