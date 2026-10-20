// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title ITransactVerifierRouter
/// @notice Interface for contracts extending the TransactVerifierRouter abstract contract
/// @dev The most important method for this feature is actually internal,
/// _verifyProof, since it's not needed to do an extra external call to verify
/// contracts, and can be internal-called from PoolVault directly
/// @dev Routes proof verification to the correct Groth16 verifier based on circuit configuration (NxM)
interface ITransactVerifierRouter {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Input and output sizes are always known when using this, since they are part of the key.
  /// We could compute the selector every time but that would cost more gas,
  /// and we have to fetch the entire slot from storage anyway.
  /// @param addr the verifier address
  /// @param selector the 4-byte function signature to use when calling the
  /// contract, as it's not trivial to compute on-chain
  struct Verifier {
    address addr;
    bytes4 selector;
  }

  /// @notice Configuration for registering a verifier for a specific NxM circuit
  /// @param n Number of nullifiers spent (N)
  /// @param m Number of commitments created (M)
  /// @param verifier Verifier address and function selector
  struct VerifierConfig {
    uint8 n;
    uint8 m;
    Verifier verifier;
  }

  /// @notice ERC-7201 namespaced storage for TransactVerifierRouter
  /// @param verifiers Mapping from circuit configuration key to verifier
  /// @custom:storage-location erc7201:privacypools.storage.TransactVerifierRouter
  struct TransactVerifierRouterStorage {
    mapping(bytes32 key => Verifier verifier) verifiers;
  }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a verifier is configured for a circuit configuration
  /// @param _nullifiersSpent Number of nullifiers spent in transaction (N)
  /// @param _commitmentsCreated Number of new commitments created by circuit (M)
  /// @param _verifier Address of the Groth16 verifier contract
  /// @param _selector Function selector to call on the verifier
  event VerifierConfigured(uint256 _nullifiersSpent, uint256 _commitmentsCreated, address _verifier, bytes4 _selector);

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when _nullifiersSpent or _commitmentsCreated is outside of configured options
  /// @param _nullifiersSpent Number of nullifiers spent in transaction (N)
  /// @param _commitmentsCreated Number of new commitments created by circuit (M)
  error TransactVerifierRouter_UnsupportedCircuitConfiguration(uint256 _nullifiersSpent, uint256 _commitmentsCreated);

  /// @notice Thrown when call to the verifier contract reverts, which should
  /// not happen in normal circumstances
  /// @param _error The revert data returned by the verifier contract
  error TransactVerifierRouter_VerifierCallReverted(bytes _error);

  /// @notice Thrown when either the nullifier or commitment count is zero, as
  /// it's impossible to have asset value to use in the transaction if no
  /// nullifier is spent, and transactions are guaranteed to always create at
  /// least one commitment in order to not dox when the value of a set of
  /// nullifiers is depleted
  error TransactVerifierRouter_InvalidZeroParameter();

  /*///////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Registers a verifier contract for a specific NxM circuit configuration
  /// @param _nullifiersSpent Number of nullifiers spent in transaction (N)
  /// @param _commitmentsCreated Number of new commitments created by circuit (M)
  /// @param _settings Verifier address and selector. Address MAY be zero to disable a configuration
  function setVerifier(uint8 _nullifiersSpent, uint8 _commitmentsCreated, Verifier calldata _settings) external;

  /// @notice Look up a verifier by its configuration key
  /// @param _key The keccak256 hash of the (nullifiersSpent, commitmentsCreated) pair
  /// @return _verifier The verifier configuration
  function verifiers(bytes32 _key) external view returns (Verifier memory _verifier);
}
