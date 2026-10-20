# RelaySwaps yield unwrap — implementation plan

Status: **planned extension, not spec** (lives in `future-ideas/` until implemented; then the
relevant sections move into `contracts/yield.md`, `swaps` design docs and `sdk/yield-sessions.md`).
Author: Claude, 2026-09-05. Reviewed: pending.

## 0a. Design revision (2026-09-09) — explicit `executeUnwrapped(zap)`, no registry

The PoC below inferred the unwrap from an owner registry keyed on `tokenIdOut` (`unwraps[share]`,
24h timelocked removal). Replaced, per review, by an explicit entry point on the same contract:

- `execute(proof, params, noteData)` — unchanged plain path.
- `executeUnwrapped(proof, params, noteData, zap)` — same body via internal `_execute(..., zap)`;
  step 6b requires `approvedZaps[zap]` and `zap.VAULT() == tokenIdOut`, step 8b redeems through
  `zap` (`_unwrap`, pro-rata fee in underlying, unchanged).
- `approveZap(zap)` / `removeZap(zap)` — owner allowlist, same trust class as `approveRouter`.
  `approveZap` cross-checks `zap.A_TOKEN() == zap.VAULT().asset()`,
  `zap.UNDERLYING() == aToken.UNDERLYING_ASSET_ADDRESS()`, non-native underlying with code, and
  `Entrypoint.assets(zap.VAULT()).enabled`.
- `approvedZapList() → address[]` (2026-09-10) — the allowlist backed by a solady
  `EnumerableSetLib.AddressSet` so an off-chain consumer can read the whole set in one call.
  `approvedZaps(addr) → bool` kept as an explicit getter. Hot path (`execute`/`executeUnwrapped`)
  unchanged; plain-path overhead +155 → ~+310 (one `contains` vs a mapping load).

Why: the unwrap becomes a caller choice, so there is no "registry drifted after the proof" case
(§4.2) and no timelock; de-listing a zap only makes `executeUnwrapped` revert. The zap argument is
safe because it must be allowlisted *and* match the proof-bound share. One processor address for
plain and yield notes, so `RelayerInfo.processorAddress`, discovery and the frontend are untouched.
Plain-path gas overhead: +155 (`test_Execute` 198,062 → 198,217).

Off-chain: `relaySwap` calls `executeUnwrapped(…, zap)` for share assets; SDK `assertZapApproved`
reads `approvedZaps(yieldDeployment.zap)` pre-proof; ops script `ApproveZap.s.sol`; `deploy.md` §3b.
Sections §3/§4 below describe the superseded registry design and are kept for the threat analysis,
which still applies minus items 2 (drift) and the timelock.

**Relayer zap discovery (2026-09-10, PR-1).** `supported_assets[].zap` is no longer *required*:
a boot singleton (`YieldZapRegistry`, `OnApplicationBootstrap`) reads `RelaySwaps.approvedZapList()`
on-chain for every chain that configures an `"Underlying"` asset, resolves each zap's share via
`zap.VAULT()`, and builds the authoritative share → zap map. It fails boot if a configured
`"Underlying"` asset has no allowlisted zap, if a config `zap` disagrees with the on-chain one, or
if the zap's on-chain `UNDERLYING()` disagrees with the asset's configured `underlying`; it only
warns for an allowlisted zap whose share this relayer does not price (shared-contract case). A
chain with no yield assets never touches its RPC here; a chain with yield assets but no
`relay_swaps_contract` is warned about and skipped (2026-10-14, previously fatal) — its shares
still relay as `PPRouter` withdrawals, and swaps there are refused upstream. `evm.quote.service.quoteSwap` and
`evm.relay.service.relaySwap` both source the zap from this registry (never the request, never a
hand-copied field), and `quoteSwap` now rejects a share-asset quote with a 400 when the registry
has no zap for it — the "Optional hardening" of §7, now shipped. Post-boot `ZapRemoved` is not
observed until the relayer restarts (same model as the router allowlist).

## 0. TL;DR

Yield notes hold ERC-4626 shares (ppUSDC / ppUSDT). Every swap flow (`withdraw+swap`, `reshield`,
`reshield-crosschain`, `swap-deposit`) hands the withdrawn token to LiFi as-is, and LiFi has no
route for pp-shares (verified live 2026-09-04: LiFi `No available quotes`, CoW
`InsufficientLiquidity`). The only contract that unwraps is `PPRouter`, and it must itself be the
proof-bound `processor`, so RelaySwaps and PPRouter are mutually exclusive.

Fix: teach **RelaySwaps** (already the processor for every swap path) to unwrap registered
shares into their underlying right after `POOL.transact`, via the wrapper's stateless
`PPYieldTokenZap`. Registry-gated, owner-set, self-validating. No change to the proof-bound
`SwapRouting` struct, so no SDK/relayer ABI break. Wrapping on the deposit side stays where it
already is (`PPRouter.depositExactShares`), reached through LiFi contractCalls; that is SDK work.

## 1. Goals / non-goals

Goals
- A yield note (ppUSDC / ppUSDT) can be spent through every existing RelaySwaps flow:
  withdraw+swap to a recipient, same-chain reshield, cross-chain reshield, and as the
  *destination* of a swap-deposit / reshield (land as pp-shares).
- Non-yield notes take a byte-identical path to today (gas snapshot equal).
- Fee stays denominated in shares (proof-bound, Entrypoint `maxRelayFee` is in shares, relayer
  `Underlying` quoter already prices shares) but is *paid* in the underlying.
- All security properties of today's RelaySwaps survive (delta-only sweeps, proof-bound routing,
  allowlisted routers, F-960 min-output rule, rescue-only for pre-existing balances).

Non-goals
- No wrap inside RelaySwaps. Deposit-side wrapping is `PPRouter.depositExactShares`.
- No batch support for yield (impossible by design: PPRouter/relayBatch are processors).
- No generic ERC-4626 support. Only `PPYieldToken` wrappers with a `PPYieldTokenZap`.
- No change to `PPRouter`, `PPYieldToken`, `PPYieldTokenZap`, `PoolVault`, `Entrypoint`.

## 2. Architecture

```
user proof: processor = RelaySwaps, tokenIdOut = ppUSDC, amountOut = S shares,
            context = keccak(TransactParams{processor, data = abi.encode(SwapRouting)}, noteData)

RelaySwaps.execute(proof, params, noteData)
  1-7   validation exactly as today (routers, fee vs maxRelayFee IN SHARES, msg.value, snapshots)
  7c    NEW: u = unwraps[tokenIdOut]; if set, snapshot u.underlying balance too
  8     POOL.transact  -> vault pays S ppUSDC to RelaySwaps
  8b    NEW: if u set:
          ppUSDC.safeApprove(u.zap, S)
          out = u.zap.redeemToUnderlying(S, address(this))      // shares -> aToken -> Aave.withdraw -> USDC
          feeUnderlying = out * feeAmount / S                  // pro-rata of REALISED output, floor
          _token = u.underlying; _amount = out; _fee = feeUnderlying; _inputBefore = underlyingBefore
  9-13  unchanged, now operating on the underlying (fee transfer, B2 gas swap, LiFi swap,
        min-output guard, delta dust sweep)
```

Wrap side (deposit as pp-shares), no contract change:
```
LiFi Executor (holds swapped USDT) --contractCalls--> PPRouter.depositExactShares(proof, noteData, asp, maxUnderlyingIn)
  proof fixes an exact share count; SDK sizes it from previewDeposit(expectedOut * (1 - slippage)),
  maxUnderlyingIn = swap output, leftover USDT follows LiFi's fallback/dust rules.
```

## 3. Contract spec (`packages/swaps/contracts/src/RelaySwaps.sol`, `IRelaySwaps.sol`)

### 3.1 Storage
```solidity
struct Unwrap { address zap; address underlying; }
mapping(address share => Unwrap) public unwraps;
mapping(address share => uint256 removableAt) public unwrapRemovalScheduledAt;
uint256 public constant UNWRAP_REMOVAL_DELAY = 24 hours;   // > relayer quote expiry
```

### 3.2 Admin (all `onlyOwner`)
```solidity
function setUnwrap(address share, address zap) external onlyOwner;
function scheduleUnwrapRemoval(address share) external onlyOwner;
function executeUnwrapRemoval(address share) external onlyOwner;
function cancelUnwrapRemoval(address share) external onlyOwner;
```
`setUnwrap` derives and cross-checks everything from three independent contracts; the owner only
names the share and the zap:
- `IPPYieldTokenZap(zap).VAULT() == share`
- `aToken = IERC4626(share).asset()`; `IAToken(aToken).UNDERLYING_ASSET_ADDRESS() == IPPYieldTokenZap(zap).UNDERLYING()`
- `IPPYieldTokenZap(zap).A_TOKEN() == aToken`
- `ENTRYPOINT.assets(share).enabled == true`
- `zap.code.length != 0`, `underlying.code.length != 0`, `underlying != NATIVE_ASSET`
- overwriting an existing entry is NOT allowed (remove first, via the timelock)
Emits `UnwrapSet(share, zap, underlying)`.

Removal is two-step with a 24h delay (`UnwrapRemovalScheduled`, `UnwrapRemoved`,
`UnwrapRemovalCancelled`) so in-flight proofs either land or expire before the path changes.
Additions need no delay: a share with no unwrap entry has no live swap path today anyway.

### 3.3 `execute()` changes
- Before step 8: read `Unwrap memory u = unwraps[_token]`; if set, `underlyingBefore = u.underlying.balanceOf(address(this))`.
- After step 8, if set:
  ```solidity
  _token.safeApprove(u.zap, _amount);
  uint256 _out = IPPYieldTokenZap(u.zap).redeemToUnderlying(_amount, address(this));
  require(_out > 0, RelaySwaps_UnwrapZeroOutput());
  uint256 _feeUnderlying = (_out * _r.feeAmount) / _amount;      // floor toward the user
  emit Unwrapped(_token, u.underlying, _amount, _out, _feeUnderlying);
  _token = u.underlying; _amount = _out; _inputBefore = underlyingBefore;
  // step 9 uses _feeUnderlying instead of _r.feeAmount; skip transfer if 0
  ```
- Steps 5 (fee vs `ENTRYPOINT.assets(share).maxRelayFee`, `feeAmount <= amount`) stay in
  **shares**, evaluated before the unwrap, so Entrypoint cap semantics are unchanged.
- Step 4 native checks: `_token != NATIVE_ASSET` always true for a share; `GasSwapNativeInput`
  check runs on the pre-unwrap token (a share is never native).
- `_sweepDust` receives the underlying as `_inputToken` with `underlyingBefore` as baseline.
- `_swapAmount = _amount - _feeUnderlying`, approved to `approvalAddress` exactly as today.

### 3.4 Errors / events (add to `IRelaySwaps.sol`)
```
error RelaySwaps_UnwrapVaultMismatch();
error RelaySwaps_UnwrapUnderlyingMismatch();
error RelaySwaps_UnwrapATokenMismatch();
error RelaySwaps_UnwrapNotPoolAsset();
error RelaySwaps_UnwrapAlreadySet();
error RelaySwaps_UnwrapNotSet();
error RelaySwaps_UnwrapRemovalNotReady();
error RelaySwaps_UnwrapZeroOutput();
event UnwrapSet(address indexed share, address indexed zap, address indexed underlying);
event UnwrapRemovalScheduled(address indexed share, uint256 removableAt);
event UnwrapRemovalCancelled(address indexed share);
event UnwrapRemoved(address indexed share);
event Unwrapped(address indexed share, address indexed underlying, uint256 shares, uint256 underlyingOut, uint256 feeUnderlying);
```

### 3.5 Interfaces
Import from `packages/contracts` via the existing `interfaces/` remapping:
`IPPYieldTokenZap` (VAULT/UNDERLYING/A_TOKEN/redeemToUnderlying), `IAToken`
(UNDERLYING_ASSET_ADDRESS), and a minimal `IERC4626Asset { function asset() view returns (address); }`.

## 4. Security analysis → mitigations (must all be covered by tests in §5)

| # | concern | mitigation |
|---|---|---|
| 1 | owner registers a malicious zap that receives the shares | `setUnwrap` cross-checks zap↔share↔aToken↔underlying and Entrypoint enablement; no overwrite. Residual = owner trust, same class as `approveRouter`. Owner → multisig (ops item). |
| 2 | registry changes between proof and relay | removal is 24h two-step; additions only affect tokens with no live path. Worst case remains a revert (LiFi `transferFrom` of the wrong token fails), never a wrong-token payout. |
| 3 | share rate moves between quote and execution | never trust calldata amounts: use realised `out`; rate up → surplus swept to proof-bound `dustRecipient`; rate down → LiFi pull exceeds approval → revert, nullifiers unspent. |
| 4 | pre-existing / donated underlying swept into this user's dust | snapshot underlying balance before `transact`; delta-only sweep; rescue-only otherwise. Zap already uses aToken deltas internally. |
| 5 | fee rounding | `out * fee / shares` floors toward the user; zero fee skips transfer; cap check stays in shares. |
| 6 | reentrancy via redeem → Aave → token transfer | `execute` is `nonReentrant`; Zap is stateless; USDC/USDT have no hooks. Test with a hook-capable mock. |
| 7 | vault inflation / donation | dead shares at 0xdEaD; donations raise `out` → surplus to user's dust recipient. |
| 8 | Aave illiquid or frozen, wrapper bug | revert; relayer simulates first. Liveness only, same as `PPRouter.withdrawToUnderlying`. Note `PPYieldToken.pause()` gates deposit/mint only — redeem is never paused, so a paused wrapper does NOT strand yield notes (fork-tested). |
| 9 | approval residue | exact-amount `safeApprove`, Zap pulls exactly that; revert unwinds. |
| 10 | share == outputToken confusion in sweep | after rebinding `_token = underlying`, `_outputToken != _inputToken` holds; snapshot of outputToken taken before transact as today. |

## 5. Test plan (`packages/swaps/contracts/test/`)

Unit (MockPool, mock Zap/aToken/wrapper): `RelaySwapsUnwrap.t.sol`
- setUnwrap: happy path; rejects wrong VAULT, wrong UNDERLYING, wrong A_TOKEN, disabled share, EOA zap, native underlying, overwrite.
- removal: schedule → too early reverts → after delay succeeds; cancel; execute on unscheduled reverts.
- execute with registered share: fee paid in underlying == `out*fee/shares`; `Unwrapped` emitted; swap sees `_amount = out - fee`.
- execute with NON-registered token: identical path (`vm.snapshotGas` / compare `gasleft` deltas against the pre-change build).
- rate up vs calldata: surplus to `dustRecipient`, recipient still gets `minOutputAmount`.
- rate down: LiFi mock pulls > approval → revert; nullifiers unspent (MockPool state).
- pre-existing underlying balance untouched.
- zero fee shares → no fee transfer; tiny fee rounding to 0 underlying → skipped, no revert.
- reentrancy: hook-capable mock underlying re-enters `execute` → `ReentrancyGuard` revert.
- B2 path with a share input: gas swap runs on the underlying.

Fork (env-gated like `RelaySwapsB2Fork.t.sol`, `UNWRAP_FORK_RPC_URL=$RPC_URL_1`): `RelaySwapsUnwrapFork.t.sol`
- real ppUSDC `0xC246…1ad6`, Zap `0x9Ea9…817B`, aEthUSDC, Aave v3, V2 PROD pool `0x0Eb4…`,
  Entrypoint `0xca1e…`; mint shares via Zap, deposit through a real proof fixture if available,
  else `MockPool` seeded with shares; execute a same-chain USDC→USDT LiFi fixture (captured with
  `scripts/b2-capture-lifi-fixtures.ts` pattern).
- fee received by relayer == `previewRedeem(feeShares)` ± 1 wei.
- paused wrapper (prank owner `0x12Db…`) → unwrap still succeeds (pause gates deposits only).

Proof binding: extend `RelaySwapsProofBinding.t.sol` — unwrap decision is NOT in the struct;
assert a registry flip after proof yields revert, not misrouting.

## 6. SDK phase (`packages/sdk`) — after contract is green

Shared helper `utils/YieldSwapInput.ts`: given a yield note, returns
`{ shares, expectedUnderlying = previewRedeem(shares), underlyingAddress, underlyingDecimals }`
and a "pessimistic" amount `expectedUnderlying * (1 - RATE_HEADROOM_BPS)` to size LiFi calldata
(rate only moves up; headroom covers block-lag rounding only).

Per session (input side, yield note as source):
- `PoolSessionWithdrawAndSwap`, `PoolSessionReshield`, `PoolSessionReshieldCrosschain`:
  when `asset` has an `underlying` (from the relayer `/details` or SDK deployment config), request
  the LiFi quote for the **underlying** amount (pessimistic), request the relayer fee quote for the
  **share** asset (relayer's `Underlying` quoter handles it), keep `feeAmount` in shares in the
  routing, validate `swapCalldata.fromToken == underlying`.
- `assertSwapCalldataMatches` gains the underlying case.

Per session (output side, land as pp-shares):
- `PoolSessionSwapDeposit`, `PoolSessionReshield(Crosschain)` when the destination asset is a
  pp-share: build the deposit proof for `shares = previewDeposit(expectedOut * (1 - slippage))`,
  encode contractCalls target = destination `PPRouter.depositExactShares(proof, noteData, asp, maxUnderlyingIn = expectedOut)`,
  `toFallbackAddress` = user-controlled address. Reuse `PoolSessionYieldDeposit` sizing.

Config: SDK deployment config gains per-chain `yield: { [share]: { router, zap, underlying } }`
(already partially present in `docs/deployments.local.json`).

Tests: unit per session (mocked LiFi + relayer), one live mainnet integration test under
`packages/swaps/test/` per flow (pattern: `mainnet-crosschain-relay-swaps-*.integration.test.ts`).

## 7. Relayer phase (`packages/relayer/relayer`)

- Nothing new for pricing: `Underlying` quoter (2026-09-04) already prices shares.
- `quoteSwap` / `relaySwap`: the commitment asset is the share, `amountSent` is shares. The zap
  passed to `executeUnwrapped` now comes from `YieldZapRegistry` (boot-derived from
  `approvedZapList()`), not `supported_assets[].zap` — see §0a "Relayer zap discovery".
- Config: new RelaySwaps address in `relay_swaps_contract` (prod + test files). `supported_assets[].zap`
  optional (cross-check only).
- **[done, PR-1]** hardening: `quoteSwap` rejects a share-asset quote with a 400 when
  `YieldZapRegistry` has no zap for the share, instead of letting the eventual `relaySwap` revert
  `RelaySwaps_InvalidZap` after a proof was spent.

## 8. Deployment / rollout

1. Contract PR merged → `forge test` + fork tests green.
2. Deploy new RelaySwaps with CREATE2 (`DeployRelaySwaps.s.sol`, new salt
   `privacy-pools-v2:RelaySwaps:prod:v2`), owner 0x0967 (→ multisig later), on mainnet + BSC
   (chains with yield wrappers). Approve LiFi Diamond + per-chain Executor + ERC20Proxy
   (`deploy.md` table). Test stack (mainnet `0x8884…` pool) gets its own instance only if yield
   wrappers are deployed there (today: no).
3. `setUnwrap` per wrapper: mainnet ppUSDC (zap `0x9Ea986Bc…817B`), mainnet ppUSDT
   (zap `0xDC3D922d…f3A5`), BSC ppUSDT (zap `0xc0FBB5D5…F766`). Verify `unwraps()` on-chain.
4. Relayer configs → new address; redeploy relayer.
5. SDK release with yield-aware sessions; frontend picks up new RelaySwaps address.
6. Old RelaySwaps `0x5936…` stays live for in-flight proofs, then is retired from configs.

## 9. Doc sync on completion

- `docs/tech-design/contracts/yield.md`: new §"Swaps: unwrap in RelaySwaps" + version bump.
- Swaps design docs (`packages/swaps/deploy.md` §5 wiring, `documentation/`): registry step.
- `docs/tech-design/sdk/yield-sessions.md`: swap flows for yield notes.
- `docs/FEATURE_BEST_PRACTICES.md` audit via `feature-standards-auditor` before calling it done.

## 9b. Implementation notes (P1/P2)

- Registry read once in step 6b (`_unwrapZap`), reused in 8b; `_unwrap()` internal keeps `execute()` under the stack limit without `via_ir`.
- `UNWRAP_REMOVAL_DELAY` is a public constant. solc 0.8.32 throws an *internal compiler error* (TypeChecker `MemberAccess` assertion) when a test calls ANY public `constant` getter through an instance (`relaySwaps.UNWRAP_REMOVAL_DELAY()`, `relaySwaps.NATIVE_ASSET()`); immutables (`POOL()`) are fine. Tests assert the delay via the scheduled timestamp instead.
- `script/SetUnwrap.s.sol` registers one (share, zap) pair; refuses if already set.
- Unit mocks: `MockZap` (rate-parameterised, `setPaused` = generic redeem-path revert), `ReentrantZap`, `MockShare`, `MockAToken`.

## 10. Open questions (decide before §3 is coded)

1. Owner of the new RelaySwaps: keep 0x0967 EOA for now, or deploy straight with a multisig?
2. `UNWRAP_REMOVAL_DELAY`: 24h proposed; relayer quote expiry is minutes, so anything ≥ 1h works.
3. Fee-in-underlying for the relayer's accounting: confirm the relayer is happy receiving USDC/USDT
   for a share-denominated commitment (it already does on the PPRouter path).
4. Should `setUnwrap` also require `ENTRYPOINT.assets(underlying).enabled`? Not needed for the
   swap path (underlying never enters the pool), so proposed: no.

## 11. Phases

- [x] P1' (2026-09-09) contract reworked to `executeUnwrapped(zap)` + `approvedZaps` (§0a); unit suite 71 (44 legacy + 27), fork suite 6/6, relayer/SDK ported
- [x] P1 contract: storage/admin/execute changes + unit tests (§3, §5 unit) — 2026-09-05, `RelaySwapsUnwrap.t.sol` (29 new cases, inherits the 44 legacy cases against the new bytecode)
- [x] P2 contract: fork test on mainnet ppUSDC (§5 fork), gas parity check — 2026-09-05, `RelaySwapsUnwrapFork.t.sol` (6 cases vs real ppUSDC/Zap/Aave/Entrypoint; run with `UNWRAP_FORK_RPC_URL=https://ethereum-rpc.publicnode.com`). Legacy-path gas overhead +1.8–2.3k (one cold `unwraps[]` SLOAD + code size): `test_Execute` 198,062 → 199,917; `test_ExecuteWithRelayFee` 217,751 → 220,037.
- [x] P3a (2026-09-10, PR-1) relayer derives the zap allowlist from the contract at boot
  (`YieldZapRegistry` off `approvedZapList()`), `supported_assets[].zap` demoted to an optional
  cross-check, `quoteSwap` 400s a share with no derived zap. Contract: solady
  `EnumerableSetLib` backing `approvedZaps` + `approvedZapList()` view (+2 unit cases, 73 total).
- [ ] P3 deploy + registry + relayer config (§8 steps 2–4)
- [x] P4 SDK input side (yield note → swap) — 2026-09-05, `PoolSessionWithdrawAndSwap`; 2026-09-10 (PR-2) `PoolSessionReshieldCrosschain`; 2026-09-10 (PR-3) `PoolSessionReshield`. `yieldWrappers` config (factory wires `yieldDeployments` + one source-chain `PPYieldTokenInteractor` each), LiFi quoted on `underlying` for `previewRedeem(net shares)`, relayer quoted on the share, budget/dust (and the B2 gas swap, crosschain only) checked/sized in underlying units against `previewRedeem(committed net shares)`, `isCrossAsset` compares underlying vs output, pre-proof `RelaySwaps.approvedZaps(zap)` check (`RELAY_SWAPS_APPROVED_ZAPS_ABI`), `swapInputToken` on the prepared quote / estimate. Shared helper `utils/YieldSwapInput.ts` (`yieldWrapperFor` / `assertZapApproved` / `previewRedeemNet`). Unit cases: +6 reshield-crosschain (39 total), +5 same-chain reshield (43 total).
- [ ] P5 SDK output side (land as pp-shares via contractCalls → PPRouter)
- [x] P6 forked e2e GREEN 2026-09-05 (standalone run confirmed by user, tx 0x4feb98e3…): 25 USDC → 24.87 ppUSDC via real PPRouter → `prepareSwapQuote` (relayer fee in shares via `Underlying`, LiFi on USDC) → `relayWithdrawAndSwap` → RelaySwaps unwrap + LiFi → 22.5 USDT to user, 2.2 USDC fee to relayer, `Unwrapped` event, zero residue. Harness gotchas fixed on the way: forge `--json` multi-line parse; `deploymentBlock` must be hex and the real V2 PROD deploy block (25,884,330) with an archive upstream (publicnode refuses historical logs); relayer honours `RPC_URL_<id>` env AND its dotenv loads `.env` from cwd → spawn from the relayer package dir with RPC/SIGNER env stripped; fresh user key per run (deterministic note labels collide across runs on one fork); stale relayer on the port must be killed. Live SDK/relayer/contract doc sync still to do (§9). Sketch written 2026-09-05: `packages/swaps/test/live-relayer-mainnet-yield-unwrap-forked.integration.test.sketch.ts` (+ `vitest.yield-forked.config.ts`, `setUnwrapOnFork` helper). Anvil mainnet fork → new RelaySwaps + LiFi periphery + `setUnwrap(ppUSDC, zap)` → POSTMAN_ROLE granted to anvil #0 via `anvil_setStorageAt` on the OZ AccessControl slot → local relayer spawned on a generated mainnet-only config (prod shape: `Underlying` quoter, `allowed_processors`) → real `PPRouter.depositExactShares` → `prepareSwapQuote`/`relayWithdrawAndSwap` on the share note → asserts USDT out ≥ min, USDC fee to relayer, `Unwrapped` event, no residue. Run: `YIELD_FORKED_CONFIRM=yes npx vitest run --config vitest.yield-forked.config.ts <file>`; upstream defaults to publicnode.
