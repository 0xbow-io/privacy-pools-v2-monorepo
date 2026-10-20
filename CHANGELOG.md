# Changelog

All notable changes to the `privacy-pools-v2` monorepo are documented in this file.

## 1.0.1 — 2026-10-20

Trusted-setup ceremony keys.

- The Groth16 proving and verification keys of all 27 circuits are now the output of the `ppv2-ceremony` phase-2 trusted setup: 500 contributions per circuit plus an Ethereum RANDAO beacon, over the PSE perpetual powers of tau. 1.0.0 shipped single-contributor dev keys. See `packages/circuits/CEREMONY.md`.
- `contracts` adds `RotateVerifiers.s.sol` to point live PoolVaults at verifiers built from the new keys. Proofs made with the 1.0.0 keys stop verifying on a chain once it is rotated.
- `core-sdk` / `evm-sdk`: `DEFAULT_CIRCUIT_MANIFEST` points at the ceremony bundle (`QmWPCQmvkJMtFEyQ94MU2CFniH6u1sbq1AQYDjj4HFpWDX`). Ships as `@0xbow/privacy-pools-v2-sdk@1.0.1`.
- The other workspace packages are bumped to `1.0.1` with no changes.

## 1.0.0 — 2026-10-19

Initial release.

- Privacy Pools V2 monorepo: Circom ZK circuits, EVM (Foundry) and Stellar (Soroban) contracts, the TypeScript SDKs (`core-sdk`, `evm-sdk`, `stellar-sdk`), the relayer and its services, the cross-chain swap integration, and dev/test tooling.
- Workspace packages are at `1.0.0`, with four exceptions:
  - `@privacy-pools-v2/alert-dispatcher` keeps its own version (`0.0.2`).
  - The Soroban Cargo workspace (`packages/contracts-stellar`) keeps its crate version `0.1.0`.
  - The relayer funder (`packages/relayer/funder`, a Rust crate) keeps its crate version `0.1.0`.
  - The sample apps in `apps/` have no version.
- Licensing is set per directory: BUSL-1.1, GPL-3.0-or-later or MIT. See the root `LICENSE` for the map and `NOTICE` for third-party components.
- Each package has its own `CHANGELOG.md`.
