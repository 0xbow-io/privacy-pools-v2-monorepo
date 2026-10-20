// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ERC1967Utils} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol';

import {IntegrationBase} from './IntegrationBase.t.sol';
import {ASPRegistryV2, EntrypointV2, KeystoreV2, PoolVaultV2} from './helpers/V2Implementations.sol';
import {ICanonGuard} from './helpers/canon-guard/CanonGuardInterfaces.sol';
import {CanonGuardSetup} from './helpers/canon-guard/CanonGuardSetup.sol';

import {Note} from './IntegrationBase.t.sol';
import {Keystore} from 'contracts/Keystore.sol';
import {PoolVault} from 'contracts/PoolVault.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {Constants} from 'utils/Constants.sol';

contract CanonGuardUpgradeIntegration is IntegrationBase, CanonGuardSetup {
  using ProofLibV2 for ProofLibV2.DepositProof;

  Note internal _aliceDeposit;

  function setUp() public override {
    super.setUp();
    if (_usingSepoliaDeployment) vm.skip(true);

    _deployCanonGuardStack();
    _transferUpgraderRoleToSafe(IAccessControl(address(_accessRouter)), _config.upgrader, _config.defaultAdmin);

    alice = _registerInKeystore(alice);
    _aliceDeposit = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);
  }

  /*///////////////////////////////////////////////////////////////
                      HAPPY-PATH: UPGRADE ALL CONTRACTS
  ///////////////////////////////////////////////////////////////*/

  function test_upgradePoolVault_viaCanonGuard() external {
    // Snapshot state before upgrade
    PoolVault poolVault = PoolVault(payable(address(_poolVault)));
    uint32 rootIdxBefore = _poolVault.currentRootIndex();
    uint256 latestRootBefore = _poolVault.roots(rootIdxBefore);
    uint256 outputCommitment = _aliceDeposit.outputCommitment;
    uint256 commitmentBefore = _poolVault.commitments(outputCommitment);

    // Deploy V2 and upgrade via Canon Guard
    PoolVaultV2 newImpl = new PoolVaultV2(IAccessControl(address(poolVault.ACCESS_ROUTER())));
    _upgradeViaCanonGuard(address(_poolVault), address(newImpl));

    // Verify implementation changed and state preserved
    assertEq(_getImplementation(address(_poolVault)), address(newImpl), 'implementation should be V2');
    assertEq(PoolVaultV2(payable(address(_poolVault))).version(), 2, 'version should be 2');
    assertTrue(_poolVault.isKnownRoot(latestRootBefore), 'root still known after upgrade');
    assertEq(_poolVault.commitments(outputCommitment), commitmentBefore, 'commitment preserved');
  }

  function test_upgradeEntrypoint_viaCanonGuard() external {
    // Snapshot state before upgrade
    IEntrypoint.AssetConfig memory configBefore = _entrypoint.assets(address(_token));

    // Deploy V2 and upgrade via Canon Guard
    EntrypointV2 newImpl = new EntrypointV2(IAccessControl(address(_accessRouter)));
    _upgradeViaCanonGuard(address(_entrypoint), address(newImpl));

    // Verify implementation changed and state preserved
    assertEq(_getImplementation(address(_entrypoint)), address(newImpl), 'implementation should be V2');
    assertEq(EntrypointV2(payable(address(_entrypoint))).version(), 2, 'version should be 2');
    IEntrypoint.AssetConfig memory configAfter = _entrypoint.assets(address(_token));
    assertEq(configAfter.enabled, configBefore.enabled, 'asset config preserved');
    assertEq(configAfter.vettingFeeBPS, configBefore.vettingFeeBPS, 'fee BPS preserved');
  }

  function test_upgradeKeystore_viaCanonGuard() external {
    // Snapshot state before upgrade
    uint256 nullifyingKeyBefore = _keystore.nullifyingKeys(alice.addr);

    // Deploy V2 and upgrade via Canon Guard
    KeystoreV2 newImpl = new KeystoreV2(IAccessControl(address(_accessRouter)));
    _upgradeViaCanonGuard(address(_keystore), address(newImpl));

    // Verify implementation changed and state preserved
    assertEq(_getImplementation(address(_keystore)), address(newImpl), 'implementation should be V2');
    assertEq(KeystoreV2(address(_keystore)).version(), 2, 'version should be 2');
    assertEq(_keystore.nullifyingKeys(alice.addr), nullifyingKeyBefore, 'nullifying key preserved');
  }

  function test_upgradeASPRegistry_viaCanonGuard() external {
    // Snapshot state before upgrade
    uint256 aspRootBefore = _aspRegistry.latestASPRoot();

    // Deploy V2 and upgrade via Canon Guard
    ASPRegistryV2 newImpl = new ASPRegistryV2(IAccessControl(address(_accessRouter)));
    _upgradeViaCanonGuard(address(_aspRegistry), address(newImpl));

    // Verify implementation changed and state preserved
    assertEq(_getImplementation(address(_aspRegistry)), address(newImpl), 'implementation should be V2');
    assertEq(ASPRegistryV2(address(_aspRegistry)).version(), 2, 'version should be 2');
    assertEq(_aspRegistry.latestASPRoot(), aspRootBefore, 'ASP root preserved');
  }

  /*///////////////////////////////////////////////////////////////
                    CANON GUARD CONFIGURATION
  ///////////////////////////////////////////////////////////////*/

  function test_canonGuard_configuredWithExpectedDelays() external view {
    assertEq(_canonGuard.LONG_TX_EXECUTION_DELAY(), LONG_DELAY, 'long delay mismatch');
    assertEq(_canonGuard.SHORT_TX_EXECUTION_DELAY(), SHORT_DELAY, 'short delay mismatch');
    assertEq(_canonGuard.TX_EXPIRY_DELAY(), EXPIRY_DELAY, 'expiry delay mismatch');
  }

  /*///////////////////////////////////////////////////////////////
                    TIMELOCK ENFORCEMENT
  ///////////////////////////////////////////////////////////////*/

  function test_revertWhen_executeBeforeDelay() external {
    KeystoreV2 newImpl = new KeystoreV2(IAccessControl(address(_accessRouter)));
    address actionsBuilder = _deploySimpleActionsForUpgrade(address(_keystore), address(newImpl));

    // Queue and approve
    vm.prank(_safeOwner);
    _canonGuard.queueTransaction(actionsBuilder);
    bytes32 safeTxHash = _canonGuard.getSafeTransactionHash(actionsBuilder);
    vm.prank(_safeOwner);
    _safe.approveHash(safeTxHash);

    // Immediately — should revert
    vm.expectRevert(ICanonGuard.TransactionNotYetExecutable.selector);
    _canonGuard.executeTransaction(actionsBuilder);

    // Warp to 1 second before LONG_DELAY — still too early
    vm.warp(vm.getBlockTimestamp() + LONG_DELAY - 1);
    vm.expectRevert(ICanonGuard.TransactionNotYetExecutable.selector);
    _canonGuard.executeTransaction(actionsBuilder);

    // Warp 1 second more (exactly LONG_DELAY) — now it should succeed
    vm.warp(vm.getBlockTimestamp() + 1);
    _canonGuard.executeTransaction(actionsBuilder);

    // Verify the upgrade actually went through
    assertEq(KeystoreV2(address(_keystore)).version(), 2, 'upgrade should have succeeded after delay');
  }

  function test_revertWhen_executeAfterExpiry() external {
    KeystoreV2 newImpl = new KeystoreV2(IAccessControl(address(_accessRouter)));
    address actionsBuilder = _deploySimpleActionsForUpgrade(address(_keystore), address(newImpl));

    // Queue and approve
    vm.prank(_safeOwner);
    _canonGuard.queueTransaction(actionsBuilder);
    bytes32 safeTxHash = _canonGuard.getSafeTransactionHash(actionsBuilder);
    vm.prank(_safeOwner);
    _safe.approveHash(safeTxHash);

    // Warp past the valid window (LONG_DELAY + EXPIRY_DELAY) — should revert as expired
    vm.warp(vm.getBlockTimestamp() + LONG_DELAY + EXPIRY_DELAY + 1);
    vm.expectRevert(ICanonGuard.TransactionExpired.selector);
    _canonGuard.executeTransaction(actionsBuilder);
  }

  /*///////////////////////////////////////////////////////////////
                    NEGATIVE: UNAUTHORIZED UPGRADE
  ///////////////////////////////////////////////////////////////*/

  function test_revertWhen_upgradeFromNonUpgrader() external {
    KeystoreV2 newImpl = new KeystoreV2(IAccessControl(address(_accessRouter)));

    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    vm.prank(address(0xbad));
    Keystore(address(_keystore)).upgradeToAndCall(address(newImpl), bytes(''));
  }

  /*///////////////////////////////////////////////////////////////
                    NEGATIVE: NON-OWNER QUEUE
  ///////////////////////////////////////////////////////////////*/

  function test_revertWhen_queueFromNonOwner() external {
    KeystoreV2 newImpl = new KeystoreV2(IAccessControl(address(_accessRouter)));
    address actionsBuilder = _deploySimpleActionsForUpgrade(address(_keystore), address(newImpl));

    vm.expectRevert(ICanonGuard.NotSafeOwner.selector);
    vm.prank(address(0xbad));
    _canonGuard.queueTransaction(actionsBuilder);
  }

  /*///////////////////////////////////////////////////////////////
                          HELPERS
  ///////////////////////////////////////////////////////////////*/

  function _getImplementation(address _proxy) internal view returns (address) {
    return address(uint160(uint256(vm.load(_proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
  }
}
