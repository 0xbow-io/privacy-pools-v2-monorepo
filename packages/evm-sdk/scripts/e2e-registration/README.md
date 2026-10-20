# Relayed keystore registration — local E2E

A live, real-proof end-to-end exercise of the **cold-start onboarding** flow
(`docs/tech-design/user-flows.md`, Flow 3): a recipient (Bob) who has never
touched the protocol and has **no funded address** receives a note and cashes it
out by registering his keystore **and** withdrawing atomically through the
relayer's `register-and-withdrawal` endpoint.

The test (`registration-e2e-relayed.test.ts`) is skipped unless `REGISTRATION_E2E=1`.

## What it does

Two phases, one per `it(...)` block, sharing state in order:

**Phase 1 — Alice funds the pool**
1. Alice registers her keystore on-chain.
2. Alice deposits native ETH (real deposit proof, `Entrypoint.deposit{value}`).
3. The deposit label is approved in the ASP (on-chain `updateASPRoot`). This is
   the "wait for approval" boundary.

**Phase 2 — Alice pays Bob; Bob registers + withdraws without funding his address**
4. Alice `prepareColdStartTransfer`s a note to Bob's `ownerAddress` and submits it
   herself (out-of-band: no encrypted recipient payload). Bob's note inherits
   Alice's already-approved label.
5. Bob signs the EIP-712 `SetAuthPolicy` off-chain (no gas).
6. Bob calls `PoolSessionWithdraw.registerAndWithdraw`, which builds a transact
   proof against the **predicted** post-registration keystore root and POSTs
   `/v1/relay/evm/11155111/register-and-withdrawal`. The relayer registers Bob's
   auth policy and withdraws his note in one transaction.
7. Asserts Bob's keystore is now registered, the withdrawal recipient received
   `amount − fee`, and the submitter was the relayer's signer (not Bob).

The run is wrapped in `evm_snapshot` / `evm_revert`, so it leaves the fork clean.

The run takes roughly **30–45s** — it generates three real Groth16 proofs
(deposit, transfer, register-and-withdraw) back to back, ~10–15s each. Under
heavy machine load individual proofs can spike well above that.

## Prerequisites

1. **Anvil Sepolia fork on `localhost:8545`** with the full stack deployed and
   `docs/deployments.local.json` written (same setup as `scripts/e2e-yield`).
   Alice's and the relayer signer's addresses must be **funded on the fork** —
   the test tops them up with `anvil_setBalance` in setup, since forked dev
   accounts start at their real (usually zero) balances. **Bob is left
   deliberately unfunded** — never funding his address is the whole point.
2. **Circuit artifacts** under `packages/circuits/build/`.
3. **The relayer pointed at the LOCAL FORK.** The default `relayer.config.json`
   targets remote Sepolia and will **not** work. Start the relayer with the
   provided local config:

   ```bash
   cd packages/relayer/relayer
   CONFIG_PATH="$PWD/relayer.config.local.json" pnpm start:dev
   ```

   `relayer.config.local.json` mirrors `deployments.local.json` (entrypoint /
   privacyPoolRelay / poolVault), supports native ETH, and uses anvil account #3
   as the relayer signer. It also sets `quote_expiration_ms: 120000` as a safety
   buffer: the default 60s is usually fine (a proof is ~10–15s), but it can be
   overrun if a proof spikes under load — the quote is fetched *before* Bob's
   register-and-withdraw proof, so that proof's duration eats into the window.
   Adjust `signer_private_key` / `fee_receiver_address` if your deployment
   authorizes a different relayer.

> **After any redeploy, re-verify the deployment-specific constants.** The
> `core.*` addresses in `deployments.local.json`, the relay/entrypoint/pool
> addresses in `relayer.config.local.json`, and the `POSTMAN` /
> `RELAYER_SIGNER_ADDRESS` constants in the test are all tied to a specific
> deployment and drift when you redeploy. Three of the failure modes below are
> just one of these gone stale.

## Run

```bash
cd packages/evm-sdk
REGISTRATION_E2E=1 pnpm exec vitest run --config scripts/e2e-registration/vitest.config.ts
```

Optional env overrides: `RPC_URL`, `RELAYER_URL`, `RELAYER_FEE_RECEIVER`
(must equal the relayer config's `fee_receiver_address`).

## Troubleshooting

Symptom → cause → fix, in the order you're likely to hit them:

| Symptom | Cause | Fix |
|---|---|---|
| Core contract reads revert, e.g. `nullifyingKeys ... returned no data ("0x")` | `deployments.local.json` addresses are stale — nothing is deployed there on the current fork | Refresh `core.*` from the deploy output. Most common breakage after a redeploy. |
| `latestASPRoot()` reverts with `ASPRegistry_EmptyAssociationSet` | The `updateASPRoot` tx silently reverted: the `POSTMAN` constant doesn't hold `POSTMAN_ROLE` on this deployment | Find the real holder — query `RoleGranted(role = keccak256("POSTMAN_ROLE"))` on the AccessRouter; the `account` is the postman — and set the `POSTMAN` constant to it. |
| `registerAndRelay` reverts with `Keystore_InvalidSignature()` (`0x0ae65d93`) | Bob's address has **code** on the forked chain (EIP-7702 delegation or a contract wallet), so `SignatureChecker` takes the ERC-1271 path and rejects his ECDSA signature | Bob must be a **code-free** address. The test uses `generatePrivateKey()` for this — don't swap him to a canonical anvil dev account (those are 7702-delegated on real Sepolia). |
| `Fee commitment expired at ... current time ...` | Bob's register-and-withdraw proof (fetched after the quote) took longer than the relayer's quote TTL — usually a proof spiking under machine load past the 60s default | Raise `quote_expiration_ms` (already `120000` in `relayer.config.local.json`). Not a bug — the default 60s is correct and normally sufficient. |
| `Insufficient value for transact: available < requested` | The note must cover `withdrawal amount + relayer fee` | Bob withdraws **less** than his note (`WITHDRAW_VALUE < TRANSFER_VALUE`); the remainder returns to Bob as a shielded change note. |

## Notes

- `register-and-withdrawal` ignores the request's `processorAddress` and always
  routes through the default `PrivacyPoolRelay.relay`, whose on-chain processor
  is `relayContractAddress()`. The SDK binds the same value into the proof
  context via `RelayerInfo.processorAddress = core.privacyPoolRelay`, so they
  match. Keep those two in sync if you change the relay address.
- The relayer currently absorbs the extra keystore-registration gas — the fee
  commitment prices only the withdrawal (see the `TODO` in
  `evm.relay.service.ts#registerAndWithdrawal`).
