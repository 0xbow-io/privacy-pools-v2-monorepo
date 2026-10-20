// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';

/// @notice Harness that exposes ProofLibV2 internal functions via external wrappers.
///         Needed because some getters take `calldata` structs which cannot be
///         called from Solidity test contracts directly on `memory` values.
contract ProofLibV2Harness {
  using ProofLibV2 for ProofLibV2.DepositProof;
  using ProofLibV2 for ProofLibV2.TransactProof;
  using ProofLibV2 for ProofLibV2.RagequitProof;

  function depositTokenId(ProofLibV2.DepositProof memory _proof) external pure returns (address) {
    return _proof.tokenId();
  }

  function transactTokenIdOut(ProofLibV2.TransactProof calldata _proof) external pure returns (address) {
    return _proof.tokenIdOut();
  }

  function ragequitTokenId(ProofLibV2.RagequitProof calldata _proof) external pure returns (address) {
    return _proof.tokenId();
  }
}

contract UnitProofLibV2 is Test {
  ProofLibV2Harness internal _harness;

  function setUp() external {
    _harness = new ProofLibV2Harness();
  }

  /*///////////////////////////////////////////////////////////////
                    DEPOSIT — tokenId canonicalization
  //////////////////////////////////////////////////////////////*/

  function test_DepositTokenId_WhenCanonical(address _token) external view {
    ProofLibV2.DepositProof memory _proof;
    _proof.pubSignals[1] = uint256(uint160(_token));
    assertEq(_harness.depositTokenId(_proof), _token);
  }

  function test_DepositTokenId_WhenDirtyUpperBits(uint256 _raw) external {
    _raw = bound(_raw, uint256(1) << 160, type(uint256).max);
    ProofLibV2.DepositProof memory _proof;
    _proof.pubSignals[1] = _raw;
    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _raw));
    _harness.depositTokenId(_proof);
  }

  /*///////////////////////////////////////////////////////////////
                    TRANSACT — tokenIdOut canonicalization
  //////////////////////////////////////////////////////////////*/

  function _buildTransactProofWithTokenIdOut(uint256 _tokenIdOut)
    internal
    pure
    returns (ProofLibV2.TransactProof memory proof_)
  {
    proof_.pubSignals = new uint256[][](8);
    for (uint256 i; i < 8; ++i) {
      proof_.pubSignals[i] = new uint256[](1);
    }
    proof_.pubSignals[6][0] = _tokenIdOut;
  }

  function test_TransactTokenIdOut_WhenCanonical(address _token) external view {
    ProofLibV2.TransactProof memory _proof = _buildTransactProofWithTokenIdOut(uint256(uint160(_token)));
    assertEq(_harness.transactTokenIdOut(_proof), _token);
  }

  function test_TransactTokenIdOut_WhenDirtyUpperBits(uint256 _raw) external {
    _raw = bound(_raw, uint256(1) << 160, type(uint256).max);
    ProofLibV2.TransactProof memory _proof = _buildTransactProofWithTokenIdOut(_raw);
    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _raw));
    _harness.transactTokenIdOut(_proof);
  }

  /*///////////////////////////////////////////////////////////////
                    RAGEQUIT — tokenId canonicalization
  //////////////////////////////////////////////////////////////*/

  function test_RagequitTokenId_WhenCanonical(address _token) external view {
    ProofLibV2.RagequitProof memory _proof;
    _proof.pubSignals[5] = uint256(uint160(_token));
    assertEq(_harness.ragequitTokenId(_proof), _token);
  }

  function test_RagequitTokenId_WhenDirtyUpperBits(uint256 _raw) external {
    _raw = bound(_raw, uint256(1) << 160, type(uint256).max);
    ProofLibV2.RagequitProof memory _proof;
    _proof.pubSignals[5] = _raw;
    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _raw));
    _harness.ragequitTokenId(_proof);
  }
}
