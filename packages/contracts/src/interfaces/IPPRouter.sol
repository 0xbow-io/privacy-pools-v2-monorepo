// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

import {ProofLibV2} from 'libraries/ProofLibV2.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title IPPRouter
/// @author 0xbow
/// @notice One-call `underlying -> pp-share -> shield` router that survives the rate drift between
/// when a deposit commitment is generated (off-chain, rate `r0`) and when its deposit tx executes
/// (on-chain, rate `r1`). A V2 deposit commitment binds a FIXED, share-denominated `value`; the
/// entrypoint pulls exactly `value + fee` pp-shares from the depositor and inserts the committed leaf.
/// Because the user funds in the underlying, the share count must be hit exactly at execution. This
/// router mints EXACTLY the committed amount via `IERC4626.mint` and lets the *underlying* spent float
/// up to a caller-supplied `maxUnderlyingIn` bound, so the note is never invalidated by a rate move —
/// it either deposits exactly its committed value or reverts cleanly for the client to re-quote the
/// bound (no re-proving, since `value` is unchanged). No circuit change.
///
/// On the way out, `withdrawToUnderlying` is the symmetric path: the router is the pool's transact
/// `processor`, so the vault pays it the withdrawn pp-shares, which it unwraps to the underlying for the
/// recipient (and the relay fee to the fee recipient) in one atomic call. The fee/native-gas routing
/// mirrors the canonical `PrivacyPoolRelay` (re-implemented here so the yield module stays self-contained;
/// collapsing the duplication into a shared relay base is a tracked future refactor), and the actual
/// unwrap is delegated to the zap — the only Aave touch-point — so this router is protocol-agnostic.
///
/// A router is deployed in one of two modes, fixed at construction. In ERC-20 mode (`NATIVE_MODE =
/// false`) the flows above are the whole story. In native mode (`NATIVE_MODE = true`; the underlying is
/// the chain's wrapped-native token, e.g. WETH for ppETH) two things change at the edges: deposits may
/// also be funded with native value via `depositExactSharesNative` (`msg.value` doubles as the
/// `maxUnderlyingIn` ceiling, the unused remainder refunded in-tx), and `withdrawToUnderlying` unwraps
/// the redeemed underlying and delivers the NATIVE coin to the recipient and fee recipient — same name
/// and ABI, so a submitter drives both modes through one interface, and the delivery form can never be
/// substituted by the submitter (it is a property of the router instance, not of the call).
interface IPPRouter {
  /*///////////////////////////////////////////////////////////////
                            STRUCTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice How a withdrawal's proceeds are split, decoded from the transact `data`

  /*///////////////////////////////////////////////////////////////
                            EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a deposit is wrapped and shielded in one call
  /// @param _payer The address that supplied the underlying (and the router's `msg.sender`)
  /// @param _asset The pp-share asset shielded (this router's vault)
  /// @param _value The committed share value inserted into the pool (the note's value)
  /// @param _underlyingIn The underlying actually pulled from the payer
  /// @param _total The pp-shares minted and deposited (`value + fee`)
  event Deposited(
    address indexed _payer, address indexed _asset, uint256 _value, uint256 _underlyingIn, uint256 _total
  );

  /// @notice Emitted when accumulated aToken dust is swept to the dust recipient
  /// @param _to The dust recipient
  /// @param _amount The aToken amount swept
  event Skimmed(address indexed _to, uint256 _amount);

  /// @notice Emitted when a withdrawal is unshielded and unwrapped to the underlying in one call
  /// @param _asset The pp-share asset withdrawn (this router's vault)
  /// @param _underlying The underlying delivered (this router's underlying)
  /// @param _recipient The address that received the unwrapped underlying
  /// @param _sharesOut The total pp-shares withdrawn from the pool (`amountOut`)
  /// @param _underlyingToRecipient The underlying delivered to the recipient
  /// @param _feeRecipient The relay fee recipient (caller when the payout left it zero)
  /// @param _feeShares The relay fee in pp-shares
  /// @param _underlyingFee The underlying delivered to the fee recipient
  /// @param _gasFunding The native value forwarded to the recipient
  event WithdrawnToUnderlying(
    address indexed _asset,
    address indexed _underlying,
    address indexed _recipient,
    uint256 _sharesOut,
    uint256 _underlyingToRecipient,
    address _feeRecipient,
    uint256 _feeShares,
    uint256 _underlyingFee,
    uint256 _gasFunding
  );

  /*///////////////////////////////////////////////////////////////
                            ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when a constructor argument is the zero address
  error PPRouter_ZeroAddress();

  /// @notice Thrown when the proof's committed value is zero
  error PPRouter_ZeroValue();

  /// @notice Thrown when the proof targets a different asset than this router's vault
  /// @param _proofAsset The asset committed in the proof
  error PPRouter_AssetMismatch(address _proofAsset);

  /// @notice Thrown when the underlying needed to mint the committed value exceeds the caller's bound
  /// @param _required The underlying the router must pull to mint exactly the committed value (+ buffer)
  /// @param _maxUnderlyingIn The caller's ceiling
  error PPRouter_SlippageExceeded(uint256 _required, uint256 _maxUnderlyingIn);

  /// @notice Thrown (defensively) when the entrypoint did not pull exactly the minted shares, leaving
  ///         pp-shares stranded in the router — impossible for the trusted entrypoint, which pulls
  ///         exactly `value + fee`; reverts cleanly rather than stranding the payer's funds
  error PPRouter_SharesStranded();

  /// @notice Thrown when a withdrawal's `amountOut` (pp-shares to withdraw) is zero
  error PPRouter_ZeroWithdrawal();

  /// @notice Thrown when the proof does not name this router as the transact processor
  error PPRouter_InvalidProcessor();

  /// @notice Thrown when the payout routing's `recipient` is the zero address (would burn the proceeds);
  ///         stricter than the canonical `PrivacyPoolRelay` by design (footgun removal, cf. INTL-14)
  error PPRouter_ZeroRecipient();

  /// @notice Thrown when `msg.value` does not equal the `nativeGas` declared in the payout routing
  error PPRouter_NativeGasMismatch();

  /// @notice Thrown when the relay fee exceeds the asset's configured `maxRelayFee`
  error PPRouter_FeeExceedsMax();

  /// @notice Thrown when the relay fee exceeds the total pp-shares withdrawn
  error PPRouter_FeeExceedsWithdrawal();

  /// @notice Thrown when the underlying delivered to the recipient is below the caller's slippage bound
  /// @param _underlyingOut The underlying the recipient's shares unwrapped to
  /// @param _minUnderlyingOut The caller's floor
  error PPRouter_BelowMinUnderlying(uint256 _underlyingOut, uint256 _minUnderlyingOut);

  /// @notice Thrown (defensively) when the vault did not pay this router exactly the withdrawn pp-shares —
  ///         impossible for the trusted vault, which pays `amountOut` of `tokenIdOut` to the processor
  error PPRouter_SharesNotReceived();

  /// @notice Thrown when `depositExactSharesNative` is called on a router not in native mode
  error PPRouter_NotNativeMode();

  /// @notice Thrown when native value is sent directly to the router by anything other than its
  ///         wrapped-native underlying (the only expected pusher, during `withdraw` unwrapping)
  error PPRouter_DirectEthTransfer();

  /*///////////////////////////////////////////////////////////////
                            MUTATIVE
  ///////////////////////////////////////////////////////////////*/

  /// @notice Wrap underlying to exactly the committed pp-share value and shield it through the pool
  /// @dev The router is the on-chain depositor-of-record. The deposit context binds the proof to
  ///      `_noteData` only (not the submitter), so this router may submit the payer's proof as long as
  ///      `_noteData` matches. Mints EXACTLY `value + fee` via `IERC4626.mint`, so no un-shielded
  ///      pp-share dust is left; only ≤ buffer wei of aToken remains (swept via `skim`).
  /// @param _proof The deposit proof (commits `value`, `tokenId`, the output commitment, and context)
  /// @param _noteData Discovery data for the output note; its keccak must equal the proof's context
  /// @param _aspCiphertext Encrypted label data for ASP registration (empty bytes to skip)
  /// @param _maxUnderlyingIn The maximum underlying the caller authorizes (slippage / validity bound)
  /// @return _underlyingIn The underlying actually pulled from the caller
  function depositExactShares(
    ProofLibV2.DepositProof calldata _proof,
    IPoolVault.NoteData calldata _noteData,
    bytes calldata _aspCiphertext,
    uint256 _maxUnderlyingIn
  ) external returns (uint256 _underlyingIn);

  /// @notice Wrap native value to exactly the committed pp-share value and shield it through the pool
  /// @dev Native-mode twin of {depositExactShares}; reverts `PPRouter_NotNativeMode` on an ERC-20-mode
  ///      router. `msg.value` plays the role of BOTH the funding pull and the `maxUnderlyingIn`
  ///      slippage ceiling — the router wraps only the quoted underlying and refunds the rest to the
  ///      caller in the same transaction, so there is no separate bound parameter to keep consistent.
  ///      The refund is a full-gas native send to `msg.sender`, so a contract caller must be able to
  ///      receive native value (or fund with the exact quote). Everything else matches
  ///      {depositExactShares}: exact `IERC4626.mint` of `value + fee`, no un-shielded pp-share dust,
  ///      ≤ buffer wei of aToken dust swept via `skim`.
  /// @param _proof The deposit proof (commits `value`, `tokenId`, the output commitment, and context)
  /// @param _noteData Discovery data for the output note; its keccak must equal the proof's context
  /// @param _aspCiphertext Encrypted label data for ASP registration (empty bytes to skip)
  /// @return _underlyingIn The native value actually consumed (`msg.value - _underlyingIn` is refunded)
  function depositExactSharesNative(
    ProofLibV2.DepositProof calldata _proof,
    IPoolVault.NoteData calldata _noteData,
    bytes calldata _aspCiphertext
  ) external payable returns (uint256 _underlyingIn);

  /// @notice Sweep any aToken dust accumulated from supply rounding to the fixed dust recipient
  /// @dev Permissionless: the destination is fixed at construction, so there is no griefing vector.
  ///      Refunding per-deposit would cost far more gas than the ≤ 2 wei dust is worth, so it is
  ///      swept lazily instead.
  /// @return _amount The aToken amount swept
  function skim() external returns (uint256 _amount);

  /// @notice Unshield pp-shares and unwrap them to the underlying for the recipient in one atomic call
  /// @dev The router must be named as the proof's transact `processor`, so the vault pays it the
  ///      withdrawn `amountOut` pp-shares; it then unwraps the recipient's share (net of the relay fee)
  ///      and the fee separately via the zap, delivering underlying to each. The recipient, fee
  ///      recipient, fee amount, and native gas are all read from `_transactParams.data` (a
  ///      {PayoutRouting}), which is bound into the proof `context` — so a submitting relayer cannot
  ///      redirect funds. Fee/native-gas semantics mirror the canonical `PrivacyPoolRelay`.
  ///      In native mode both legs are redeemed to the router itself, unwrapped once, and delivered as
  ///      the NATIVE coin: the recipient receives their payout plus the submitter's `msg.value` gas
  ///      funding in a single transfer, and the fee recipient receives the fee — a fresh recipient
  ///      address is immediately liquid. A recipient or fee recipient that cannot receive native value
  ///      makes the call revert without consuming the proof (re-route and re-prove; no funds move).
  ///      Trust model: `_minUnderlyingOut` is the only input NOT bound into the proof context. A
  ///      malicious submitter can pass an unsatisfiable floor to force a revert, but this is pure
  ///      griefing — the proof is not consumed and an honest submitter re-submits; it cannot redirect or
  ///      reduce funds. This matches the trusted-relayer model (the submitter passes the value the note
  ///      owner authorized, or the owner submits the tx themselves).
  /// @param _proof The transact proof; its `amountOut` is the pp-shares withdrawn and `tokenIdOut` must equal `VAULT`
  /// @param _transactParams The processor (must be this router) and the abi-encoded {PayoutRouting}
  /// @param _noteData Discovery data for the output notes
  /// @param _minUnderlyingOut The minimum underlying the recipient must receive (slippage / rate-drift bound; see @dev trust model)
  /// @return _underlyingToRecipient The underlying delivered to the recipient
  /// @return _underlyingFee The underlying delivered to the fee recipient
  function withdrawToUnderlying(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData,
    uint256 _minUnderlyingOut
  ) external payable returns (uint256 _underlyingToRecipient, uint256 _underlyingFee);

  /*///////////////////////////////////////////////////////////////
                            VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @notice The pp-share wrapper this router shields into
  function VAULT() external view returns (IPPYieldToken);

  /// @notice The Aave v3 pool the underlying is supplied to
  function POOL() external view returns (IAavePool);

  /// @notice The underlying token supplied to Aave (e.g. USDC)
  function UNDERLYING() external view returns (IERC20);

  /// @notice The aToken the vault wraps (`VAULT.asset()`)
  function A_TOKEN() external view returns (IERC20);

  /// @notice The privacy-pool entrypoint the deposit is submitted through
  function ENTRYPOINT() external view returns (IEntrypoint);

  /// @notice The fixed recipient of any aToken dust left by supply rounding (set at construction)
  function DUST_RECIPIENT() external view returns (address);

  /// @notice The zap used to unwrap withdrawn pp-shares back to the underlying (the only Aave touch-point on exit)
  function ZAP() external view returns (IPPYieldTokenZap);

  /// @notice The privacy-pool vault this router processes withdrawals against
  function POOL_VAULT() external view returns (IPoolVault);

  /// @notice Whether this router is in native mode: the underlying is the wrapped-native token,
  ///         deposits may be funded with `msg.value`, and withdrawals deliver the native coin.
  ///         Fixed at construction.
  function NATIVE_MODE() external view returns (bool);

  /// @notice The underlying a withdrawal of `_shares` pp-shares would currently unwrap to, gross of any relay fee
  /// @dev Clients should set `minUnderlyingOut` from this (on the recipient's share, net of fee), with a
  ///      small margin for the rate moving between this read and execution. Reads the live exchange rate.
  /// @param _shares The pp-shares to redeem
  /// @return _underlyingOut The underlying the shares would redeem to (`VAULT.previewRedeem`)
  function quoteWithdraw(uint256 _shares) external view returns (uint256 _underlyingOut);

  /// @notice The underlying needed to deposit a commitment of `_value` pp-shares, at the live rate
  /// @dev Clients should pass `maxUnderlyingIn >= underlyingNeeded`, with a small margin for the rate
  ///      moving further between this read and execution. The fee component is read from this router's
  ///      `VAULT` config, so the quote is valid for proofs whose `tokenId == VAULT` — the only asset
  ///      `depositExactShares` accepts.
  /// @param _value The committed share value (the note's value)
  /// @return _underlyingNeeded The underlying the router would pull (`previewMint(value + fee) + buffer`)
  /// @return _total The pp-shares that will be minted and deposited (`value + fee`)
  function quote(uint256 _value) external view returns (uint256 _underlyingNeeded, uint256 _total);
}
