// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import {IRootBuffer} from 'interfaces/IRootBuffer.sol';

/// @title RootBufferUpgradeable
/// @notice Abstract contract that manages a circular buffer of merkle roots
abstract contract RootBufferUpgradeable is IRootBuffer, Initializable {
  /*///////////////////////////////////////////////////////////////
                              STORAGE
  //////////////////////////////////////////////////////////////*/

  /// @notice ERC-7201 storage location for RootBuffer
  // keccak256(abi.encode(uint256(keccak256("privacypools.storage.RootBuffer")) - 1)) & ~bytes32(uint256(0xff))
  // solhint-disable-next-line private-vars-leading-underscore
  bytes32 private constant ROOT_BUFFER_STORAGE_LOCATION =
    0xac713a80b3fd44767a41e07502586f1b518ee209f229b08d50caf0016cc65900;

  /// @notice Returns a pointer to the ERC-7201 namespaced storage for RootBuffer
  /// @return $ Storage pointer to RootBufferStorage
  function _getRootBufferStorage() internal pure returns (RootBufferStorage storage $) {
    assembly {
      $.slot := ROOT_BUFFER_STORAGE_LOCATION
    }
  }

  /*///////////////////////////////////////////////////////////////
                            INITIALIZER
  //////////////////////////////////////////////////////////////*/

  /// @notice Initializes the root buffer with a given history size
  /// @dev We set currentRootIndex = _size - 1 so first insert uses index [0]
  /// @param _size The number of roots to keep in history
  // solhint-disable-next-line ordering, style-guide-casing
  function __RootBufferUpgradeable_init(uint32 _size) internal onlyInitializing {
    require(_size != 0, RootBuffer_InvalidSize());

    RootBufferStorage storage $ = _getRootBufferStorage();
    $.currentRootIndex = _size - 1;
    $.rootHistorySize = _size;
  }

  /*///////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IRootBuffer
  function rootHistorySize() public view returns (uint32 _size) {
    _size = _getRootBufferStorage().rootHistorySize;
  }

  /// @inheritdoc IRootBuffer
  function currentRootIndex() public view returns (uint32 _index) {
    _index = _getRootBufferStorage().currentRootIndex;
  }

  /// @inheritdoc IRootBuffer
  function roots(uint256 _index) public view returns (uint256 _root) {
    _root = _getRootBufferStorage().roots[_index];
  }

  /// @inheritdoc IRootBuffer
  function isKnownRoot(uint256 _root) public view returns (bool _isKnown) {
    if (_root == 0) return false;

    RootBufferStorage storage $ = _getRootBufferStorage();
    uint32 _size = $.rootHistorySize;
    uint32 _index = $.currentRootIndex;

    for (uint32 _i; _i < _size; ++_i) {
      if (_root == $.roots[_index]) {
        _isKnown = true;
        break;
      }
      _index = (_index + _size - 1) % _size;
    }
  }

  /*///////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
  //////////////////////////////////////////////////////////////*/

  /// @notice Stores a new root in the circular buffer
  /// @dev Advances currentRootIndex and overwrites the oldest root when buffer is full
  /// @param _newLatestRoot The new merkle root to store
  function _updateRoot(uint256 _newLatestRoot) internal {
    RootBufferStorage storage $ = _getRootBufferStorage();
    uint32 _nextIndex = ($.currentRootIndex + 1) % $.rootHistorySize;

    // Store the root at the next index
    $.roots[_nextIndex] = _newLatestRoot;

    // Update currentRootIndex to point to the latest root
    $.currentRootIndex = _nextIndex;
  }
}

