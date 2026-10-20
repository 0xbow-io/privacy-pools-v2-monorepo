// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {PoseidonT2} from 'poseidon-solidity/PoseidonT2.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Verifies the hardcoded leaf-tag constants match Poseidon(preimage).
contract UnitLeafTags is Test {
  function test_CommitmentLeafTag_MatchesPreimage() external pure {
    uint256 _preimage = _utf8ToBigEndianUint('privacy_pools_note');
    uint256 _computed = PoseidonT2.hash([_preimage]);
    assertEq(_computed, Constants.COMMITMENT_LEAF_TAG, 'COMMITMENT_LEAF_TAG mismatch');
  }

  function test_NullifierLeafTag_MatchesPreimage() external pure {
    uint256 _preimage = _utf8ToBigEndianUint('privacy_pools_nullifier');
    uint256 _computed = PoseidonT2.hash([_preimage]);
    assertEq(_computed, Constants.NULLIFIER_LEAF_TAG, 'NULLIFIER_LEAF_TAG mismatch');
  }

  function test_TagsAreDifferent() external pure {
    assertTrue(Constants.COMMITMENT_LEAF_TAG != Constants.NULLIFIER_LEAF_TAG, 'tags must differ');
  }

  /// @dev Converts an ASCII string to a uint256 using big-endian byte encoding.
  ///      This mirrors: BigInt(Buffer.from(s, "utf-8")) in JavaScript.
  function _utf8ToBigEndianUint(string memory _s) internal pure returns (uint256 _result) {
    bytes memory _b = bytes(_s);
    require(_b.length <= 32, 'string too long');
    for (uint256 i; i < _b.length; ++i) {
      _result = (_result << 8) | uint8(_b[i]);
    }
  }
}
