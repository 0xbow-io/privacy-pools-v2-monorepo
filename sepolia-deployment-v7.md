# Sepolia Deployment V7

**Date:** 2026-05-13
**Deployer:** `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39`
**Chain ID:** 11155111
**Branch:** `chore/sepolia-v7-deploy-post-audit`
**Commit:** `82d3dca9289f1ef3edcf551e7a44cd43cf67185b`

---

## Protocol Contracts

| Contract | Address |
| -------- | ------- |
| AccessRouter | [`0x58e8A5F5b8F6810bABabECA757F13bDE69fF2369`](https://sepolia.etherscan.io/address/0x58e8A5F5b8F6810bABabECA757F13bDE69fF2369) |
| ASPRegistry (proxy) | [`0xa147A3770bAcc7B8Ac06B008Bab448Baea5C457b`](https://sepolia.etherscan.io/address/0xa147A3770bAcc7B8Ac06B008Bab448Baea5C457b) |
| Keystore (proxy) | [`0xC6df884b8e492c358865210F5d6BC713761290f4`](https://sepolia.etherscan.io/address/0xC6df884b8e492c358865210F5d6BC713761290f4) |
| PoolVault (proxy) | [`0xE6095e7Dc61b549d27A85caadfE867379DC5981e`](https://sepolia.etherscan.io/address/0xE6095e7Dc61b549d27A85caadfE867379DC5981e) |
| Entrypoint (proxy) | [`0x6d48B27391b1110577095124ee4e112b323e7050`](https://sepolia.etherscan.io/address/0x6d48B27391b1110577095124ee4e112b323e7050) |
| PrivacyPoolRelay | [`0x97308cbDc81CE97e80661eB2532897d4638B14e6`](https://sepolia.etherscan.io/address/0x97308cbDc81CE97e80661eB2532897d4638B14e6) |

## Governance

| Role | Address |
| ---- | ------- |
| Canon Guard Safe | `0x0000000000000000000000000000000000000000` (Sepolia skips Canon Guard) |

## Role Holders

| Role | Address |
| ---- | ------- |
| DEFAULT_ADMIN | `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39` |
| OPS_ADMIN | `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39` |
| UPGRADER | `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39` |
| ENTRYPOINT_MANAGER | `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39` |
| POSTMAN | `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39` |
| PAUSER | `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39` |
| UNPAUSER | `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39` |

## System Config

| Parameter | Value |
| --------- | ----- |
| rootHistorySize | 16 |
| keystoreRootLiveness | 1200 |
| maxKeystoreTreeSize | 262144 (2^18) |
| maxStateTreeSize | 4194304 (2^22) |
