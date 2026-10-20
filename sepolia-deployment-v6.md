# Sepolia Deployment V6

**Date:** 2026-04-30
**Deployer:** `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39`
**Chain ID:** 11155111
**Branch:** `deploy/sepolia-v6`
**Commit:** `cfd03147`

---

## Protocol Contracts

| Contract | Address |
| -------- | ------- |
| AccessRouter | [`0x58c66264bb10893e9eccaded96e17b7f916e7dc5`](https://sepolia.etherscan.io/address/0x58c66264bb10893e9eccaded96e17b7f916e7dc5) |
| ASPRegistry (proxy) | [`0x7e93793e6d175b77a16243b3f880210a182db3c2`](https://sepolia.etherscan.io/address/0x7e93793e6d175b77a16243b3f880210a182db3c2) |
| Keystore (proxy) | [`0x491ac0a4826a1eee1a25a841974e655cd7f7f1ca`](https://sepolia.etherscan.io/address/0x491ac0a4826a1eee1a25a841974e655cd7f7f1ca) |
| PoolVault (proxy) | [`0x408a36fb03b4828ea2d6a903cbc99629141bb9f1`](https://sepolia.etherscan.io/address/0x408a36fb03b4828ea2d6a903cbc99629141bb9f1) |
| Entrypoint (proxy) | [`0x713186039ae933acdb45f3330f74f29a3962d424`](https://sepolia.etherscan.io/address/0x713186039ae933acdb45f3330f74f29a3962d424) |
| PrivacyPoolRelay | [`0x4491667fa554ca06608c170132adce77ba09517c`](https://sepolia.etherscan.io/address/0x4491667fa554ca06608c170132adce77ba09517c) |

## Implementation Contracts

| Contract | Address | Verified |
| -------- | ------- | -------- |
| ASPRegistry (impl) | [`0x1d6997107c2d8d3929be1878ba2333f0f5ddfba5`](https://sepolia.etherscan.io/address/0x1d6997107c2d8d3929be1878ba2333f0f5ddfba5) | pending |
| Keystore (impl) | [`0x418e6c61238569a8ff0c2eb898e3ffcda0c0a185`](https://sepolia.etherscan.io/address/0x418e6c61238569a8ff0c2eb898e3ffcda0c0a185) | pending |
| PoolVault (impl) | [`0x3426f56415aad23f954a2ee2e3bb980ffa675cdc`](https://sepolia.etherscan.io/address/0x3426f56415aad23f954a2ee2e3bb980ffa675cdc) | pending |
| Entrypoint (impl) | [`0xf894f33e75828b8b83c4d756badb204887ae241b`](https://sepolia.etherscan.io/address/0xf894f33e75828b8b83c4d756badb204887ae241b) | pending |

## Libraries

| Library | Address | Note |
| ------- | ------- | ---- |
| LeanIMT | [`0x615CCfBe2d6A018993bb398FBEEA410a861Ce02A`](https://sepolia.etherscan.io/address/0x615CCfBe2d6A018993bb398FBEEA410a861Ce02A) | linked |
| PoseidonT3 | [`0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93`](https://sepolia.etherscan.io/address/0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93) | canonical deterministic deployment |
| PoseidonT4 | [`0x4443338EF595F44e0121df4C21102677B142ECF0`](https://sepolia.etherscan.io/address/0x4443338EF595F44e0121df4C21102677B142ECF0) | canonical deterministic deployment |

## Verifiers

| Contract | Address |
| -------- | ------- |
| DepositGroth16Verifier | [`0x6d917faff5980fa10f9e1aa7280615db989b9d16`](https://sepolia.etherscan.io/address/0x6d917faff5980fa10f9e1aa7280615db989b9d16) |
| RagequitGroth16Verifier | [`0x122f33160e30cabf137d385c2560fca55e2b7de5`](https://sepolia.etherscan.io/address/0x122f33160e30cabf137d385c2560fca55e2b7de5) |

### Transact Verifiers (NxM)

| Config | Address |
| ------ | ------- |
| 1x1 | [`0xc48e662d0ee982831bb053d0f5f5f09ec4f7d025`](https://sepolia.etherscan.io/address/0xc48e662d0ee982831bb053d0f5f5f09ec4f7d025) |
| 1x2 | [`0xbfa59bbe96e8a13f80341b0dac42100f9816cc4e`](https://sepolia.etherscan.io/address/0xbfa59bbe96e8a13f80341b0dac42100f9816cc4e) |
| 1x3 | [`0x85db14b197fc91569c94d08c26a9c22a6beda5f2`](https://sepolia.etherscan.io/address/0x85db14b197fc91569c94d08c26a9c22a6beda5f2) |
| 1x4 | [`0x89aad4310debdd92e2bbb6f8e6873b0bb236e949`](https://sepolia.etherscan.io/address/0x89aad4310debdd92e2bbb6f8e6873b0bb236e949) |
| 1x5 | [`0x507399a3976d84a937538c6f4cfb10cbebbb2d7f`](https://sepolia.etherscan.io/address/0x507399a3976d84a937538c6f4cfb10cbebbb2d7f) |
| 2x1 | [`0x15e11933dd4d896d69d6ae4bf3e46df0be60ee0c`](https://sepolia.etherscan.io/address/0x15e11933dd4d896d69d6ae4bf3e46df0be60ee0c) |
| 2x2 | [`0xa49a47d85572d34a5f569bcadd87bf962a62c50a`](https://sepolia.etherscan.io/address/0xa49a47d85572d34a5f569bcadd87bf962a62c50a) |
| 2x3 | [`0x0761993f62790a570f65f1987d2f3e1df4cc1ac5`](https://sepolia.etherscan.io/address/0x0761993f62790a570f65f1987d2f3e1df4cc1ac5) |
| 2x4 | [`0x871031fbcdd96e09dc0aab0e9245abf6b6f7df7d`](https://sepolia.etherscan.io/address/0x871031fbcdd96e09dc0aab0e9245abf6b6f7df7d) |
| 2x5 | [`0xafcb600abde1903bd4430f2ec71895409e996ebb`](https://sepolia.etherscan.io/address/0xafcb600abde1903bd4430f2ec71895409e996ebb) |
| 3x1 | [`0xa91441ca4292dda0c9a44bdca5cd9561a3d0222c`](https://sepolia.etherscan.io/address/0xa91441ca4292dda0c9a44bdca5cd9561a3d0222c) |
| 3x2 | [`0x86170674a8800f4d5f1987d49178db19bcaed7f6`](https://sepolia.etherscan.io/address/0x86170674a8800f4d5f1987d49178db19bcaed7f6) |
| 3x3 | [`0x7b7df104deaad03fbd73fc4794b891d141ca4e1e`](https://sepolia.etherscan.io/address/0x7b7df104deaad03fbd73fc4794b891d141ca4e1e) |
| 3x4 | [`0xf2e804a7ccdc1c53888b4aaaeedab0178b0d3cfe`](https://sepolia.etherscan.io/address/0xf2e804a7ccdc1c53888b4aaaeedab0178b0d3cfe) |
| 3x5 | [`0x4c81ae4ef576b8b974ce8298ba35886b29a555b0`](https://sepolia.etherscan.io/address/0x4c81ae4ef576b8b974ce8298ba35886b29a555b0) |
| 4x1 | [`0xa28e16294ae7a3151add7323353c787f6dc203e7`](https://sepolia.etherscan.io/address/0xa28e16294ae7a3151add7323353c787f6dc203e7) |
| 4x2 | [`0x371e51b0d7cf0eb40706e2c6efe6614b304af4ee`](https://sepolia.etherscan.io/address/0x371e51b0d7cf0eb40706e2c6efe6614b304af4ee) |
| 4x3 | [`0xc570897cf291afafae187dc95e61ed23ba2ff66c`](https://sepolia.etherscan.io/address/0xc570897cf291afafae187dc95e61ed23ba2ff66c) |
| 4x4 | [`0x3f90804e8c8eacbeb9f43bf62bb9bc5b9dba90e9`](https://sepolia.etherscan.io/address/0x3f90804e8c8eacbeb9f43bf62bb9bc5b9dba90e9) |
| 4x5 | [`0x514b564cb5aa00c1e7a35371d8bcdd8863f18390`](https://sepolia.etherscan.io/address/0x514b564cb5aa00c1e7a35371d8bcdd8863f18390) |
| 5x1 | [`0x4a9d2f1ecc37a7fe9409fec296ba49760df2f9bb`](https://sepolia.etherscan.io/address/0x4a9d2f1ecc37a7fe9409fec296ba49760df2f9bb) |
| 5x2 | [`0x6ee4368f398ac67148a41e4d22168841d78bc5d5`](https://sepolia.etherscan.io/address/0x6ee4368f398ac67148a41e4d22168841d78bc5d5) |
| 5x3 | [`0x6fa5b79cd782abd5f514b9b0be626a82cf13ee83`](https://sepolia.etherscan.io/address/0x6fa5b79cd782abd5f514b9b0be626a82cf13ee83) |
| 5x4 | [`0x10ef19f643a38158620d777a7f41e802c5eef654`](https://sepolia.etherscan.io/address/0x10ef19f643a38158620d777a7f41e802c5eef654) |
| 5x5 | [`0x68c9f76a60760bc119a8bede0f8cfd2d0564cef2`](https://sepolia.etherscan.io/address/0x68c9f76a60760bc119a8bede0f8cfd2d0564cef2) |
