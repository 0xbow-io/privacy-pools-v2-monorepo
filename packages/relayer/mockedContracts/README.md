# Mocked Contracts

Simplified Solidity contracts used by the relayer e2e test suite. They replicate the on-chain interfaces (Entrypoint, PrivacyPoolRelay, PoolVault) with relaxed validation so that tests can run against a local Anvil fork without real proof verification.

## Contents

| Path | Purpose |
|---|---|
| `src/contracts/Entrypoint.sol` | Minimal Entrypoint accepting deposits/withdrawals |
| `src/contracts/PrivacyPoolRelay.sol` | Simplified relay that skips heavy on-chain checks |
| `src/libraries/VerifierMock.sol` | Stub verifier that accepts any proof |
| `src/interfaces/` | Shared interfaces (`IEntrypoint`, `IPoolVault`, `IPrivacyPoolRelay`) |
| `script/PrivacyPoolRelay.s.sol` | Forge deployment script for local Anvil testing |

## Usage

### Build

```shell
forge build
```

### Deploy to local Anvil

```shell
forge script script/PrivacyPoolRelay.s.sol:RelayDeployment --rpc-url http://127.0.0.1:8545 --broadcast
```
