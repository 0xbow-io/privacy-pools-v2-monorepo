// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase, Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {IERC5564Announcer} from 'interfaces/IERC5564Announcer.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

/// @notice Integration tests for PrivacyPoolRelay.relayAndAnnounce() using real ZK proofs
/// @dev Alice deposits, then withdraws to a fresh stealth address via relayAndAnnounce; the relay
///      atomically publishes the ERC-5564 announcement for that stealth payment. Verifies both the
///      on-chain announcement (against the resolved ANNOUNCER) and the recipient-binding revert.
contract RelayAndAnnounceIntegration is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  uint256 internal constant RELAY_FEE = 0.05 ether;
  uint256 internal constant SCHEME_ID = 1;
  bytes internal constant EPHEMERAL_PUB_KEY = hex'0271c1e4b3a0f6e2d5c8b9a7f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4';
  bytes internal constant ANNOUNCE_METADATA = hex'aa';

  address internal _relayer;
  /// @dev Fresh stealth address the withdrawal pays; a plain unfunded EOA (no keystore registration).
  address internal _stealth;

  function setUp() public override {
    super.setUp();
    // The pinned Sepolia deployment predates relayAndAnnounce, so the path cannot run against it.
    if (_usingSepoliaDeployment) vm.skip(true);
    alice = _registerInKeystore(alice);
    _relayer = makeAddr('relayer');
    _stealth = makeAddr('stealth');
  }

  /// @notice Alice deposits ERC20 → withdraws the full value to a fresh stealth address via
  ///         relayAndAnnounce, which emits the ERC-5564 Announcement in the same transaction.
  function test_relayAndAnnounce_withdrawsAndAnnounces() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    vm.warp(vm.getBlockTimestamp() + 1);

    address _tokenAddr = address(uint160(deposit.tokenId));
    uint256 _stealthBefore = _balanceOf(_tokenAddr, _stealth);
    uint256 _feeBefore = _balanceOf(_tokenAddr, charlie.addr);
    uint256 _poolBefore = _balanceOf(_tokenAddr, address(_poolVault));

    (ProofLibV2.TransactProof memory _proof, IPoolVault.TransactParams memory _params) =
      _buildStealthRelayProof(deposit, alice, _stealth, charlie.addr, SAMPLE_VALUE, SAMPLE_VALUE, RELAY_FEE);

    IPrivacyPoolRelay.Announcement memory _announcement = IPrivacyPoolRelay.Announcement({
      schemeId: SCHEME_ID, stealthAddress: _stealth, ephemeralPubKey: EPHEMERAL_PUB_KEY, metadata: ANNOUNCE_METADATA
    });

    // The withdrawal relays first (Relayed), then the announcer publishes the announcement (Announcement).
    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(_tokenAddr, _stealth, SAMPLE_VALUE - RELAY_FEE, charlie.addr, RELAY_FEE, 0);
    // The announcer emits with msg.sender (the relay) as the caller topic.
    vm.expectEmit(address(_privacyPoolRelay.ANNOUNCER()));
    emit IERC5564Announcer.Announcement(
      SCHEME_ID, _stealth, address(_privacyPoolRelay), EPHEMERAL_PUB_KEY, ANNOUNCE_METADATA
    );

    vm.prank(_relayer);
    _privacyPoolRelay.relayAndAnnounce(_proof, _params, _defaultTransactNoteData, _announcement);

    // The withdrawal happened: funds moved from the pool to the stealth address (minus fee to charlie).
    _assertProofWasSpent(_proof, vm.getBlockTimestamp());
    _assertStateRootSync(_proof);
    assertEq(_balanceOf(_tokenAddr, _stealth), _stealthBefore + SAMPLE_VALUE - RELAY_FEE, 'Stealth address underpaid');
    assertEq(_balanceOf(_tokenAddr, charlie.addr), _feeBefore + RELAY_FEE, 'Fee recipient underpaid');
    assertEq(_balanceOf(_tokenAddr, address(_poolVault)), _poolBefore - SAMPLE_VALUE, 'PoolVault balance mismatch');
    assertEq(_balanceOf(_tokenAddr, address(_privacyPoolRelay)), 0, 'Relay should hold no funds');
  }

  /// @notice The announced stealth address must equal the PayoutRouting recipient the proof commits to;
  ///         a mismatch reverts the whole bundle (no withdrawal, no announcement).
  function test_relayAndAnnounce_revertsWhenStealthAddressMismatchesRecipient() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    vm.warp(vm.getBlockTimestamp() + 1);

    // Proof pays _stealth (the PayoutRouting recipient) ...
    (ProofLibV2.TransactProof memory _proof, IPoolVault.TransactParams memory _params) =
      _buildStealthRelayProof(deposit, alice, _stealth, charlie.addr, SAMPLE_VALUE, SAMPLE_VALUE, RELAY_FEE);

    // ... but the announcement names a DIFFERENT stealth address.
    address _wrongStealth = makeAddr('wrongStealth');
    IPrivacyPoolRelay.Announcement memory _announcement = IPrivacyPoolRelay.Announcement({
      schemeId: SCHEME_ID,
      stealthAddress: _wrongStealth,
      ephemeralPubKey: EPHEMERAL_PUB_KEY,
      metadata: ANNOUNCE_METADATA
    });

    vm.prank(_relayer);
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_AnnouncementRecipientMismatch.selector);
    _privacyPoolRelay.relayAndAnnounce(_proof, _params, _defaultTransactNoteData, _announcement);
  }

  /*///////////////////////////////////////////////////////////////
                              HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Build a relay proof paying a raw stealth address (not a keystore identity). The change note is
  ///      owned by the spender (`alice`); a full withdrawal makes its value zero. Mirrors Relay.t.sol's
  ///      `_buildRelayProof` but takes a plain address recipient so a fresh stealth EOA can be paid.
  function _buildStealthRelayProof(
    Note memory _note,
    UserIdentityLib.UserIdentity storage _spender,
    address _recipient,
    address _feeRecipient,
    uint256 _inputNoteValue,
    uint256 _withdrawValue,
    uint256 _feeAmount
  ) internal returns (ProofLibV2.TransactProof memory _txProof, IPoolVault.TransactParams memory _params) {
    _params = IPoolVault.TransactParams({
      processor: address(_privacyPoolRelay),
      data: abi.encode(
        IPrivacyPoolRelay.PayoutRouting({
          recipient: _recipient, feeRecipient: _feeRecipient, feeAmount: _feeAmount, nativeGas: 0
        })
      )
    });

    // The change note (any residual value) is retained by the spender; full withdrawal => zero value.
    NoteCreationParams memory _outputNote = _spender.receiveNote(_inputNoteValue - _withdrawValue, _note.inputLabel);

    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;
    NoteCreationParams[] memory _outputNotes = new NoteCreationParams[](1);
    _outputNotes[0] = _outputNote;

    _txProof = _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _outputNotes,
      _amountOut: _withdrawValue,
      _context: _hashTransactContext(_params, _defaultTransactNoteData)
    });
  }

  receive() external payable {}
}
