# Changelog

All notable changes to `@privacy-pools-v2/dust-rescue-prover` are documented in this file.

## 1.0.1 — 2026-10-20

- Version bump only; no changes.

## 1.0.0 — 2026-10-19

Initial release.

- Proving module for cross-chain-reshield stealth dust rescue: derives an ERC-5564 stealth address and generates the deposit proof and calldata for a relayer-observed destination-chain leftover.
- Keyless (holds no chain-signing key); consumed as a library by `dust-rescue-service`.
