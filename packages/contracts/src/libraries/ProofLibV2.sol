// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IDepositVerifier} from 'interfaces/IDepositVerifier.sol';
import {IGroth16Verifier} from 'interfaces/IGroth16Verifier.sol';

/// @title ProofLibV2
/// @notice Library for parsing Groth16 proof public signals for Privacy Pools V2 circuits
/// @dev Provides accessor functions for each circuit's public inputs and outputs
library ProofLibV2 {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  //////////////////////////////////////////////////////////////*/

  /// @notice Groth16 proof components and public signals for deposit circuit
  /// @param pA G1 point (proof.pi_a)
  /// @param pB G2 point (proof.pi_b)
  /// @param pC G1 point (proof.pi_c)
  /// @param pubSignals Public signals array
  struct DepositProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[4] pubSignals;
  }

  /// @notice Groth16 proof components and public signals for transact circuit
  /// @param pA G1 point (proof.pi_a)
  /// @param pB G2 point (proof.pi_b)
  /// @param pC G1 point (proof.pi_c)
  /// @param pubSignals Public signals 2D array
  struct TransactProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[][] pubSignals;
  }

  /// @notice Groth16 proof components and public signals for ragequit circuit
  /// @param pA G1 point (proof.pi_a)
  /// @param pB G2 point (proof.pi_b)
  /// @param pC G1 point (proof.pi_c)
  /// @param pubSignals Public signals array
  struct RagequitProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[7] pubSignals;
  }

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /// @notice Thrown when a tokenId public signal has non-zero bits above 160
  /// @param _raw The raw uint256 value that failed canonicalization
  error ProofLib_TokenIdNotCanonical(uint256 _raw);

  /*///////////////////////////////////////////////////////////////
                        VERIFIER WRAPPERS
  //////////////////////////////////////////////////////////////*/

  /// @notice allows calling the verifier contract without accessing the
  /// proof elements, which in a real programming language would be qualified
  /// as private
  /// @param _verifier circomkit-generated groth16 verifier
  /// @param _proof deposit proof
  /// @return _valid True if the proof is valid
  function verify(IDepositVerifier _verifier, DepositProof calldata _proof) internal view returns (bool _valid) {
    return _verifier.verifyProof({_pA: _proof.pA, _pB: _proof.pB, _pC: _proof.pC, _pubSignals: _proof.pubSignals});
  }

  /*///////////////////////////////////////////////////////////////
                        DEPOSIT PROOF FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Returns the output commitment from a deposit proof
  /// @param _proof The deposit proof struct
  /// @return The commitment hash for tree insertion
  function outputCommitment(DepositProof memory _proof) internal pure returns (uint256) {
    return _proof.pubSignals[0];
  }

  /// @notice Returns the token address from a deposit proof
  /// @param _proof The deposit proof struct
  /// @return The token identifier (address as uint256)
  function tokenId(DepositProof memory _proof) internal pure returns (address) {
    uint256 _raw = _proof.pubSignals[1];
    require(_raw >> 160 == 0, ProofLib_TokenIdNotCanonical(_raw));
    return address(uint160(_raw));
  }

  /// @notice Returns the deposit value from a deposit proof
  /// @param _proof The deposit proof struct
  /// @return The deposited amount
  function value(DepositProof memory _proof) internal pure returns (uint256) {
    return _proof.pubSignals[2];
  }

  /// @notice Returns the context value from a deposit proof
  /// @param _proof The deposit proof struct
  /// @return The context field
  /// @dev Must match uint256(keccak256(abi.encode(_noteData))) % SNARK_SCALAR_FIELD for the NoteData bound in PoolVault.deposit
  function context(DepositProof memory _proof) internal pure returns (uint256) {
    return _proof.pubSignals[3];
  }

  /*///////////////////////////////////////////////////////////////
                        TRANSACT PROOF FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Extracts Groth16 proof components from TransactProof
  /// @param _proof The transact proof struct
  /// @return The Groth16 proof components (pA, pB, pC)
  function toGroth16Proof(TransactProof calldata _proof) internal pure returns (IGroth16Verifier.Proof memory) {
    return IGroth16Verifier.Proof({pA: _proof.pA, pB: _proof.pB, pC: _proof.pC});
  }

  /// @notice Returns the nullifier hashes array from a transact proof
  /// @param _proof The transact proof struct
  /// @return The array of spent note nullifiers
  function nullifierHashes(TransactProof calldata _proof) internal pure returns (uint256[] calldata) {
    return _proof.pubSignals[0];
  }

  /// @notice Returns the output commitments array from a transact proof
  /// @param _proof The transact proof struct
  /// @return The array of new note commitments
  function outputCommitments(TransactProof calldata _proof) internal pure returns (uint256[] calldata) {
    return _proof.pubSignals[1];
  }

  /// @notice Returns the state tree root from a transact proof
  /// @param _proof The transact proof struct
  /// @return The root of the commitment state tree
  function stateRoot(TransactProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[2][0];
  }

  /// @notice Returns the key registry root from a transact proof
  /// @param _proof The transact proof struct
  /// @return The root of the key registry tree
  function keyRegistryRoot(TransactProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[3][0];
  }

  /// @notice Returns the ASP association set root from a transact proof
  /// @param _proof The transact proof struct
  /// @return The root of the ASP association set tree
  function associationSetRoot(TransactProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[4][0];
  }

  /// @notice Returns the public withdrawal amount from a transact proof
  /// @param _proof The transact proof struct
  /// @return The amount being withdrawn (0 for pure transfers)
  function amountOut(TransactProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[5][0];
  }

  /// @notice Returns the token address for withdrawal from a transact proof
  /// @param _proof The transact proof struct
  /// @return The token address being withdrawn
  function tokenIdOut(TransactProof calldata _proof) internal pure returns (address) {
    uint256 _raw = _proof.pubSignals[6][0];
    require(_raw >> 160 == 0, ProofLib_TokenIdNotCanonical(_raw));
    return address(uint160(_raw));
  }

  /// @notice Returns the context hash from a transact proof
  /// @param _proof The transact proof struct
  /// @return The context binding transaction params and encrypted payload
  function context(TransactProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[7][0];
  }

  /*///////////////////////////////////////////////////////////////
                        RAGEQUIT PROOF FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Returns the nullifier hash from a ragequit proof
  /// @param _proof The ragequit proof struct
  /// @return The nullifier to prevent double-spending
  function nullifierHash(RagequitProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[0];
  }

  /// @notice Returns the commitment from a ragequit proof
  /// @param _proof The ragequit proof struct
  /// @return The commitment hash for verification
  function commitment(RagequitProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[1];
  }

  /// @notice Returns the keystore root from a ragequit proof
  /// @param _proof The ragequit proof struct
  /// @return The root of the keystore tree
  function keystoreRoot(RagequitProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[2];
  }

  /// @notice Returns the owner address from a ragequit proof
  /// @param _proof The ragequit proof struct
  /// @return The forced withdrawal recipient address
  function ownerAddress(RagequitProof calldata _proof) internal pure returns (address) {
    return address(uint160(_proof.pubSignals[3]));
  }

  /// @notice Returns the note value from a ragequit proof
  /// @param _proof The ragequit proof struct
  /// @return The amount being withdrawn
  function value(RagequitProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[4];
  }

  /// @notice Returns the token ID (asset address) from a ragequit proof
  /// @param _proof The ragequit proof struct
  /// @return The asset address
  function tokenId(RagequitProof calldata _proof) internal pure returns (address) {
    uint256 _raw = _proof.pubSignals[5];
    require(_raw >> 160 == 0, ProofLib_TokenIdNotCanonical(_raw));
    return address(uint160(_raw));
  }

  /// @notice Returns the label from a ragequit proof
  /// @param _proof The ragequit proof struct
  /// @return The lineage identifier for ASP tracking
  function label(RagequitProof calldata _proof) internal pure returns (uint256) {
    return _proof.pubSignals[6];
  }
}
