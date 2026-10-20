// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {Permissioned} from 'abstracts/Permissioned.sol';
import {TransactVerifierRouter} from 'abstracts/TransactVerifierRouter.sol';
import {IGroth16Verifier} from 'interfaces/IGroth16Verifier.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';

/// @notice Harness contract to expose internal functions for testing
contract TransactVerifierRouterHarness is TransactVerifierRouter {
  struct VerifyProofParams {
    IGroth16Verifier.Proof proof;
    uint256[6] fixedPubSignals; // stateRoot; keystoreRoot; aspRoot; amountOut; tokenId; context;
    uint256[] nullifiersSpent;
    uint256[] commitmentsCreated;
  }

  constructor(IAccessControl _accessRouter) Permissioned(_accessRouter) {
    _disableInitializers();
  }

  /// @notice Initializes the harness with verifier configurations
  function initialize(VerifierConfig[] calldata _verifierConfigs) external initializer {
    __TransactVerifierRouter_init(_verifierConfigs);
  }

  /// @notice Writes a Verifier struct directly into namespaced storage for testing
  function exposed_verifiersStorage(bytes32 _key, ITransactVerifierRouter.Verifier memory _v) external {
    _getTransactVerifierRouterStorage().verifiers[_key] = _v;
  }

  /// @notice Exposes the internal verifyProof as external for testing
  function exposed_verifyProof(VerifyProofParams memory _p) external returns (bool valid_) {
    return _verifyProof(
      _p.proof,
      _p.fixedPubSignals[0], // stateRoot
      _p.fixedPubSignals[1], // keystoreRoot
      _p.fixedPubSignals[2], // aspRoot
      _p.fixedPubSignals[3], // amountOut
      _p.fixedPubSignals[4], // tokenId
      _p.fixedPubSignals[5], // context
      _p.nullifiersSpent,
      _p.commitmentsCreated
    );
  }
}
