// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {RootBufferUpgradeable} from 'abstracts/RootBufferUpgradeable.sol';

/// @notice Harness contract to expose internal functions for testing
contract RootBufferHarness is RootBufferUpgradeable {
  function initialize(uint32 _size) external initializer {
    __RootBufferUpgradeable_init(_size);
  }

  function updateRoot(uint256 _newLatestRoot) external {
    _updateRoot(_newLatestRoot);
  }

  function setRootHistorySize(uint32 _size) external {
    _getRootBufferStorage().rootHistorySize = _size;
  }

  function setCurrentRootIndex(uint32 _index) external {
    _getRootBufferStorage().currentRootIndex = _index;
  }

  function setRoot(uint256 _index, uint256 _root) external {
    _getRootBufferStorage().roots[_index] = _root;
  }
}
