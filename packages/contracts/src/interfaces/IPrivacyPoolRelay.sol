// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IERC5564Announcer} from 'interfaces/IERC5564Announcer.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';

/// @title IPrivacyPoolRelay
/// @notice Interface for relaying private withdrawals so a relayer pays gas and funds go to a recipient (with optional fee)
interface IPrivacyPoolRelay {
  /*///////////////////////////////////////////////////////////////
                              STRUCTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Routing of withdrawn amount between recipient and fee recipient
  /// @param recipient Address to receive the net amount after fee
  /// @param feeRecipient Address to receive the fee (or msg.sender if zero)
  /// @param feeAmount Fee in nominal token amount
  /// @param nativeGas Exact native ETH the relayer must attach
  struct PayoutRouting {
    address recipient;
    address feeRecipient;
    uint256 feeAmount;
    uint256 nativeGas;
  }

  /// @notice ERC-5564 stealth-payment announcement, emitted atomically with the relayed withdrawal
  /// @param schemeId The ERC-5564 stealth-address scheme id
  /// @param stealthAddress The stealth address the withdrawal pays; must equal the PayoutRouting recipient
  /// @param ephemeralPubKey The ephemeral public key used to derive the stealth address
  /// @param metadata View-tag + scheme metadata forwarded verbatim to the Announcer
  struct Announcement {
    uint256 schemeId;
    address stealthAddress;
    bytes ephemeralPubKey;
    bytes metadata;
  }

  /*///////////////////////////////////////////////////////////////
                              EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a withdrawal is successfully relayed
  /// @param _asset The token address (or NATIVE_ASSET for ETH)
  /// @param _recipient Address that received the net amount
  /// @param _recipientAmount Amount sent to recipient
  /// @param _feeRecipient Address that received the fee
  /// @param _fee Fee amount taken
  /// @param _gasFunding Native ETH forwarded to recipient for gas funding
  event Relayed(
    address indexed _asset,
    address indexed _recipient,
    uint256 _recipientAmount,
    address indexed _feeRecipient,
    uint256 _fee,
    uint256 _gasFunding
  );

  /// @notice Emitted when a batch of withdrawals is successfully relayed in a single transaction
  /// @param _asset The token address (or NATIVE_ASSET for ETH), shared across the batch
  /// @param _recipient Address that received the aggregate net amount
  /// @param _recipientAmount Aggregate amount sent to recipient (sum of amountOut minus total fee)
  /// @param _feeRecipient Address that received the aggregate fee
  /// @param _fee Aggregate fee amount taken across the batch
  /// @param _gasFunding Native ETH forwarded to recipient for gas funding (sum of per-item nativeGas)
  /// @param _count Number of transacts in the batch
  event RelayedBatch(
    address indexed _asset,
    address indexed _recipient,
    uint256 _recipientAmount,
    address indexed _feeRecipient,
    uint256 _fee,
    uint256 _gasFunding,
    uint256 _count
  );

  /*///////////////////////////////////////////////////////////////
                              ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when pool is the zero address
  error PrivacyPoolRelay_ZeroPool();

  /// @notice Thrown when entrypoint is the zero address
  error PrivacyPoolRelay_ZeroEntrypoint();

  /// @notice Thrown when the announcer is the zero address at construction
  error PrivacyPoolRelay_ZeroAnnouncer();

  /// @notice Thrown when the announced stealth address does not equal the withdrawal's payout recipient
  /// @dev Binds the announced `stealthAddress` to the address the withdrawal actually funds, so the
  ///   announcement cannot point at an address this withdrawal never pays. Scope: ONLY the address is
  ///   enforced on-chain; `ephemeralPubKey`, `schemeId`, and `metadata` are forwarded to the Announcer
  ///   as-is (not proven). A wrong ephemeral key only breaks the recipient's off-chain discovery of an
  ///   otherwise-correctly-funded payment and is recoverable by re-announcing (permissionless) — never a
  ///   fund-safety issue. This is the on-chain half of the SDK's STLTH-18 binding.
  error PrivacyPoolRelay_AnnouncementRecipientMismatch();

  /// @notice Thrown when fee amount exceeds asset's maxRelayFee
  error PrivacyPoolRelay_FeeExceedsMax();

  /// @notice Thrown when fee amount exceeds the withdrawn value
  /// @dev Fee is taken from the withdrawal, so it cannot exceed the withdrawn amount
  error PrivacyPoolRelay_FeeExceedsWithdrawal();

  /// @notice Thrown when withdrawnValue is zero to avoid executing an empty withdrawal that only costs gas
  error PrivacyPoolRelay_ZeroWithdrawal();

  /// @notice Thrown when msg.value does not match the nativeGas committed in the proof context
  error PrivacyPoolRelay_NativeGasMismatch();

  /// @notice Thrown when receive() is called by an address other than the pool vault
  error PrivacyPoolRelay_OnlyPoolCanSendETH();

  /// @notice Thrown when the batch input arrays have mismatched lengths
  error PrivacyPoolRelay_BatchLengthMismatch();

  /// @notice Thrown when a batch contains zero transacts
  error PrivacyPoolRelay_EmptyBatch();

  /// @notice Thrown when a batch contains more than MAX_BATCH transacts
  error PrivacyPoolRelay_BatchTooLarge();

  /// @notice Thrown when batch items do not share the same recipient and fee recipient
  error PrivacyPoolRelay_InconsistentRecipient();

  /// @notice Thrown when batch items do not share the same withdrawn asset
  error PrivacyPoolRelay_InconsistentAsset();

  /// @notice Thrown when the payout recipient is the zero address
  /// @dev Footgun removal mirroring PPRouter: a zero recipient would burn the withdrawn funds (and any
  ///   native gas) via a transfer to address(0). The recipient is bound into the proof context, so this
  ///   only guards a self-inflicted misconfiguration, but reverting is strictly safer than burning.
  error PrivacyPoolRelay_ZeroRecipient();

  /// @notice Thrown at construction when _MAX_BATCH is not strictly below the pool's rootHistorySize
  /// @dev Enforces the invariant that every batched transact validates against the shared pre-batch root
  ///   snapshot; if the pool's state-root buffer is too small, later batch items would evict that snapshot
  ///   and revert PoolVault_UnknownStateRoot.
  error PrivacyPoolRelay_RootHistoryTooSmall();

  /*///////////////////////////////////////////////////////////////
                          EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Relays a withdrawal: relayer pays gas; pool transacts then relay forwards to recipient and optional fee
  /// @dev Decodes PayoutRouting from _transactParams.data, calls pool.transact, then sends funds to recipient and fee to feeRecipient.
  ///   Any ETH sent via msg.value is forwarded to the recipient, enabling atomic gas funding for ERC-20 withdrawals.
  /// @param _proof The Groth16 proof with public signals (uses amountOut and tokenIdOut)
  /// @param _transactParams Transact params; .data must ABI-encode PayoutRouting, .processor should be address(this)
  /// @param _noteData Per-output discovery data (hint + encrypted payload)
  function relay(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData
  ) external payable;

  /// @notice Relays a batch of withdrawals (each spending up to the circuit's max inputs) in a single transaction
  /// @dev All items must share the same withdrawn asset, recipient, and fee recipient. Each item's
  ///   PayoutRouting (decoded from _transactParams[i].data) binds its own fee into the proof context.
  ///   The pool transacts each item against a shared root snapshot (no inter-item dependency), funds
  ///   accumulate in this contract, then a single aggregate payout is made to recipient and fee recipient.
  ///   The whole batch is atomic: if any transact reverts, the entire call reverts.
  /// @param _proofs The per-item Groth16 proofs (uses amountOut and tokenIdOut)
  /// @param _transactParams Per-item transact params; each .data must ABI-encode PayoutRouting,
  ///   each .processor should be address(this)
  /// @param _noteData Per-item per-output discovery data (hint + encrypted payload)
  function relayBatch(
    ProofLibV2.TransactProof[] calldata _proofs,
    IPoolVault.TransactParams[] calldata _transactParams,
    IPoolVault.NoteData[][] calldata _noteData
  ) external payable;

  /// @notice Atomically registers `_account` in the keystore then relays its first withdrawal
  /// @dev Closes the economic loop for relayed registration: the withdrawal fee repays the registration
  ///   gas in the same transaction. Registration (via the keystore resolved off `POOL`) executes strictly
  ///   before `transact`, since the keystore-membership check needs the freshly inserted leaf. The
  ///   withdrawal `feeAmount` (bounded by the asset's `maxRelayFee`) must absorb the added registration
  ///   gas, so deployments should configure `maxRelayFee` with headroom.
  ///
  ///   The withdrawal proof must anchor to the keystore root that *includes* the just-inserted leaf — a
  ///   root that does not yet exist when the proof is built. The caller (relayer) is responsible for
  ///   predicting that post-insertion root off-chain and for submitting via private orderflow so a stale
  ///   prediction reverts on simulation rather than burning gas. There is no on-chain mitigation.
  /// @param _account The account being registered (leaf owner and signer)
  /// @param _authDigest The authentication digest
  /// @param _nullifyingKeyHash The hash of the nullifying key
  /// @param _deadline The unix timestamp after which the registration signature is no longer valid
  /// @param _signature The EIP-712 signature by `_account` authorizing the registration
  /// @param _proof The Groth16 proof with public signals (uses amountOut and tokenIdOut)
  /// @param _transactParams Transact params; `.data` must ABI-encode `PayoutRouting`, `.processor` should be address(this)
  /// @param _noteData Per-output discovery data (hint + encrypted payload)
  function registerAndRelay(
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    uint256 _deadline,
    bytes calldata _signature,
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData
  ) external payable;

  /// @notice Atomically relays a withdrawal to a stealth address then publishes its ERC-5564 announcement
  /// @dev Closes the stealth-payment atomicity gap (STLTH-03): relay + announce land in one transaction,
  ///   so a stealth withdrawal never splits into a relayed withdraw plus a separately-submitted announce.
  ///   Enforces on-chain that `_announcement.stealthAddress` equals the PayoutRouting recipient decoded
  ///   from `_transactParams.data`, so the announcement cannot name an address this withdrawal does not
  ///   fund (the on-chain half of STLTH-18). The other announcement fields (`ephemeralPubKey`, `schemeId`,
  ///   `metadata`) are forwarded as-is, not proven — a wrong ephemeral key only breaks off-chain
  ///   discovery of an otherwise-correctly-funded payment and is recoverable by re-announcing. The
  ///   withdrawal relays first (funds land at the stealth address), then the pinned `ANNOUNCER` is called
  ///   so the recipient can discover it. Permissionless, like `relay`.
  /// @param _proof The Groth16 proof with public signals (uses amountOut and tokenIdOut)
  /// @param _transactParams Transact params; `.data` must ABI-encode `PayoutRouting`, `.processor` should be address(this)
  /// @param _noteData Per-output discovery data (hint + encrypted payload)
  /// @param _announcement The ERC-5564 announcement whose `stealthAddress` must equal the payout recipient
  function relayAndAnnounce(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData,
    Announcement calldata _announcement
  ) external payable;

  /*///////////////////////////////////////////////////////////////
                      EXTERNAL VIEW FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Returns the pool vault used for transact
  /// @return _pool The pool vault contract
  function POOL() external view returns (IPoolVault _pool);

  /// @notice Returns the pinned ERC-5564 Announcer used by relayAndAnnounce
  /// @return _announcer The announcer contract
  function ANNOUNCER() external view returns (IERC5564Announcer _announcer);

  /// @notice Returns the entrypoint used for asset config
  /// @return _entrypoint The entrypoint contract
  function ENTRYPOINT() external view returns (IEntrypoint _entrypoint);

  /// @notice Returns the maximum number of transacts allowed in a single relayBatch call
  /// @dev Must remain strictly below the pool's rootHistorySize so every item validates against the
  ///   shared pre-batch root snapshot
  /// @return _maxBatch The maximum batch size
  function MAX_BATCH() external pure returns (uint256 _maxBatch);
}
