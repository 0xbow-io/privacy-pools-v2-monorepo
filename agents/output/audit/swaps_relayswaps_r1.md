# Security Audit — `RelaySwaps` (round r1, independent)

**Commit:** `7a0b764e` · **Branch:** `review/swaps-333` · **Scope:** `packages/swaps/contracts/src/RelaySwaps.sol` (365 lines)
**Auditor role:** adversarial single-contract audit (AUDIT_AGENT.md). Prior rounds referenced "Finding A" / "H3"; this is an independent pass.

## What I ran / read
- Read the full contract, `RelaySwaps.t.sol`, `RelaySwapsProofBinding.t.sol` (incl. `ContextBindingPool`), `MockPool` deploy scripts, `ProofLibV2.sol`, and the **real** `PoolVault.transact` (PoolVault.sol:137-203) + `_transferAsset` (401-407).
- Read the design doc `docs/tech-design/sdk/withdraw-and-swap.md` (intended security model).
- Confirmed `Constants.NATIVE_ASSET = 0xEeee…EEeE` (utils/Constants.sol:7) == the contract's hardcoded sentinel (RelaySwaps.sol:130).
- **Did not run forge** (deps not vendored for this package); verified properties by tracing code + reading the shipped tests, which exercise the tamper-rejection path against a pool mock that mirrors PoolVault's context check.

## Verdict
**Worst severity: LOW.** No Critical/High/Medium confirmed. The core security claim holds: every field the contract acts on is inside the proof-bound blob, and the router allowlist + strict `msg.value` pin close the on-chain tamper surface. The residual findings are governance/availability (no rescue path, renounceable ownership) and hardening/informational notes. Prior rounds (Finding A, H3) closed the genuinely exploitable gaps; I could not construct a new exploit.

---

## Proof-binding integrity — CONFIRMED SOUND (the crux)
The contract decodes `SwapRouting` from `_transactParams.data` (line 212) and forwards the **same** `_transactParams` struct into `POOL.transact` (line 276). PoolVault enforces both halves of the binding:
- `require(_transactParams.processor == msg.sender)` (PoolVault.sol:143) — processor must be `RelaySwaps`.
- `require(_proof.context() == keccak256(abi.encode(_transactParams, _noteData)) % FIELD)` (PoolVault.sol:147).

So `swapTarget`, `approvalAddress`, `outputToken`, `recipient`, `feeRecipient`, `dustRecipient`, `feeAmount`, `minOutputAmount`, `nativeGas`, and the full `swapCalldata` are all committed in the proof. `_token`/`_amount` come from `amountOut`/`tokenIdOut` public signals (also proof-verified). The only relayer-controlled input is `msg.value`, which is pinned by `require(msg.value == _r.nativeGas)` (line 236) — a strict `==`, so the relayer cannot over-fund to later harvest via the dust sweep. **The relayer cannot change any routing field without invalidating the proof.** No field the contract acts on lives outside the proof-bound data. `RelaySwapsProofBinding.t.sol` exercises calldata/target/noteData tamper → `ContextMismatch`.

## Dust sweep, minOutput, fee accounting — traced and sound
- **Persistent-balance protection.** `_ethBefore = balance − msg.value` (257), `_inputBefore`/`_outputBefore` snapshot pre-`transact` (261-265). Sweep sends only `now − before` (344-362). ETH accounting for native-input+fee+nativeGas nets exactly to the persistent baseline, so nothing but genuine swap refund dust is swept. Persistent funds can never be swept to `dustRecipient` (which is proof-bound anyway). Confirmed via the accounting identity and `test_SweepETHDust`/`test_SweepInputTokenDust`.
- **minOutput** snapshots recipient balance (267-273) and re-checks delta after the swap (308-316), gated identically on `recipient != 0 && minOutputAmount > 0`. Reshield/cross-chain sentinel (`recipient == 0`) forces `nativeGas == 0` and `minOutputAmount == 0` (241-247). Sound.
- **No underflow:** `_swapAmount = _amount − feeAmount` guarded by `feeAmount <= _amount` (254).

---

## Findings

### S-1 · LOW · Router allowlist is the sole on-chain guard for arbitrary calldata + ETH
`swapTarget.call{value}(swapCalldata)` (298 / 302) forwards fully arbitrary, proof-bound calldata (and ETH) to an allowlisted address; there is zero on-chain inspection of what it does. The allowlist is the only structural defense. If the owner ever allowlists a broad-surface router (a general multicall/diamond facet that can move the caller's approved balances or its transient ETH), a maliciously-shaped calldata could misroute the contract's in-flight funds. **Not relayer-exploitable** (calldata is proof-bound; the relayer can't craft it) and **not third-party-exploitable** (only the user, who proof-binds their own LiFi calldata, could self-harm). This is an accepted architectural trust boundary (documented at withdraw-and-swap.md:199), but the owner's vetting duty is load-bearing and undocumented in-contract.
**Fix:** document the owner invariant "allowlist only minimal-surface, non-multicall swap targets"; consider a per-router capability note in NatSpec. No code change strictly required.

### S-2 · LOW · No admin rescue path — stranded funds are permanently locked (availability, not theft)
The delta-only sweep never touches the persistent balance and there is no `rescue`/`sweep`/`withdraw` admin function. Any funds that land outside a single atomic `execute` are stuck forever: leg-1 bridge refunds to the contract (documented, withdraw-and-swap.md:165), stray ETH via the open `receive()` (170), and fee-on-transfer remainders. **Confirmed funds-stuck, not stealable** — a delta sweep can only move what a *later* `execute` adds above its own baseline, and nothing lets a third party extract the persistent balance. Matches the documented known limitation ("admin rescue planned in a separate PR").
**Fix:** ship the planned `onlyOwner` rescue (guarded, event-emitting). Until then the stranding is real; keep it flagged.

### S-3 · LOW · Ownership is renounceable → router allowlist can be permanently frozen
`changeOwnership` (191) merely wraps OZ `transferOwnership`, but the inherited public `renounceOwnership()` is not overridden. An owner that renounces (or transfers to a dead address) makes `approveRouter`/`removeRouter` uncallable forever — no new routers can be added and, critically, a **compromised router can never be removed** (its allowlist entry becomes immutable). Governance/availability risk.
**Fix:** `function renounceOwnership() public override onlyOwner { revert(); }` or document the operational prohibition. Consider a 2-step owner transfer (`Ownable2Step`) to avoid the dead-address footgun.

### S-4 · INFO · minOutput snapshot taken before fee payment (defense-in-depth gap)
The recipient snapshot (267) precedes fee payment (279-286). If `feeRecipient == recipient` **and** `inputToken == outputToken`, the fee credit inflates the measured output delta, weakening the slippage floor. **Not exploitable:** all fields are proof-bound, the SDK never emits this config, and input==output is a degenerate swap; only self-harm. Purely a hardening note.
**Fix:** move the recipient snapshot to immediately before the swap call (after step 9), so the delta measures swap output only.

### S-5 · INFO · minOutput delta can revert with an opaque panic instead of `RelaySwaps_InsufficientOutput`
`_recipientOutputAfter − _recipientOutputBefore` (313) underflows (panic 0x11) if a contract-recipient's outputToken balance decreases mid-tx. Safe-fail, but a confusing error.
**Fix:** compute with a guarded subtraction and revert `RelaySwaps_InsufficientOutput` when after < before.

### S-6 · INFO · `execute()` is permissionless (by design)
No caller gating. A front-runner can spend the proof's nullifiers early: the user's swap still completes and the (proof-bound) `feeRecipient` relayer is still paid, but the relayer's own pending tx then reverts (nullifier already spent), wasting its gas. No theft; standard for relayed privacy pools, mitigated by the private-orderflow submission model already in the design.

### S-7 · INFO · Fee-on-transfer / rebasing input tokens are unsupported, fail closed
Fee payment and approval both assume the full `_amount` was received. A short receipt makes the fee transfer or the swap's `transferFrom` revert → whole tx reverts → pool not drained. Document the token assumption.

### S-8 · INFO · Unbounded fee when `maxRelayFee == 0` (accepted)
Line 252 allows any `feeAmount` when the asset has no configured `maxRelayFee`, bounded only by `feeAmount <= _amount` (254). `feeAmount` is proof-bound + SDK-validated; the deliberate absence of an SDK percentage cap for unconfigured assets is documented (withdraw-and-swap.md:257,269). Not on-chain exploitable by the relayer.

### S-9 · INFO · Constructor / `approveRouter` accept `address(0)`
`approvedRouters[address(0)]` could be set `true`, but `swapTarget`/`approvalAddress == 0` is rejected at execute (215-216), so it is unusable. Cosmetic; add a zero-check for hygiene.

---

## Paths checked and found SAFE (with reason)
- **Reentrancy:** `execute` is `nonReentrant`; the only mutable state is `approvedRouters` (owner-only). PoolVault.transact has already returned before the swap, and re-entry into `execute`/owner fns is blocked. CEI: fee (step 9) precedes swap (step 10), but a swap revert reverts the whole atomic tx, rolling back the fee. No cross-function reentrancy.
- **ERC20 approval window:** scoped to `_swapAmount`, reset to `0` in the same tx (301-304); a partial-fill leftover is reset; a revert rolls back the approval. No lingering allowance. `test_ApprovalResetAfterSwap` confirms.
- **`msg.value` harvesting:** strict `== nativeGas` prevents the relayer over-funding to sweep the excess.
- **Native vs ERC20 asymmetry:** native path validates `approvalAddress` (allowlisted) though it doesn't use it — harmless, keeps the invariant uniform.
- **Leg-1 bridge stranding:** confirmed funds-stuck-not-stealable (see S-2).

## Recommendation
Ship as-is is acceptable for the exploitable-surface bar. Before mainnet, prioritize **S-3** (override `renounceOwnership`) and land the **S-2** rescue function; treat S-1 as an operational invariant to document. Nothing blocks on a Critical/High/Medium.
