// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

library Constants {
  /// @notice Sentinel address representing native ETH
  // solhint-disable-next-line private-vars-leading-underscore
  address internal constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
  /// @dev authType = 0 → direct key authorization (Poseidon(0, privateRevocableKey))
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant AUTH_TYPE_DIRECT_KEY = 0;

  /// @dev Poseidon(BigInt(Buffer.from("privacy_pools_note","utf-8"))) (UTF-8 → big-endian uint256)
  ///      Domain-separation tag for commitment leaves in the state tree.
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant COMMITMENT_LEAF_TAG =
    3_791_694_183_000_795_315_792_098_099_581_407_680_958_131_641_292_811_872_617_553_086_713_867_485_913;

  /// @dev Poseidon(BigInt(Buffer.from("privacy_pools_nullifier","utf-8"))) (UTF-8 → big-endian uint256)
  ///      Domain-separation tag for nullifier leaves in the state tree.
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant NULLIFIER_LEAF_TAG =
    1_480_564_842_420_020_354_887_207_755_615_370_381_236_762_558_448_265_256_256_653_429_412_951_563_031;
}
