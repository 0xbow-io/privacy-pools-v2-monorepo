// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title IERC5564Announcer
/// @notice Minimal interface for the canonical ERC-5564 stealth-address Announcer singleton, as called
///   by PrivacyPoolRelay.relayAndAnnounce to publish a stealth-payment announcement in the same
///   transaction as the withdrawal that funds it.
interface IERC5564Announcer {
  /// @notice Emitted by `announce` so a stealth-payment recipient can discover the payment
  /// @param _schemeId The ERC-5564 stealth-address scheme id
  /// @param _stealthAddress The stealth address that received the payment
  /// @param _caller The account that emitted the announcement (msg.sender)
  /// @param _ephemeralPubKey The ephemeral public key used to derive the stealth address
  /// @param _metadata View-tag + scheme metadata
  event Announcement(
    uint256 indexed _schemeId,
    address indexed _stealthAddress,
    address indexed _caller,
    bytes _ephemeralPubKey,
    bytes _metadata
  );

  /// @notice Publishes a stealth-payment announcement
  /// @param _schemeId The ERC-5564 stealth-address scheme id
  /// @param _stealthAddress The generated stealth address that received the payment
  /// @param _ephemeralPubKey The ephemeral public key used to derive the stealth address
  /// @param _metadata View-tag + scheme metadata
  function announce(
    uint256 _schemeId,
    address _stealthAddress,
    bytes calldata _ephemeralPubKey,
    bytes calldata _metadata
  ) external;
}
