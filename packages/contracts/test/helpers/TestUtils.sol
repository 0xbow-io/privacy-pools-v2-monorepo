// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IGroth16Verifier} from 'interfaces/IGroth16Verifier.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';

/// @notice Memory-compatible accessors for TransactProof (mirrors ProofLibV2's calldata-only functions)
library TransactProofMemory {
  function nullifierHashes(ProofLibV2.TransactProof memory _self) internal pure returns (uint256[] memory) {
    return _self.pubSignals[0];
  }

  function outputCommitments(ProofLibV2.TransactProof memory _self) internal pure returns (uint256[] memory) {
    return _self.pubSignals[1];
  }

  function groth16Proof(ProofLibV2.TransactProof memory _self) internal pure returns (IGroth16Verifier.Proof memory) {
    return IGroth16Verifier.Proof({pA: _self.pA, pB: _self.pB, pC: _self.pC});
  }
}

/// @notice Memory-compatible accessors for RagequitProof (mirrors ProofLibV2's calldata-only functions)
library RagequitProofMemory {
  function nullifierHash(ProofLibV2.RagequitProof memory _self) internal pure returns (uint256) {
    return _self.pubSignals[0];
  }

  function commitment(ProofLibV2.RagequitProof memory _self) internal pure returns (uint256) {
    return _self.pubSignals[1];
  }

  function keystoreRoot(ProofLibV2.RagequitProof memory _self) internal pure returns (uint256) {
    return _self.pubSignals[2];
  }

  function ownerAddress(ProofLibV2.RagequitProof memory _self) internal pure returns (uint256) {
    return _self.pubSignals[3];
  }

  function value(ProofLibV2.RagequitProof memory _self) internal pure returns (uint256) {
    return _self.pubSignals[4];
  }

  function tokenId(ProofLibV2.RagequitProof memory _self) internal pure returns (uint256) {
    return _self.pubSignals[5];
  }

  function label(ProofLibV2.RagequitProof memory _self) internal pure returns (uint256) {
    return _self.pubSignals[6];
  }
}

/// @notice Generic array helpers for building circuit proof inputs
library TestUtils {
  /// @dev Build a zero-filled array of the given length
  function zeros(uint256 _len) internal pure returns (uint256[] memory arr) {
    arr = new uint256[](_len);
  }

  /// @dev Build a 2D zero-filled array of the given dimensions
  function zeros(uint256 _outerLen, uint256 _innerLen) internal pure returns (uint256[][] memory arr) {
    arr = new uint256[][](_outerLen);
    for (uint256 i; i < _outerLen; i++) {
      arr[i] = zeros(_innerLen);
    }
  }

  /// @dev Wrap a single value in a length-1 array
  function single(uint256 _val) internal pure returns (uint256[] memory arr) {
    arr = new uint256[](1);
    arr[0] = _val;
  }
}
