# Swaps PR #333 — Six-Lens Review Synthesis

**Reviewed at:** PR head `7a0b764e` (branch `review/swaps-333`, off `fat/merging_swaps_into_v2features`),
five lenses in parallel + hand verification of the Medium+ findings.

**Scope:** the LiFi-backed swap feature — a new `packages/swaps/` package (`RelaySwaps.sol`), three SDK
sessions (`PoolSessionWithdrawAndSwap`, `PoolSessionSwapDeposit`, `PoolSessionReshield`), a
`LiFiSwapQuoteProvider`, and relayer swap endpoints (~41 files, ~15.7k additions). The PR had already
been through prior audit rounds (it references "Finding A", "H3").

## Per-lens verdicts

| Lens | Verdict | Report |
|------|---------|--------|
| RelaySwaps contract audit | **LOW** — proof-binding CONFIRMED SOUND; no Crit/High/Med | `audit/swaps_relayswaps_r1.md` |
| SDK+relayer audit | **MEDIUM** (worst) — no Crit/High | `audit/swaps_sdk_relayer_r1.md` |
| Code review + coherence | **APPROVE-WITH-CHANGES** — zero SwapRouting tuple drift | `code-review/swaps_full_r1.md` |
| User-flow matrix + SDK comprehension | **DONE-WITH-GAPS** — no ❌ (all flows reachable) | `feature-check/swaps_userflows_matrix.md` |
| Test-gap | broad coverage; 1 High + 4 Medium gaps | `test-gap/swaps_full_r1.md` |

## Security posture

**Fundamentally sound.** The crux — the full LiFi `swapCalldata` + all 11 routing fields are committed
in the proof `context` — is CONFIRMED against `PoolVault.sol:143-149` (processor==msg.sender +
context==keccak256(abi.encode(transactParams,noteData))); the contract forwards the SAME decoded struct
to `POOL.transact`, `msg.value` is pinned `== nativeGas`, so a malicious relayer can change nothing. The
`SwapRouting` tuple is byte-for-byte identical across the contract struct, the relayer ABI, and the SDK
constant (zero drift). All flows are reachable through the public SDK. Reentrancy (nonReentrant + CEI),
the ERC20 approve-scope-and-reset, and the delta-based dust sweep's persistent-balance protection all
verified safe. Worst finding is a Medium value/privacy leak (M-1), not a theft.

## Findings (hand-verified where marked ✓)

### Medium
| ID | Lens | Verified | Summary + fix |
|----|------|----------|---------------|
| **M-1** | sdk audit | ✓ | Reshield input dust routes to the relayer by default and is unbounded (`PoolSessionReshield` `dustRecipient ?? relayerInfo.address`; LiFi is fixed-output so `net − lifiFromAmount` accrues to `dustRecipient`; the 1% buffer + any fee under-quote leak to the relayer). Withdraw-and-swap is fixed-input → no leak. Fix options: change/require an explicit `dustRecipient` for reshield, tighten the buffer, or document + warn. (Design change on the author's PR — recommend documenting + surfacing unless the author wants the default changed.) |
| **D-1** | user-flow | ✓ | swap-and-deposit doc↔schema drift: `pool-session.md` documents `{fromToken,toToken,fromAddress,toChainId}` but the Zod schema requires `{fromChainId,inputToken,depositToken,depositAmount}` — coding to the doc gets a Zod rejection. Fix: align the doc to the schema. |
| **G1** | test-gap | ✓ | `PoolSessionSwapDeposit` (the swap-and-deposit flow) has NO test file; `prepareSwapAndDeposit`/`executeSwapAndDeposit`/`swapAndDeposit` never execute in tests. Fix: add a unit test. (High per test-gap.) |
| **G2** | test-gap |  | `LiFiSwapQuoteProvider.getSwapQuote`/`getSwapAndDepositQuote` parsing untested off-chain (only `getSwapStatus` is); two real response fixtures sit unused. Fix: fixture-replay parse tests. |
| **G5** | test-gap |  | Proof-binding tamper-tested on only 2 of 11 routing fields (via a keccak-mirror mock, not real Groth16). Fix: tamper-test the remaining fields at the mock layer (real-proof is gated). |
| **G3** | test-gap |  | Output-token dust-sweep branch untested; delta-only parallel-safety never asserted (both sweep tests start from zero balance — a full-drain regression would pass). Fix: add a nonzero-starting-balance sweep test. |
| **G4** | test-gap |  | Relayer `quoteSwap` committed blob not asserted to carry swapTarget/approvalAddress/outputToken/swapCalldata/dustRecipient (TEST-8). Fix: assert blob field survival. |

### Low / cleanliness
| ID | Lens | Verified | Summary |
|----|------|----------|---------|
| **L-2** (audit) | sdk audit | ✓ | `feeRecipient` (field 5/11) is the one routing field never asserted SDK-side — contradicts the "field-by-field" invariant. Cheap fix: add the assert in both sessions. |
| **L-1** (audit) | sdk audit |  | LiFi echo cross-check is self-reported (`step.action.*`), never parses the proof-bound calldata; cross-chain recipient is never verified — a compromised LiFi could redirect it undetectably. Fix: correct the doc's overclaim; on-chain fix infeasible. |
| **L-3/L-4** (audit) | sdk audit |  | Relay-time same-chain `nativeGas` unchecked in the hand-built path; `relaySwap` omits a `feeAmount<=maxRelayFee` re-check the batch/quote paths have. On-chain still enforces both → gas-waste only. Cheap defense-in-depth. |
| **S-3** (contract) | contract audit | ✓ | `renounceOwnership()` inherited un-overridden — the owner can permanently freeze the router allowlist (can't remove a compromised router). Fix: override to revert. |
| **S-1/S-2** (contract) | contract audit | ✓ | Router-allowlist vetting is load-bearing + undocumented in-contract; no admin rescue for stranded funds (leg-1 refunds / stray ETH — stuck-not-stealable). Accept as documented limitations. |
| **CR-1** | code-review |  | Routing ABI defined 3× across the wire boundary — relayer should import the SDK constant (latent drift risk; identical today). |
| **CR-2** | code-review |  | 5 validator privates copy-pasted between WithdrawAndSwap + Reshield sessions. |
| **CR-8** | code-review |  | `packages/swaps/package.json` is boilerplate (declares nonexistent `src/main.ts`, unused NestJS/express deps, "via Intents" description, `test:unit` matches zero files). |
| **CR-3/4/5/6/7, CR-9** | code-review |  | `forge fmt` fails; `SwapRouting` struct in contract not an interface; non-`_camelCase` params; dead `changeOwnership` wrapper; unnamed Ownable import; orphaned committed fixtures (`full_swap_response.json`, `.http`, `deploy-v0.1.json`) — gitignore + a placeholder anvil key (not a real secret). |
| **dead code** | test-gap/review | ✓ | `RelaySwaps_InvalidCalldata` declared but never thrown. Remove. |
| **D-2 / B-1** | user-flow |  | swap-and-deposit has no `slippage` override; no self-submit for withdraw-and-swap/reshield (relayer-only) — undocumented as a limitation. |

## Notes
- This is @p0ro70's PR, currently CONFLICTING with `v2.0-features` (needs a rebase — the author's job).
  Our review branch `review/swaps-333` is off the PR head; patches here go back as a PR into the author's
  branch.
- Nothing here blocks on a security basis. The high-value patches are the test gaps (G1/G2/G5/G3/G4) and
  the cheap correctness/hygiene fixes (L-2, S-3, dead code, D-1 doc). M-1 and the DRY/structural items
  (CR-1/CR-2/CR-8) are judgment calls better confirmed with the author or the requester before editing.
