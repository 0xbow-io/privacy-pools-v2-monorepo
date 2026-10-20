# Privacy Pools V2 — `v2.0` Feature Audit — Auditor Handoff

> **Status: complete.** All four quality-loop passes ran; the consolidated findings register is at
> [`output/security/SECURITY_FINDINGS.md`](security/SECURITY_FINDINGS.md). Converged test counts:
> contracts **444/444 unit**, batch **3/3** + register **2/2** + yield **24** real-proof integration;
> SDK **1318 pass / 8 skip**; relayer **72 pass / 4 skip**. Fork integration needs an archive
> `MAINNET_RPC` (see §3).

## 1. What this is
An internal audit of the four features added to `v2-monorepo` on branch `v2.0` (HEAD `d91112f2`), on
top of base `72886c12`, prepared for external human auditors. All audit work is on branch
`audit/v2.0-features`; every finding, with evidence, is filed under `agents/output/**` (start at
[`agents/README.md`](../README.md) and [`output/INDEX.md`](INDEX.md)).

## 2. Scope — the four features
| # | Feature | PR | Surface | Design doc |
|---|---|---|---|---|
| 1 | Relayed registration | #310 (`0fb6ffcd`) | contracts | `tech-design/contracts/contracts-tech-design.md` §3/§5; rationale in `future-ideas/relayed-key-registration.md` |
| 2 | Yield farming (ppUSDC) | #315 (`1beea313`) | contracts + SDK | `tech-design/sdk/yield-sessions.md` (contracts doc **was missing** — see contracts pass) |
| 3 | Batch transactions | #316 (`2398d737`) | contracts + SDK + relayer | `tech-design/contracts/batch-withdrawal.md`, `tech-design/sdk/batch-withdraw.md` |
| 4 | Stealth addresses | #317 (`d91112f2`) | SDK only | `tech-design/sdk/stealth.md` (**written during this audit**; shipped with none) |

Circuits: **unchanged** by all four features (verified `git diff --numstat 72886c12..d91112f2 --
packages/circuits` = empty). Batch reuses the Transact circuit; stealth is off-chain secp256k1; yield
is an ordinary ERC-20 tokenId; relayed registration verifies the EIP-712 sig in Solidity.

## 3. How to build & test (a cold auditor, from scratch)
```bash
pnpm install
# Contracts (Foundry)
cd packages/contracts
cp .env.example .env      # set MAINNET_RPC + SEPOLIA_RPC to ARCHIVE endpoints (fork tests need them)
forge build
forge test --match-contract Unit           # mock-proof unit suite
forge test --match-contract Integration     # real-proof, forks mainnet at the pinned block
forge test --match-contract Invariant       # property/fuzz campaign
# SDK (vitest)  → 1318 pass / 8 skip (gated)
pnpm --filter sdk test
# Relayer (jest) → 72 pass / 4 skip
pnpm --filter @privacy-pools-v2/relayer test    # (nested at packages/relayer/relayer)
```
See [`docs/TESTING_GUIDE.md`](../../docs/TESTING_GUIDE.md) for the real-proof-vs-mock bar and CI
selection rules. **Fork tests require an archive `MAINNET_RPC`** (pinned block in
`IntegrationBase.t.sol`); without it they fail in `setUp` — an env gate, not a code failure.

## 4. Trust assumptions & privileged surface (for the threat model)
- **Relayer signer** — signs EIP-712 fee commitments; any address in the `allowed_processors` config
  gets `simulateContract`+`writeContract` from the signer (bound into the user's proof context, all
  calls simulated first). Unauthenticated HTTP endpoints (bounded by `MAX_BATCH`).
- **Keystore** — UUPS-upgradeable; `setAuthPolicyWithSig` is permissionless (EIP-712 gated);
  `initializeEIP712` is a `reinitializer(2)`. _[access-control detail pending contracts_r1]_
- **Yield** — `PPYieldToken` is `Ownable2Step`: owner sets fee (≤20%), `rewardsController` (external
  call target), can `rescueToken` (non-asset), pause. Aave v3 is a trusted external protocol.
- **ASP registry** — compliance authority (latest-root gate), trusted by design.
- **No `delegatecall`** in the new contracts (only OZ UUPS proxy machinery, unchanged).

Consolidated threat model: [`output/security/CROSS_FEATURE_THREAT_MODEL.md`](security/CROSS_FEATURE_THREAT_MODEL.md)
and `output/security/SECURITY_FINDINGS.md`.

## 5. Deployment status (important context)
- Current on-chain deployment record is `sepolia-deployment-v9.md` (block 10_932_483), which
  **predates all four features** — there is no v10, so **none of relayed-registration / yield / batch /
  stealth is reflected in any published deployment**. The SDK's pinned deployment
  (`packages/sdk/src/constant/deployments.ts`) and the integration-test fork block reference v9.
- `docs/deployments.local.json` is an ephemeral local-anvil record only.

## 6. Prior audit trail (external)
Commit/branch names reference an external auditor's numbered findings (`audit-47`, `audit-93-54`,
`audit-h34-…`, severity prefixes l/m/h). **That report is not committed to this repo** and there is no
findings register mapping the IDs — reconstructing which were fixed requires reading the merge history
(PRs ~#275–#298). This is a handoff gap flagged for the team. The internal
`FEATURE_BEST_PRACTICES.md` + `.claude/agents/feature-standards-auditor.md` + the `agents/output/`
reports are the closest thing to a definition-of-done and remediation record.

## 7. Findings Register
The full severity-ranked, cross-package register is
**[`output/security/SECURITY_FINDINGS.md`](security/SECURITY_FINDINGS.md)**. Summary of the
fund-safety-relevant outcomes:
- **Fixed & verified:** zero-recipient burn (C-1), `MAX_BATCH<rootHistorySize` (C-2), the 3
  never-compiling integration tests, 46 mis-selected tests, the 2 Entrypoint fuzz failures
  (test-harness bug, not a contract bug), stealth schemeId collision; relayer batch-quote signing DoS
  (SEC-1) and `minUnderlyingOut=0` (SEC-2) hardened.
- **Remediated (branch `v2.0-features`, 2026-07-08):** H-1 (yield real-proof E2E now runs `src/`,
  vendored copies removed), C-7 (zap balance-delta accounting), C-6/L-6 (fork deploy via factory), N-2
  (`_fee` → `FeeCalculator`), C-8 (`setAuthPolicyWithSig` EIP-712 `deadline` + `registerAndRelay`), F-1
  (SDK relayed-yield `processorAddress`), MED-1 (batch e2e drives the SDK orchestrator), the TEST gaps
  (`relayBatch`/`registerAndRelay` invariant handlers + `PPRouter`/`Zap`/factory invariants), and E2E
  (real-proof `BatchWithdrawOrchestrator.prepareBatchWithdraw`), and TREE (conforming bulloak trees for
  `PPRouter`/`PPYieldTokenFactory`; `PPRouter.t.sol` split into 3 per-contract files). See
  `output/security/SECURITY_FINDINGS.md` for per-finding commit hashes.
- **Deferred:** stealth M-1 (atomic announce+withdraw transport — needs a new on-chain aggregator) and M-2
  (canonical EIP-5564 scheme) are out of scope this pass.
- **Still open:** C-9 (BENIGN), airdrop AIR-1/2/3 (pre-implementation design-blockers).
- **Design-blockers (pre-implementation):** airdrop mint-entrypoint / tree-completeness / claim-nullifier
  (3 blockers, `AIRDROP_DESIGN_REVIEW.md`).
- **Key cross-feature result:** the batch×yield attack surface is **zero** (processor mutual-exclusion).
