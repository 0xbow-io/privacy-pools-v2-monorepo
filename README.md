# Privacy Pools V2

A monorepo for Privacy Pools V2, containing smart contracts, ZK circuits, and a TypeScript SDK.

## Structure

```
privacy-pools-v2/
├── packages/
│   ├── contracts/    # Solidity smart contracts (Foundry)
│   ├── circuits/     # Circom ZK circuits (Circomkit)
│   └── sdk/          # TypeScript SDK
└── ...
```

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 9
- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- [Circom](https://docs.circom.io/getting-started/installation/)

## Setup

1. Install [git-lfs](https://git-lfs.com/) in your system and run `git lfs install` to instrument it in your user account.

This is used to include all the artifacts of the circom circuits without degrading the repository's performance

2. Clone the repository:

```bash
git clone https://github.com/0xbow/privacy-pools-v2.git
cd privacy-pools-v2
```

3. Install dependencies:

```bash
pnpm install
```

4. Build all packages:

```bash
pnpm build
```

## Development

### Commands

```bash
# Build all packages
pnpm build

# Run all tests
pnpm test

# Lint all packages
pnpm lint

# Format code
pnpm format

# Clean build artifacts
pnpm clean
```

### Package-specific commands

```bash
# Contracts
pnpm --filter @privacy-pools-v2/contracts build
pnpm --filter @privacy-pools-v2/contracts test
pnpm --filter @privacy-pools-v2/contracts test:unit
pnpm --filter @privacy-pools-v2/contracts coverage

# Circuits
pnpm --filter @privacy-pools-v2/circuits test
pnpm --filter @privacy-pools-v2/circuits compile <circuit-name>
pnpm --filter @privacy-pools-v2/circuits setup <circuit-name>

# SDK
pnpm --filter @privacy-pools-v2/sdk build
pnpm --filter @privacy-pools-v2/sdk test
pnpm --filter @privacy-pools-v2/sdk dev
```

## Packages

### [@privacy-pools-v2/contracts](./packages/contracts)

Solidity smart contracts built with Foundry. Based on [Wonderland's Solidity Foundry Boilerplate](https://github.com/defi-wonderland/solidity-foundry-boilerplate).

### [@privacy-pools-v2/circuits](./packages/circuits)

Circom ZK circuits managed with [Circomkit](https://github.com/erhant/circomkit).

### [@privacy-pools-v2/sdk](./packages/sdk)

TypeScript SDK for interacting with Privacy Pools V2 contracts and generating/verifying proofs.

## Development partner

Privacy Pools v2 was developed by 0xbow with [Wonderland](https://wonderland.xyz) as development partner.

## License

© 2025-2026 0xbow. Each directory carries its own license; the root [LICENSE](./LICENSE) maps them.

| Component | License |
| --- | --- |
| Core contracts (`packages/contracts`, `packages/contracts-stellar`, `packages/swaps`) | [Business Source License 1.1](./packages/contracts/LICENSE) (`BUSL-1.1`) |
| Circuits (`packages/circuits`) and relayer (`packages/relayer`) | [GNU GPL v3.0 or later](./packages/circuits/LICENSE) (`GPL-3.0-or-later`): the circuits include circomlib and the relayer runs snarkjs, both GPL-3.0 |
| SDKs (`packages/core-sdk`, `packages/evm-sdk`, `packages/stellar-sdk`), dev tooling and everything else | [MIT](./packages/core-sdk/LICENSE) |

Under the BUSL, production use is permitted only to interact with Privacy Pools v2 deployments that 0xbow operates or has authorized in writing (see the Additional Use Grant). On the Change Date each version converts to GPL-2.0-or-later.

Third-party components that keep their own licenses are listed in [NOTICE](./NOTICE).
