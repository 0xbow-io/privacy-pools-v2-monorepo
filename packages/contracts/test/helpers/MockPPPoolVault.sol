// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IPoolVault} from 'interfaces/IPoolVault.sol';

import {ProofLibV2} from 'libraries/ProofLibV2.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

/// @title MockPPPoolVault
/// @notice Minimal privacy-pool V2 PoolVault stand-in for unit-testing {PPRouter}'s withdraw path
/// without the full `v2-monorepo`. It does NOT verify the Groth16 proof (there is no verifier here):
/// it trusts the proof's public signals and simulates the only behaviour the router depends on — on
/// `transact`, the vault pays `amountOut` of `tokenIdOut` to the processor (`msg.sender`, the router).
/// It must be pre-funded with custodied pp-shares in test setUp (as a real PoolVault holds the shares
/// it shields). Real proof verification is covered by the monorepo integration tests against the real
/// PoolVault.
contract MockPPPoolVault {
  using SafeERC20 for IERC20;
  using ProofLibV2 for ProofLibV2.TransactProof;

  /// @notice When non-zero, the vault pays THIS amount to the processor instead of the proof's
  /// `amountOut`, to exercise the router's defensive `PPRouter_SharesNotReceived` branch. Zero (the
  /// default) keeps the vault honest: it pays exactly `amountOut`.
  uint256 public payActualOverride;

  /// @notice Test helper: force the next `transact` to pay `_amount` instead of the proof's `amountOut`.
  function setPayActualOverride(uint256 _amount) external {
    payActualOverride = _amount;
  }

  function transact(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata,
    IPoolVault.NoteData[] calldata
  ) external {
    // The real vault pays `amountOut` of `tokenIdOut` to the processor (`msg.sender`). The override
    // lets a test pay a deliberately wrong amount to hit the router's defensive balance check.
    uint256 _amount = payActualOverride != 0 ? payActualOverride : _proof.amountOut();
    IERC20(_proof.tokenIdOut()).safeTransfer(msg.sender, _amount);
  }
}
