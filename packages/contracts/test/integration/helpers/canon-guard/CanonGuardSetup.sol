// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {Test} from 'forge-std/Test.sol';

import {ISafe} from '@safe-smart-account/interfaces/ISafe.sol';
import {Enum} from '@safe-smart-account/libraries/Enum.sol';
import {SafeProxy} from '@safe-smart-account/proxies/SafeProxy.sol';

import {UPGRADER_ROLE} from 'utils/RolesConstants.sol';

import {IArbitraryActionsFactory, ICanonGuard, ICanonGuardFactory, ISimpleActions} from './CanonGuardInterfaces.sol';

/// @title CanonGuardSetup
/// @notice Deploys a Safe + Canon Guard stack for integration tests.
///         Requires a mainnet fork so the deployed Canon Guard factories are available.
///         Registry: https://github.com/defi-wonderland/canon-guard-docs/pull/14
abstract contract CanonGuardSetup is Test {
  /// @dev Deployed via CREATE2 — same address on Ethereum and Optimism
  address internal constant CANON_GUARD_FACTORY = 0x656c264F914bd8Fe7bbAfb9B4F2EBcB4f259F67C;
  address internal constant ARBITRARY_ACTIONS_FACTORY = 0xD1F0e9D34B292E3EB27324F041f28929dBa41845;

  /// @dev Safe v1.4.1 canonical deployments (same address across all chains)
  address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
  address internal constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;

  ISafe internal _safe;
  ICanonGuard internal _canonGuard;

  address internal _safeOwner;
  uint256 internal _safeOwnerPk;

  uint256 internal constant SHORT_DELAY = 1 hours;
  uint256 internal constant LONG_DELAY = 7 days;
  uint256 internal constant EXPIRY_DELAY = 7 days;
  uint256 internal constant MAX_APPROVAL_DURATION = 30 days;

  /// @dev Deploy a 1-of-1 Safe multisig, Canon Guard (via on-chain factory), and wire them together
  function _deployCanonGuardStack() internal {
    (_safeOwner, _safeOwnerPk) = makeAddrAndKey('safeOwner');

    SafeProxy safeProxy = new SafeProxy(SAFE_SINGLETON);
    _safe = ISafe(address(safeProxy));

    address[] memory owners = new address[](1);
    owners[0] = _safeOwner;
    _safe.setup(
      owners,
      1, // threshold
      address(0), // delegatecall target (none)
      bytes(''), // delegatecall data (none)
      address(0), // fallback handler
      address(0), // payment token
      0, // payment amount
      payable(address(0)) // payment receiver
    );

    // The factory requires msg.sender == _safe, so we prank the Safe
    vm.prank(address(_safe));
    address canonGuardAddr = ICanonGuardFactory(CANON_GUARD_FACTORY)
      .createCanonGuard(
        address(_safe), // the Safe this guard protects
        MULTISEND_CALL_ONLY, // MultiSend for batched execution
        SHORT_DELAY, // short tx execution delay
        LONG_DELAY, // long tx execution delay
        EXPIRY_DELAY, // tx expiry delay
        MAX_APPROVAL_DURATION, // max pre-approval duration
        address(0xdead), // emergency caller (unused in tests)
        address(0xbeef) // emergency trigger (unused in tests)
      );
    _canonGuard = ICanonGuard(canonGuardAddr);

    // Install Canon Guard on the Safe (must be a self-call through the Safe)
    _execSafeTxDirectly(
      address(_safe), // target: the Safe itself
      0, // value
      abi.encodeWithSignature('setGuard(address)', address(_canonGuard)) // Safe.setGuard(canonGuard)
    );
  }

  /// @dev Transfer UPGRADER_ROLE from the old upgrader to the Safe (caller must hold `DEFAULT_ADMIN_ROLE` on the router).
  function _transferUpgraderRoleToSafe(
    IAccessControl _accessRouter,
    address _oldUpgrader,
    address _defaultAdmin
  ) internal {
    vm.startPrank(_defaultAdmin);
    _accessRouter.grantRole(UPGRADER_ROLE, address(_safe));
    _accessRouter.revokeRole(UPGRADER_ROLE, _oldUpgrader);
    vm.stopPrank();
  }

  /// @dev Run the full Canon Guard upgrade cycle for a single proxy
  function _upgradeViaCanonGuard(address _proxy, address _newImpl) internal {
    // Encode the upgrade call as a SimpleActions contract
    address actionsBuilder = _deploySimpleActionsForUpgrade(_proxy, _newImpl);

    // Owner queues the transaction (starts the timelock)
    vm.prank(_safeOwner);
    _canonGuard.queueTransaction(actionsBuilder);

    // Owner pre-approves the Safe tx hash
    bytes32 safeTxHash = _canonGuard.getSafeTransactionHash(actionsBuilder);
    vm.prank(_safeOwner);
    _safe.approveHash(safeTxHash);

    // Fast-forward past the timelock
    vm.warp(vm.getBlockTimestamp() + LONG_DELAY + 1);

    // Execute — Canon Guard validates the delay, then the Safe calls upgradeToAndCall
    _canonGuard.executeTransaction(actionsBuilder);
  }

  /// @dev Encode an upgradeToAndCall(newImpl, "") as a Canon Guard ArbitraryActions contract
  function _deploySimpleActionsForUpgrade(address _proxy, address _newImpl) internal returns (address) {
    ISimpleActions.SimpleAction[] memory actions = new ISimpleActions.SimpleAction[](1);
    actions[0] = ISimpleActions.SimpleAction({
      target: _proxy,
      signature: 'upgradeToAndCall(address,bytes)',
      data: abi.encodeWithSignature('upgradeToAndCall(address,bytes)', _newImpl, bytes('')),
      value: 0
    });

    return IArbitraryActionsFactory(ARBITRARY_ACTIONS_FACTORY).createArbitraryActions(actions);
  }

  /// @dev Execute a Safe tx without going through Canon Guard (used during initial setup)
  function _execSafeTxDirectly(address _to, uint256 _value, bytes memory _data) internal {
    bytes memory sig = _buildOwnerApprovedSig();
    bytes32 txHash = _safe.getTransactionHash(
      _to, _value, _data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), _safe.nonce()
    );
    vm.prank(_safeOwner);
    _safe.approveHash(txHash);
    _safe.execTransaction(_to, _value, _data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig);
  }

  /// @dev Safe signature format for a pre-approved hash: r=ownerAddr, s=0, v=1
  function _buildOwnerApprovedSig() internal view returns (bytes memory) {
    return abi.encodePacked(uint256(uint160(_safeOwner)), bytes32(0), uint8(1));
  }
}
