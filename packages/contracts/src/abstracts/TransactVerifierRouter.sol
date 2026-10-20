// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';

import {Permissioned} from 'abstracts/Permissioned.sol';
import {IGroth16Verifier} from 'interfaces/IGroth16Verifier.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {UPGRADER_ROLE} from 'utils/RolesConstants.sol';

abstract contract TransactVerifierRouter is ITransactVerifierRouter, Permissioned, Initializable {
  /// @notice Number of fixed public signals in a transact proof
  uint8 private constant _FIXED_PUBSIGNALS = 6;

  /*///////////////////////////////////////////////////////////////
                              STORAGE
  ///////////////////////////////////////////////////////////////*/

  /// @notice ERC-7201 storage location for TransactVerifierRouter
  // keccak256(abi.encode(uint256(keccak256("privacypools.storage.TransactVerifierRouter")) - 1)) & ~bytes32(uint256(0xff))
  // solhint-disable-next-line private-vars-leading-underscore
  bytes32 private constant TRANSACT_VERIFIER_ROUTER_STORAGE_LOCATION =
    0x0c027be59f417c97b0d67624f8bfbaef96df39bc0b10e77a5d17c62359798400;

  /*///////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc ITransactVerifierRouter
  function setVerifier(
    uint8 _nullifiersSpent,
    uint8 _commitmentsCreated,
    Verifier calldata _settings
  ) external checkAccess(UPGRADER_ROLE) {
    _setVerifier(_nullifiersSpent, _commitmentsCreated, _settings);
  }

  /// @inheritdoc ITransactVerifierRouter
  function verifiers(bytes32 _key) external view returns (Verifier memory _verifier) {
    _verifier = _getTransactVerifierRouterStorage().verifiers[_key];
  }

  /*///////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Registers a verifier for a specific NxM circuit configuration
  /// @param _nullifiersSpent Number of nullifiers spent in transaction (N)
  /// @param _commitmentsCreated Number of new commitments created by circuit (M)
  /// @param _settings Address and selector of the Groth16 verifier contract
  function _setVerifier(uint8 _nullifiersSpent, uint8 _commitmentsCreated, Verifier calldata _settings) internal {
    require(_nullifiersSpent != 0 && _commitmentsCreated != 0, TransactVerifierRouter_InvalidZeroParameter());
    bytes32 _key = _computeKey(_nullifiersSpent, _commitmentsCreated);
    _getTransactVerifierRouterStorage().verifiers[_key] = _settings;
    emit VerifierConfigured({
      _nullifiersSpent: _nullifiersSpent,
      _commitmentsCreated: _commitmentsCreated,
      _verifier: _settings.addr,
      _selector: _settings.selector
    });
  }

  /// @notice Verifies a transact proof by delegating to the appropriate NxM Groth16 verifier
  /// @param _proof Groth16 proof components (pA, pB, pC)
  /// @param _stateRoot Merkle root of the state tree
  /// @param _keystoreRoot Merkle root of the keystore tree
  /// @param _aspRoot Merkle root of the ASP (Association Set Provider) tree
  /// @param _amountOut Amount being withdrawn from the pool
  /// @param _tokenId Identifier of the token being transacted
  /// @param _context Application-specific context hash (binds proof to everything that is not included in it)
  /// @param _nullifiersSpent Nullifier hashes of the input notes being spent
  /// @param _commitmentsCreated Commitments of the newly created output notes
  /// @return _valid True if the proof is valid, false otherwise
  /// @dev It's not a view function because when testing the PoolVault via a
  /// harness we want to save the passed params in storage in order to assert on
  /// them in tests later.
  function _verifyProof(
    IGroth16Verifier.Proof memory _proof,
    uint256 _stateRoot,
    uint256 _keystoreRoot,
    uint256 _aspRoot,
    uint256 _amountOut,
    uint256 _tokenId,
    uint256 _context,
    uint256[] memory _nullifiersSpent,
    uint256[] memory _commitmentsCreated
  ) internal virtual returns (bool _valid) {
    bytes32 _key = _computeKey(_nullifiersSpent.length, _commitmentsCreated.length);
    Verifier memory _verifier = _getTransactVerifierRouterStorage().verifiers[_key];
    require(
      _verifier.addr != address(0),
      TransactVerifierRouter_UnsupportedCircuitConfiguration(_nullifiersSpent.length, _commitmentsCreated.length)
    );
    bytes memory _calldata = abi.encodePacked(_verifier.selector, _proof.pA, _proof.pB, _proof.pC);

    uint256[_FIXED_PUBSIGNALS] memory _fixedPublicSignals;
    _fixedPublicSignals[0] = _stateRoot;
    _fixedPublicSignals[1] = _keystoreRoot;
    _fixedPublicSignals[2] = _aspRoot;
    _fixedPublicSignals[3] = _amountOut;
    _fixedPublicSignals[4] = _tokenId;
    _fixedPublicSignals[5] = _context;

    _calldata = abi.encodePacked(_calldata, _nullifiersSpent, _commitmentsCreated, _fixedPublicSignals);
    (bool _success, bytes memory _retdata) = _verifier.addr.staticcall(_calldata);
    require(_success, TransactVerifierRouter_VerifierCallReverted(_retdata));
    _valid = abi.decode(_retdata, (bool));
  }

  /// @notice Initializes the TransactVerifierRouter with an array of verifier configurations
  /// @param _verifierConfigs Array of verifier configurations to register
  // solhint-disable-next-line style-guide-casing
  function __TransactVerifierRouter_init(VerifierConfig[] calldata _verifierConfigs) internal onlyInitializing {
    for (uint256 i; i < _verifierConfigs.length; ++i) {
      _setVerifier(_verifierConfigs[i].n, _verifierConfigs[i].m, _verifierConfigs[i].verifier);
    }
  }

  /// @notice Computes the mapping key for a given verifier configuration
  /// @param _n Number of nullifiers spent
  /// @param _m Number of commitments created
  /// @return The keccak256 hash used as the verifier lookup key
  function _computeKey(uint256 _n, uint256 _m) internal pure returns (bytes32) {
    return keccak256(abi.encode(_n, _m));
  }

  /// @notice Returns a pointer to the ERC-7201 namespaced storage for TransactVerifierRouter
  /// @return $ Storage pointer to TransactVerifierRouterStorage
  function _getTransactVerifierRouterStorage() internal pure returns (TransactVerifierRouterStorage storage $) {
    assembly {
      $.slot := TRANSACT_VERIFIER_ROUTER_STORAGE_LOCATION
    }
  }
}
