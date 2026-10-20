// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {ProofLibV2} from 'libraries/VerifierMock.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

/// @title IPrivacyPoolRelay
/// @notice Interface for relaying private withdrawals so a relayer pays gas and funds go to a recipient (with optional fee)
interface IPrivacyPoolRelay {
    /*///////////////////////////////////////////////////////////////
      STRUCTS
    ///////////////////////////////////////////////////////////////*/

    /// @notice Routing of withdrawn amount between recipient and fee recipient
    /// @param recipient Address to receive the net amount after fee
    /// @param feeRecipient Address to receive the fee (or msg.sender if zero)
    /// @param feeAmount Fee in nominal token amount
    struct PayoutRouting {
        address recipient;
        address feeRecipient;
        uint256 feeAmount;
        uint256 nativeGas;
    }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a withdrawal is successfully relayed
  /// @param _asset The token address (or NATIVE_ASSET for ETH)
  /// @param _recipient Address that received the net amount
  /// @param _recipientAmount Amount sent to recipient
  /// @param _feeRecipient Address that received the fee
  /// @param _fee Fee amount taken
  /// @param _gasFunding Native ETH forwarded to recipient for gas funding
  event Relayed(
    address indexed _asset,
    address indexed _recipient,
    uint256 _recipientAmount,
    address indexed _feeRecipient,
    uint256 _fee,
    uint256 _gasFunding
  );


  /*///////////////////////////////////////////////////////////////
                              ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when pool is the zero address
  error PrivacyPoolRelay_ZeroPool();

  /// @notice Thrown when fee amount exceeds asset's maxRelayFee
  error PrivacyPoolRelay_FeeExceedsMax();

  /// @notice Thrown when fee amount exceeds the withdrawn value
  /// @dev Fee is taken from the withdrawal, so it cannot exceed the withdrawn amount
  error PrivacyPoolRelay_FeeExceedsWithdrawal();

  /// @notice Thrown when withdrawnValue is zero to avoid executing an empty withdrawal that only costs gas
  error PrivacyPoolRelay_ZeroWithdrawal();

  /*///////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Relays a withdrawal: relayer pays gas; pool transacts then relay forwards to recipient and optional fee
  /// @dev Decodes PayoutRouting from _transactParams.data, calls pool.transact, then sends funds to recipient and fee to feeRecipient.
  ///   Any ETH sent via msg.value is forwarded to the recipient, enabling atomic gas funding for ERC-20 withdrawals.
  /// @param _proof The Groth16 proof with public signals (uses amountOut and tokenIdOut)
  /// @param _transactParams Transact params; .data must ABI-encode PayoutRouting, .processor should be address(this) or address(0)
  /// @param _noteData Per-output discovery data (hint + encrypted payload)
  function relay(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData
  ) external payable;
}
