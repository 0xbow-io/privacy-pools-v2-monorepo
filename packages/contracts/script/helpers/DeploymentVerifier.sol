// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {AssetEntry, ChainAssets} from 'script/registries/ChainAssetRegistry.sol';
import {GovernanceConfig, SystemConfig} from 'script/registries/ChainConfigRegistry.sol';
import {Deployment} from 'script/registries/ChainDeploymentRegistry.sol';
import {PrivacyPoolRelay} from 'src/contracts/PrivacyPoolRelay.sol';
import {Constants} from 'src/utils/Constants.sol';
import {
  DEFAULT_ADMIN_ROLE,
  DEPOSITOR_ROLE,
  ENTRYPOINT_MANAGER_ROLE,
  OPS_ADMIN_ROLE,
  PAUSER_ROLE,
  POSTMAN_ROLE,
  UNPAUSER_ROLE,
  UPGRADER_ROLE
} from 'src/utils/RolesConstants.sol';

/// @title DeploymentVerifier
/// @notice Shared validation logic for Privacy Pools V2 deployments.
///         Used by `Deploy.s.sol` to (a) sanity-check inputs *before* deployment and
///         (b) verify the live deployment matches the declared config *after* deployment.
///         Also used by the standalone `VerifyDeployment.s.sol` script to re-run verification
///         against an existing deployment without re-running deploy logic.
///
/// @dev All functions in this library are `view` (post-deploy) or `pure` (pre-flight).
///      They never broadcast or change state.
library DeploymentVerifier {
  /*///////////////////////////////////////////////////////////////
                        SANITY LIMITS
  ///////////////////////////////////////////////////////////////*/

  /// @dev `LIKELY_*` constants are deploy-time heuristic bounds — values above/below them are
  ///      *likely* mistakes (e.g. an extra zero in a delay literal), not protocol-enforced. They
  ///      exist purely to fail loud on obvious typos in `ChainConfigRegistry`.
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant LIKELY_MAX_ROOT_HISTORY_SIZE = 256;
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant LIKELY_MAX_KEYSTORE_ROOT_LIVENESS = 30 days;
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant LIKELY_MAX_STATE_TREE_SIZE = 1 << 32;
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant LIKELY_MIN_STATE_TREE_SIZE = 1 << 18;
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant LIKELY_MIN_KEYSTORE_TREE_SIZE = 1 << 16;
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant LIKELY_MAX_GOVERNANCE_DELAY = 365 days;

  /// @dev Precompile cutoff: any address numerically below this is rejected as a
  ///      precompile or placeholder. Catches `address(3)`, `address(0xdead)`,
  ///      `address(0xbeef)`, `address(0xA11CE)`, etc.
  // solhint-disable-next-line private-vars-leading-underscore
  uint160 internal constant MIN_VALID_ADDRESS = 0x1000000;

  /*///////////////////////////////////////////////////////////////
                    PRE-FLIGHT: SYSTEM CONFIG
  ///////////////////////////////////////////////////////////////*/

  /// @notice Validates a `SystemConfig` before any contract is deployed.
  /// @dev Pure — operates only on the input struct. Reverts with a descriptive string
  /// @param _config The system configuration to validate
  function validateSystemConfig(SystemConfig memory _config) internal pure {
    _requireValidAddress(_config.opsAdmin, 'opsAdmin');
    _requireValidAddress(_config.entrypointManager, 'entrypointManager');
    _requireValidAddress(_config.postman, 'postman');

    require(_config.pausers.length != 0, 'DeploymentVerifier: pausers empty');
    for (uint256 _i; _i < _config.pausers.length; ++_i) {
      _requireValidAddress(_config.pausers[_i], 'pauser');
      for (uint256 _j; _j < _i; ++_j) {
        require(_config.pausers[_i] != _config.pausers[_j], 'DeploymentVerifier: duplicate pauser');
      }
    }

    require(_config.unpausers.length != 0, 'DeploymentVerifier: unpausers empty');
    for (uint256 _i; _i < _config.unpausers.length; ++_i) {
      _requireValidAddress(_config.unpausers[_i], 'unpauser');
      for (uint256 _j; _j < _i; ++_j) {
        require(_config.unpausers[_i] != _config.unpausers[_j], 'DeploymentVerifier: duplicate unpauser');
      }
    }

    require(_config.opsAdminRoles.length != 0, 'DeploymentVerifier: opsAdminRoles empty');
    for (uint256 _i; _i < _config.opsAdminRoles.length; ++_i) {
      _requireKnownOpsRole(_config.opsAdminRoles[_i]);
      for (uint256 _j; _j < _i; ++_j) {
        require(_config.opsAdminRoles[_i] != _config.opsAdminRoles[_j], 'DeploymentVerifier: duplicate opsAdminRole');
      }
    }

    require(_config.rootHistorySize != 0, 'DeploymentVerifier: rootHistorySize zero');
    require(_config.rootHistorySize <= LIKELY_MAX_ROOT_HISTORY_SIZE, 'DeploymentVerifier: rootHistorySize too large');
    require(_config.keystoreRootLiveness != 0, 'DeploymentVerifier: keystoreRootLiveness zero');
    require(
      _config.keystoreRootLiveness <= LIKELY_MAX_KEYSTORE_ROOT_LIVENESS,
      'DeploymentVerifier: keystoreRootLiveness too large'
    );

    require(_isPowerOfTwo(_config.maxKeystoreTreeSize), 'DeploymentVerifier: maxKeystoreTreeSize not power of two');
    require(
      _config.maxKeystoreTreeSize >= LIKELY_MIN_KEYSTORE_TREE_SIZE, 'DeploymentVerifier: maxKeystoreTreeSize too small'
    );
    require(
      _config.maxKeystoreTreeSize <= LIKELY_MAX_STATE_TREE_SIZE, 'DeploymentVerifier: maxKeystoreTreeSize too large'
    );

    require(_isPowerOfTwo(_config.maxStateTreeSize), 'DeploymentVerifier: maxStateTreeSize not power of two');
    require(
      _config.maxStateTreeSize >= _config.maxKeystoreTreeSize,
      'DeploymentVerifier: maxStateTreeSize must be >= maxKeystoreTreeSize'
    );
    require(_config.maxStateTreeSize <= LIKELY_MAX_STATE_TREE_SIZE, 'DeploymentVerifier: maxStateTreeSize too large');
    require(_config.maxStateTreeSize >= LIKELY_MIN_STATE_TREE_SIZE, 'DeploymentVerifier: maxStateTreeSize too small');
  }

  /*///////////////////////////////////////////////////////////////
                    PRE-FLIGHT: GOVERNANCE CONFIG
  ///////////////////////////////////////////////////////////////*/

  /// @notice Validates a `GovernanceConfig` (Canon Guard Safe parameters) before deployment.
  function validateGovernanceConfig(GovernanceConfig memory _gov) internal pure {
    require(_gov.owners.length != 0, 'DeploymentVerifier: governance owners empty');
    for (uint256 _i; _i < _gov.owners.length; ++_i) {
      _requireValidAddress(_gov.owners[_i], 'governance owner');
      for (uint256 _j; _j < _i; ++_j) {
        require(_gov.owners[_i] != _gov.owners[_j], 'DeploymentVerifier: duplicate governance owner');
      }
    }

    require(_gov.threshold != 0, 'DeploymentVerifier: governance threshold zero');
    require(_gov.threshold <= _gov.owners.length, 'DeploymentVerifier: governance threshold > owners');

    _requireValidAddress(_gov.emergencyCaller, 'emergencyCaller');
    _requireValidAddress(_gov.emergencyTrigger, 'emergencyTrigger');

    require(_gov.shortDelay != 0, 'DeploymentVerifier: shortDelay zero');
    require(_gov.shortDelay <= LIKELY_MAX_GOVERNANCE_DELAY, 'DeploymentVerifier: shortDelay too large');
    require(_gov.longDelay >= _gov.shortDelay, 'DeploymentVerifier: longDelay < shortDelay');
    require(_gov.longDelay <= LIKELY_MAX_GOVERNANCE_DELAY, 'DeploymentVerifier: longDelay too large');
    require(_gov.expiryDelay != 0, 'DeploymentVerifier: expiryDelay zero');
    require(_gov.expiryDelay <= LIKELY_MAX_GOVERNANCE_DELAY, 'DeploymentVerifier: expiryDelay too large');
    require(_gov.maxApprovalDuration != 0, 'DeploymentVerifier: maxApprovalDuration zero');
    require(
      _gov.maxApprovalDuration <= LIKELY_MAX_GOVERNANCE_DELAY, 'DeploymentVerifier: maxApprovalDuration too large'
    );
  }

  /*///////////////////////////////////////////////////////////////
                    PRE-FLIGHT: CHAIN ASSETS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Validates a `ChainAssets` registry entry before passing it to `setAssetConfiguration`.
  /// @dev Mirrors the on-chain checks in `Entrypoint.setAssetConfiguration` so pre-flight produces a
  ///      clear error before any state-changing call. The native asset is allowed by sentinel.
  function validateChainAssets(ChainAssets memory _chain) internal pure {
    for (uint256 _i; _i < _chain.assets.length; ++_i) {
      AssetEntry memory _entry = _chain.assets[_i];

      if (_entry.token != Constants.NATIVE_ASSET) {
        _requireValidAddress(_entry.token, 'asset token');
      }

      require(
        !_entry.config.enabled || _entry.config.minAmount != 0, 'DeploymentVerifier: enabled asset has zero minAmount'
      );
      require(_entry.config.vettingFeeBPS < 10_000, 'DeploymentVerifier: vettingFeeBPS >= 100%');

      for (uint256 _j; _j < _i; ++_j) {
        require(_entry.token != _chain.assets[_j].token, 'DeploymentVerifier: duplicate asset token');
      }
    }
  }

  /*///////////////////////////////////////////////////////////////
                  POST-DEPLOY: ROLE & WIRING VERIFICATION
  ///////////////////////////////////////////////////////////////*/

  /// @notice Asserts that the deployment's role wiring and contract references match the declared config.
  /// @dev All calls are `view`. Safe to call from inside `vm.startBroadcast` — view calls are not broadcast.
  /// @param _d The deployed contract addresses
  /// @param _config The configuration the deployment was built from (with `defaultAdmin` / `upgrader` already
  ///        patched to the Safe address on chains that use Canon Guard)
  /// @param _deployer The address that ran the deploy script. Used to assert temp roles were revoked.
  function verifyDeployment(Deployment memory _d, SystemConfig memory _config, address _deployer) internal view {
    _verifyCode(_d);
    _verifyRoles({
      _accessRouter: _d.accessRouter, _config: _config, _deployer: _deployer, _entrypoint: address(_d.entrypoint)
    });
    _verifyReferences(_d);
    _verifyInitState(_d, _config);
  }

  /// @notice Asserts that every asset listed in `_chain` is wired correctly on the Entrypoint.
  /// @dev Separate entry point so it can be skipped when running against a partially-configured deployment.
  function verifyAssets(Deployment memory _d, ChainAssets memory _chain) internal view {
    for (uint256 _i; _i < _chain.assets.length; ++_i) {
      AssetEntry memory _entry = _chain.assets[_i];
      IEntrypoint.AssetConfig memory _live = _d.entrypoint.assets(_entry.token);

      require(_live.enabled == _entry.config.enabled, 'DeploymentVerifier: asset enabled mismatch');
      require(_live.minAmount == _entry.config.minAmount, 'DeploymentVerifier: asset minAmount mismatch');
      require(_live.vettingFeeBPS == _entry.config.vettingFeeBPS, 'DeploymentVerifier: asset vettingFeeBPS mismatch');
      require(_live.maxRelayFee == _entry.config.maxRelayFee, 'DeploymentVerifier: asset maxRelayFee mismatch');

      // Enabled ERC-20s must have a max-uint allowance from Entrypoint → PoolVault
      if (_entry.config.enabled && _entry.token != Constants.NATIVE_ASSET) {
        uint256 _allowance = IERC20(_entry.token).allowance(address(_d.entrypoint), address(_d.poolVault));
        require(_allowance == type(uint256).max, 'DeploymentVerifier: missing Entrypoint->PoolVault allowance');
      }
    }
  }

  /*///////////////////////////////////////////////////////////////
                    INTERNAL VERIFY HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev All proxy / contract addresses must have non-empty code (rules out CREATE2 mispredictions).
  function _verifyCode(Deployment memory _d) private view {
    require(address(_d.accessRouter).code.length != 0, 'DeploymentVerifier: AccessRouter has no code');
    require(address(_d.aspRegistry).code.length != 0, 'DeploymentVerifier: ASPRegistry has no code');
    require(address(_d.keystore).code.length != 0, 'DeploymentVerifier: Keystore has no code');
    require(address(_d.poolVault).code.length != 0, 'DeploymentVerifier: PoolVault has no code');
    require(address(_d.entrypoint).code.length != 0, 'DeploymentVerifier: Entrypoint has no code');
    require(address(_d.relay).code.length != 0, 'DeploymentVerifier: Relay has no code');
  }

  /// @dev Asserts every protocol role lands on its expected holder and the deployer relinquished all temp roles.
  function _verifyRoles(
    IAccessControl _accessRouter,
    SystemConfig memory _config,
    address _deployer,
    address _entrypoint
  ) private view {
    // Final admin assignments
    require(
      _accessRouter.hasRole(DEFAULT_ADMIN_ROLE, _config.defaultAdmin), 'DeploymentVerifier: defaultAdmin missing role'
    );
    require(_accessRouter.hasRole(OPS_ADMIN_ROLE, _config.opsAdmin), 'DeploymentVerifier: opsAdmin missing role');
    require(_accessRouter.hasRole(UPGRADER_ROLE, _config.upgrader), 'DeploymentVerifier: upgrader missing role');
    require(
      _accessRouter.hasRole(ENTRYPOINT_MANAGER_ROLE, _config.entrypointManager),
      'DeploymentVerifier: entrypointManager missing role'
    );
    require(_accessRouter.hasRole(POSTMAN_ROLE, _config.postman), 'DeploymentVerifier: postman missing role');

    // Deployer relinquished every temp role (only required when deployer != final holder)
    if (_deployer != _config.defaultAdmin) {
      require(!_accessRouter.hasRole(DEFAULT_ADMIN_ROLE, _deployer), 'DeploymentVerifier: deployer kept DEFAULT_ADMIN');
    }
    if (_deployer != _config.opsAdmin) {
      require(!_accessRouter.hasRole(OPS_ADMIN_ROLE, _deployer), 'DeploymentVerifier: deployer kept OPS_ADMIN');
    }
    if (_deployer != _config.entrypointManager) {
      require(
        !_accessRouter.hasRole(ENTRYPOINT_MANAGER_ROLE, _deployer),
        'DeploymentVerifier: deployer kept ENTRYPOINT_MANAGER'
      );
    }

    // Pausers / unpausers
    for (uint256 _i; _i < _config.pausers.length; ++_i) {
      require(_accessRouter.hasRole(PAUSER_ROLE, _config.pausers[_i]), 'DeploymentVerifier: pauser missing role');
    }
    for (uint256 _i; _i < _config.unpausers.length; ++_i) {
      require(_accessRouter.hasRole(UNPAUSER_ROLE, _config.unpausers[_i]), 'DeploymentVerifier: unpauser missing role');
    }

    // Entrypoint can call PoolVault.deposit()
    require(_accessRouter.hasRole(DEPOSITOR_ROLE, _entrypoint), 'DeploymentVerifier: Entrypoint missing DEPOSITOR_ROLE');

    // Delegated-admin wiring: every role in opsAdminRoles must have OPS_ADMIN_ROLE as its admin
    for (uint256 _i; _i < _config.opsAdminRoles.length; ++_i) {
      require(
        _accessRouter.getRoleAdmin(_config.opsAdminRoles[_i]) == OPS_ADMIN_ROLE,
        'DeploymentVerifier: opsAdminRole has wrong admin'
      );
    }
  }

  /// @dev Asserts all inter-contract immutable / initialized references point at the expected peers.
  function _verifyReferences(Deployment memory _d) private view {
    require(
      address(_d.entrypoint.poolVault()) == address(_d.poolVault), 'DeploymentVerifier: Entrypoint.poolVault wrong'
    );
    require(
      address(_d.poolVault.aspRegistry()) == address(_d.aspRegistry), 'DeploymentVerifier: PoolVault.aspRegistry wrong'
    );
    require(address(_d.poolVault.keystore()) == address(_d.keystore), 'DeploymentVerifier: PoolVault.keystore wrong');
    require(address(_d.poolVault.depositVerifier()) != address(0), 'DeploymentVerifier: PoolVault.depositVerifier zero');
    require(
      address(_d.poolVault.ragequitVerifier()) != address(0), 'DeploymentVerifier: PoolVault.ragequitVerifier zero'
    );

    // Relay exposes its refs as immutable public state vars on the concrete contract.
    PrivacyPoolRelay _relay = PrivacyPoolRelay(payable(address(_d.relay)));
    require(address(_relay.POOL()) == address(_d.poolVault), 'DeploymentVerifier: Relay.POOL wrong');
    require(address(_relay.ENTRYPOINT()) == address(_d.entrypoint), 'DeploymentVerifier: Relay.ENTRYPOINT wrong');
  }

  /// @dev Asserts initialization parameters (liveness, tree caps) made it from config into the live contract.
  function _verifyInitState(Deployment memory _d, SystemConfig memory _config) private view {
    require(
      _d.keystore.keystoreRootLiveness() == _config.keystoreRootLiveness,
      'DeploymentVerifier: keystoreRootLiveness mismatch'
    );
    require(
      _d.keystore.maxKeystoreTreeSize() == _config.maxKeystoreTreeSize,
      'DeploymentVerifier: maxKeystoreTreeSize mismatch'
    );
    require(
      _d.poolVault.maxStateTreeSize() == _config.maxStateTreeSize, 'DeploymentVerifier: maxStateTreeSize mismatch'
    );
  }

  /*///////////////////////////////////////////////////////////////
                    INTERNAL VALIDATION HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev `_addr` must be non-zero and above the precompile / placeholder cutoff. The cutoff
  ///      (`MIN_VALID_ADDRESS`) is large enough that the usual sentinel literals like `0xdead`,
  ///      `0xbeef`, `0xA11CE` are rejected automatically.
  function _requireValidAddress(address _addr, string memory _label) private pure {
    require(_addr != address(0), string.concat('DeploymentVerifier: ', _label, ' is zero'));
    require(
      uint160(_addr) >= MIN_VALID_ADDRESS, string.concat('DeploymentVerifier: ', _label, ' is precompile/placeholder')
    );
  }

  /// @dev Allowlist for `opsAdminRoles`. AccessRouter already rejects DEFAULT_ADMIN_ROLE and OPS_ADMIN_ROLE
  ///      (would be a privilege-escalation foot-gun), but it would silently accept arbitrary unknown
  ///      `bytes32` values. This pre-flight check requires every entry to be one of the four roles whose
  ///      admin is intentionally delegated to the operational multisig.
  function _requireKnownOpsRole(bytes32 _role) private pure {
    require(
      _role == PAUSER_ROLE || _role == UNPAUSER_ROLE || _role == ENTRYPOINT_MANAGER_ROLE || _role == POSTMAN_ROLE,
      'DeploymentVerifier: unknown opsAdminRole'
    );
  }

  /// @dev Exact power-of-two check (rejects zero).
  function _isPowerOfTwo(uint256 _n) private pure returns (bool) {
    return _n != 0 && (_n & (_n - 1)) == 0;
  }
}
