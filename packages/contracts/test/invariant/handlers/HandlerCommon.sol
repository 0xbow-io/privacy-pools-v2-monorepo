// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Constants} from '../Constants.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {Note} from 'test/handlers/HandlerBase.sol';
import {HandlerDeposit} from 'test/handlers/HandlerDeposit.sol';
import {HandlerRagequit} from 'test/handlers/HandlerRagequit.sol';
import {HandlerTransact} from 'test/handlers/HandlerTransact.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

contract HandlerCommon is HandlerDeposit, HandlerTransact, HandlerRagequit, Constants {
  using MerkleTree for MerkleTree.Tree;

  struct LabelBalance {
    bool tracked;
    uint256 deposited;
    uint256 withdrawn;
    uint256 ragequit;
    uint256 unspent;
  }

  /// @dev Tracked asset addresses (NATIVE_ASSET, ERC-20, ...)
  address[] internal _assets;

  /*///////////////////////////////////////////////////////////////
                          GHOST VARIABLES
  ///////////////////////////////////////////////////////////////*/

  // Tree-wide counts (asset-agnostic; the state tree is shared across all assets).
  uint256 public ghost_depositCount;
  uint256 public ghost_ragequitCount;
  uint256 public ghost_transactLeafInserts;

  // Per-asset value accumulators. Keyed by the asset address (NATIVE_ASSET sentinel for ETH).
  mapping(address _asset => uint256 _sum) public ghost_depositSum;
  mapping(address _asset => uint256 _sum) public ghost_feeSum;
  mapping(address _asset => uint256 _sum) public ghost_feeSwept;
  mapping(address _asset => uint256 _sum) public ghost_ragequitSum;
  mapping(address _asset => uint256 _sum) public ghost_withdrawnSum;
  mapping(address _asset => uint256 _sum) public ghost_unspentCommitmentValueSum;

  // Per-asset, per-actor accumulators.
  mapping(address _asset => mapping(address _actor => uint256 _sum)) public ghost_withdrawnTo;
  mapping(address _asset => mapping(address _actor => uint256 _sum)) public ghost_ragequitTo;
  mapping(address _asset => mapping(address _actor => uint256 _sum)) public ghost_sweptTo; // entrypoint fee sweeps
  mapping(address _asset => mapping(address _actor => uint256 _sum)) public ghost_relayedRecipientTo;
  mapping(address _asset => mapping(address _actor => uint256 _sum)) public ghost_relayedFeeTo;
  mapping(address _actor => uint256 _sum) public ghost_relayedNativeGasTo;

  // Per-label accounting. Labels are derived from a precommitment that already includes tokenId,
  // so each label is implicitly bound to a single asset; no per-asset key needed here.
  uint256[] public ghost_labels;
  mapping(uint256 _label => LabelBalance _balance) public ghost_labelBalance;

  /*///////////////////////////////////////////////////////////////
                        SPENT NOTE TRACKING
  ///////////////////////////////////////////////////////////////*/

  /// @notice Marks notes as spent after ragequit
  /// @dev notes stay in _actorNotes, never removed
  mapping(uint256 _commitment => bool _spent) internal _spentNotes;

  /*///////////////////////////////////////////////////////////////
                        ACTOR MANAGEMENT
  ///////////////////////////////////////////////////////////////*/

  UserIdentityLib.UserIdentity[] internal _actors;

  /// @dev A fully-formed identity that is deliberately NOT registered in the keystore.
  ///      Kept out of `_actors` so that the regular handlers never accidentally use it
  UserIdentityLib.UserIdentity internal _unregisteredActor;

  /// @dev Per-actor note storage: deposits push notes, ragequits mark them spent, transact does both
  mapping(address _actorAddress => Note[] _notes) internal _actorNotes;

  /*///////////////////////////////////////////////////////////////
                      ADMIN ADDRESSES
  ///////////////////////////////////////////////////////////////*/

  address internal _pauser;
  address internal _unpauser;
  address internal _entrypointManager;

  /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  constructor(
    IEntrypoint _entrypoint_,
    IPoolVault _poolVault_,
    IPrivacyPoolRelay _relay_,
    IASPRegistry _aspRegistry_,
    IKeystore _keystore_,
    IAccessControl _accessRouter_,
    address _postman_,
    address _pauser_,
    address _unpauser_,
    address _entrypointManager_,
    address[] memory _assets_
  ) {
    _entrypoint = _entrypoint_;
    _poolVault = _poolVault_;
    _privacyPoolRelay = _relay_;
    _aspRegistry = _aspRegistry_;
    _keystore = _keystore_;
    _accessRouter = _accessRouter_;
    _postman = _postman_;
    _pauser = _pauser_;
    _unpauser = _unpauser_;
    _entrypointManager = _entrypointManager_;
    for (uint256 _i; _i < _assets_.length; ++_i) {
      _assets.push(_assets_[_i]);
    }

    // Register actors in keystore (required for ragequit proof generation)
    _actors.push(_registerInKeystore(UserIdentityLib.createIdentity('alice')));
    _actors.push(_registerInKeystore(UserIdentityLib.createIdentity('bob')));
    _actors.push(_registerInKeystore(UserIdentityLib.createIdentity('charlie')));
    _actors.push(_registerInKeystore(UserIdentityLib.createIdentity('dave')));
    _actors.push(_registerInKeystore(UserIdentityLib.createIdentity('eve')));
    _actors.push(_registerInKeystore(UserIdentityLib.createIdentity('frank')));

    // deliberately create an identity but do NOT register it in the keystore.
    _unregisteredActor = UserIdentityLib.createIdentity('unregistered');
  }

  /*///////////////////////////////////////////////////////////////
                        PUBLIC GETTERS
  ///////////////////////////////////////////////////////////////*/
  function actorsLength() external view returns (uint256) {
    return _actors.length;
  }

  function actors(uint256 _index) external view returns (address _actor) {
    return _actors[_index].addr;
  }

  function assetsLength() external view returns (uint256) {
    return _assets.length;
  }

  function assets(uint256 _index) external view returns (address _asset) {
    return _assets[_index];
  }

  /// @dev Address of the identity deliberately left out of the keystore
  function ghost_unregisteredActor() external view returns (address) {
    return _unregisteredActor.addr;
  }

  /// @dev Expose the mirror state tree root for invariant checks
  function ghost_stateTreeRoot() external view returns (uint256) {
    return _stateTreeMirror.root();
  }

  /// @dev Expose the mirror state tree size for invariant checks
  function ghost_stateTreeSize() external view returns (uint256) {
    return _stateTreeMirror.size;
  }

  /// @dev Public arrays have no external `.length`; invariants iterate via this.
  function ghost_labelsLength() external view returns (uint256) {
    return ghost_labels.length;
  }

  function ghost_trackedNullifierCount() external view returns (uint256) {
    return _trackedNullifierHashes.length;
  }

  function ghost_actorNoteCount(address _actor) external view returns (uint256) {
    return _actorNotes[_actor].length;
  }

  function ghost_actorNote(
    address _actor,
    uint256 _i
  ) external view returns (uint256 outputCommitment, uint256 stateLeafIndex) {
    Note storage _note = _actorNotes[_actor][_i];
    return (_note.outputCommitment, _note.stateLeafIndex);
  }

  function ghost_stateTreeLeafAt(uint256 _leafIndex) external view returns (uint256) {
    return _stateTreeMirror.leafAt(_leafIndex);
  }

  function ghost_trackedNullifier(uint256 _i) external view returns (uint256 nullifierHash, uint256 leafIndex) {
    return (_trackedNullifierHashes[_i], _trackedNullifierLeafIndices[_i]);
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Route actor index to storage identity
  function _getActor(uint256 _seed) internal view returns (UserIdentityLib.UserIdentity storage) {
    return _actors[_seed % _actors.length];
  }

  /// @dev Pick a registered asset by seed; uniform over the configured asset set.
  function _pickAsset(uint256 _seed) internal view returns (address) {
    return _assets[_seed % _assets.length];
  }

  function _assetOf(Note memory _note) internal pure returns (address) {
    return address(uint160(_note.tokenId));
  }

  function _addNote(uint256 _actorSeed, Note memory _note) internal {
    _addNoteForAddress(_getActor(_actorSeed).addr, _note);
  }

  /// @dev Address-keyed variant of `_addNote`. Used also by unregistered-actor handler, which
  ///      cannot resolve it through the `_actors` modulo
  function _addNoteForAddress(address _actor, Note memory _note) internal {
    _actorNotes[_actor].push(_note);
    _trackLabel(_note.inputLabel);
    LabelBalance storage _balance = _labelBalance(_note.inputLabel);
    _balance.unspent += _note.value;
    ghost_unspentCommitmentValueSum[_assetOf(_note)] += _note.value;
  }

  function _getNotes(uint256 _actorSeed) internal view returns (Note[] storage _notes) {
    return _actorNotes[_getActor(_actorSeed).addr];
  }

  function _getNote(uint256 _actorSeed, uint256 _noteSeed) internal view returns (Note memory _note) {
    Note[] storage _notes = _getNotes(_actorSeed);
    uint256 _noteCount = _notes.length;
    vm.assume(_noteCount > 0);
    uint256 _noteIndex = _noteSeed % _noteCount;
    return _notes[_noteIndex];
  }

  function _markSpent(Note memory _note) internal {
    _spentNotes[_note.outputCommitment] = true;
    LabelBalance storage _balance = _labelBalance(_note.inputLabel);
    _balance.unspent -= _note.value;
    ghost_unspentCommitmentValueSum[_assetOf(_note)] -= _note.value;
  }

  function _isSpent(Note memory _note) internal view returns (bool) {
    return _spentNotes[_note.outputCommitment];
  }

  function _labelBalance(uint256 _label) internal view returns (LabelBalance storage _balance) {
    return ghost_labelBalance[_label];
  }

  /// @dev Register a label for PP2-6 iteration the first time it enters accounting.
  function _trackLabel(uint256 _label) internal {
    LabelBalance storage _balance = _labelBalance(_label);
    if (_balance.tracked) return;
    _balance.tracked = true;
    ghost_labels.push(_label);
  }
}
