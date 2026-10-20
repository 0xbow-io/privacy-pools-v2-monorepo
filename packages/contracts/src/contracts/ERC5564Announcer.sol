// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IERC5564Announcer} from 'interfaces/IERC5564Announcer.sol';

/// @title ERC5564Announcer
/// @notice Minimal ERC-5564 stealth-address Announcer for local/anvil deploys where the canonical
///   singleton (0x55649e01b5df198d18d95b5cc5051630cfd45564) is not present. Faithful to the standard:
///   `announce` simply logs the announcement so a stealth-payment recipient can discover the payment.
contract ERC5564Announcer is IERC5564Announcer {
  /// @inheritdoc IERC5564Announcer
  function announce(
    uint256 _schemeId,
    address _stealthAddress,
    bytes calldata _ephemeralPubKey,
    bytes calldata _metadata
  ) external {
    emit Announcement({
      _schemeId: _schemeId,
      _stealthAddress: _stealthAddress,
      _caller: msg.sender,
      _ephemeralPubKey: _ephemeralPubKey,
      _metadata: _metadata
    });
  }
}
