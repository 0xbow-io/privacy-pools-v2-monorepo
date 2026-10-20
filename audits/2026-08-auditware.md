# Privacy Pools v2 — Code Security Review

*Auditware · Version 1.0*

## Review Summary

The Auditware team has performed a re-audit of 0xbow's Privacy Pools V2, focused on the changes introduced since the previous review.

The audit commit hash was `71263ca8`.

Retest commit hash: `38c16e7`.

Extra focus was directed at five new feature areas:

- the Aave yield wrapper
- batch transactions
- proof-context binding that constrains the relayer
- cold-start relayed registration
- stealth addresses.

During the audit we reviewed the contracts using various industry tools, AI, and thorough manual review. The review surfaced **Medium** and **Low** findings. No critical issues were found during the engagement. All findings can be shown in detail in the Findings Overview below.

As with most protocols, it is highly recommended to:

- Conduct regular and thorough internal and external audits to identify and mitigate vulnerabilities.
- Achieve the highest possible test coverage, ideally approaching 100%.
- Continuing to maintain comprehensive and up-to-date documentation, ensuring code-to-docs compliance.
- Participate in auditing contests and/or a bug bounty program.
- Implement on-chain monitoring for real-time threat detection and mitigation.

## Findings Overview

| Finding | Components | Trust Boundary | Risk Level | Status |
| --- | --- | --- | --- | --- |
| **AW-M-01:** Ungovernable mainnet deployment via unreachable config validators on the production broadcast path | Deploy scripts, ChainConfigRegistry | Deployer | Medium | Fixed |
| **AW-L-01:** Relayer gas-drain and cold-start liveness gap via public-RPC predicted-root submission | Relayer, Keystore, PrivacyPoolRelay | Relayer infra | Low | Acknowledged |
| **AW-L-02:** Local note-state corruption via unverified receipt acceptance | SDK (pool sessions) | Relayer to client | Low | Fixed |
| **AW-L-03:** Withdrawal denial via unguarded fee-leg liquidity shortfall in the yield withdraw path | PPRouter, PPYieldTokenZap | Aave (external dependency) | Low | Acknowledged |

## AW-M-01: Ungovernable mainnet deployment via unreachable config validators on the production broadcast path

**Severity:** Medium · **Status:** Fixed

**Retest notes (25.8.2026):**

**Partially addressed.** `Deploy.run()` now validates config before broadcast and rejects all mainnet placeholders (`Deploy.s.sol:95-97`), but the `runStaging()` path skips the validators and can still deploy mainnet from placeholder governance (`DeployStaging.s.sol:26-65`), and threshold > 1 is not enforced.

**Locations:**

- `packages/contracts/script/Deploy.s.sol:101-127` - the broadcast path
- `packages/contracts/script/Deploy.s.sol:130-136` - the test-only entrypoint
- `packages/contracts/script/helpers/DeploymentVerifier.sol` - the validators that are never called
- `packages/contracts/script/registries/ChainConfigRegistry.sol` - placeholder mainnet governance roles

**Description:**

The deployment tooling ships a `DeploymentVerifier` library whose validators reject placeholder and precompile role addresses before a deployment is accepted.

During the audit it was found that the broadcast path, where `run()` calls `fullDeploy()`, invokes none of these validators (while they do run in the test suite and a standalone verification script). The mainnet config that path consumes still holds placeholder governance, marked with TODOs.

Although broadcasting is a privileged, one-time action and mainnet is not yet live, an operator who launches before the config is replaced might deploy an ungovernable protocol with no mechanical check to stop them, recoverable only by a full redeploy. That unrecoverable failure state is why it is rated Medium despite the Low probability.

**Recommendations:**

- Invoke `validateSystemConfig`, `validateGovernanceConfig`, and `validateChainAssets` at the top of `fullDeploy` before any broadcast, and `verifyDeployment` and `verifyAssets` as a post-deploy assertion, so an invalid config reverts the run on the production path, not only in tests.
- Populate the mainnet config with the real multisig, operator, and postman addresses, and raise the Safe threshold above 1.
- Convert the skipped mainnet-deploy safety test into a required CI gate.

## AW-L-01: Relayer gas-drain and cold-start liveness gap via public-RPC predicted-root submission

**Severity:** Low · **Status:** Acknowledged

**Retest notes (25.8.2026):**

**Acknowledged.** Team received and acknowledged the issue and no mitigation was applied at this time. The relayer still submits the bundle over public RPC, so a competing registration can revert it and drain relayer gas. No user funds at risk.

**Locations:**

- `packages/relayer/relayer/src/chain.service/evm.chain.service.ts` - public RPC submission
- `packages/contracts/src/contracts/PrivacyPoolRelay.sol:83`
- `packages/contracts/src/contracts/Keystore.sol:181-187` - permissionless append, root-window check
- `packages/contracts/src/contracts/PoolVault.sol:355` - keystore-root membership gate

**Description:**

Relayed registration lets a fresh, unfunded address register and withdraw in one atomic bundle. Its withdrawal proof must anchor to a keystore root that only exists after its own leaf is inserted, so the SDK predicts that root by appending the leaf.

However, because the tree is append-only and `setAuthPolicy` is permissionless, any other registration landing first shifts the leaf index and invalidates the prediction.

During the audit it was found that the design's intended mitigation, submitting the bundle through private orderflow so a stale prediction is discarded before inclusion, is not implemented and the relayer submits over a plain public RPC.

Although no user funds are at risk, an actor who spams cheap registrations might repeatedly revert the bundle and burn the relayer's gas, leaving the one-transaction cold-start intermittently unavailable until it retries.

**Issue Flow:**

- A fresh, unfunded address requests a cold-start register-and-withdraw bundle.
- The SDK predicts the keystore root that will exist once this address's own leaf is appended, and builds the withdrawal proof against it.
- The bundle is submitted over a public RPC and waits in the mempool where it is visible.
- An observer submits a cheap competing registration that is included first, shifting the leaf index and invalidating the predicted root.
- The bundle reverts on-chain and the relayer pays gas for the reverted transaction; repeating this keeps the one-transaction cold-start path intermittently unavailable.

**Recommendations:**

- Implement the intended private-orderflow, protected transport for the `registerAndRelay` bundle so a stale-root revert is discarded pre-inclusion at no gas cost.

## AW-L-02: Local note-state corruption via unverified receipt acceptance

**Severity:** Low · **Status:** Fixed

**Retest notes (25.8.2026):**

**Resolved.** The wallet now re-reads the receipt from its own RPC and marks notes spent only after confirming the real pool emitted `Transacted` events consuming every expected nullifier, else it persists nothing. Applied to all relayed paths.

**Locations:**

- `packages/sdk/src/services/poolSessions/PoolSessionBatchWithdraw.ts:132-140`

**Description:**

The relayed batch-withdrawal flow submits a batch, receives a transaction hash from the relayer, waits for that receipt, and on any successful status marks every selected note spent in local storage.

It was found that nothing verifies the confirmed transaction actually executed the batch or spent its nullifiers. The client trusts the relayer-supplied hash and the receipt status alone, and the same trust pattern is present on the single-withdraw path. Although the on-chain state is untouched, a relayer that returns the hash of an unrelated successful transaction might make the wallet treat spendable notes as spent.

**Recommendations:**

- After confirmation, parse the receipt's `Transacted` and `RelayedBatch` logs and confirm each item's nullifier hashes are present, and that the emitting contract is the expected pool, before persisting any note-state transition.
- Apply the same check to every relayed-withdraw path.

## AW-L-03: Withdrawal denial via unguarded fee-leg liquidity shortfall in the yield withdraw path

**Severity:** Low · **Status:** Acknowledged

**Retest notes (25.8.2026):**

**Acknowledged.** Team received and acknowledged the issue and no mitigation was applied at this time. The fee leg still runs an unguarded raw Aave withdraw after the recipient leg (`PPRouter.sol:209-210`, `PPYieldTokenZap.sol:132`), so a shortfall between the two amounts reverts the whole withdrawal. No funds at risk.

**Locations:**

- `packages/contracts/src/contracts/PPRouter.sol:202-210` - recipient leg first, fee leg unguarded
- `packages/contracts/src/contracts/PPYieldTokenZap.sol:132`

**Description:**

A yield withdrawal unwraps the recipient leg and the relayer-fee leg through Aave in one atomic transaction, and Aave's pool withdraw reverts rather than partially filling when the reserve lacks free liquidity.

It was found that the recipient leg is redeemed first and the fee leg then runs unguarded, so when free liquidity sits between the recipient amount and the recipient-plus-fee amount, the fee leg reverts and takes the already-successful recipient payout down with it.

Although this needs Aave's reserve near full utilization, which is very rare, an affected holder might be unable to withdraw to underlying until liquidity returns.

**Issue Flow:**

- Aave's reserve for the underlying asset sits near full utilization, leaving limited free liquidity.
- A holder withdraws from the yield wrapper to the underlying asset, which unwraps in two legs within one atomic transaction.
- The recipient leg redeems first and succeeds, consuming most of the remaining free liquidity.
- The fee leg then attempts its redemption, free liquidity is insufficient, and Aave reverts rather than partially filling.
- Because the transaction is atomic, the already-successful recipient payout is rolled back and the holder cannot withdraw until liquidity returns.

**Recommendations:**

- Cap the fee-leg withdraw at available liquidity, or let the fee leg fail gracefully rather than revert, so a shortfall on the smaller fee conversion cannot block the recipient payout.

---

This report was produced by Auditware for 0xbow based solely on the information provided by 0xbow. Auditware provides no guarantees as to the accuracy of the contents of this report and does not make any guarantees that following the advice within will prevent security incidents or issues.

Auditware is available for questions or comments about any of the contents of this report. We can be reached at https://auditware.io/ or by email at joe@auditware.io.
