// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {PPRouter} from 'contracts/PPRouter.sol';
import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';

import {ProofLibV2} from 'libraries/ProofLibV2.sol';

import {MockAaveAToken, MockAaveMultiPool} from 'test/helpers/MockAaveMulti.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';
import {MockPPEntrypoint} from 'test/helpers/MockPPEntrypoint.sol';
import {MockPPPoolVault} from 'test/helpers/MockPPPoolVault.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

/// @title PPRouterBase
/// @notice Shared fixtures for the {PPRouter} + {PPRouterFactory} unit suites against a mock Aave
/// pool and a {MockPPEntrypoint} (no Groth16 — the monorepo integration tests cover real proofs).
/// Proves the exact-output wrap+shield math, the `maxUnderlyingIn` bound, the vetting-fee split, dust
/// handling, and the factory's wiring/guards in this repo, guarding the canonical source against drift
/// from the vendored monorepo copy. Split into three per-contract files (deposit, withdraw, factory) so
/// each maps one test contract to its own bulloak `.tree`.
contract PPRouterBase is Test {
  using ProofLibV2 for ProofLibV2.DepositProof;

  MockAaveMultiPool internal pool;
  MockERC20 internal usdc;
  MockAaveAToken internal aUSDC;
  PPYieldToken internal vault;
  MockPPEntrypoint internal entrypoint;
  PPYieldTokenZap internal zap;
  MockPPPoolVault internal poolVault;
  PPRouter internal router;

  address internal admin = makeAddr('admin');
  address internal alice = makeAddr('alice');
  address internal ppDust = makeAddr('ppDust');

  uint256 internal constant SHIELD_VALUE = 1e18; // 1 pp-share (18 dp; aUSDC offset 12)

  function setUp() public virtual {
    pool = new MockAaveMultiPool();
    usdc = new MockERC20('USD Coin', 'USDC', 6);
    aUSDC = pool.addReserve(IERC20Metadata(address(usdc)), 'Aave USDC', 'aUSDC');
    // Vault protocol fee = 0 so the only fee under test is the entrypoint vetting fee.
    vault = new PPYieldToken(IERC20(address(aUSDC)), 0, admin, 'Privacy Pool USDC', 'ppUSDC');
    entrypoint = new MockPPEntrypoint();
    zap = new PPYieldTokenZap(IPPYieldToken(address(vault)), IAavePool(address(pool)), IERC20(address(usdc)));
    poolVault = new MockPPPoolVault();
    _enableAsset(0);

    router = new PPRouter(
      IPPYieldToken(address(vault)),
      IAavePool(address(pool)),
      IERC20(address(usdc)),
      IEntrypoint(address(entrypoint)),
      ppDust,
      IPPYieldTokenZap(address(zap)),
      IPoolVault(address(poolVault)),
      false
    );

    _seed(100e18);
  }

  /// @dev Configure the vault asset on the entrypoint with `_vettingFeeBPS`.
  function _enableAsset(uint256 _vettingFeeBPS) internal {
    entrypoint.setAssetConfig(
      address(vault),
      IEntrypoint.AssetConfig({
        enabled: true, minAmount: 1, vettingFeeBPS: _vettingFeeBPS, maxRelayFee: type(uint256).max
      })
    );
  }

  /// @dev Seed the vault with `_ppAmount` shares so supply > 0 and the rate can move (fresh = 1:1).
  function _seed(uint256 _ppAmount) internal {
    uint256 _u = _ppAmount / 1e12;
    usdc.mint(address(this), _u);
    usdc.approve(address(pool), _u);
    pool.supply(address(usdc), _u, address(this), 0);
    aUSDC.approve(address(vault), _u);
    vault.deposit(_u, makeAddr('seedHolder'));
  }

  /// @dev Simulate Aave yield: mint `_extraUsdc` of aUSDC straight to the vault, lifting the rate.
  function _accrueYield(uint256 _extraUsdc) internal {
    usdc.mint(address(this), _extraUsdc);
    usdc.approve(address(pool), _extraUsdc);
    pool.supply(address(usdc), _extraUsdc, address(vault), 0);
  }

  /// @dev Build a deposit proof literal targeting `_asset` with committed `_value` (no Groth16 needed).
  function _proof(address _asset, uint256 _value) internal pure returns (ProofLibV2.DepositProof memory _p) {
    _p.pubSignals[1] = uint256(uint160(_asset));
    _p.pubSignals[2] = _value;
  }

  function _noteData() internal pure returns (IPoolVault.NoteData memory _n) {
    _n.hint = bytes32(uint256(1));
  }

  /// @dev Fund `alice` with `_amount` underlying and approve the router.
  function _fundAlice(uint256 _amount) internal {
    usdc.mint(alice, _amount);
    vm.prank(alice);
    usdc.approve(address(router), _amount);
  }

  /// @dev The transact proof's 2D public-signals row count: [nullifierHashes, outputCommitments,
  ///      stateRoot, keystoreRoot, aspRoot, amountOut, tokenIdOut, context] — mirrors ProofLibV2.
  uint256 internal constant TRANSACT_PUBSIGNAL_ROWS = 8;

  /// @dev Build a transact proof literal with `amountOut` (`pubSignals[5]`) and `tokenIdOut`
  ///      (`pubSignals[6]`) set; all other slots are single-element zeros, pA/pB/pC zero. No Groth16.
  function _transactProof(
    uint256 _amountOut,
    address _tokenIdOut
  ) internal pure returns (ProofLibV2.TransactProof memory _p) {
    _p.pubSignals = new uint256[][](TRANSACT_PUBSIGNAL_ROWS);
    for (uint256 _i = 0; _i < TRANSACT_PUBSIGNAL_ROWS; ++_i) {
      _p.pubSignals[_i] = new uint256[](1);
    }
    _p.pubSignals[5][0] = _amountOut;
    _p.pubSignals[6][0] = uint256(uint160(_tokenIdOut));
  }

  /// @dev Build transact params naming `_processor` and carrying an abi-encoded {PayoutRouting}.
  function _transactParams(
    address _processor,
    address _recipient,
    address _feeRecipient,
    uint256 _feeAmount,
    uint256 _nativeGas
  ) internal pure returns (IPoolVault.TransactParams memory _tp) {
    _tp.processor = _processor;
    _tp.data = abi.encode(
      IPrivacyPoolRelay.PayoutRouting({
        recipient: _recipient, feeRecipient: _feeRecipient, feeAmount: _feeAmount, nativeGas: _nativeGas
      })
    );
  }

  /// @dev Empty note-data array (the mock pool vault ignores it; no Groth16 here).
  function _emptyNotes() internal pure returns (IPoolVault.NoteData[] memory _n) {
    _n = new IPoolVault.NoteData[](0);
  }

  /// @dev Fund the mock pool vault with `_shares` pp-shares (representing custodied deposits) by
  ///      depositing fresh underlying into the vault and transferring the minted shares to it.
  function _fundPoolVault(uint256 _shares) internal {
    uint256 _aNeeded = vault.previewMint(_shares);
    usdc.mint(address(this), _aNeeded);
    usdc.approve(address(pool), _aNeeded);
    pool.supply(address(usdc), _aNeeded, address(this), 0);
    aUSDC.approve(address(vault), _aNeeded);
    vault.mint(_shares, address(this));
    IERC20(address(vault)).transfer(address(poolVault), _shares);
  }
}
