// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title IRootBuffer
/// @notice Interface for contracts extending the RootBufferUpgradeable abstract contract
/// @dev Manages a circular buffer of merkle roots with configurable history size
interface IRootBuffer {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  //////////////////////////////////////////////////////////////*/

  /// @notice ERC-7201 namespaced storage for RootBuffer
  /// @param rootHistorySize Maximum number of roots stored in the buffer
  /// @param currentRootIndex Index of the most recently stored root
  /// @param roots Mapping from index to stored merkle root
  /// @custom:storage-location erc7201:privacypools.storage.RootBuffer
  struct RootBufferStorage {
    uint32 rootHistorySize;
    uint32 currentRootIndex;
    mapping(uint256 index => uint256 root) roots;
  }

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /// @notice Thrown when attempting to initialize with a zero history size
  error RootBuffer_InvalidSize();

  /*///////////////////////////////////////////////////////////////
                              VARIABLES
  //////////////////////////////////////////////////////////////*/

  /// @notice Returns the maximum number of roots stored in the buffer
  /// @return _size The size of the root history buffer
  function rootHistorySize() external view returns (uint32 _size);

  /// @notice Returns the index of the most recently stored root
  /// @return _index The current root index in the circular buffer
  function currentRootIndex() external view returns (uint32 _index);

  /// @notice Returns the root stored at a specific index
  /// @param _index The index in the circular buffer
  /// @return _root The merkle root stored at that index
  function roots(uint256 _index) external view returns (uint256 _root);

  /*///////////////////////////////////////////////////////////////
                              LOGIC
  //////////////////////////////////////////////////////////////*/

  /// @notice Checks if a given root exists in the history buffer
  /// @dev Returns false for zero roots. Iterates through the circular buffer
  ///      starting from the most recent root and going backwards
  /// @param _root The merkle root to check
  /// @return _isKnown True if the root exists in the buffer, false otherwise
  function isKnownRoot(uint256 _root) external view returns (bool _isKnown);
}
