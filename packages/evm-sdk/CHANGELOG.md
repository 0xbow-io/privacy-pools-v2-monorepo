# Changelog

All notable changes to `@privacy-pools-v2/evm-sdk` are documented in this file.

## 1.0.1 — 2026-10-20

- Ships the core-sdk 1.0.1 `DEFAULT_CIRCUIT_MANIFEST` (trusted-setup ceremony keys). Published as `@0xbow/privacy-pools-v2-sdk@1.0.1`. Integrators on the IPFS path should upgrade before the on-chain verifiers are rotated.

## 1.0.0 — 2026-10-19

Initial release.

- EVM SDK built on `@privacy-pools-v2/core-sdk`: viem- and LiFi-backed chain adapters, pool sessions and the stealth-address module.
- Published to npmjs.org as `@0xbow/privacy-pools-v2-sdk@1.0.0`, with `core-sdk` inlined. Entry points: `.`, `./batch-fee` and `./stealth`.
