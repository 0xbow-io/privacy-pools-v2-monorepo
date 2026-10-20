// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase, Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {MockSmartWallet} from 'test/helpers/MockSmartWallet.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

/// @notice Integration tests for PrivacyPoolRelay.registerAndRelay() using real ZK proofs
/// @dev Alice transfers a note to a fresh, unfunded recipient; the relayer then registers that
///      recipient in the keystore (authorized by an off-chain signature) and withdraws atomically.
contract RegisterAndRelayIntegration is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  uint256 internal constant RELAY_FEE = 0.05 ether;

  address internal _relayer;

  /// @dev A fresh recipient whose address is backed by a real signing key, so it can authorize a
  ///      relayed keystore registration via EIP-712 without ever holding native funds.
  UserIdentityLib.UserIdentity internal _freshBob;

  /// @dev A fresh recipient whose address is an EIP-1271 smart-contract wallet; its owner key signs
  ///      and the wallet validates, exercising the contract-wallet branch of `SignatureChecker`.
  UserIdentityLib.UserIdentity internal _walletBob;

  function setUp() public override {
    super.setUp();
    // The pinned Sepolia deployment predates setAuthPolicyWithSig/EIP712, so the relayed-registration
    // path cannot run against it. Exercised on the fresh mainnet deploy.
    if (_usingSepoliaDeployment) vm.skip(true);
    alice = _registerInKeystore(alice);
    _relayer = makeAddr('relayer');
    _freshBob = UserIdentityLib.createSignableIdentity('freshBob');

    (address _walletOwner, uint256 _walletOwnerKey) = makeAddrAndKey('walletBob_owner');
    MockSmartWallet _wallet = new MockSmartWallet(_walletOwner);
    // The CREATE address may collide with a funded account on the fork; zero it so "unfunded" is meaningful.
    vm.deal(address(_wallet), 0);
    _walletBob = UserIdentityLib.createContractWalletIdentity('walletBob', address(_wallet));
    _walletBob.signingKey = _walletOwnerKey;
  }

  /// @notice Alice transfers to Bob's fresh, unfunded EOA → Bob withdraws via registerAndRelay,
  ///         which registers Bob's keystore leaf in the same tx. Bob never funds his address or pays gas.
  function test_registerAndRelay_freshRecipientNeverFunded() external {
    assertEq(_keystore.nullifyingKeys(_freshBob.addr), 0, 'Bob should not be registered yet');
    assertEq(_freshBob.addr.balance, 0, 'Bob address must be unfunded');

    Note memory aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory bobNote,) = _transact({
      _note: aliceDeposit,
      _spender: alice,
      _noteCreationParams: _freshBob.receiveNote(SAMPLE_VALUE, aliceDeposit.inputLabel),
      _amountOut: 0
    });

    _registerAndRelay({
      _note: bobNote,
      _account: _freshBob,
      _recipient: _freshBob.addr,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE
    });

    assertEq(_keystore.nullifyingKeys(_freshBob.addr), _freshBob.nullifyingKeyHash, 'Bob should be registered');
  }

  /// @notice Same flow, but Bob's fresh address is an EIP-1271 smart-contract wallet: the wallet owner
  ///         signs off-chain and the wallet validates, registering the wallet via SignatureChecker.
  function test_registerAndRelay_eip1271ContractWallet() external {
    assertEq(_keystore.nullifyingKeys(_walletBob.addr), 0, 'Wallet should not be registered yet');
    assertEq(_walletBob.addr.balance, 0, 'Wallet must be unfunded');

    Note memory aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory bobNote,) = _transact({
      _note: aliceDeposit,
      _spender: alice,
      _noteCreationParams: _walletBob.receiveNote(SAMPLE_VALUE, aliceDeposit.inputLabel),
      _amountOut: 0
    });

    _registerAndRelay({
      _note: bobNote,
      _account: _walletBob,
      _recipient: _walletBob.addr,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE
    });

    assertEq(_keystore.nullifyingKeys(_walletBob.addr), _walletBob.nullifyingKeyHash, 'Wallet should be registered');
  }

  /// @notice Front-run resilience: an attacker submits Bob's OWN signed registration directly to the
  ///         keystore before the bundle lands. `registerAndRelay` must SKIP the now-redundant
  ///         registration (rather than revert `Keystore_AuthPolicyAlreadySet` and lose the whole
  ///         atomic bundle) and still relay Bob's withdrawal. Real keystore, real signature, real proof.
  function test_registerAndRelay_skipsRegistrationWhenAlreadyRegistered() external {
    Note memory aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory bobNote,) = _transact({
      _note: aliceDeposit,
      _spender: alice,
      _noteCreationParams: _freshBob.receiveNote(SAMPLE_VALUE, aliceDeposit.inputLabel),
      _amountOut: 0
    });

    // FRONT-RUN: anyone submits Bob's own signed registration directly. It binds Bob's account/key, so
    // the attacker can only reproduce Bob's intended registration — but it would strand a naive bundle.
    uint256 _deadline = vm.getBlockTimestamp() + 1 days;
    bytes memory _bobSig = _signSetAuthPolicy(_freshBob, _deadline);
    vm.prank(charlie.addr);
    _keystore.setAuthPolicyWithSig(
      _freshBob.addr, _freshBob.authDigest, _freshBob.nullifyingKeyHash, _deadline, _bobSig
    );
    assertEq(_keystore.nullifyingKeys(_freshBob.addr), _freshBob.nullifyingKeyHash, 'front-run registered Bob');

    // The atomic bundle must degrade to a plain relay: registration is skipped, the withdrawal still
    // pays Bob (the helper asserts the recipient/fee payout + that the anchored root is known on-chain).
    _registerAndRelay({
      _note: bobNote,
      _account: _freshBob,
      _recipient: _freshBob.addr,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE
    });

    assertEq(_keystore.nullifyingKeys(_freshBob.addr), _freshBob.nullifyingKeyHash, 'Bob remains registered');
  }

  /// @notice Atomic-abort on a genuinely bad registration authorization: `registerAndRelay` must revert
  ///         the WHOLE bundle when the keystore rejects the auth signature — both for a signature from the
  ///         WRONG signer (`Keystore_InvalidSignature`) and a correctly-signed but EXPIRED deadline
  ///         (`Keystore_SignatureExpired`). Real keystore, real EIP-712. No funds move and Bob is never
  ///         registered; the note is proven un-spent by a subsequent VALID relay that still succeeds
  ///         (a consumed nullifier would make the retry revert).
  function test_registerAndRelay_atomicAbort_badAndExpiredSignature() external {
    assertEq(_keystore.nullifyingKeys(_freshBob.addr), 0, 'Bob should not be registered yet');

    Note memory aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory bobNote,) = _transact({
      _note: aliceDeposit,
      _spender: alice,
      _noteCreationParams: _freshBob.receiveNote(SAMPLE_VALUE, aliceDeposit.inputLabel),
      _amountOut: 0
    });

    address _tokenAddr = address(uint160(bobNote.tokenId));
    uint256 _recipientBefore = _balanceOf(_tokenAddr, _freshBob.addr);
    uint256 _feeBefore = _balanceOf(_tokenAddr, charlie.addr);
    uint256 _poolBefore = _balanceOf(_tokenAddr, address(_poolVault));

    // (a) Signature from the WRONG signer (valid, non-expired deadline) -> whole bundle reverts.
    uint256 _deadline = vm.getBlockTimestamp() + 1 days;
    (, uint256 _wrongKey) = makeAddrAndKey('mallory');
    bytes memory _wrongSig = _signSetAuthPolicyWithKey(_freshBob, _deadline, _wrongKey);
    _expectRegisterAndRelayReverts(_freshBob, _deadline, _wrongSig, IKeystore.Keystore_InvalidSignature.selector);

    // (b) Correctly-signed but EXPIRED deadline -> whole bundle reverts.
    uint256 _expired = vm.getBlockTimestamp() - 1;
    bytes memory _expiredSig = _signSetAuthPolicy(_freshBob, _expired);
    _expectRegisterAndRelayReverts(_freshBob, _expired, _expiredSig, IKeystore.Keystore_SignatureExpired.selector);

    // No funds moved and Bob was never registered by either aborted bundle.
    assertEq(_keystore.nullifyingKeys(_freshBob.addr), 0, 'Bob must remain unregistered after aborts');
    assertEq(_balanceOf(_tokenAddr, _freshBob.addr), _recipientBefore, 'recipient balance unchanged');
    assertEq(_balanceOf(_tokenAddr, charlie.addr), _feeBefore, 'fee recipient balance unchanged');
    assertEq(_balanceOf(_tokenAddr, address(_poolVault)), _poolBefore, 'pool balance unchanged');

    // The note was NOT spent by the aborted bundles: a subsequent VALID registerAndRelay still succeeds
    // (a consumed nullifier would make this revert on double-spend).
    _registerAndRelay({
      _note: bobNote,
      _account: _freshBob,
      _recipient: _freshBob.addr,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE
    });

    assertEq(_keystore.nullifyingKeys(_freshBob.addr), _freshBob.nullifyingKeyHash, 'Bob registered by the valid relay');
  }

  /*///////////////////////////////////////////////////////////////
                              HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Registers `_account` and withdraws its note in one atomic relayer call. The keystore
  ///      membership proof is anchored to the PREDICTED post-registration root: the account's leaf is
  ///      inserted into the mirror tree before proving, and `registerAndRelay` performs the matching
  ///      on-chain insert so the root the proof commits to becomes current right before `transact`.
  function _registerAndRelay(
    Note memory _note,
    UserIdentityLib.UserIdentity storage _account,
    address _recipient,
    address _feeRecipient,
    uint256 _inputNoteValue,
    uint256 _withdrawValue,
    uint256 _feeAmount
  ) internal {
    vm.warp(vm.getBlockTimestamp() + 1);

    address _tokenAddr = address(uint160(_note.tokenId));

    // Predict the post-registration root: mirror the account's leaf now (on-chain insert happens inside
    // registerAndRelay) and prove membership against the resulting mirror root.
    uint256 _authLeaf = PoseidonT4.hash([_account.ownerAddress, _account.nullifyingKeyHash, _account.authDigest]);
    _keystoreTreeMirror.insert(_authLeaf);
    _account.keystoreIndex = _keystoreTreeMirror.size - 1;

    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({
      processor: address(_privacyPoolRelay),
      data: abi.encode(
        IPrivacyPoolRelay.PayoutRouting({
          recipient: _recipient, feeRecipient: _feeRecipient, feeAmount: _feeAmount, nativeGas: 0
        })
      )
    });

    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;
    NoteCreationParams[] memory _outNotes = new NoteCreationParams[](1);
    _outNotes[0] = _account.receiveNote(_inputNoteValue - _withdrawValue, _note.inputLabel);

    ProofGenerator.TransactInputs memory _inputs = _buildTransactInputs(
      _notes, _account, _hashTransactContext(_params, _defaultTransactNoteData), _outNotes, _withdrawValue
    );
    // Anchor to the predicted (mirror) root, not the stale on-chain root that lacks the account's leaf.
    _inputs.keystoreRoot = _keystoreTreeMirror.root();
    ProofLibV2.TransactProof memory _proof = ProofGenerator.generateTransactProof(_inputs);

    uint256 _deadline = block.timestamp + 1 days;
    bytes memory _signature = _signSetAuthPolicy(_account, _deadline);

    uint256 _recipientBefore = _balanceOf(_tokenAddr, _recipient);
    uint256 _feeRecipientBefore = _balanceOf(_tokenAddr, _feeRecipient);
    uint256 _poolVaultBefore = _balanceOf(_tokenAddr, address(_poolVault));

    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(_tokenAddr, _recipient, _withdrawValue - _feeAmount, _feeRecipient, _feeAmount, 0);

    vm.prank(_relayer);
    _privacyPoolRelay.registerAndRelay(
      _account.addr,
      _account.authDigest,
      _account.nullifyingKeyHash,
      _deadline,
      _signature,
      _proof,
      _params,
      _defaultTransactNoteData
    );

    _assertProofWasSpent(_proof, vm.getBlockTimestamp());
    _assertStateRootSync(_proof);
    assertTrue(_keystore.isKnownRoot(_keystoreTreeMirror.root()), 'Predicted keystore root must be known on-chain');

    assertEq(
      _balanceOf(_tokenAddr, _recipient),
      _recipientBefore + _withdrawValue - _feeAmount,
      'Recipient should receive withdrawal minus fee'
    );
    assertEq(
      _balanceOf(_tokenAddr, _feeRecipient), _feeRecipientBefore + _feeAmount, 'Fee recipient should receive relay fee'
    );
    assertEq(
      _balanceOf(_tokenAddr, address(_poolVault)), _poolVaultBefore - _withdrawValue, 'PoolVault balance mismatch'
    );
    assertEq(_balanceOf(_tokenAddr, address(_privacyPoolRelay)), 0, 'Relay should hold no funds');
  }

  /// @dev Produces the EIP-712 `SetAuthPolicy` signature `_account` would create off-chain, signed by the
  ///      account's own key. Reconstructs the keystore domain (name "PrivacyPoolsKeystore", version "1").
  function _signSetAuthPolicy(
    UserIdentityLib.UserIdentity storage _account,
    uint256 _deadline
  ) internal view returns (bytes memory) {
    return _signSetAuthPolicyWithKey(_account, _deadline, _account.signingKey);
  }

  /// @dev Same EIP-712 `SetAuthPolicy` digest over `_account`'s fields, but signed by an arbitrary
  ///      `_signingKey` — used to forge a signature from the WRONG signer (recovers to a non-`_account`
  ///      address, so the keystore's `SignatureChecker` rejects it as `Keystore_InvalidSignature`).
  function _signSetAuthPolicyWithKey(
    UserIdentityLib.UserIdentity storage _account,
    uint256 _deadline,
    uint256 _signingKey
  ) internal view returns (bytes memory) {
    bytes32 _domainSeparator = keccak256(
      abi.encode(
        keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
        keccak256(bytes('PrivacyPoolsKeystore')),
        keccak256(bytes('1')),
        block.chainid,
        address(_keystore)
      )
    );
    bytes32 _structHash = keccak256(
      abi.encode(
        keccak256('SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)'),
        _account.addr,
        _account.authDigest,
        _account.nullifyingKeyHash,
        _deadline
      )
    );
    bytes32 _digest = keccak256(abi.encodePacked(hex'1901', _domainSeparator, _structHash));
    (uint8 _v, bytes32 _r, bytes32 _s) = vm.sign(_signingKey, _digest);
    return abi.encodePacked(_r, _s, _v);
  }

  /// @dev Attempt a `registerAndRelay` bundle expected to abort atomically inside the keystore
  ///      registration step (before any `transact`), asserting the exact revert selector. A zeroed proof
  ///      is sufficient — the bundle reverts before the proof is ever decoded/verified.
  function _expectRegisterAndRelayReverts(
    UserIdentityLib.UserIdentity storage _account,
    uint256 _deadline,
    bytes memory _signature,
    bytes4 _expectedError
  ) internal {
    ProofLibV2.TransactProof memory _dummyProof; // never reached: registration reverts first
    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({
      processor: address(_privacyPoolRelay),
      data: abi.encode(
        IPrivacyPoolRelay.PayoutRouting({
          recipient: _account.addr, feeRecipient: charlie.addr, feeAmount: RELAY_FEE, nativeGas: 0
        })
      )
    });

    vm.expectRevert(_expectedError);
    vm.prank(_relayer);
    _privacyPoolRelay.registerAndRelay(
      _account.addr,
      _account.authDigest,
      _account.nullifyingKeyHash,
      _deadline,
      _signature,
      _dummyProof,
      _params,
      _defaultTransactNoteData
    );
  }
}
