# Yield (ppUSDC) local e2e — how to run

Two local paths, in increasing scope. Both are **skipped by default** and need no Sepolia RPC unless
noted.

## 0. Fully-local wrapper e2e (no RPC, one command) ✅

The `PPYieldTokenInteractor` read/exit surface against a **real `PPYieldToken` deployed over a MOCK
Aave pool** on a throwaway anvil node — no Sepolia fork, no RPC key:

```bash
bash packages/evm-sdk/scripts/yield-e2e/run-wrapper-local.sh
```

It starts anvil, deploys the wrapper (`DeployLocalYield.s.sol` in the yield contracts repo), runs
`test/services/yield-wrapper-local.integration.test.ts` against the live node, and tears anvil down.
Requires Foundry (`anvil`/`forge`) on PATH. The contract-layer deposit→yield→withdraw logic itself is
covered offline by the mock-Aave Foundry suite (`forge test --match-path test/integration/PPYieldToken.t.sol`).

## 1. Full deposit/withdraw fork e2e (local anvil fork of Sepolia — no key needed)

Drives the yield SDK **sessions** against the full stack (pool + router + real Aave, real Groth16
proofs) on a local anvil **fork of Sepolia**. Gated behind `YIELD_E2E=1`.

**No RPC key required** — a public Sepolia endpoint works for the fork. Verified reachable and that
all dependencies already have code on the fork (so only the yield module must be deployed onto it):

```bash
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --chain-id 11155111
```

| Dependency (present on the fork) | Address |
|---|---|
| PoolVault (proxy) | `0x09b94d3127019298757A6ceeB7911922085f7C01` |
| Entrypoint (proxy) | `0xEB3e3961008952348445513e418ad6F43C23ca9a` |
| Keystore (proxy) | `0x6d264aCb9C3A7A3105c29470AfE2F5F1EC203C73` |
| Aave v3 Pool | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` |
| aUSDC | `0x16dA4541aD1807f4443d92D26044C1147406EB80` |
| Safe ProxyFactory (canonical) | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` |

Remaining setup to run it end-to-end (the yield module is **not** on public Sepolia, only these deps):
1. Deploy the wrapper + zap + `PPRouter` onto the fork, wired to the Entrypoint/PoolVault above and
   the real Aave pool/aUSDC.
2. Register the wrapper as an asset on the Entrypoint (impersonate the entrypoint admin on the fork;
   lift the Aave USDC supply cap as pool admin — see the yield contracts' `SEPOLIA_FORK_AND_DEPLOY.md`).
3. Write `docs/deployments.local.json`, set `YIELD_E2E=1 RPC_URL=http://localhost:8545`, and run the
   session e2e (a port of the reference `scripts/e2e-yield/` flow onto `PoolSessionYieldDeposit` /
   `PoolSessionYieldWithdraw`).

## Why they don't run out of the box

They need three things this repo does not carry:

1. **A Sepolia archive RPC** to fork (for real Aave aUSDC). Set `RPC_FORK_URL`.
2. **A running anvil fork** of that RPC on `localhost:8545`.
3. **A `docs/deployments.local.json`** produced by deploying the full stack (pool, entrypoint,
   keystore, ASP registry, verifiers, and the yield `PPRouter` + `PPYieldToken` + zap) to that fork.

## Recipe

```bash
# 1. Fork Sepolia locally (needs a real archive RPC — Alchemy/Infura/etc.)
anvil --fork-url "$RPC_FORK_URL" --chain-id 11155111

# 2. Deploy the full protocol + yield module to the fork, writing docs/deployments.local.json
#    (from packages/contracts; see Deploy.s.sol / the yield deploy script)
forge script script/Deploy.s.sol --rpc-url http://localhost:8545 --broadcast

# 3. Run the gated e2e against it
YIELD_E2E=1 RPC_URL=http://localhost:8545 pnpm --filter @privacy-pools-v2/evm-sdk test
```

## What runs when enabled

`test/services/yield-smoke.integration.test.ts` is a **gated on-chain smoke test** for the yield
interactors against the real deployed contracts: `PPRouterInteractor.quote` / `quoteWithdraw` and
`PPYieldTokenInteractor.exchangeRate` / `previewRedeem` return sane, positive values. It skips unless
`YIELD_E2E=1` and `docs/deployments.local.json` are both present.

The full deposit → yield-accrual → withdraw flow with real proofs is **not** ported here — it mirrors
the reference scripts on the `feat/batch-transactions` branch
(`packages/sdk/scripts/e2e-yield/`), which would be adapted to call the new sessions
(`PoolSessionYieldDeposit` / `PoolSessionYieldWithdraw`) instead of the inline re-encode. That port is
deferred because it cannot be executed or verified without the fork + deployment above.

Note: the SDK-internal re-encode fidelity is already covered by a **runnable real-proof test**,
`test/services/PoolSessionYieldDeposit.realproof.integration.test.ts`, which generates a genuine
Groth16 deposit proof and asserts the router re-encode preserves it byte-for-byte — no chain needed.
