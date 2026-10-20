// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';

import {PoolVault} from 'contracts/PoolVault.sol';
import {IGroth16Verifier} from 'interfaces/IGroth16Verifier.sol';
import {LeanIMT, LeanIMTData} from 'lean-imt/LeanIMT.sol';

/// @notice Harness contract to expose internal functions for testing
contract PoolVaultHarness is PoolVault {
  using LeanIMT for LeanIMTData;

  struct VerifyProofCall {
    IGroth16Verifier.Proof proof;
    uint256 stateRoot;
    uint256 keystoreRoot;
    uint256 aspRoot;
    uint256 amountOut;
    uint256 tokenId;
    uint256 context;
    uint256[] nullifiersSpent;
    uint256[] commitmentsCreated;
  }

  uint256[] public insertInTreeSpies;
  uint256[] public mockedRoots;
  uint256[] public mockedIndices;

  /// @notice Mocked commitments for ragequit tests
  mapping(uint256 _commitment => bool _exists) private _mockedCommitments;

  /// @notice Spy data for verifyProof calls
  VerifyProofCall[] private _verifyProofCalls;
  bool public mockedTransactVerifyResult;

  constructor(IAccessControl _mockAccessRouter) PoolVault(_mockAccessRouter) {}

  function mockRootInsertion(uint256 _newRoot) external {
    mockedRoots.push(_newRoot);
  }

  function mockInsertionIndex(uint256 _newIndex) external {
    mockedIndices.push(_newIndex);
  }

  /// @notice Mock a commitment as existing in state tree (for ragequit tests)
  function mockCommitmentInsertion(uint256 _commitment) external {
    _mockedCommitments[_commitment] = true;
  }

  function _commitmentExists(uint256 _commitment) internal view override returns (bool) {
    return _mockedCommitments[_commitment];
  }

  /// @notice Exposes _updateRoot for transact tests
  function exposed_updateRoot(uint256 _root) external {
    _updateRoot(_root);
  }

  /// @notice Exposes the state tree root for transact tests assertions
  function exposed_root() external view returns (uint256) {
    return _getPoolVaultStorage().stateTree.root();
  }

  function mockTransactVerifyResult(bool _result) external {
    mockedTransactVerifyResult = _result;
  }

  function verifyProofCalls(uint256 _index) external view returns (VerifyProofCall memory) {
    return _verifyProofCalls[_index];
  }

  function _verifyProof(
    IGroth16Verifier.Proof memory _proof,
    uint256 _stateRoot,
    uint256 _keystoreRoot,
    uint256 _aspRoot,
    uint256 _amountOut,
    uint256 _tokenId,
    uint256 _context,
    uint256[] memory _nullifiersSpent,
    uint256[] memory _commitmentsCreated
  ) internal override returns (bool valid_) {
    _verifyProofCalls.push(
      VerifyProofCall(
        _proof,
        _stateRoot,
        _keystoreRoot,
        _aspRoot,
        _amountOut,
        _tokenId,
        _context,
        _nullifiersSpent,
        _commitmentsCreated
      )
    );
    return mockedTransactVerifyResult;
  }

  function _insertInStateTree(uint256 _newLeaf) internal override returns (uint256 _newRoot, uint256 _index) {
    insertInTreeSpies.push(_newLeaf);
    _newRoot = mockedRoots[mockedRoots.length - 1];
    _index = mockedIndices[mockedIndices.length - 1];
  }

  function _insertInStateTree(uint256[] memory _newLeaves)
    internal
    override
    returns (uint256 _newRoot, uint256 _startIndex)
  {
    _startIndex = insertInTreeSpies.length;
    for (uint256 i; i < _newLeaves.length; ++i) {
      insertInTreeSpies.push(_newLeaves[i]);
    }
    _newRoot = mockedRoots[mockedRoots.length - 1];
  }

  /// @notice Writes `stateTree.size` directly so tests can simulate a near-capacity tree
  ///         without performing `maxStateTreeSize` real insertions.
  function exposed_setStateTreeSize(uint256 _size) external {
    _getPoolVaultStorage().stateTree.size = _size;
  }
}
