// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @notice Minimal interface for the Canon Guard factory.
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

/// @title CanonGuardSetupDelegator
/// @notice Called via `delegatecall` from `Safe.setup()` to atomically create and install a Canon Guard.
///
/// @dev Why this contract exists:
///
///      The Canon Guard factory requires `msg.sender == _safe` when creating a guard.
///      During deployment, the Safe doesn't exist yet, so we can't use `execTransaction`.
///      The deploy script calls `safe.setup()` from an EOA, but the EOA is not the Safe.
///
///      Safe.setup accepts a `(address to, bytes data)` pair that it executes as a delegatecall
///      after initialising owners and threshold. Because the delegatecall runs in the Safe's context:
///        - `address(this)` == the Safe
///        - external CALLs originate from the Safe's address (satisfies the factory check)
///        - storage writes target the Safe's storage
///
///      This contract is the delegatecall target — it holds the logic the Safe executes
///      as itself during initialization:
///        1. Call the Canon Guard factory — passes `msg.sender == _safe` check
///        2. Write the returned guard address into the Safe's guard storage slot
///
///      Without this helper, creating + installing a Canon Guard would require 4+ separate
///      transactions after setup (approveHash + execTransaction for createCanonGuard, then
///      again for setGuard). The delegatecall approach does it atomically in the setup tx.
///
///      Guard slot: `keccak256("guard_manager.guard.address")` per Safe v1.4.1 GuardManager.
contract CanonGuardSetupDelegator {
  // solhint-disable-next-line private-vars-leading-underscore
  bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

  event CanonGuardInstalled(address indexed safe, address indexed canonGuard);

  /// @notice Creates a Canon Guard via the on-chain factory and installs it on the calling Safe.
  ///         Must be invoked via `delegatecall` from a Safe — will revert if called directly.
  function setupCanonGuard(
    address _factory,
    address _multiSendCallOnly,
    uint256 _shortDelay,
    uint256 _longDelay,
    uint256 _expiryDelay,
    uint256 _maxApprovalDuration,
    address _emergencyCaller,
    address _emergencyTrigger
  ) external {
    ICanonGuardFactory _guardFactory = ICanonGuardFactory(_factory);
    address _canonGuard = _guardFactory.createCanonGuard({
      _safe: address(this),
      _multiSendCallOnly: _multiSendCallOnly,
      _shortTxExecutionDelay: _shortDelay,
      _longTxExecutionDelay: _longDelay,
      _txExpiryDelay: _expiryDelay,
      _maxApprovalDuration: _maxApprovalDuration,
      _emergencyTrigger: _emergencyTrigger,
      _emergencyCaller: _emergencyCaller
    });

    assembly {
      sstore(GUARD_STORAGE_SLOT, _canonGuard)
    }

    emit CanonGuardInstalled(address(this), _canonGuard);
  }
}
