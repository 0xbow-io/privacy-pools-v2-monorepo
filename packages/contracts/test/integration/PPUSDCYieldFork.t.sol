// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';

import {IntegrationBase, Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

import {DepositProofHelper} from './PPUSDCYieldMock.t.sol';
import {PPRouter} from 'contracts/PPRouter.sol';
import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';

/// @title PPUSDCYieldForkBase
/// @notice Full V2 privacy-pool integration for ppUSDC against the REAL Aave v3 mainnet market on a
/// pinned fork (fidelity counterpart to the mock-Aave suite). USDC is supplied to real Aave for real
/// aUSDC, wrapped to ppUSDC, shielded with a REAL deposit proof, and UNSHIELDED through the real
/// `PPRouter.withdrawToUnderlying` (the router is the transact processor on the unmodified PoolVault).
/// Yield is the genuine Aave interest accrued over a `vm.warp`, realized in USDC at unwrap.
/// @dev Requires `MAINNET_RPC` (IntegrationBase forks mainnet). NO EntryPoint/PoolVault change — the
/// router/zap sits on top, bound into the transact proof context as the processor + payout routing.
abstract contract PPUSDCYieldForkBase is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using UserIdentityLib for UserIdentityLib.UserIdentity;
  using ProofLibV2 for ProofLibV2.DepositProof;
  using TransactProofMemory for ProofLibV2.TransactProof;

  // Real Aave v3 mainnet addresses (exist at the pinned fork block)
  address internal constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
  address internal constant AAVE_V3_AUSDC = 0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c;

  PPYieldToken internal ppusdc;
  PPYieldTokenZap internal zap;
  PPRouter internal router;
  DepositProofHelper internal prover;

  address internal ppAdmin = makeAddr('ppAdmin');
  address internal dustRecipient = makeAddr('dustRecipient');
  address internal feeRecipient = makeAddr('feeRecipient');
  address internal usdcRecipient = makeAddr('usdcRecipient');

  uint256 internal constant PP_FEE = 1000; // 10% protocol fee on yield
  uint256 internal constant PRINCIPAL_USDC = 1000e6; // 1000 USDC of backing

  function setUp() public override {
    super.setUp();
    alice = _registerInKeystore(alice);
    bob = _registerInKeystore(bob);
    vm.warp(vm.getBlockTimestamp() + 1);

    // ppUSDC over the REAL Aave aUSDC, with the zap over the real Aave pool + real USDC
    ppusdc = new PPYieldToken(IERC20(AAVE_V3_AUSDC), PP_FEE, ppAdmin, 'Privacy Pool USDC', 'ppUSDC');
    zap = new PPYieldTokenZap(IPPYieldToken(address(ppusdc)), IAavePool(AAVE_V3_POOL), IERC20(_usdc));

    // Deploy the combined PPRouter BEFORE any proof is generated, so its address binds into the
    // transact `context` as the withdrawal processor.
    router = new PPRouter(
      IPPYieldToken(address(ppusdc)),
      IAavePool(AAVE_V3_POOL),
      IERC20(_usdc),
      _entrypoint,
      dustRecipient,
      IPPYieldTokenZap(address(zap)),
      _poolVault,
      false
    );
    prover = new DepositProofHelper();

    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      address(ppusdc),
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    );
  }

  /*///////////////////////////////////////////////////////////////
                            HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Fund `_to` with ppUSDC by zapping real USDC -> real Aave aUSDC -> ppUSDC. Returns the
  /// actual ppUSDC minted (depends on the live aToken index, so it is read back, not assumed).
  function _fundPPYieldToken(address _to, uint256 _usdcAmount) internal returns (uint256 _shares) {
    deal(_usdc, _to, _usdcAmount);
    vm.startPrank(_to);
    IERC20(_usdc).approve(address(zap), _usdcAmount);
    _shares = zap.depositUnderlying(_usdcAmount, _to);
    vm.stopPrank();
  }

  /// @dev Shield `_value` ppUSDC the depositor already holds, addressed to `_recipient` (genuine
  /// wrap funding, 0 vetting fee). Mirrors the mock suite's helper.
  function _shieldPPYieldToken(
    UserIdentityLib.UserIdentity storage _depositor,
    UserIdentityLib.UserIdentity storage _recipient,
    uint256 _value
  ) internal returns (Note memory note_) {
    (uint256 _noteSecret, uint256 _depositSecret) = _depositor.newSecrets();
    note_.value = _value;
    note_.noteSecret = _noteSecret;
    note_.depositSecret = _depositSecret;
    note_.noteAddressHash = PoseidonT3.hash([_recipient.ownerAddress, _noteSecret]);
    note_.tokenId = uint256(uint160(address(ppusdc)));

    note_.outputCommitment = _submitShield(_depositor.addr, _value, note_.noteAddressHash, _depositSecret);
    note_.depositLeaf = _commitmentLeaf(note_.outputCommitment);
    _stateTreeMirror.insert(note_.depositLeaf);
    note_.stateLeafIndex = _stateTreeMirror.size - 1;
    note_ = _registerInASP(note_, DEFAULT_NOTE_METADATA);
  }

  function _submitShield(
    address _depositor,
    uint256 _value,
    uint256 _noteAddressHash,
    uint256 _depositSecret
  ) private returns (uint256 _outputCommitment) {
    ProofLibV2.DepositProof memory _proof = prover.generate(
      address(ppusdc),
      _value,
      _noteAddressHash,
      _depositSecret,
      uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD
    );

    vm.startPrank(_depositor);
    IERC20(address(ppusdc)).approve(address(_entrypoint), _value);
    _entrypoint.deposit(_proof, _defaultNoteData, bytes(''));
    vm.stopPrank();

    _outputCommitment = _proof.outputCommitment();
  }

  /// @dev Shield `_value` ppUSDC addressed to `_recipient` by funding the deposit THROUGH the exact-share
  /// path: `PPRouter.depositExactShares` supplies USDC to REAL Aave, wraps to EXACTLY `_value + fee`
  /// pp-shares via `PPYieldTokenZap.buyFixedYieldToken`, and shields them. Returns the note, the underlying
  /// the router pulled, and the residual aToken dust left in the router (the ≤ buffer-wei round-trip loss).
  function _shieldViaRouterExactShares(
    UserIdentityLib.UserIdentity storage _depositor,
    UserIdentityLib.UserIdentity storage _recipient,
    uint256 _value
  ) internal returns (Note memory note_, uint256 _underlyingIn, uint256 _dust) {
    (uint256 _noteSecret, uint256 _depositSecret) = _depositor.newSecrets();
    note_.value = _value;
    note_.noteSecret = _noteSecret;
    note_.depositSecret = _depositSecret;
    note_.noteAddressHash = PoseidonT3.hash([_recipient.ownerAddress, _noteSecret]);
    note_.tokenId = uint256(uint160(address(ppusdc)));

    (note_.outputCommitment, _underlyingIn, _dust) =
      _submitShieldViaRouter(_depositor.addr, _value, note_.noteAddressHash, _depositSecret);
    note_.depositLeaf = _commitmentLeaf(note_.outputCommitment);
    _stateTreeMirror.insert(note_.depositLeaf);
    note_.stateLeafIndex = _stateTreeMirror.size - 1;
    note_ = _registerInASP(note_, DEFAULT_NOTE_METADATA);
  }

  /// @dev Build the deposit proof and drive it through `PPRouter.depositExactShares` (isolated frame to
  /// keep the large DepositProof struct off the caller's stack). Funds the depositor with exactly the
  /// quoted underlying, so the ≤ buffer-wei dust the router forwards is the genuine Aave index round-trip.
  function _submitShieldViaRouter(
    address _depositor,
    uint256 _value,
    uint256 _noteAddressHash,
    uint256 _depositSecret
  ) private returns (uint256 _outputCommitment, uint256 _underlyingIn, uint256 _dust) {
    ProofLibV2.DepositProof memory _proof = prover.generate(
      address(ppusdc),
      _value,
      _noteAddressHash,
      _depositSecret,
      uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD
    );

    (uint256 _need,) = router.quote(_value);
    deal(_usdc, _depositor, _need);
    uint256 _dustBefore = IERC20(AAVE_V3_AUSDC).balanceOf(address(router));

    vm.startPrank(_depositor);
    IERC20(_usdc).approve(address(router), _need);
    _underlyingIn = router.depositExactShares(_proof, _defaultNoteData, bytes(''), _need);
    vm.stopPrank();

    _dust = IERC20(AAVE_V3_AUSDC).balanceOf(address(router)) - _dustBefore;
    _outputCommitment = _proof.outputCommitment();
  }

  /// @dev Unshield `_note` (full withdrawal of `_amountOut` pp-shares) THROUGH the real
  /// `PPRouter.withdrawToUnderlying` — identical binding to the mock suite (router as processor, payout
  /// routing in the transact `data`, context bound to `keccak256(abi.encode(params, payload))`).
  function _unshieldViaRouter(
    Note memory _note,
    UserIdentityLib.UserIdentity storage _spender,
    uint256 _amountOut,
    address _recipient,
    address _feeRecipient,
    uint256 _feeShares,
    uint256 _minUnderlyingOut
  ) internal returns (uint256 _toRecipient, uint256 _toFee) {
    NoteCreationParams[] memory _outs = new NoteCreationParams[](1);
    _outs[0] = _spender.receiveNote(0, _note.inputLabel);

    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](1);
    bytes memory _data = abi.encode(
      IPrivacyPoolRelay.PayoutRouting({
        recipient: _recipient, feeRecipient: _feeRecipient, feeAmount: _feeShares, nativeGas: 0
      })
    );
    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({processor: address(router), data: _data});

    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;

    ProofLibV2.TransactProof memory _proof = _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _outs,
      _amountOut: _amountOut,
      _context: _hashTransactContext(_params, _payload)
    });

    uint256[] memory _nulls = _proof.nullifierHashes();
    uint256[] memory _outCommitments = _proof.outputCommitments();

    (_toRecipient, _toFee) = router.withdrawToUnderlying(_proof, _params, _payload, _minUnderlyingOut);

    _mirrorTransactLeaves(_outCommitments, _nulls);
    // Postconditions: the single input nullifier is spent and the single output commitment is recorded
    // at this block (this is a 1x1 spend), and the on-chain state root matches the mirrored tree.
    _assertProofWasSpent(_proof, vm.getBlockTimestamp());
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()),
      _stateTreeMirror.root(),
      'State root mismatch after router withdraw'
    );
  }

  /// @dev Partial in-pool transfer (1->2): spend `_note` owned by `_from`, creating a `_toAmt` note
  /// for `_to` and a change note back to `_from` (same label lineage, no withdrawal).
  function _splitTransfer(
    Note memory _note,
    UserIdentityLib.UserIdentity storage _from,
    UserIdentityLib.UserIdentity storage _to,
    uint256 _toAmt
  ) internal returns (Note memory _toNote, Note memory _changeNote) {
    NoteCreationParams[] memory _outs = new NoteCreationParams[](2);
    _outs[0] = _to.receiveNote(_toAmt, _note.inputLabel);
    _outs[1] = _from.receiveNote(_note.value - _toAmt, _note.inputLabel);
    Note[] memory _ins = new Note[](1);
    _ins[0] = _note;
    (Note[] memory _newNotes,) = _transact(_ins, _from, _outs, 0);
    (_toNote, _changeNote) = (_newNotes[0], _newNotes[1]);
  }
}

/// @notice Against real Aave: ppUSDC shields, then unshields through the real `PPRouter`, delivering
/// the principal USDC (no yield window) to the recipient — proving the router/zap path works against
/// the live Aave market, not just the mock.
contract PPUSDCForkRouterWithdrawConservationIntegration is PPUSDCYieldForkBase {
  function test_fork_shieldUnshieldViaRouter_deliversUSDC() external {
    uint256 _shieldAmt = _fundPPYieldToken(alice.addr, PRINCIPAL_USDC);
    assertGt(_shieldAmt, 0, 'alice wrapped real aUSDC into ppUSDC');

    Note memory _note = _shieldPPYieldToken(alice, alice, _shieldAmt);
    assertEq(ppusdc.balanceOf(address(_poolVault)), _shieldAmt, 'pool custodies the shielded ppUSDC');

    vm.warp(vm.getBlockTimestamp() + 30 days);

    uint256 _expectedUSDC = ppusdc.previewRedeem(_shieldAmt);
    (uint256 _toRecipient, uint256 _toFee) = _unshieldViaRouter({
      _note: _note,
      _spender: alice,
      _amountOut: _shieldAmt,
      _recipient: usdcRecipient,
      _feeRecipient: feeRecipient,
      _feeShares: 0,
      _minUnderlyingOut: _expectedUSDC
    });

    assertEq(ppusdc.balanceOf(address(_poolVault)), 0, 'pool fully drained');
    assertEq(_toFee, 0, 'no fee leg');
    assertApproxEqAbs(_toRecipient, _expectedUSDC, 2, 'router delivered ~previewRedeem USDC');
    assertEq(IERC20(_usdc).balanceOf(usdcRecipient), _toRecipient, 'recipient holds the unwrapped USDC');
    assertEq(ppusdc.balanceOf(address(router)), 0, 'router holds no residual pp-shares');
  }
}

/// @notice Against real Aave: a partial in-pool transfer whose recipient's position grows with real
/// Aave interest, then bob unshields through the real `PPRouter` and realizes MORE USDC (principal +
/// accrued yield) than an immediate withdrawal — delivered atomically, with the fee leg in USDC.
contract PPUSDCForkRouterWithdrawYieldIntegration is PPUSDCYieldForkBase {
  function test_fork_routerWithdraw_deliversPrincipalPlusYield_andFee() external {
    // 1) alice deposits (real USDC -> real aUSDC -> ppUSDC -> shield)
    uint256 _shieldAmt = _fundPPYieldToken(alice.addr, PRINCIPAL_USDC);
    Note memory _aliceNote = _shieldPPYieldToken(alice, alice, _shieldAmt);

    // 2) alice sends bob *some* (40%) inside the pool, keeping change (1->2 transact)
    uint256 _bobAmt = (_shieldAmt * 2) / 5;
    uint256 _changeAmt = _shieldAmt - _bobAmt;
    (Note memory _bobNote,) = _splitTransfer(_aliceNote, alice, bob, _bobAmt);
    assertEq(ppusdc.balanceOf(address(_poolVault)), _shieldAmt, 'in-pool transfer keeps the pool balance');

    // 3a) if bob unshielded NOW, his ppUSDC is worth X USDC
    uint256 _xNow = ppusdc.previewRedeem(_bobAmt);

    // 3b) bob waits a year: real Aave interest accrues, so the same ppUSDC is worth more
    vm.warp(vm.getBlockTimestamp() + 365 days);
    uint256 _yLater = ppusdc.previewRedeem(_bobAmt);
    assertGt(_yLater, _xNow, 'real Aave yield: bob is worth more by waiting');

    // 4) bob unshields through the real router, with a relay fee of 10% of the shares.
    uint256 _feeShares = _bobAmt / 10;
    uint256 _recipientShares = _bobAmt - _feeShares;
    uint256 _expectedRecipientUSDC = ppusdc.previewRedeem(_recipientShares);
    uint256 _expectedFeeUSDC = ppusdc.previewRedeem(_feeShares);

    (uint256 _toRecipient, uint256 _toFee) = _unshieldViaRouter({
      _note: _bobNote,
      _spender: bob,
      _amountOut: _bobAmt,
      _recipient: usdcRecipient,
      _feeRecipient: feeRecipient,
      _feeShares: _feeShares,
      _minUnderlyingOut: _expectedRecipientUSDC
    });

    // KEY PROPERTY: the recipient + fee realized MORE USDC than an immediate (no-yield) withdrawal.
    assertGt(_toRecipient + _toFee, _xNow, 'router delivered principal + real Aave yield (> immediate)');
    assertApproxEqAbs(_toRecipient, _expectedRecipientUSDC, 10, 'recipient USDC == previewRedeem(recipientShares)');
    assertApproxEqAbs(_toFee, _expectedFeeUSDC, 10, 'fee recipient USDC == previewRedeem(feeShares)');
    assertEq(IERC20(_usdc).balanceOf(usdcRecipient), _toRecipient, 'recipient holds the unwrapped USDC');
    assertEq(IERC20(_usdc).balanceOf(feeRecipient), _toFee, 'fee recipient holds the unwrapped fee USDC');
    assertGt(_toFee, 0, 'fee leg delivered in USDC');

    assertEq(ppusdc.balanceOf(address(_poolVault)), _changeAmt, 'alice change remains shielded in the pool');
    assertEq(ppusdc.balanceOf(address(router)), 0, 'router holds no residual pp-shares');
  }
}

/// @notice Against REAL Aave: fund a deposit through the exact-share DEPOSIT-IN path
/// (`PPRouter.depositExactShares` -> `PPYieldTokenZap.buyFixedYieldToken` -> exact `VAULT.mint` -> shield)
/// after the aToken index has moved via `vm.warp`, proving the ≤2-wei `_SUPPLY_ROUNDING_BUFFER` absorbs
/// the genuine ray-scaled index round-trip (`supply(x)` credits `x` or `x-1`) — the fidelity the 1:1
/// mock cannot give (closes gaps Y1+Y2). The exact-output mint is dust-free at the pool.
contract PPUSDCForkDepositExactSharesIntegration is PPUSDCYieldForkBase {
  function test_fork_depositExactShares_realIndexRoundTrip_exactShares() external {
    // Seed the vault with real aUSDC backing, then advance time so REAL Aave interest moves the aToken
    // index (and the vault's share:asset ratio), making `previewMint` a genuine ray-scaled round-trip.
    uint256 _seed = _fundPPYieldToken(alice.addr, PRINCIPAL_USDC);
    _shieldPPYieldToken(alice, alice, _seed);
    vm.warp(vm.getBlockTimestamp() + 30 days);

    uint256 _value = 250e18; // exact ppUSDC shares (18dp) to shield through the exact-output path
    (uint256 _need, uint256 _total) = router.quote(_value);
    assertEq(_total, _value, 'zero vetting fee -> total pp-shares == committed value');

    uint256 _poolBefore = ppusdc.balanceOf(address(_poolVault));
    (Note memory _note, uint256 _underlyingIn, uint256 _dust) = _shieldViaRouterExactShares(bob, bob, _value);

    // EXACT-output mint: the pool custodies EXACTLY `_value` more ppUSDC (no share dust, no shortfall) —
    // the mock's 1:1 pool can produce this trivially, but here it holds against the real ray-scaled index.
    assertEq(ppusdc.balanceOf(address(_poolVault)) - _poolBefore, _value, 'exact shares shielded');
    assertEq(_underlyingIn, _need, 'router pulled exactly the quoted underlying (previewMint + buffer)');
    // The ≤2-wei buffer absorbed the real Aave index round-trip: `buyFixedYieldToken` did NOT revert
    // `PPYieldTokenZap_InsufficientWrap`, and the residual aToken dust forwarded to the router is ≤ buffer.
    assertLe(_dust, 2, 'aToken dust within _SUPPLY_ROUNDING_BUFFER (2)');
    assertEq(ppusdc.balanceOf(address(router)), 0, 'router holds no residual pp-shares');

    // The shielded note is real and spendable: unshield it back to USDC through the router (round-trip).
    uint256 _expectedUSDC = ppusdc.previewRedeem(_value);
    (uint256 _toRecipient,) = _unshieldViaRouter({
      _note: _note,
      _spender: bob,
      _amountOut: _value,
      _recipient: usdcRecipient,
      _feeRecipient: feeRecipient,
      _feeShares: 0,
      _minUnderlyingOut: _expectedUSDC
    });
    assertApproxEqAbs(_toRecipient, _expectedUSDC, 2, 'exact-share note round-trips to ~previewRedeem USDC');
  }
}

/// @notice Against REAL Aave: `PPYieldToken.claimFees()` carves the protocol fee from a full year of
/// genuine Aave interest accrued on the vault's aUSDC, transfers EXACTLY the carved fee to the recipient,
/// and leaves depositor-facing `totalAssets` invariant (the fee was already excluded) — the real-yield
/// counterpart to the mock-Aave fee test (closes gap Y4).
contract PPUSDCForkClaimFeesIntegration is PPUSDCYieldForkBase {
  function test_fork_claimFees_onRealAaveYield_carvesFee_preservesDepositorAssets() external {
    // Fund real aUSDC backing into the vault (no shield needed — the vault custodies the aToken directly).
    _fundPPYieldToken(alice.addr, PRINCIPAL_USDC);
    assertEq(ppusdc.claimableFees(), 0, 'no yield yet -> no claimable fee');

    // A year of REAL Aave interest accrues on the vault's aUSDC.
    vm.warp(vm.getBlockTimestamp() + 365 days);

    uint256 _claimable = ppusdc.claimableFees();
    assertGt(_claimable, 0, 'real Aave yield accrued a protocol fee');

    uint256 _assetsBefore = ppusdc.totalAssets();
    uint256 _feeRecipBefore = IERC20(AAVE_V3_AUSDC).balanceOf(feeRecipient);

    // Only the admin (owner) can claim; claim to the fee recipient.
    vm.prank(ppAdmin);
    uint256 _claimed = ppusdc.claimFees(feeRecipient);

    assertEq(_claimed, _claimable, 'claimed exactly the carved fee');
    assertApproxEqAbs(
      IERC20(AAVE_V3_AUSDC).balanceOf(feeRecipient) - _feeRecipBefore,
      _claimed,
      2,
      'fee recipient received the carved aUSDC'
    );
    // Depositor-facing assets are unchanged by the claim — the fee was already excluded from totalAssets.
    assertApproxEqAbs(ppusdc.totalAssets(), _assetsBefore, 2, 'claim leaves depositor assets invariant');
    assertEq(ppusdc.claimableFees(), 0, 'claimable fee reset to zero after claim');
  }
}
