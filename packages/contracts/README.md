# Privacy Pools V2 — Contracts

Solidity smart contracts for Privacy Pools V2, built with [Foundry](https://book.getfoundry.sh/).

## Contracts

Core contracts live in `packages/contracts/src/contracts/`.

Supporting code lives in `src/abstracts/`, `src/interfaces/`, 
`src/libraries/`, and `src/utils/`.

| Contract | Description |
|---|---|
| `Entrypoint` | User-facing entry point for deposits, transacts, and ragequits |
| `PoolVault` | Holds pooled funds and manages the note commitment Merkle tree |
| `Keystore` | On-chain identity and viewing-key registry |
| `AccessRouter` | Role-based access control routing |
| `ASPRegistry` | Association Set Provider registry |
| `PrivacyPoolRelay` | Relays private withdrawals so a relayer pays gas and funds go to a recipient with optional fee split |

## Project Structure

```
packages/contracts/
├── src/
│   ├── abstracts/       # Shared base contracts
│   ├── contracts/       # Core deployable contracts
│   ├── interfaces/      # All external interfaces
│   ├── libraries/       # Standalone library code
│   └── utils/           # Utility contracts
├── test/
│   ├── unit/            # Unit tests + .tree BTT files
│   │   └── helpers/     # Harnesses, mock utils
│   ├── integration/     # Integration tests (real proofs via FFI)
│   │   └── helpers/     # Proof generators, Merkle tree, mocks
│   └── helper/          # Node.js FFI scripts (proof-utils, generators)
├── script/              # Foundry deployment scripts
├── lib/                 # Git submodule deps (lean-imt)
├── foundry.toml
├── remappings.txt
└── .env.example
```

Groth16 verifier contracts live in the sibling `packages/circuits/build/` directory. No BUSL-1.1 file imports them: `PoolVault` references them through the `IDepositVerifier` / `IRagequitVerifier` interfaces (transact verifiers through `TransactVerifierRouter`'s address + selector configs). Only `src/verifiers/VerifierArtifacts.sol` (GPL-3.0) imports them, via the `verifiers/` remapping in `remappings.txt`, so that every forge build, test and script run emits their artifacts; `Deploy.s.sol` and `script/helpers/AllTransactVerifiers.sol` then deploy them with `vm.deployCode`. These artifacts are checked into the repo via **Git LFS** (see [Setup](#setup)).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| [Foundry](https://book.getfoundry.sh/getting-started/installation) | Latest | `forge`, `cast`, `anvil` |
| [Node.js](https://nodejs.org/) | ≥ 18 | Required for FFI proof generation in integration tests |
| [pnpm](https://pnpm.io/) | 9.x | Monorepo package manager |
| [Git LFS](https://git-lfs.com/) | Latest | Required to pull circuit artifacts (zkeys, wasm, verifier `.sol`) |

### Optional (for linting / scaffolding workflows)

```bash
cargo install lintspec   # NatSpec linter (used by pnpm lint:natspec)
cargo install bulloak    # BTT test scaffolding
```

## Setup

### 1. Git LFS

Circuit build artifacts (zkeys, wasm, Groth16 verifier `.sol` files) are stored in Git LFS. Without them, **compilation will fail** because `remappings.txt` maps `verifiers/` to `../circuits/build/`.

If you had Git LFS installed before cloning, the files are already pulled automatically. You can verify with:

```bash
ls packages/circuits/build/deposit/groth16_verifier.sol
```

If the file is missing or looks like a small text pointer, install LFS and pull:

```bash
git lfs install
git lfs pull
```

### 2. Install dependencies

From the **monorepo root**:

```bash
pnpm install
```

### 3. Environment variables (optional, for deployments only)

Copy the example env file if you need to deploy or run mainnet fork tests:

```bash
cp .env.example .env
```

| Variable | Used by |
|---|---|
| `MAINNET_RPC` | Mainnet fork tests / deployments |
| `SEPOLIA_RPC` | Sepolia deployments |
| `MAINNET_DEPLOYER_NAME` | Deployment scripts only |
| `SEPOLIA_DEPLOYER_NAME` | Deployment scripts only |
| `ETHERSCAN_API_KEY` | Contract verification |

## Tests

> **Note:** `foundry.toml` has `ffi = true`. Forge will execute Node.js scripts during integration tests to generate Groth16 proofs.

### Run all tests

```bash
pnpm test
```

### Unit tests

Unit test contracts are named `Unit*` and live in `test/unit/`.

```bash
pnpm test:unit            # 1,000 fuzz runs (default)
pnpm test:unit:deep       # 5,000 fuzz runs
```

### Integration tests

Integration test contracts are named `*Integration` and live in `test/integration/`. They require Git LFS artifacts to be present (see [Setup](#1-install-git-lfs-and-pull-artifacts)).

```bash
pnpm test:integration
```

### Coverage

```bash
pnpm coverage
```

Generates a summary + `lcov` report scoped to unit tests.

## Build

```bash
pnpm build                # via-IR (default profile)
```

## Linting

```bash
pnpm lint                 # forge fmt --check + solhint
pnpm lint:fix             # auto-fix formatting + solhint
pnpm lint:natspec         # NatSpec coverage check (requires lintspec)
pnpm lint:bulloak         # verify .tree ↔ .t.sol sync
```

## Bulloak (BTT scaffolding)

Tests follow the [Branched-Tree Technique](https://twitter.com/PaulRBerg/status/1682346315806539776). Each unit test file has a paired `.tree` file that declares the test structure.

To scaffold new test files from `.tree` files:

```bash
pnpm test:bulloak:scaffold
```

To verify existing tests match their `.tree` files:

```bash
pnpm lint:bulloak
```

## Foundry Configuration

Key settings in `foundry.toml`:

- **Solc:** 0.8.32 / Prague EVM
- **Optimizer:** 10 000 runs. **`[profile.default]` uses via-IR** for the full tree so `forge build`, `forge test`, and `forge script` match.
- **FFI:** enabled (`ffi = true`)
- **Fuzz:** 1 000 runs (default `[fuzz]`); CI sets `FOUNDRY_FUZZ_RUNS=3000` for the contract test job

## Deploy & Verify

See [`script/README.md`](./script/README.md) for the full deployment guide (local Anvil, mainnet, verification, role assignments). To rotate a live PoolVault's 27 verifiers after the circuit keys change, use `RotateVerifiers.s.sol` (see [Rotating Verifiers](./script/README.md#rotating-verifiers)).

### Keystore setup

```bash
source .env
cast wallet import $MAINNET_DEPLOYER_NAME --interactive
cast wallet import $SEPOLIA_DEPLOYER_NAME --interactive
```

### Deploy

```bash
pnpm deploy:sepolia
pnpm deploy:mainnet
```

Broadcast artifacts are written to `./broadcast`.

## License

[BUSL-1.1](./LICENSE) — © 2025-2026 0xbow. The snarkJS-generated verifiers built from `packages/circuits/build` remain GPL-3.0-or-later and are deployed as separate contracts; see the repository [NOTICE](../../NOTICE).
