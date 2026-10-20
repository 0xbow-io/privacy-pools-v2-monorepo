// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';

import {IntegrationBase, Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

import {MockAavePool, MockRebasingAToken} from './helpers/ppusdc/MockAavePool.sol';
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

/// @notice Thin external wrapper so deposit-proof generation is delegated by `call` rather than
/// inlined into the test contract. IntegrationBase already inlines one copy of
/// `generateDepositProof` (via `_submitDeposit`); inlining a second copy alongside the transact
/// path tips `MerkleTree.generateProof` 1-slot over the via-IR stack limit. Keeping it external
/// avoids the duplicate inline. FFI works from any contract (the cheatcode address is global).
contract DepositProofHelper {
  function generate(
    address _token,
    uint256 _value,
    uint256 _noteAddressHash,
    uint256 _depositSecret,
    uint256 _context
  ) external returns (ProofLibV2.DepositProof memory) {
    return ProofGenerator.generateDepositProof(_token, _value, _noteAddressHash, _depositSecret, _context);
  }
}

/// @title PPUSDCYieldMockBase
/// @notice Full V2 privacy-pool integration for ppUSDC against a MOCK Aave (deterministic yield),
/// with the WITHDRAW side realized through the combined `PPRouter.withdrawToUnderlying` — the real
/// router is the transact `processor`, so the unmodified PoolVault pays it the withdrawn pp-shares,
/// which it unwraps to USDC for the recipient (and the relay fee to the fee recipient) atomically.
/// Deploys the real Entrypoint/PoolVault/Keystore/ASP (via IntegrationBase on a pinned mainnet fork),
/// registers ppUSDC as a pool asset, and shields/unshields it through REAL Groth16 proofs.
/// @dev ppUSDC is non-rebasing, so it is a valid pool asset (the vault rejects rebasing tokens). The
/// Aave leg is a mock here for determinism; the sibling fork test exercises real Aave. NO change to
/// EntryPoint/PoolVault: the router/zap sits on top, bound into the proof context as the processor.
abstract contract PPUSDCYieldMockBase is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using UserIdentityLib for UserIdentityLib.UserIdentity;
  using ProofLibV2 for ProofLibV2.DepositProof;
  using TransactProofMemory for ProofLibV2.TransactProof;

  MockERC20 internal mockUSDC;
  MockAavePool internal aavePool;
  MockRebasingAToken internal aUSDC;
  PPYieldToken internal ppusdc;
  PPYieldTokenZap internal zap;
  PPRouter internal router;
  DepositProofHelper internal prover;

  address internal ppAdmin = makeAddr('ppAdmin');
  address internal borrower = makeAddr('aaveBorrower');
  address internal dustRecipient = makeAddr('dustRecipient');
  address internal feeRecipient = makeAddr('feeRecipient');
  address internal usdcRecipient = makeAddr('usdcRecipient');

  uint256 internal constant PP_FEE = 1000; // 10% protocol fee on yield
  uint256 internal constant PP_BPS = 10_000;
  uint256 internal constant SHIELD_VALUE = 1e18; // 1 ppUSDC (18 dp)
  uint256 internal constant PRINCIPAL_USDC = 1e6; // backing for 1 ppUSDC (aUSDC is 6 dp; offset 12)
  uint256 internal constant RATE_10PCT = 0.1e27; // Aave borrow rate (ray)

  function setUp() public override {
    super.setUp();
    alice = _registerInKeystore(alice);
    bob = _registerInKeystore(bob);
    vm.warp(vm.getBlockTimestamp() + 1);

    // Deploy the mock-Aave-backed ppUSDC stack
    mockUSDC = new MockERC20('Mock USDC', 'USDC', 6);
    aavePool = new MockAavePool(IERC20(address(mockUSDC)), 'Aave USDC', 'aUSDC', 6);
    aUSDC = aavePool.A_TOKEN();
    ppusdc = new PPYieldToken(IERC20(address(aUSDC)), PP_FEE, ppAdmin, 'Privacy Pool USDC', 'ppUSDC');
    zap = new PPYieldTokenZap(IPPYieldToken(address(ppusdc)), IAavePool(address(aavePool)), IERC20(address(mockUSDC)));

    // Deploy the combined PPRouter BEFORE any proof is generated, so its address can be bound into the
    // transact `context` as the withdrawal processor. NO EntryPoint/PoolVault change — the router is a
    // processor on top of the unmodified vault.
    router = new PPRouter(
      IPPYieldToken(address(ppusdc)),
      IAavePool(address(aavePool)),
      IERC20(address(mockUSDC)),
      _entrypoint,
      dustRecipient,
      IPPYieldTokenZap(address(zap)),
      _poolVault,
      false
    );
    prover = new DepositProofHelper();

    // Register ppUSDC as a pool asset (0 vetting fee for clean 1:1 accounting in the test)
    vm.prank(_config.entrypointManager);
    _entrypoint.setAssetConfiguration(
      address(ppusdc),
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    );
  }

  /*///////////////////////////////////////////////////////////////
                            HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Fund `_to` with exactly `_ppAmount` ppUSDC by genuinely zapping USDC -> aUSDC -> ppUSDC
  /// (so the vault holds real backing and a later unwrap/redeem is consistent). First deposit into a
  /// fresh vault mints `assets * 10**offset` shares with no fee, so `_usdc * 1e12 == _ppAmount`.
  function _fundPPYieldToken(address _to, uint256 _ppAmount) internal returns (uint256 _shares) {
    uint256 _usdc = _ppAmount / 1e12;
    mockUSDC.mint(_to, _usdc);
    vm.startPrank(_to);
    mockUSDC.approve(address(zap), _usdc);
    _shares = zap.depositUnderlying(_usdc, _to);
    vm.stopPrank();
  }

  /// @dev Shield `_value` ppUSDC the depositor already holds, addressed to `_recipient`. Mirrors
  /// IntegrationBase._depositFor but funds via a genuine wrap (no `deal`, which would desync the
  /// 4626 backing) and assumes a 0 vetting fee.
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

  /// @dev Build the deposit proof and submit it through the entrypoint (isolated frame to keep the
  /// large DepositProof struct off the caller's stack). The depositor already holds the ppUSDC.
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

  /// @dev Accrue deterministic Aave yield on the ppUSDC vault's aUSDC: a borrower draws `_borrow`
  /// against the pool's liquidity at 10% APR, time advances a year, then repays so the pool can
  /// satisfy withdrawals. The rebasing index rise lifts every aUSDC holder's balance, including the vault.
  function _accrueAaveYield(uint256 _borrow) internal {
    aavePool.setBorrowRate(RATE_10PCT);
    vm.prank(borrower);
    aavePool.borrow(address(mockUSDC), _borrow, borrower);

    vm.warp(vm.getBlockTimestamp() + 365 days);

    uint256 _debt = aavePool.totalDebt();
    mockUSDC.mint(borrower, _debt);
    vm.startPrank(borrower);
    mockUSDC.approve(address(aavePool), _debt);
    aavePool.repay(address(mockUSDC), _debt, borrower);
    vm.stopPrank();
  }

  /// @dev Unshield `_note` (full withdrawal of `_amountOut` pp-shares) THROUGH the real
  /// `PPRouter.withdrawToUnderlying`. Builds a transact proof whose `processor` is the router and whose
  /// transact `data` is the abi-encoded `PayoutRouting` (recipient/feeRecipient/feeAmount/nativeGas),
  /// with the proof `context` bound to `keccak256(abi.encode(params, payload))` so the proof commits to
  /// the router + payout. The router then unwraps each leg to USDC via the zap. Returns the underlying
  /// delivered to the recipient and to the fee recipient.
  function _unshieldViaRouter(
    Note memory _note,
    UserIdentityLib.UserIdentity storage _spender,
    uint256 _amountOut,
    address _recipient,
    address _feeRecipient,
    uint256 _feeShares,
    uint256 _minUnderlyingOut
  ) internal returns (uint256 _toRecipient, uint256 _toFee) {
    // Full spend: the single output note carries 0 value (everything withdraws), same label lineage.
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

    // Build the proof bound to (router as processor, payout data) via the context hash.
    ProofLibV2.TransactProof memory _proof = _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _outs,
      _amountOut: _amountOut,
      _context: _hashTransactContext(_params, _payload)
    });

    // The router is msg.sender to the vault; mirror leaves + assert vault postconditions ourselves
    // (we cannot reuse _submitTransact, which calls _poolVault.transact directly as address(this)).
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
  /// for `_to` and a change note back to `_from` (same label lineage, no withdrawal). Returns both
  /// new spendable notes. Kept in the base so the `using UserIdentityLib` receiveNote call resolves.
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

/// @notice Baseline: ppUSDC shields and unshields through the real pool conserving the exact share
/// amount, with the WITHDRAW unwrapped to USDC by the real `PPRouter.withdrawToUnderlying`. With no
/// yield and no fee, the recipient receives exactly the principal USDC backing the shielded shares.
contract PPUSDCRouterWithdrawConservationIntegration is PPUSDCYieldMockBase {
  function test_shieldUnshieldViaRouter_noYield_deliversPrincipalUSDC() external {
    _fundPPYieldToken(alice.addr, SHIELD_VALUE);
    assertEq(ppusdc.balanceOf(alice.addr), SHIELD_VALUE, 'alice should hold the wrapped ppUSDC');

    // Shield: alice deposits her ppUSDC into the pool (real deposit proof)
    Note memory _note = _shieldPPYieldToken(alice, alice, SHIELD_VALUE);
    assertEq(ppusdc.balanceOf(alice.addr), 0, 'all ppUSDC shielded');
    assertEq(ppusdc.balanceOf(address(_poolVault)), SHIELD_VALUE, 'pool custodies the shielded ppUSDC');

    vm.warp(vm.getBlockTimestamp() + 30 days); // time passes while shielded (no yield: no borrower)

    // What the recipient's shares are worth at the live rate (no yield => the original principal).
    uint256 _expectedUSDC = ppusdc.previewRedeem(SHIELD_VALUE);

    // Unshield via the real router: full withdrawal, no relay fee.
    (uint256 _toRecipient, uint256 _toFee) = _unshieldViaRouter({
      _note: _note,
      _spender: alice,
      _amountOut: SHIELD_VALUE,
      _recipient: usdcRecipient,
      _feeRecipient: feeRecipient,
      _feeShares: 0,
      _minUnderlyingOut: _expectedUSDC
    });

    assertEq(ppusdc.balanceOf(address(_poolVault)), 0, 'pool fully drained');
    assertEq(_toFee, 0, 'no fee leg');
    assertEq(_toRecipient, _expectedUSDC, 'router delivered exactly the previewRedeem USDC');
    assertEq(mockUSDC.balanceOf(usdcRecipient), _toRecipient, 'recipient holds the unwrapped USDC');
    assertEq(mockUSDC.balanceOf(usdcRecipient), PRINCIPAL_USDC, 'no-yield withdrawal returns the principal');
    // The router is stateless on the share leg: no pp-shares left stranded in it.
    assertEq(ppusdc.balanceOf(address(router)), 0, 'router holds no residual pp-shares');
  }
}

/// @notice The headline property: a yield withdrawal delivers principal + accrued yield ATOMICALLY,
/// and waiting longer (more yield) yields MORE underlying than an immediate withdrawal — all through
/// the real `PPRouter.withdrawToUnderlying`, with the relay fee leg delivered in USDC to the fee
/// recipient. No EntryPoint/PoolVault change.
contract PPUSDCRouterWithdrawYieldIntegration is PPUSDCYieldMockBase {
  function test_routerWithdraw_deliversPrincipalPlusYield_andFee() external {
    // 1) alice wraps USDC -> ppUSDC and shields it
    _fundPPYieldToken(alice.addr, SHIELD_VALUE);
    Note memory _aliceNote = _shieldPPYieldToken(alice, alice, SHIELD_VALUE);
    assertEq(ppusdc.balanceOf(address(_poolVault)), SHIELD_VALUE, 'pool custodies the shielded ppUSDC');

    // 2) alice privately sends bob *some* (40%) inside the pool, keeping the change note (1->2)
    uint256 _bobAmt = (SHIELD_VALUE * 2) / 5;
    uint256 _changeAmt = SHIELD_VALUE - _bobAmt;
    (Note memory _bobNote,) = _splitTransfer(_aliceNote, alice, bob, _bobAmt);
    assertEq(ppusdc.balanceOf(address(_poolVault)), SHIELD_VALUE, 'in-pool transfer keeps the pool balance');

    // 3a) if bob unshielded NOW (no yield yet), his ppUSDC is worth X USDC
    uint256 _xNow = ppusdc.previewRedeem(_bobAmt);

    // 3b) but bob waits: Aave yield accrues, so the same ppUSDC is now worth more
    _accrueAaveYield(PRINCIPAL_USDC / 2);
    uint256 _yLater = ppusdc.previewRedeem(_bobAmt);
    assertGt(_yLater, _xNow, 'ppUSDC appreciates with yield: bob is worth more by waiting');

    // 4) bob unshields his note through the real router, with a relay fee of 10% of the shares.
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

    // KEY PROPERTY: the recipient realized MORE USDC than an immediate (no-yield) withdrawal of the
    // same shares would have, i.e. principal + accrued yield, delivered atomically by the router.
    assertGt(_toRecipient + _toFee, _xNow, 'router delivered principal + accrued yield (> immediate value)');

    // The recipient leg ~= previewRedeem(recipientShares), INCLUDING the accrued yield.
    assertApproxEqAbs(_toRecipient, _expectedRecipientUSDC, 3, 'recipient USDC == previewRedeem(recipientShares)');
    assertApproxEqAbs(_toFee, _expectedFeeUSDC, 3, 'fee recipient USDC == previewRedeem(feeShares)');
    assertEq(mockUSDC.balanceOf(usdcRecipient), _toRecipient, 'recipient holds the unwrapped USDC');
    assertEq(mockUSDC.balanceOf(feeRecipient), _toFee, 'fee recipient holds the unwrapped fee USDC');
    assertGt(_toFee, 0, 'fee leg delivered in USDC');

    // alice's change note remains shielded (and keeps accruing); the protocol took its fee on yield.
    assertEq(ppusdc.balanceOf(address(_poolVault)), _changeAmt, 'alice change remains shielded in the pool');
    assertGt(ppusdc.claimableFees(), 0, 'protocol fee accrued on the yield');
    assertEq(ppusdc.balanceOf(address(router)), 0, 'router holds no residual pp-shares');
  }

  /// @notice The same withdrawal yields strictly MORE underlying the longer bob waits — proving the
  /// shielded position genuinely accrues yield that the router delivers at unwrap time.
  function test_routerWithdraw_moreTimeYieldsMoreUnderlying() external {
    _fundPPYieldToken(alice.addr, SHIELD_VALUE);
    Note memory _aliceNote = _shieldPPYieldToken(alice, alice, SHIELD_VALUE);

    uint256 _immediate = ppusdc.previewRedeem(SHIELD_VALUE);

    // Accrue a year of yield, then withdraw the whole position via the router.
    _accrueAaveYield(PRINCIPAL_USDC / 2);
    uint256 _afterYield = ppusdc.previewRedeem(SHIELD_VALUE);
    assertGt(_afterYield, _immediate, 'position appreciates with time');

    (uint256 _toRecipient,) = _unshieldViaRouter({
      _note: _aliceNote,
      _spender: alice,
      _amountOut: SHIELD_VALUE,
      _recipient: usdcRecipient,
      _feeRecipient: feeRecipient,
      _feeShares: 0,
      _minUnderlyingOut: _immediate
    });

    assertGt(_toRecipient, _immediate, 'waiting for yield delivered MORE USDC than an immediate withdrawal');
    assertApproxEqAbs(_toRecipient, _afterYield, 3, 'realized USDC matches the post-yield redeem value');
    assertEq(mockUSDC.balanceOf(usdcRecipient), _toRecipient, 'recipient received the unwrapped USDC');
  }
}
