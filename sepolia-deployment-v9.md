# Sepolia Deployment V9

**Date:** 2026-05-27
**Deployer:** `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39`
**Chain ID:** 11155111
**Deploy blocks:** `10932354` – `10932483` (49 transactions)
**Pinned block (`SEPOLIA_V9_DEPLOYMENT_BLOCK`):** `10932483`

Referenced in `IntegrationBase.t.sol` and `Deployment.t.sol` for Sepolia fork tests
(`SEPOLIA_DEPLOYMENT_TESTS=true`).

> Re-deployed on top of V8 with Canon Guard Safe wired as `DEFAULT_ADMIN` and
> `UPGRADER`. V8 addresses are abandoned and no longer referenced by
> `ChainDeploymentRegistry`.

---

## Protocol Contracts

| Contract | Address |
| -------- | ------- |
| AccessRouter | [`0xfe61D9D43418e23e2Add1069D1A8CcA4fd3906A2`](https://sepolia.etherscan.io/address/0xfe61D9D43418e23e2Add1069D1A8CcA4fd3906A2) |
| ASPRegistry (proxy) | [`0x35D29EFDCf067599ab4A53cf40229477f0b1cA9c`](https://sepolia.etherscan.io/address/0x35D29EFDCf067599ab4A53cf40229477f0b1cA9c) |
| Keystore (proxy) | [`0x6d264aCb9C3A7A3105c29470AfE2F5F1EC203C73`](https://sepolia.etherscan.io/address/0x6d264aCb9C3A7A3105c29470AfE2F5F1EC203C73) |
| PoolVault (proxy) | [`0x09b94d3127019298757A6ceeB7911922085f7C01`](https://sepolia.etherscan.io/address/0x09b94d3127019298757A6ceeB7911922085f7C01) |
| Entrypoint (proxy) | [`0xEB3e3961008952348445513e418ad6F43C23ca9a`](https://sepolia.etherscan.io/address/0xEB3e3961008952348445513e418ad6F43C23ca9a) |
| PrivacyPoolRelay | [`0x762665Dc7aAeeA25DC1759AEBef1F61730497f6e`](https://sepolia.etherscan.io/address/0x762665Dc7aAeeA25DC1759AEBef1F61730497f6e) |

## Implementation Contracts

| Contract | Address |
| -------- | ------- |
| ASPRegistry (impl) | [`0x3e98ed1a80d16a92d42314809b5e11a612fb98d2`](https://sepolia.etherscan.io/address/0x3e98ed1a80d16a92d42314809b5e11a612fb98d2) |
| Keystore (impl) | [`0x2aa77fa12ec391df772157e223f6b1d9862c20ad`](https://sepolia.etherscan.io/address/0x2aa77fa12ec391df772157e223f6b1d9862c20ad) |
| PoolVault (impl) | [`0x94515c7469eb8be37a5188f6ebe327bf8a9753a8`](https://sepolia.etherscan.io/address/0x94515c7469eb8be37a5188f6ebe327bf8a9753a8) |
| Entrypoint (impl) | [`0x6370b20d1afdde4a6681f43a3124e863279c4454`](https://sepolia.etherscan.io/address/0x6370b20d1afdde4a6681f43a3124e863279c4454) |

## Libraries

| Library | Address | Note |
| ------- | ------- | ---- |
| PoseidonT3 | [`0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93`](https://sepolia.etherscan.io/address/0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93) | canonical deterministic deployment, linked via `--libraries` |
| PoseidonT4 | [`0x4443338EF595F44e0121df4C21102677B142ECF0`](https://sepolia.etherscan.io/address/0x4443338EF595F44e0121df4C21102677B142ECF0) | canonical deterministic deployment, linked via `--libraries` |

## Verifiers

| Contract | Address |
| -------- | ------- |
| RagequitGroth16Verifier | [`0x03b81c5620a5a736cc7084337bd0ebe272ff6f0a`](https://sepolia.etherscan.io/address/0x03b81c5620a5a736cc7084337bd0ebe272ff6f0a) |
| DepositGroth16Verifier | [`0x6b780f56aa1007abd19980cef5b8a68a74f34d06`](https://sepolia.etherscan.io/address/0x6b780f56aa1007abd19980cef5b8a68a74f34d06) |

### Transact Verifiers (NxM)

| Config | Address |
| ------ | ------- |
| 1x1 | [`0x88fe44b518a0887dcb7518af91dd0c7d85a53c73`](https://sepolia.etherscan.io/address/0x88fe44b518a0887dcb7518af91dd0c7d85a53c73) |
| 1x2 | [`0xf1336106259d64164170741223c48122cc1a02df`](https://sepolia.etherscan.io/address/0xf1336106259d64164170741223c48122cc1a02df) |
| 1x3 | [`0xe4acebed8fdad6569cd09c659887bb95f484b6d0`](https://sepolia.etherscan.io/address/0xe4acebed8fdad6569cd09c659887bb95f484b6d0) |
| 1x4 | [`0xb03e7c25e120f0b108417ceae4fb5222f5620ef7`](https://sepolia.etherscan.io/address/0xb03e7c25e120f0b108417ceae4fb5222f5620ef7) |
| 1x5 | [`0x06a03fbf0e81e2fdb64dabab41e62793731f313f`](https://sepolia.etherscan.io/address/0x06a03fbf0e81e2fdb64dabab41e62793731f313f) |
| 2x1 | [`0xe6211b250f09cee27a11ca7e249def275210a5b6`](https://sepolia.etherscan.io/address/0xe6211b250f09cee27a11ca7e249def275210a5b6) |
| 2x2 | [`0x52c90dc1c2141d3e9e62cdbcf35c08e71c61a2f5`](https://sepolia.etherscan.io/address/0x52c90dc1c2141d3e9e62cdbcf35c08e71c61a2f5) |
| 2x3 | [`0x893756eb749e72f9137ab34b58a8856f0056a9ca`](https://sepolia.etherscan.io/address/0x893756eb749e72f9137ab34b58a8856f0056a9ca) |
| 2x4 | [`0x41e3f39b1e29c40bb891dc112b7b4fad483ea860`](https://sepolia.etherscan.io/address/0x41e3f39b1e29c40bb891dc112b7b4fad483ea860) |
| 2x5 | [`0x9c8275b6f1c539aa1cabebef46ab7d00ad6c810c`](https://sepolia.etherscan.io/address/0x9c8275b6f1c539aa1cabebef46ab7d00ad6c810c) |
| 3x1 | [`0x8f306312e64d32a8b4a801b96f1b92254913a111`](https://sepolia.etherscan.io/address/0x8f306312e64d32a8b4a801b96f1b92254913a111) |
| 3x2 | [`0x62cd502b06b4225967dff693e44fc40e1b23bb8c`](https://sepolia.etherscan.io/address/0x62cd502b06b4225967dff693e44fc40e1b23bb8c) |
| 3x3 | [`0x41200b842fd36ecfbe5bdeef8d01c9232aa5ddd1`](https://sepolia.etherscan.io/address/0x41200b842fd36ecfbe5bdeef8d01c9232aa5ddd1) |
| 3x4 | [`0xe09f650fff06a11094ab939220bbc144f518acce`](https://sepolia.etherscan.io/address/0xe09f650fff06a11094ab939220bbc144f518acce) |
| 3x5 | [`0xa36e4e67538f25dd2986def9f1c42c9a95e4ce99`](https://sepolia.etherscan.io/address/0xa36e4e67538f25dd2986def9f1c42c9a95e4ce99) |
| 4x1 | [`0x49c27cc52bb15e65ce97803fe983bb74e6776ab3`](https://sepolia.etherscan.io/address/0x49c27cc52bb15e65ce97803fe983bb74e6776ab3) |
| 4x2 | [`0x4622879e7aa55c48e6ba09bdb4ff162f74f1e30f`](https://sepolia.etherscan.io/address/0x4622879e7aa55c48e6ba09bdb4ff162f74f1e30f) |
| 4x3 | [`0x6e744c97d927ec21c18157521a5c839c8257d7a6`](https://sepolia.etherscan.io/address/0x6e744c97d927ec21c18157521a5c839c8257d7a6) |
| 4x4 | [`0x321383f91bdd467e51ed2d24817f1881060d108f`](https://sepolia.etherscan.io/address/0x321383f91bdd467e51ed2d24817f1881060d108f) |
| 4x5 | [`0xbbf961a12f3463263318e3bd7f37c4e7c50201ee`](https://sepolia.etherscan.io/address/0xbbf961a12f3463263318e3bd7f37c4e7c50201ee) |
| 5x1 | [`0xdd0d817fb1f27e9ca39b0761464be489a6554941`](https://sepolia.etherscan.io/address/0xdd0d817fb1f27e9ca39b0761464be489a6554941) |
| 5x2 | [`0xf0624087bf3050088703c321dd3b4e630cc4d0c8`](https://sepolia.etherscan.io/address/0xf0624087bf3050088703c321dd3b4e630cc4d0c8) |
| 5x3 | [`0x86efa456807a6c0ab268826d5e6c5e3427fffbdc`](https://sepolia.etherscan.io/address/0x86efa456807a6c0ab268826d5e6c5e3427fffbdc) |
| 5x4 | [`0x81b66ace1ecbafe31a087748b1544d26b94ffda0`](https://sepolia.etherscan.io/address/0x81b66ace1ecbafe31a087748b1544d26b94ffda0) |
| 5x5 | [`0x0271aa7acfc43b5a264c1205609487795a084880`](https://sepolia.etherscan.io/address/0x0271aa7acfc43b5a264c1205609487795a084880) |

## Governance

| Role | Address |
| ---- | ------- |
| Canon Guard Safe | [`0xD9BaFC442C00bAd122802b38498c8a39CBA1697e`](https://sepolia.etherscan.io/address/0xD9BaFC442C00bAd122802b38498c8a39CBA1697e) |

## Role Holders

| Role | Address |
| ---- | ------- |
| DEFAULT_ADMIN | `0xD9BaFC442C00bAd122802b38498c8a39CBA1697e` (Canon Guard Safe) |
| OPS_ADMIN | `0x6a3452F47Cc3a881bff24F08ab242AB0c44e2916` |
| UPGRADER | `0xD9BaFC442C00bAd122802b38498c8a39CBA1697e` (Canon Guard Safe) |
| ENTRYPOINT_MANAGER | `0x295C28a0fAd0D79Ed72268d17139Fc367eDf2049` |
| POSTMAN | `0x723a43064e73Bcf46cf7d9b8506C400Df8ac878b` |
| PAUSER | `0x0AaF0241dDC869944e30a5e93469F36F3bad1d06` |
| PAUSER | `0x71a2088Ad5D17f401EAcF579fb6198F07f7Eda03` |
| UNPAUSER | `0x1eDC0c3b058e55d16e7986a4307477068875AD75` |
| DEPOSITOR | `0xEB3e3961008952348445513e418ad6F43C23ca9a` (Entrypoint proxy) |

## Configured Assets

| Token | Address | minAmount | vettingFeeBPS | maxRelayFee |
| ----- | ------- | --------- | ------------- | ----------- |
| ETH | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` | 1 | 0 | `type(uint256).max` |
| USDC (Circle) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 1 | 0 | `type(uint256).max` |
| USDT (Aave) | `0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0` | 1 | 0 | `type(uint256).max` |

## System Config

| Parameter | Value |
| --------- | ----- |
| rootHistorySize | 16 |
| keystoreRootLiveness | 1200 |
| maxKeystoreTreeSize | 262144 (2^18) |
| maxStateTreeSize | 4194304 (2^22) |
