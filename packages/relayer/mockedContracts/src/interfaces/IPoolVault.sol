// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

/// @title IPoolVault
/// @notice Interface for the PoolVault contract that manages private transactions
interface IPoolVault {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Parameters for a transact operation
  /// @param processor Address allowed to process this transaction (address(0) for anyone)
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

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  ///////////////////////////////////////////////////////////////*/

}
