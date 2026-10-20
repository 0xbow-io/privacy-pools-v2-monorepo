// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import {Test} from 'forge-std/Test.sol';
import {IRootBuffer} from 'interfaces/IRootBuffer.sol';
import {RootBufferHarness} from 'test/unit/helpers/RootBufferHarness.sol';

contract UnitRootBufferUpgradeable is Test {
  RootBufferHarness internal rootBuffer;

  uint32 internal constant MAX_SIZE = 10_000;

  function setUp() external {
    rootBuffer = new RootBufferHarness();
  }

  /*///////////////////////////////////////////////////////////////
                  __RootBufferUpgradeable_init
  //////////////////////////////////////////////////////////////*/

  function test___RootBufferUpgradeable_init_WhenAlreadyInitialized(uint32 _size) external {
    _size = uint32(bound(_size, 1, type(uint32).max));

    rootBuffer.initialize(_size);

    // It should revert with InvalidInitialization
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    rootBuffer.initialize(_size);
  }

  function test___RootBufferUpgradeable_init_WhenSizeIsZero() external {
    // It should revert with RootBuffer_InvalidSize
    vm.expectRevert(IRootBuffer.RootBuffer_InvalidSize.selector);
    rootBuffer.initialize(0);
  }

  function test___RootBufferUpgradeable_init_WhenSizeIsGreaterThanZero(uint32 _size) external {
    _size = uint32(bound(_size, 1, type(uint32).max));

    rootBuffer.initialize(_size);

    // It should set rootHistorySize to size
    assertEq(rootBuffer.rootHistorySize(), _size);

    // It should set currentRootIndex to last possible position
    assertEq(rootBuffer.currentRootIndex(), _size - 1);
  }

  /*///////////////////////////////////////////////////////////////
                          isKnownRoot
  //////////////////////////////////////////////////////////////*/

  function test_IsKnownRoot_WhenRootIsZero(uint32 _size) external {
    _size = uint32(bound(_size, 1, MAX_SIZE));
    rootBuffer.initialize(_size);

    // It should return false
    assertFalse(rootBuffer.isKnownRoot(0));
  }

  modifier whenRootIsNotZero(uint256 _root) {
    vm.assume(_root != 0);
    _;
  }

  function test_IsKnownRoot_GivenBufferIsEmpty(uint32 _size, uint256 _root) external whenRootIsNotZero(_root) {
    _size = uint32(bound(_size, 1, MAX_SIZE));
    rootBuffer.initialize(_size);

    // It should return false (buffer is empty, no roots stored)
    assertFalse(rootBuffer.isKnownRoot(_root));
  }

  function test_IsKnownRoot_GivenRootDoesNotExistInBuffer(
    uint32 _size,
    uint256 _storedRoot,
    uint256 _searchRoot,
    uint32 _index
  ) external whenRootIsNotZero(_storedRoot) whenRootIsNotZero(_searchRoot) {
    _size = uint32(bound(_size, 1, MAX_SIZE));
    _index = uint32(bound(_index, 0, _size - 1));

    // Ensure we're searching for a different root
    vm.assume(_searchRoot != _storedRoot);

    rootBuffer.initialize(_size);

    // Set root directly via harness
    rootBuffer.setRoot(_index, _storedRoot);
    rootBuffer.setCurrentRootIndex(_index);

    // It should return false
    assertFalse(rootBuffer.isKnownRoot(_searchRoot));
  }

  function test_IsKnownRoot_GivenRootIsAtCurrentIndex(
    uint32 _size,
    uint32 _currentIndex,
    uint256 _root
  ) external whenRootIsNotZero(_root) {
    _size = uint32(bound(_size, 1, MAX_SIZE));
    _currentIndex = uint32(bound(_currentIndex, 0, _size - 1));

    rootBuffer.initialize(_size);
    rootBuffer.setRoot(_currentIndex, _root);
    rootBuffer.setCurrentRootIndex(_currentIndex);

    // It should return true
    assertTrue(rootBuffer.isKnownRoot(_root));
  }

  function test_IsKnownRoot_GivenRootIsAtAnEarlierIndex(
    uint32 _size,
    uint32 _rootIndex,
    uint32 _currentIndex,
    uint256 _root
  ) external whenRootIsNotZero(_root) {
    _size = uint32(bound(_size, 2, MAX_SIZE));
    _currentIndex = uint32(bound(_currentIndex, 1, _size - 1));
    _rootIndex = uint32(bound(_rootIndex, 0, _currentIndex - 1));

    rootBuffer.initialize(_size);
    rootBuffer.setRoot(_rootIndex, _root);
    rootBuffer.setCurrentRootIndex(_currentIndex);

    // It should return true
    assertTrue(rootBuffer.isKnownRoot(_root));
  }

  function test_IsKnownRoot_GivenRootIsAtOldestIndex(
    uint32 _size,
    uint32 _currentIndex,
    uint256 _root
  ) external whenRootIsNotZero(_root) {
    _size = uint32(bound(_size, 2, MAX_SIZE));
    _currentIndex = uint32(bound(_currentIndex, 0, _size - 1));

    rootBuffer.initialize(_size);

    // Oldest index is (currentIndex + 1) % size
    // it's searched last and overwritten next
    uint32 oldestIndex = (_currentIndex + 1) % _size;
    // Set root directly via harness
    rootBuffer.setRoot(oldestIndex, _root);
    rootBuffer.setCurrentRootIndex(_currentIndex);

    // It should return true
    assertTrue(rootBuffer.isKnownRoot(_root));
  }

  /*///////////////////////////////////////////////////////////////
                          _updateRoot
  //////////////////////////////////////////////////////////////*/

  function test__updateRoot_GivenBufferHasSpace(uint32 _size, uint256 _root, uint32 _startIndex) external {
    _size = uint32(bound(_size, 2, MAX_SIZE)); // min 2 so we can have space
    _root = bound(_root, 1, type(uint256).max);
    _startIndex = uint32(bound(_startIndex, 0, _size - 2)); // not at last position = has space

    // Set up state via harness
    rootBuffer.setRootHistorySize(_size);
    rootBuffer.setCurrentRootIndex(_startIndex);

    rootBuffer.updateRoot(_root);

    // It should store root at next index
    uint32 expectedIndex = _startIndex + 1;
    assertEq(rootBuffer.roots(expectedIndex), _root);

    // It should increment currentRootIndex
    assertEq(rootBuffer.currentRootIndex(), expectedIndex);
  }

  function test__updateRoot_GivenCurrentRootIndexIsAtLastPosition(uint32 _size, uint256 _root) external {
    _size = uint32(bound(_size, 1, MAX_SIZE));
    _root = bound(_root, 1, type(uint256).max);

    // Set up state via harness: currentRootIndex at last position
    rootBuffer.setRootHistorySize(_size);
    rootBuffer.setCurrentRootIndex(_size - 1);

    rootBuffer.updateRoot(_root);

    // It should wrap currentRootIndex to zero
    assertEq(rootBuffer.currentRootIndex(), 0);

    // It should overwrite oldest root (index 0)
    assertEq(rootBuffer.roots(0), _root);
  }
}
