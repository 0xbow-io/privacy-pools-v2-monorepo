# Sepolia Deployment V8

**Date:** 2026-05-18
**Deployer:** `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39`
**Chain ID:** 11155111
**Deploy block:** `10875479` (single block)
**Pinned block (`SEPOLIA_V8_DEPLOYMENT_BLOCK`):** `10875680` (after post-deploy USDC fee bump in block `10875675`)

> Re-deployed on top of V7 with role-separated holders baked in by `Deploy.s.sol`
> (V7 concentrated every role on the deployer EOA, which made the AccessRouter
> integration tests un-runnable against a real Sepolia fork). The V7 addresses are
> abandoned and no longer referenced by `ChainDeploymentRegistry`.

---

## Protocol Contracts

| Contract | Address |
| -------- | ------- |
| AccessRouter | [`0xe2fAFF4BceA7Eed77CF1bDe422BBAdE19B21024A`](https://sepolia.etherscan.io/address/0xe2fAFF4BceA7Eed77CF1bDe422BBAdE19B21024A) |
| ASPRegistry (proxy) | [`0x264D76933F80009dE335f5f86A894FE4e71495c9`](https://sepolia.etherscan.io/address/0x264D76933F80009dE335f5f86A894FE4e71495c9) |
| Keystore (proxy) | [`0x59c4BfBC334Ba0CC717C2dC80a2D6e83C0CEBda9`](https://sepolia.etherscan.io/address/0x59c4BfBC334Ba0CC717C2dC80a2D6e83C0CEBda9) |
| PoolVault (proxy) | [`0x323C28ce5f21192Df8009215D3aBdf6011158347`](https://sepolia.etherscan.io/address/0x323C28ce5f21192Df8009215D3aBdf6011158347) |
| Entrypoint (proxy) | [`0x49Eac830F663578BDF2344C7371DC669DEaCf176`](https://sepolia.etherscan.io/address/0x49Eac830F663578BDF2344C7371DC669DEaCf176) |
| PrivacyPoolRelay | [`0xb52f2465C165791ebf2A1e3eD6c6Ef8055f996C6`](https://sepolia.etherscan.io/address/0xb52f2465C165791ebf2A1e3eD6c6Ef8055f996C6) |

## Implementation Contracts

| Contract | Address |
| -------- | ------- |
| ASPRegistry (impl) | [`0x27BBc4f30213768eeDB5393dDa39926Be3dd7754`](https://sepolia.etherscan.io/address/0x27BBc4f30213768eeDB5393dDa39926Be3dd7754) |
| Keystore (impl) | [`0x5f79f6f44e420ce31cc9a4dc0Be0836652B3B606`](https://sepolia.etherscan.io/address/0x5f79f6f44e420ce31cc9a4dc0Be0836652B3B606) |
| PoolVault (impl) | [`0xfd4276B55c2975335Baa148e1b290708e3f2178b`](https://sepolia.etherscan.io/address/0xfd4276B55c2975335Baa148e1b290708e3f2178b) |
| Entrypoint (impl) | [`0x9A0eA2E509a41599A9779FF440859a64cF80F37d`](https://sepolia.etherscan.io/address/0x9A0eA2E509a41599A9779FF440859a64cF80F37d) |

## Libraries

| Library | Address | Note |
| ------- | ------- | ---- |
| PoseidonT3 | [`0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93`](https://sepolia.etherscan.io/address/0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93) | canonical deterministic deployment, linked via `--libraries` |
| PoseidonT4 | [`0x4443338EF595F44e0121df4C21102677B142ECF0`](https://sepolia.etherscan.io/address/0x4443338EF595F44e0121df4C21102677B142ECF0) | canonical deterministic deployment, linked via `--libraries` |

## Verifiers

| Contract | Address |
| -------- | ------- |
| DepositGroth16Verifier | [`0x3ad9E082b8dbA6A454adB138edd868648a64A1Ba`](https://sepolia.etherscan.io/address/0x3ad9E082b8dbA6A454adB138edd868648a64A1Ba) |
| RagequitGroth16Verifier | [`0xF83937b8039C8d7400b876680CEE9C9444b47CEF`](https://sepolia.etherscan.io/address/0xF83937b8039C8d7400b876680CEE9C9444b47CEF) |

### Transact Verifiers (NxM)

| Config | Address |
| ------ | ------- |
| 1x1 | [`0xDd908137f7A7AEEb72c398f29F9D2e441fA2560E`](https://sepolia.etherscan.io/address/0xDd908137f7A7AEEb72c398f29F9D2e441fA2560E) |
| 1x2 | [`0x676DD2f1AFdbE262281143894D9F1c814F03CBe3`](https://sepolia.etherscan.io/address/0x676DD2f1AFdbE262281143894D9F1c814F03CBe3) |
| 1x3 | [`0x655bAaBbE1d16C1BE99230B361c2AD419F153527`](https://sepolia.etherscan.io/address/0x655bAaBbE1d16C1BE99230B361c2AD419F153527) |
| 1x4 | [`0x6a8ED79c3Cdd004eD4E83a5a36685dC387b8bdce`](https://sepolia.etherscan.io/address/0x6a8ED79c3Cdd004eD4E83a5a36685dC387b8bdce) |
| 1x5 | [`0x16C216c30CDb58dC7871594d2540d034467E58B7`](https://sepolia.etherscan.io/address/0x16C216c30CDb58dC7871594d2540d034467E58B7) |
| 2x1 | [`0xc86DBe4218Aa3046D3EB9B5c9620a4975CC32C1f`](https://sepolia.etherscan.io/address/0xc86DBe4218Aa3046D3EB9B5c9620a4975CC32C1f) |
| 2x2 | [`0x8dbAA8b3b07C6721e7b3C6E7D890DEf4bbeb099a`](https://sepolia.etherscan.io/address/0x8dbAA8b3b07C6721e7b3C6E7D890DEf4bbeb099a) |
| 2x3 | [`0x5416bd47654B6169C3c6DA646808c6D4cA894D12`](https://sepolia.etherscan.io/address/0x5416bd47654B6169C3c6DA646808c6D4cA894D12) |
| 2x4 | [`0xdAC5254d9C982D8A817796cC3C4269545142C944`](https://sepolia.etherscan.io/address/0xdAC5254d9C982D8A817796cC3C4269545142C944) |
| 2x5 | [`0x2D42CCCE2c70b92BE5AB39605B0eA8dBDd6A49F6`](https://sepolia.etherscan.io/address/0x2D42CCCE2c70b92BE5AB39605B0eA8dBDd6A49F6) |
| 3x1 | [`0xAF63ba748Ff4bbd10eBa9De74dc41bBcEDB508bf`](https://sepolia.etherscan.io/address/0xAF63ba748Ff4bbd10eBa9De74dc41bBcEDB508bf) |
| 3x2 | [`0xE45b46B0930Deb70100715091777D1d9Fec8ff15`](https://sepolia.etherscan.io/address/0xE45b46B0930Deb70100715091777D1d9Fec8ff15) |
| 3x3 | [`0x78f733749b30a406DB5eb335Afc7743a00Ccf61f`](https://sepolia.etherscan.io/address/0x78f733749b30a406DB5eb335Afc7743a00Ccf61f) |
| 3x4 | [`0xeeC84B848e62379f42F5a2dF5bE0c3951483764C`](https://sepolia.etherscan.io/address/0xeeC84B848e62379f42F5a2dF5bE0c3951483764C) |
| 3x5 | [`0xF2FCe9cEE15be39fE85B618d8C08f862E971d462`](https://sepolia.etherscan.io/address/0xF2FCe9cEE15be39fE85B618d8C08f862E971d462) |
| 4x1 | [`0x971980006fcF84670B85d066742AeE7ea70311C1`](https://sepolia.etherscan.io/address/0x971980006fcF84670B85d066742AeE7ea70311C1) |
| 4x2 | [`0x879fF0B0BE1f2037C4DFbE02660d0F780f5852c2`](https://sepolia.etherscan.io/address/0x879fF0B0BE1f2037C4DFbE02660d0F780f5852c2) |
| 4x3 | [`0x902255F489d1659214e1f526F1CE187e4842306a`](https://sepolia.etherscan.io/address/0x902255F489d1659214e1f526F1CE187e4842306a) |
| 4x4 | [`0x013D7b691397ACC6F78Dd70DF7187b1f6275640f`](https://sepolia.etherscan.io/address/0x013D7b691397ACC6F78Dd70DF7187b1f6275640f) |
| 4x5 | [`0xf7BaCDE04cb4B7F80f603fe6b2CB5F1F24377fEd`](https://sepolia.etherscan.io/address/0xf7BaCDE04cb4B7F80f603fe6b2CB5F1F24377fEd) |
| 5x1 | [`0xB660b55bd5043b32437c1B822b60F5e141D6F2E9`](https://sepolia.etherscan.io/address/0xB660b55bd5043b32437c1B822b60F5e141D6F2E9) |
| 5x2 | [`0x8e633C43Ce8bB99D7694a58d9B849612267fe5ce`](https://sepolia.etherscan.io/address/0x8e633C43Ce8bB99D7694a58d9B849612267fe5ce) |
| 5x3 | [`0xb2842CD2dC264000C33896e2aC41cEFe14c4377e`](https://sepolia.etherscan.io/address/0xb2842CD2dC264000C33896e2aC41cEFe14c4377e) |
| 5x4 | [`0x564452ab3a937cDe7CC06b07fe03374314278519`](https://sepolia.etherscan.io/address/0x564452ab3a937cDe7CC06b07fe03374314278519) |
| 5x5 | [`0x34A355A3215c6e09193d65684727f1e65074c0dA`](https://sepolia.etherscan.io/address/0x34A355A3215c6e09193d65684727f1e65074c0dA) |

## Governance

| Role | Address |
| ---- | ------- |
| Canon Guard Safe | `0x0000000000000000000000000000000000000000` (Sepolia skips Canon Guard) |

## Role Holders

Each operational role is held by a distinct EOA so the AccessRouter integration
suite exercises real role separation (no overlap with the deployer).

| Role | Address |
| ---- | ------- |
| DEFAULT_ADMIN | `0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39` (deployer; only role retained) |
| OPS_ADMIN | `0x6a3452F47Cc3a881bff24F08ab242AB0c44e2916` |
| UPGRADER | `0xC1083300DB1F7De7794925897E71206f2E069438` |
| ENTRYPOINT_MANAGER | `0x295C28a0fAd0D79Ed72268d17139Fc367eDf2049` |
| POSTMAN | `0x723a43064e73Bcf46cf7d9b8506C400Df8ac878b` |
| PAUSER | `0x0AaF0241dDC869944e30a5e93469F36F3bad1d06` |
| PAUSER | `0x71a2088Ad5D17f401EAcF579fb6198F07f7Eda03` |
| UNPAUSER | `0x1eDC0c3b058e55d16e7986a4307477068875AD75` |
| DEPOSITOR | `0x49Eac830F663578BDF2344C7371DC669DEaCf176` (Entrypoint proxy) |

## Configured Assets

| Token | Address | minAmount | vettingFeeBPS | maxRelayFee |
| ----- | ------- | --------- | ------------- | ----------- |
| ETH | `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` | 1 | 0 | `type(uint256).max` |
| USDC (Circle) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | 1 | 100 | `type(uint256).max` |
| USDT (Aave) | `0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0` | 1 | 0 | `type(uint256).max` |

## System Config

| Parameter | Value |
| --------- | ----- |
| rootHistorySize | 16 |
| keystoreRootLiveness | 1200 |
| maxKeystoreTreeSize | 262144 (2^18) |
| maxStateTreeSize | 4194304 (2^22) |
