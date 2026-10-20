// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @notice Minimal 0.8.32 interfaces mirroring Canon Guard's ABI.
///         Canon Guard source uses pragma 0.8.30, so we can't import its interfaces directly.
///         Tests interact with Canon Guard via a mainnet fork where the factories are already deployed.

interface ICanonGuard {
  struct TransactionInfo {
    address proposer;
    bytes actionsData;
    uint256 executableAt;
    uint256 expiresAt;
    bool isPreApproved;
  }

  error TransactionNotYetExecutable();
  error TransactionExpired();
  error NotSafeOwner();

  function queueTransaction(address _actionsBuilder) external;
  function executeTransaction(address _actionsBuilder) external;
  function getSafeTransactionHash(address _actionsBuilder) external view returns (bytes32);
  function getSafeTransactionHash(address _actionsBuilder, uint256 _safeNonce) external view returns (bytes32);
  function getSafeNonce() external view returns (uint256);
  function transactionsInfo(address _actionsBuilder)
    external
    view
    returns (address proposer, bytes memory actionsData, uint256 executableAt, uint256 expiresAt, bool isPreApproved);
  function LONG_TX_EXECUTION_DELAY() external view returns (uint256);
  function SHORT_TX_EXECUTION_DELAY() external view returns (uint256);
  function TX_EXPIRY_DELAY() external view returns (uint256);
}

interface IActionsBuilder {
  struct Action {
    address target;
    bytes data;
    uint256 value;
  }

  function getActions() external view returns (Action[] memory);
}

interface ISimpleActions is IActionsBuilder {
  struct SimpleAction {
    address target;
    string signature;
    bytes data;
    uint256 value;
  }
}

/// @notice Factory for deploying Canon Guard instances (deployed via CREATE2, same address on all chains)
interface ICanonGuardFactory {
  function createCanonGuard(
    address _safe,
    address _multiSendCallOnly,
    uint256 _shortTxExecutionDelay,
    uint256 _longTxExecutionDelay,
    uint256 _txExpiryDelay,
    uint256 _maxApprovalDuration,
    address _emergencyTrigger,
    address _emergencyCaller
  ) external returns (address _canonGuard);
}

/// @notice Factory for deploying ArbitraryActions (action builders) contracts
interface IArbitraryActionsFactory {
  function createArbitraryActions(ISimpleActions
        .SimpleAction[] calldata _actions) external returns (address _arbitraryActions);
}
