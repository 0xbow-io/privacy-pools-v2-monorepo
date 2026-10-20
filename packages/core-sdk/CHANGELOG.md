# Changelog

All notable changes to `@privacy-pools-v2/core-sdk` are documented in this file.

## 1.0.1 — 2026-10-20

- `DEFAULT_CIRCUIT_MANIFEST` now points at the trusted-setup ceremony bundle (root `QmWPCQmvkJMtFEyQ94MU2CFniH6u1sbq1AQYDjj4HFpWDX`). The proving and verification key CIDs and digests changed; the wasm entries are unchanged. Proofs built with the 1.0.0 manifest stop verifying once a chain's verifiers are rotated.

## 1.0.0 — 2026-10-19

Initial release.

- Chain-agnostic SDK core: protocol logic, cryptography, note and keystore management, and the generic contract-interactor abstractions that `evm-sdk` and `stellar-sdk` build on.
- Not published on its own: it ships inlined in `@0xbow/privacy-pools-v2-sdk@1.0.0`, the npm package built from `evm-sdk`.
