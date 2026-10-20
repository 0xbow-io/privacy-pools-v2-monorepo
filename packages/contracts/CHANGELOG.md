# Changelog

All notable changes to `@privacy-pools-v2/contracts` are documented in this file.

## 1.0.1 — 2026-10-20

- The deposit, ragequit and transact verifiers now embed the trusted-setup ceremony keys.
- Add `script/RotateVerifiers.s.sol`: deploys all 27 verifiers and points an existing PoolVault at them (`setDepositVerifier`, `setRagequitVerifier`, `setVerifier` x25), then reads back every slot. Requires `UPGRADER_ROLE`.

## 1.0.0 — 2026-10-19

Initial release.

- Foundry project with the Privacy Pools V2 EVM contracts: `Entrypoint`, `PoolVault`, `Keystore`, `ASPRegistry`, `AccessRouter`, `PrivacyPoolRelay`, `ERC5564Announcer`, and the yield contracts (`PPYieldToken`, `PPRouter`, `PPYieldTokenZap` and their factories).
- Deployment, verification and operations scripts, with per-chain address registries, live in `script/`.
- The package version is repository metadata only; it is not compiled into any contract.
