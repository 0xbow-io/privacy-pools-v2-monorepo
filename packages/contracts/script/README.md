# Deploy Script

Privacy Pools V2 full deployment, including atomic Canon Guard Safe creation.

## Deployment Pipeline

The `Deploy.s.sol` script executes the following steps in a single broadcast:

| Step | What | Notes |
|------|------|-------|
| 0 | Canon Guard Safe | Gnosis Safe + Canon Guard installed atomically via `SafeProxyFactory.createProxyWithNonce` |
| 1 | AccessRouter | Two-tier role manager (DEFAULT_ADMIN + OPS_ADMIN), deployer holds temp admin |
| 2 | Keystore (proxy) | UUPS, initialized with `keystoreRootLiveness` and `maxKeystoreTreeSize` |
| 3 | ASPRegistry (proxy) | UUPS, initialized (no config params) |
| 4 | PoolVault (proxy) | UUPS, atomically initialized with root buffer, 25 transact verifiers (1x1..5x5), `aspRegistry`/`keystore` refs, deposit+ragequit verifiers, and `maxStateTreeSize`. Holds the authoritative `aspRegistry` slot |
| 5 | Entrypoint (proxy) | UUPS, initialized with `PoolVault` ref only — `aspRegistry` is read on demand via `poolVault.aspRegistry()` |
| 6 | PrivacyPoolRelay | Stateless relay with immutable refs to AccessRouter, PoolVault, Entrypoint |
| 7 | Role wiring | DEPOSITOR_ROLE granted to Entrypoint |
| 8 | Asset config | Chain-specific assets enabled on Entrypoint (deployer gets temp ENTRYPOINT_MANAGER_ROLE) |
| 9 | Admin transfer | DEFAULT_ADMIN + OPS_ADMIN transferred to config holders; deployer stripped of all roles |

After step 9 the deployer EOA has **zero** on-chain authority.

## Configuration

All per-chain values live in three registries under `script/registries/`:

| Registry | Purpose |
|----------|---------|
| `registries/ChainConfigRegistry.sol` | Role holders, `rootHistorySize`, Canon Guard governance params |
| `registries/ChainAssetRegistry.sol` | Enabled assets and their fee/limit configuration |
| `registries/ChainDeploymentRegistry.sol` | Post-deploy address book (Keystore, PoolVault, etc.) |

To add a new chain: create `_<chain>Config()`, `_<chain>Governance()`, and `_<chain>Assets()` functions, then add entries to the `_*ForChain()` resolvers.

## Running the Deploy

### Prerequisites

- [Foundry](https://book.getfoundry.sh/) installed
- A mainnet RPC URL (the Canon Guard factory and Safe singleton are deployed via CREATE2 on mainnet — a fork makes them available locally)
- An Etherscan API key (for contract verification)

### Poseidon Library Linking

`PoolVault` and `Keystore` use the `poseidon-solidity` library, whose contracts (`PoseidonT3`, `PoseidonT4`) exceed EIP-170's 24576-byte size limit. These libraries are pre-deployed at deterministic CREATE2 addresses on every EVM chain via the [Arachnid deterministic deployment proxy](https://github.com/Arachnid/deterministic-deployment-proxy):

| Library | Address | Source |
|---------|---------|--------|
| PoseidonT3 | `0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93` | [`poseidon-solidity/deploy/PoseidonT3.js`](https://github.com/vimwitch/poseidon-solidity/blob/main/deploy/PoseidonT3.js) |
| PoseidonT4 | `0x4443338EF595F44e0121df4C21102677B142ECF0` | [`poseidon-solidity/deploy/PoseidonT4.js`](https://github.com/vimwitch/poseidon-solidity/blob/main/deploy/PoseidonT4.js) |

So we need to pass `--libraries` to link against these canonical addresses instead of letting Foundry auto-deploy (which would fail on-chain due to the size limit):

### Deploy Command

```bash
cd packages/contracts

forge script script/Deploy.s.sol:Deploy \
  --fork-url $RPC_URL \
  --broadcast \
  --private-key $DEPLOYER_KEY \
  --libraries poseidon-solidity/PoseidonT3.sol:PoseidonT3:0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93 \
  --libraries poseidon-solidity/PoseidonT4.sol:PoseidonT4:0x4443338EF595F44e0121df4C21102677B142ECF0 \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  -vv
```

The `--verify` flag submits source code to Etherscan for every deployed contract. Use `-vvvv` instead of `-vv` for full call traces.

For mainnet or Sepolia, fill in the TODO placeholders in `registries/ChainConfigRegistry.sol` first:

1. `_mainnetConfig()` / `_sepoliaConfig()` — operator addresses for each role
2. `_mainnetGovernance()` / `_sepoliaGovernance()` — Safe owners, threshold, Canon Guard delay parameters
3. `_mainnetAssets()` / `_sepoliaAssets()` in `registries/ChainAssetRegistry.sol` — token addresses and fee configs

### Local Testing (Anvil)

Start Anvil forking mainnet in one terminal:

```bash
anvil --fork-url $MAINNET_RPC
```

This forks mainnet state (chain ID 1) so the Canon Guard factory, Safe singleton, and real token contracts are available. The deploy script uses `_mainnetConfig()` — the same config used everywhere.

Then deploy in a second terminal:

```bash
cd packages/contracts

forge script script/Deploy.s.sol:Deploy \
  --fork-url http://127.0.0.1:8545 \
  --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --libraries poseidon-solidity/PoseidonT3.sol:PoseidonT3:0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93 \
  --libraries poseidon-solidity/PoseidonT4.sol:PoseidonT4:0x4443338EF595F44e0121df4C21102677B142ECF0 \
  -vv
```

The private key is Anvil's default account 0 (`0xf39F...`). The `--verify` flag is omitted for local testing — on Anvil, Etherscan verification fails.

## Verification

System parameter and configuration validation lives in [`helpers/DeploymentVerifier.sol`](helpers/DeploymentVerifier.sol) and runs in two places:

- **At test time `IntegrationBase` and `test/integration/Deployment.t.sol`** — the former ensures *all of the test suite assertions are performed against post-deployment state, and the latter ensures deployment configs are valid for ever supported chain.
- **Standalone via [`VerifyDeployment.s.sol`](VerifyDeployment.s.sol)** — read-only re-check against the addresses in `ChainDeploymentRegistry`. Useful for post-mainnet sanity checks by an independent operator, CI gates, or detecting drift after registry edits.

```bash
forge script script/VerifyDeployment.s.sol:VerifyDeployment --rpc-url $RPC_URL -vv
```

No `--broadcast` / `--private-key` / `--libraries` needed: `run()` is `view`. Reverts loudly with a `DeploymentVerifier: …` reason on any mismatch; on success logs the full address book and role holders.

Negative-path coverage lives in [`test/unit/DeploymentVerifier.t.sol`](../test/unit/DeploymentVerifier.t.sol).

## Rotating Verifiers

Every verifier contract embeds its verification key, so new circuit keys (such as the trusted-setup ceremony keys, see [`packages/circuits/CEREMONY.md`](../../circuits/CEREMONY.md)) need new verifier contracts. [`RotateVerifiers.s.sol`](RotateVerifiers.s.sol) deploys all 27 verifiers (deposit, ragequit, transact 1x1..5x5) and points an existing PoolVault at them with `setDepositVerifier`, `setRagequitVerifier` and `setVerifier` ×25. The PoolVault is passed explicitly. The broadcaster must hold `UPGRADER_ROLE` on the PoolVault's `ACCESS_ROUTER()` (checked before broadcasting), and all 27 slots are read back afterwards.

```bash
forge script script/RotateVerifiers.s.sol --sig 'run(address)' <poolVault> \
  --rpc-url $RPC --account <keystore account> --broadcast -vvvv
```

[`RedeployTransactVerifiers.s.sol`](RedeployTransactVerifiers.s.sol) covers only the 25 transact verifiers and resolves the PoolVault from `ChainDeploymentRegistry`. Tests: [`test/integration/RotateVerifiers.t.sol`](../test/integration/RotateVerifiers.t.sol).
