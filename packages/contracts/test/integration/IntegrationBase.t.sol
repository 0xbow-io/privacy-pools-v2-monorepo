// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ISafe} from '@safe-smart-account/interfaces/ISafe.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {Deploy} from 'script/Deploy.s.sol';
import {ChainAssetRegistry, ChainAssets} from 'script/registries/ChainAssetRegistry.sol';
import {ChainConfigRegistry, SystemConfig} from 'script/registries/ChainConfigRegistry.sol';
import {ChainDeploymentRegistry, Deployment} from 'script/registries/ChainDeploymentRegistry.sol';

import {Note, NoteCreationParams} from 'test/handlers/HandlerBase.sol';
import {HandlerDeposit} from 'test/handlers/HandlerDeposit.sol';
import {HandlerRagequit} from 'test/handlers/HandlerRagequit.sol';
import {HandlerTransact} from 'test/handlers/HandlerTransact.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

contract IntegrationBase is
  HandlerDeposit,
  HandlerTransact,
  HandlerRagequit,
  ChainAssetRegistry,
  ChainConfigRegistry,
  ChainDeploymentRegistry
{
  using UserIdentityLib for UserIdentityLib.UserIdentity;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using MerkleTree for MerkleTree.Tree;

  /*///////////////////////////////////////////////////////////////
                        STATE VARIABLES
  ///////////////////////////////////////////////////////////////*/
  /// @dev Patched config returned by fullDeploy() — all addresses are final (no address(0) placeholders)
  SystemConfig internal _config;
  Deployment internal _deployment;
  ISafe internal _canonGuardSafe;

  /// @dev Default ERC20 under test. Both mainnet and Sepolia deploy configs include USDC.
  IERC20 internal _token;

  UserIdentityLib.UserIdentity internal alice;
  UserIdentityLib.UserIdentity internal bob;
  UserIdentityLib.UserIdentity internal charlie;

  /// @dev Fork selectors
  uint256 internal constant MAINNET_CHAIN_ID = 1;
  uint256 internal constant MAINNET_FORK_BLOCK = 25_089_274;
  uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;
  /// @dev Pinned to a block right after the V9 deploy.
  ///      Update me if Sepolia is redeployed.
  uint256 internal constant SEPOLIA_V9_DEPLOYMENT_BLOCK = 10_932_483;

  /// @dev Token addresses for fork tests
  address internal constant MAINNET_USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
  address internal constant MAINNET_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
  address internal constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
  address internal constant SEPOLIA_USDT = 0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0;

  address internal _usdc;
  address internal _usdt;
  bool internal _usingSepoliaDeployment;

  /// @dev Sample values shared across test contracts
  uint256 internal constant SAMPLE_VALUE = 1 ether;

  /// @dev Default transact parameters (no processor, no discovery data)
  IPoolVault.TransactParams internal _defaultTransactParams;
  /// @dev Default transact parameters (only one element, for the most common Nx1 case)
  IPoolVault.NoteData[] internal _defaultTransactNoteData;

  uint256 internal _defaultTransactContext;
  uint256 internal _sampleOutputNoteAddressHash;

  /*///////////////////////////////////////////////////////////////
                        SETUP
  ///////////////////////////////////////////////////////////////*/

  function setUp() public virtual {
    _usingSepoliaDeployment = vm.envOr('SEPOLIA_DEPLOYMENT_TESTS', false);
    if (_usingSepoliaDeployment) {
      vm.createSelectFork('sepolia', SEPOLIA_V9_DEPLOYMENT_BLOCK);
      require(block.chainid == SEPOLIA_CHAIN_ID, 'Integration tests require a Sepolia fork');
    } else {
      vm.createSelectFork('mainnet', MAINNET_FORK_BLOCK);
      require(block.chainid == MAINNET_CHAIN_ID, 'Integration tests require a mainnet fork');
    }

    if (_usingSepoliaDeployment) {
      _deployment = _deploymentForChain(block.chainid);
      _config = _configForChain(block.chainid);
    } else {
      // Full deploy pipeline — same as run() but without vm.startBroadcast()
      Deploy deployer = new Deploy();
      (_deployment, _config) = deployer.fullDeploy(address(deployer));
    }

    _accessRouter = _deployment.accessRouter;
    _aspRegistry = _deployment.aspRegistry;
    _entrypoint = _deployment.entrypoint;
    _keystore = _deployment.keystore;
    _poolVault = _deployment.poolVault;
    _privacyPoolRelay = _deployment.relay;
    _postman = _config.postman;
    _canonGuardSafe = _deployment.canonGuardSafe;

    _setForkTokenAddresses();
    // Mostly redundant after a local fullDeploy(), but valuable for Sepolia:
    // it proves the pinned deployed fork points at fresh, untouched contracts before tests mutate state.
    _assertFreshDeploymentState();

    // Default ERC20 under test. Both mainnet and Sepolia deploy configs include USDC.
    _token = IERC20(_usdc);

    // Build user identities (raw keys + Poseidon-derived values)
    alice = UserIdentityLib.createIdentity('alice');
    bob = UserIdentityLib.createIdentity('bob');
    charlie = UserIdentityLib.createIdentity('charlie');

    // Ensure test addresses are EOAs (they may collide with contracts on mainnet)
    vm.etch(alice.addr, '');
    vm.etch(bob.addr, '');
    vm.etch(charlie.addr, '');

    // Default transact parameters shared across test contracts
    _defaultTransactParams = IPoolVault.TransactParams({processor: address(this), data: ''});
    _defaultTransactNoteData.push(IPoolVault.NoteData({hint: bytes32(0), data: bytes('')}));
    _defaultTransactContext = _hashTransactContext(_defaultTransactParams, _defaultTransactNoteData);
    _sampleOutputNoteAddressHash =
      PoseidonT3.hash([uint256(keccak256('recipient_address')), uint256(keccak256('recipient_secret'))]);
  }

  function _setForkTokenAddresses() internal {
    if (block.chainid == SEPOLIA_CHAIN_ID) {
      _usdc = SEPOLIA_USDC;
      _usdt = SEPOLIA_USDT;
    } else {
      _usdc = MAINNET_USDC;
      _usdt = MAINNET_USDT;
    }
  }

  function _assertFreshDeploymentState() internal view {
    require(address(_accessRouter).code.length != 0, 'IntegrationBase: AccessRouter has no code');
    require(address(_aspRegistry).code.length != 0, 'IntegrationBase: ASPRegistry has no code');
    require(address(_entrypoint).code.length != 0, 'IntegrationBase: Entrypoint has no code');
    require(address(_keystore).code.length != 0, 'IntegrationBase: Keystore has no code');
    require(address(_poolVault).code.length != 0, 'IntegrationBase: PoolVault has no code');
    require(address(_privacyPoolRelay).code.length != 0, 'IntegrationBase: Relay has no code');
    require(_keystore.currentRoot() == 0, 'IntegrationBase: deployed Keystore is not fresh');
    require(_poolVault.roots(_poolVault.currentRootIndex()) == 0, 'IntegrationBase: deployed PoolVault is not fresh');
  }

  /*///////////////////////////////////////////////////////////////
                        FEE / ASSET HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Resolve the deploy-time chain asset registry config for the given asset.
  function _chainAssetConfig(address _tokenAddr) internal view returns (IEntrypoint.AssetConfig memory) {
    ChainAssets memory _chainAssets = _assetsForChain(block.chainid);
    for (uint256 _i; _i < _chainAssets.assets.length; ++_i) {
      if (_chainAssets.assets[_i].token == _tokenAddr) {
        return _chainAssets.assets[_i].config;
      }
    }
    revert('IntegrationBase: asset not configured for chain');
  }

  /// @dev Override the handler-level fee calculation to use the per-chain configured BPS for fork tests.
  function _calcFee(address _tokenAddr, uint256 _value) internal view override returns (uint256) {
    return (_value * _chainAssetConfig(_tokenAddr).vettingFeeBPS) / 10_000;
  }

  /*///////////////////////////////////////////////////////////////
                        TRANSACT OVERLOADS
  ///////////////////////////////////////////////////////////////*/

  /// @dev 1x1 overload taking a single NoteCreationParams
  function _transact(
    Note memory _note,
    UserIdentityLib.UserIdentity storage _spender,
    NoteCreationParams memory _noteCreationParams,
    uint256 _amountOut
  ) internal returns (Note memory _newNote, uint256 _spentNullifier) {
    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;
    NoteCreationParams[] memory _params = new NoteCreationParams[](1);
    _params[0] = _noteCreationParams;
    (Note[] memory _newNotes, uint256[] memory _spentNullifiers) = _transact(_notes, _spender, _params, _amountOut);
    return (_newNotes[0], _spentNullifiers[0]);
  }

  /// @dev 1x1 overload: wraps single note, builds NoteCreationParams from recipient identity, delegates to NxM
  function _transact(
    Note memory _note,
    UserIdentityLib.UserIdentity storage _spender,
    UserIdentityLib.UserIdentity storage _recipient,
    uint256 _outputValue,
    uint256 _outputLabel,
    uint256 _amountOut
  ) internal returns (Note memory _newNote, uint256 _spentNullifier) {
    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;
    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](1);
    _noteCreationParams[0] = _recipient.receiveNote(_outputValue, _outputLabel);
    (Note[] memory _newNotes, uint256[] memory _spentNullifiers) =
      _transact(_notes, _spender, _noteCreationParams, _amountOut);
    return (_newNotes[0], _spentNullifiers[0]);
  }

  /// @dev Nx1 overload: builds NoteCreationParams from recipient identity, delegates to general
  function _transact(
    Note[] memory _notes,
    UserIdentityLib.UserIdentity storage _spender,
    NoteCreationParams memory _params,
    uint256 _amountOut
  ) internal returns (Note memory _newNote, uint256[] memory _spentNullifiers) {
    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](1);
    _noteCreationParams[0] = _params;

    Note[] memory _newNotes;
    (_newNotes, _spentNullifiers) =
      _transact(_notes, _spender, _noteCreationParams, _amountOut, _defaultTransactParams, _defaultTransactNoteData);
    return (_newNotes[0], _spentNullifiers);
  }

  /// @dev General case with default context
  function _transact(
    Note[] memory _notes,
    UserIdentityLib.UserIdentity memory _spender,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _amountOut
  ) internal returns (Note[] memory _newNotes, uint256[] memory _nullifierHashes) {
    // default empty NoteData, but with the correct length
    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](_noteCreationParams.length);

    ProofLibV2.TransactProof memory _proof = _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _noteCreationParams,
      _amountOut: _amountOut,
      _context: _hashTransactContext(_defaultTransactParams, _payload)
    });
    return
      _submitTransact(address(this), _proof, _noteCreationParams, _notes[0].tokenId, _defaultTransactParams, _payload);
  }

  /// @dev 1x1 overload with default transact params
  function _buildTransactProof(
    Note memory _note,
    UserIdentityLib.UserIdentity memory _spender,
    NoteCreationParams memory _noteCreationParams,
    uint256 _amountOut
  ) internal returns (ProofLibV2.TransactProof memory) {
    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;
    NoteCreationParams[] memory _params = new NoteCreationParams[](1);
    _params[0] = _noteCreationParams;
    return _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _params,
      _amountOut: _amountOut,
      _context: _defaultTransactContext
    });
  }

  /// @dev Nx1 overload with default transact params
  function _buildTransactProof(
    Note[] memory _notes,
    UserIdentityLib.UserIdentity memory _spender,
    NoteCreationParams memory _noteCreationParams,
    uint256 _amountOut
  ) internal returns (ProofLibV2.TransactProof memory) {
    NoteCreationParams[] memory _params = new NoteCreationParams[](1);
    _params[0] = _noteCreationParams;
    return _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _params,
      _amountOut: _amountOut,
      _context: _defaultTransactContext
    });
  }

  /// @dev NxM overload with default transact params
  function _buildTransactProof(
    Note[] memory _notes,
    UserIdentityLib.UserIdentity memory _spender,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _amountOut
  ) internal returns (ProofLibV2.TransactProof memory) {
    return _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _noteCreationParams,
      _amountOut: _amountOut,
      _context: _defaultTransactContext
    });
  }

  /// @dev 1x1 overload: same inputs as `_buildTransactProof` (single note, default context)
  function _buildTransactInputs(
    Note memory _note,
    UserIdentityLib.UserIdentity memory _spender,
    NoteCreationParams memory _noteCreationParams,
    uint256 _amountOut
  ) internal view returns (ProofGenerator.TransactInputs memory) {
    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;
    NoteCreationParams[] memory _params = new NoteCreationParams[](1);
    _params[0] = _noteCreationParams;
    return _buildTransactInputs(_notes, _spender, _defaultTransactContext, _params, _amountOut);
  }

  /// @dev 1x1 overload with explicit processor — returns both proof and matching params
  function _buildTransactProof(
    Note memory _note,
    UserIdentityLib.UserIdentity memory _spender,
    NoteCreationParams memory _noteCreationParams,
    uint256 _amountOut,
    address _processor
  ) internal returns (ProofLibV2.TransactProof memory proof_, IPoolVault.TransactParams memory params_) {
    params_ = IPoolVault.TransactParams({processor: _processor, data: ''});
    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;
    NoteCreationParams[] memory _noteParams = new NoteCreationParams[](1);
    _noteParams[0] = _noteCreationParams;
    proof_ = _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _noteParams,
      _amountOut: _amountOut,
      _context: _hashTransactContext(params_, _defaultTransactNoteData)
    });
  }

  /*///////////////////////////////////////////////////////////////
                      DEPOSIT OVERLOADS
  ///////////////////////////////////////////////////////////////*/

  function _deposit(
    UserIdentityLib.UserIdentity storage _user,
    address _tokenAddr,
    uint256 _value
  ) internal returns (Note memory) {
    return _deposit(_user, _user, _tokenAddr, _value);
  }

  /*///////////////////////////////////////////////////////////////
                      TRANSACT ASSERTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Assert the proof's input nullifier and output commitment were recorded at `_expectedTimestamp`
  function _assertProofWasSpent(ProofLibV2.TransactProof memory _proof, uint256 _expectedTimestamp) internal view {
    assertEq(
      _poolVault.spentNullifiers(_proof.nullifierHashes()[0]), _expectedTimestamp, 'Nullifier spend timestamp mismatch'
    );
    assertEq(
      _poolVault.commitments(_proof.outputCommitments()[0]), _expectedTimestamp, 'Output commitment timestamp mismatch'
    );
  }

  /// @dev Mirror the proof's leaves and assert the on-chain state root matches the mirror tree
  function _assertStateRootSync(ProofLibV2.TransactProof memory _proof) internal {
    _mirrorTransactLeaves(_proof.outputCommitments(), _proof.nullifierHashes());
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()),
      _stateTreeMirror.root(),
      'State root mismatch after relay transact'
    );
  }

  /*///////////////////////////////////////////////////////////////
                      FFI PROOF HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Assert that transact proof generation reverts (FFI / circuit failure)
  function _assertTransactProofReverts(ProofGenerator.TransactInputs memory _scenario, string memory _reason) internal {
    // solhint-disable-next-line avoid-low-level-calls
    (bool _success, bytes memory _returnData) =
      address(this).call(abi.encodeCall(IntegrationBase.generateTransactProofExternal, (_scenario)));
    assertFalse(_success, _reason);
    assertGt(_returnData.length, 4, 'Revert should contain selector plus error data');
    assertEq(
      bytes4(_returnData), bytes4(keccak256('CheatcodeError(string)')), 'Should be an FFI (CheatcodeError) revert'
    );
  }

  /// @dev Assert that ragequit proof generation reverts (FFI / circuit failure)
  function _assertRagequitProofReverts(ProofGenerator.RagequitInputs memory _inputs, string memory _reason) internal {
    // solhint-disable-next-line avoid-low-level-calls
    (bool _success, bytes memory _returnData) =
      address(this).call(abi.encodeCall(IntegrationBase.generateRagequitProofExternal, (_inputs)));
    assertFalse(_success, _reason);
    assertGt(_returnData.length, 4, 'Revert should contain selector plus error data');
    assertEq(
      bytes4(_returnData), bytes4(keccak256('CheatcodeError(string)')), 'Should be an FFI (CheatcodeError) revert'
    );
  }

  /// @dev External wrapper so FFI failures can be caught via low-level call
  function generateTransactProofExternal(
    ProofGenerator.TransactInputs memory _scenario
  ) external returns (ProofLibV2.TransactProof memory) {
    return ProofGenerator.generateTransactProof(_scenario);
  }

  /// @dev External wrapper so FFI failures can be caught via low-level call
  function generateRagequitProofExternal(
    ProofGenerator.RagequitInputs memory _inputs
  ) external returns (ProofLibV2.RagequitProof memory) {
    return ProofGenerator.generateRagequitProof(_inputs);
  }
}
