// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title IDepositVerifier
/// @notice Interface of the snarkjs-generated Groth16 verifier for the Deposit circuit
/// @dev The verifier itself is GPL-3.0 (snarkjs template) and is deployed as a separate contract;
///      BUSL code references it only through this interface. Public signals layout: see IGroth16Verifier.
interface IDepositVerifier {
  /// @notice Verifies a Groth16 proof for the Deposit circuit
  /// @param _pA G1 point (proof.pi_a)
  /// @param _pB G2 point (proof.pi_b)
  /// @param _pC G1 point (proof.pi_c)
  /// @param _pubSignals [outputCommitment, tokenId, value, context]
  /// @return _valid True if the proof is valid
  function verifyProof(
    uint256[2] calldata _pA,
    uint256[2][2] calldata _pB,
    uint256[2] calldata _pC,
    uint256[4] calldata _pubSignals
  ) external view returns (bool _valid);
}
