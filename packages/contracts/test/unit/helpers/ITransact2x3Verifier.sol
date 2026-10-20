// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @notice Shape of the snarkjs-generated 2x3 transact verifier (2 + 3 + 6 = 11 public signals)
/// @dev Declared here so BUSL tests do not import the GPL-3.0 verifier source
interface ITransact2x3Verifier {
  /// @notice Verifies a Groth16 proof for the 2x3 Transact circuit
  /// @param _pA G1 point (proof.pi_a)
  /// @param _pB G2 point (proof.pi_b)
  /// @param _pC G1 point (proof.pi_c)
  /// @param _pubSignals 2 nullifiers, 3 commitments, then the 6 fixed public signals
  /// @return _valid True if the proof is valid
  function verifyProof(
    uint256[2] calldata _pA,
    uint256[2][2] calldata _pB,
    uint256[2] calldata _pC,
    uint256[11] calldata _pubSignals
  ) external view returns (bool _valid);
}
