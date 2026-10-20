// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IDepositVerifier} from 'interfaces/IDepositVerifier.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {IRagequitVerifier} from 'interfaces/IRagequitVerifier.sol';
import {IRootBuffer} from 'interfaces/IRootBuffer.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {ITreeUpdates} from 'interfaces/ITreeUpdates.sol';
import {LeanIMTData} from 'lean-imt/LeanIMT.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';

/// @title IPoolVault
/// @notice Interface for the PoolVault contract that manages private transactions
interface IPoolVault is IRootBuffer, ITreeUpdates, ITransactVerifierRouter, IPermissioned {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Parameters for a transact operation
  /// @param processor Address allowed to process this transaction
  /// @param data Arbitrary data for the processor
  struct TransactParams {
    address processor;
    bytes data;
  }

  /// @notice Discovery data for an output note
  /// @param hint Indexed tag for RPC-level log filtering (opaque to the contract)
  /// @param data Encrypted note payload (opaque to the contract)
  struct NoteData {
    bytes32 hint;
    bytes data;
  }

  /// @notice ERC-7201 namespaced storage for PoolVault
  /// @param aspRegistry The ASP registry contract (Entrypoint also reads this slot)
  /// @param keystore The keystore contract
  /// @param ragequitVerifier The ragequit proof verifier contract
  /// @param depositVerifier The deposit proof verifier contract
  /// @param maxStateTreeSize Maximum number of leaves the state Merkle tree can hold (`2^stateMaxDepth`)
  /// @param stateTree LeanIMT storing timestamped commitment and nullifier leaves
  /// @param spentNullifiers Mapping of nullifier hash to the timestamp at which it was spent
  /// @param commitments Mapping of commitment hash to the timestamp at which it was created
  /// @custom:storage-location erc7201:privacypools.storage.PoolVault
  struct PoolVaultStorage {
    IASPRegistry aspRegistry;
    IKeystore keystore;
    IRagequitVerifier ragequitVerifier;
    IDepositVerifier depositVerifier;
    uint256 maxStateTreeSize;
    LeanIMTData stateTree;
    mapping(uint256 nullifierHash => uint256 spentAt) spentNullifiers;
    mapping(uint256 commitmentHash => uint256 createdAt) commitments;
  }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted once per output note (shared across deposit and transact flows)
  /// @param hint Indexed tag for RPC-level log filtering (opaque to the contract)
  /// @param data Encrypted note payload (opaque to the contract)
  event Note(bytes32 indexed hint, bytes data);

  /// @notice Emitted once per transact call with protocol-level metadata
  /// @param outputCommitments New commitments appended to the state
  /// @param nullifierHashes Nullifiers that were spent
  /// @param asset Address of the withdrawn asset (if any); `address(0)` on internal transacts
  /// @param withdrawnValue Amount withdrawn (0 if none)
  /// @param caller Address that executed the transaction
  event Transacted(
    uint256[] outputCommitments,
    uint256[] nullifierHashes,
    address indexed asset,
    uint256 withdrawnValue,
    address indexed caller
  );

  /// @notice Emitted when a ragequit operation is executed
  /// @param ragequitter Address that executed the ragequit (the commitment owner)
  /// @param asset Address of the withdrawn asset
  /// @param value Amount withdrawn
  /// @param commitment The commitment hash that was spent
  /// @param nullifierHash The nullifier to prevent double-spending
  /// @param label The label hash exposed for ASP tracking
  event Ragequit(
    address indexed ragequitter,
    address indexed asset,
    uint256 value,
    uint256 commitment,
    uint256 nullifierHash,
    uint256 label
  );

  /// @notice Emitted when a deposit operation is executed
  /// @param outputCommitment The commitment appended to the state
  /// @param asset Address of the deposited asset
  /// @param depositedValue Amount deposited
  /// @param caller Address that executed the transaction
  event Deposited(uint256 outputCommitment, address indexed asset, uint256 depositedValue, address indexed caller);

  /// @notice Emitted when the ASP registry reference is updated
  /// @param _previous The previous ASP registry address
  /// @param _current The new ASP registry address
  event AspRegistrySet(address indexed _previous, address indexed _current);

  /// @notice Emitted when the keystore reference is updated
  /// @param _previous The previous keystore address
  /// @param _current The new keystore address
  event KeystoreSet(address indexed _previous, address indexed _current);

  /// @notice Emitted when the ragequit verifier reference is updated
  /// @param _previous The previous ragequit verifier address
  /// @param _current The new ragequit verifier address
  event RagequitVerifierSet(address indexed _previous, address indexed _current);

  /// @notice Emitted when the deposit verifier reference is updated
  /// @param _previous The previous deposit verifier address
  /// @param _current The new deposit verifier address
  event DepositVerifierSet(address indexed _previous, address indexed _current);

  /// @notice Emitted when the max state tree size is updated
  /// @param _previousSize The old maximum size
  /// @param _newSize The new maximum size
  event MaxStateTreeSizeUpdated(uint256 _previousSize, uint256 _newSize);

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when caller is not the designated processor
  error PoolVault_InvalidProcessor();

  /// @notice Thrown when the proof context does not match computed context
  error PoolVault_ProofContextMismatch();

  /// @notice Thrown when the state root is not in the root buffer
  error PoolVault_UnknownStateRoot();

  /// @notice Thrown when the ASP root does not match the latest
  error PoolVault_InvalidASPRoot();

  /// @notice Thrown when the keystore root is not in the root buffer
  error PoolVault_UnknownKeystoreRoot();

  /// @notice Thrown when the proof verification fails
  error PoolVault_InvalidTransactProof();

  /// @notice Thrown when the proof verification fails
  error PoolVault_InvalidDepositProof();

  /// @notice Thrown when the transferred asset amount does not match the proof amount
  error PoolVault_InvalidValue();

  /// @notice Thrown when `msg.value` is non-zero on an ERC20 deposit path (defense-in-depth mirror of `IEntrypoint.Entrypoint_UnexpectedETHAmount`)
  error PoolVault_UnexpectedETHAmount();

  /// @notice Thrown when a nullifier has already been spent
  error PoolVault_NullifierAlreadySpent();

  /// @notice Thrown when a commitment has already been used, preventing a given commitment to be inserted twice with different timestamps in stateTree
  error PoolVault_CommitmentAlreadyUsed();

  /// @notice Thrown when the ragequit caller does not match the owner address in the proof
  error PoolVault_InvalidOwnerAddress();

  /// @notice Thrown when a ragequit is attempted on a zero-value note
  error PoolVault_ZeroValueRagequit();

  /// @notice Thrown when the ragequit proof verification fails
  error PoolVault_InvalidRagequitProof();

  /// @notice Thrown when the commitment does not exist in the state tree
  error PoolVault_CommitmentNotFound();

  /// @notice Thrown when a state tree insertion would exceed `maxStateTreeSize` capacity
  error PoolVault_StateTreeFull();

  /// @notice Thrown when `setMaxStateTreeSize` is called with a value `<=` the current state tree size
  error PoolVault_InvalidMaxTreeSize();

  /// @notice Thrown when a transact call has `tokenIdOut` different than zero but
  /// `amountOut` is zero. The value is not relevant in that case, and is a vector
  /// through which users could inadvertently fingerprint their transactions
  error PoolVault_TokenIdMustBeZeroOnInternalTransfer();

  /*///////////////////////////////////////////////////////////////
                      EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Initializes the PoolVault contract
  /// @param _rootHistorySize The size for the parent RootBufferUpgradeable
  /// @param _verifierConfigs Array of verifier configurations to register at initialization
  /// @param _aspRegistry The ASP registry contract (authoritative; Entrypoint reads from here)
  /// @param _keystore The keystore contract
  /// @param _ragequitVerifier The ragequit proof verifier contract
  /// @param _depositVerifier The deposit proof verifier contract
  /// @param _maxStateTreeSize The maximum state tree size cap (`2^stateMaxDepth`)
  function initialize(
    uint32 _rootHistorySize,
    VerifierConfig[] calldata _verifierConfigs,
    IASPRegistry _aspRegistry,
    IKeystore _keystore,
    IRagequitVerifier _ragequitVerifier,
    IDepositVerifier _depositVerifier,
    uint256 _maxStateTreeSize
  ) external;

  /// @notice Deposits funds into the pool
  /// @dev Only callable by addresses with DEPOSITOR_ROLE. The Entrypoint contract
  ///      has this role - normal users should use Entrypoint.deposit() instead. For operational risks when the output
  ///      note's owner is not the depositor (e.g. cold start), see `IEntrypoint.deposit`.
  /// @param _proof The Groth16 deposit proof with public signals
  /// @param _noteData Discovery data for the output note, bound to the proof context
  function deposit(ProofLibV2.DepositProof calldata _proof, NoteData calldata _noteData) external payable;

  /// @notice Executes a private transaction (transfer, merge, split, or withdraw)
  /// @dev If `amountOut > 0`, the withdrawn value is always transferred to `msg.sender`.
  ///      `msg.sender` must equal `_transactParams.processor`; in relayer scenarios, as the processor receives the full
  ///      `amountOut`, the relayer is expected to redistribute the value accordingly (e.g. net amount to recipient, fee to relayer)
  /// @dev `_noteData` is intentionally opaque: no length or structure is enforced on-chain.
  ///       Integrity is guaranteed by the `keccak256(abi.encode(_transactParams, _noteData))` proof context binding.
  /// @param _proof The Groth16 proof with public signals
  /// @param _transactParams Transaction parameters (processor and data)
  /// @param _noteData Per-output discovery data (hint + encrypted payload), bound to the proof context
  function transact(
    ProofLibV2.TransactProof calldata _proof,
    TransactParams calldata _transactParams,
    NoteData[] calldata _noteData
  ) external;

  /// @notice Unconditional exit from the protocol, bypassing ASP approval
  /// @dev This function is NOT pausable - users can always exit via ragequit
  /// @dev Publicly exposes the label for ASP to link ragequit to original deposit
  /// @dev This function validates the ragequitted amount is not zero. This is
  ///      meant as a defense-in-depth check to ensure the Ragequit events are only
  ///      emitted from actual notes, since the transact circuits already enforce notes
  ///      can't be created for labels that are not being spent
  /// @param _proof The Groth16 ragequit proof with public signals
  function ragequit(ProofLibV2.RagequitProof calldata _proof) external;

  /// @notice Pauses the contract
  function pause() external;

  /// @notice Unpauses the contract
  function unpause() external;

  /// @notice Updates the ASP registry reference
  /// @dev Only callable by addresses with UPGRADER_ROLE. This is the authoritative slot; Entrypoint
  ///      reads from `aspRegistry()` on each deposit, so a single update here propagates everywhere.
  /// @param _aspRegistry The new ASP registry contract
  function setAspRegistry(IASPRegistry _aspRegistry) external;

  /// @notice Updates the keystore reference
  /// @dev Only callable by addresses with UPGRADER_ROLE
  /// @param _keystore The new keystore contract
  function setKeystore(IKeystore _keystore) external;

  /// @notice Updates the ragequit verifier reference
  /// @dev Only callable by addresses with UPGRADER_ROLE
  /// @param _ragequitVerifier The new ragequit verifier contract
  function setRagequitVerifier(IRagequitVerifier _ragequitVerifier) external;

  /// @notice Updates the deposit verifier reference
  /// @dev Only callable by addresses with UPGRADER_ROLE
  /// @param _depositVerifier The new deposit verifier contract
  function setDepositVerifier(IDepositVerifier _depositVerifier) external;

  /// @notice Updates the maximum state tree size cap
  /// @dev Only callable by addresses with UPGRADER_ROLE. Must stay in lockstep with the circuit
  ///      parameter `stateMaxDepth` (i.e. `2^stateMaxDepth`); raising the cap above the circuit capacity
  ///      leaves proofs beyond the circuit limit unverifiable. Reverts with
  ///      `PoolVault_InvalidMaxTreeSize` if the new cap is `<=` the current state tree size
  /// @param _maxStateTreeSize The new maximum size (typically a power of two)
  function setMaxStateTreeSize(uint256 _maxStateTreeSize) external;

  /*///////////////////////////////////////////////////////////////
                      EXTERNAL VIEW FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Maximum number of leaves the state Merkle tree can hold
  /// @dev Must stay in lockstep with the circuit parameter (`2^stateMaxDepth`).
  /// @return _maxSize The configured cap
  function maxStateTreeSize() external view returns (uint256 _maxSize);

  /// @notice Returns the ASP registry contract
  /// @return _aspRegistry The ASP registry address
  function aspRegistry() external view returns (IASPRegistry _aspRegistry);

  /// @notice Returns the keystore contract
  /// @return _keystore The keystore address
  function keystore() external view returns (IKeystore _keystore);

  /// @notice Returns the ragequit verifier contract
  /// @return _verifier The ragequit verifier address
  function ragequitVerifier() external view returns (IRagequitVerifier _verifier);

  /// @notice Returns the deposit verifier contract
  /// @return _verifier The deposit verifier address
  function depositVerifier() external view returns (IDepositVerifier _verifier);

  /// @notice Only ragequits are available when the contract is paused
  /// @return _paused Whether the contract is paused
  function paused() external view returns (bool _paused);

  /// @notice Returns the timestamp at which a nullifier was spent, or zero if unspent
  /// @dev Storing the spend-time allows users to collect yields on commitments after spending.
  ///      The raw nullifier hash is the mapping key. The leaf inserted into the state tree
  ///      is `PoseidonT4.hash(NULLIFIER_LEAF_TAG, nullifierHash, timestamp)`, not the raw hash.
  /// @param _nullifierHash The nullifier hash to check
  /// @return _spentAt Timestamp when the nullifier was spent (0 if not spent)
  function spentNullifiers(uint256 _nullifierHash) external view returns (uint256 _spentAt);

  /// @notice Returns the timestamp at which a commitment was created, or zero if unused
  /// @dev The raw commitment hash is the mapping key. The leaf inserted into the state tree
  ///      is `PoseidonT4.hash(COMMITMENT_LEAF_TAG, commitmentHash, timestamp)`, not the raw hash.
  /// @param _commitmentHash The commitment hash to check
  /// @return _createdAt Timestamp when the commitment was created (0 if not used)
  function commitments(uint256 _commitmentHash) external view returns (uint256 _createdAt);
}
