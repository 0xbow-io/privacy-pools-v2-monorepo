// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title MockPPEntrypoint
/// @notice Minimal privacy-pool entrypoint stand-in for unit-testing {PPRouter} without the full
/// `v2-monorepo`. It does NOT verify the Groth16 proof (there is no verifier here): it trusts the
/// proof's public signals, charges the configured vetting fee, and pulls `value + fee` of the asset
/// from the caller — exactly the custody behaviour the router must satisfy. Real proof verification is
/// covered by the monorepo integration tests against the real Entrypoint.
contract MockPPEntrypoint {
  using ProofLibV2 for ProofLibV2.DepositProof;

  error MockPPEntrypoint_AssetNotEnabled();
  error MockPPEntrypoint_BelowMinAmount();

  mapping(address _asset => IEntrypoint.AssetConfig _config) internal _configs;

  /// @notice Cumulative value shielded per asset (held by this contract, like the real PoolVault)
  mapping(address _asset => uint256 _value) public shielded;

  /// @notice Cumulative vetting fee retained per asset (held by this contract, like the real Entrypoint)
  mapping(address _asset => uint256 _fee) public feeCollected;

  /// @notice Test helper: set an asset's deposit config
  function setAssetConfig(address _asset, IEntrypoint.AssetConfig calldata _config) external {
    _configs[_asset] = _config;
  }

  function assets(address _asset) external view returns (IEntrypoint.AssetConfig memory _config) {
    _config = _configs[_asset];
  }

  function deposit(
    ProofLibV2.DepositProof calldata _proof,
    IPoolVault.NoteData calldata,
    bytes calldata
  ) external payable {
    address _asset = _proof.tokenId();
    uint256 _value = _proof.value();
    IEntrypoint.AssetConfig memory _config = _configs[_asset];
    require(_config.enabled, MockPPEntrypoint_AssetNotEnabled());
    require(_value >= _config.minAmount, MockPPEntrypoint_BelowMinAmount());

    uint256 _fee = (_value * _config.vettingFeeBPS) / 10_000;
    IERC20(_asset).transferFrom(msg.sender, address(this), _value + _fee);
    shielded[_asset] += _value;
    feeCollected[_asset] += _fee;
  }
}
