# Swaps Contract Deployment Guide

Covers configuring and deploying `RelaySwaps.sol` to a new chain. All commands run from
`packages/swaps/contracts/`. For the MockPool test-deploy variant see `contracts/README.md`.

## 1. Gather configuration

All of these are per-chain values. The LiFi Diamond is the only address that is the same
on every chain; the periphery contracts are not, so don't copy those between chains
without checking.

| Variable | What it is | How to get it |
|---|---|---|
| `POOL_ADDRESS` | PPv2 `PoolVault` on the target chain | PPv2 deployment records |
| `ENTRYPOINT_ADDRESS` | PPv2 `Entrypoint` on the target chain | PPv2 deployment records |
| `ROUTER` | LiFi Diamond (the initial allowlisted `swapTarget`) | `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` on every supported chain; confirm in [LiFi's deployments registry](https://github.com/lifinance/contracts/tree/main/deployments) |
| `UPGRADER_ROLE` | Contract owner: manages the router allowlist and `rescue()` | Use a multisig or hardware wallet in production, not the deployer key |
| `PUBLISHER_PRIVATE_KEY` | Deployer key used by forge | Needs gas on the target chain |
| `CREATE2_SALT` (optional) | bytes32 salt; when set the script deploys through forge's default CREATE2 factory (`0x4e59b44847b379578588920ca78fbf26c0b4956c`) so the address is the same on every chain with identical constructor args (pool, entrypoint, owner, router). Deployer/nonce don't matter. Script aborts if code already exists at the predicted address. | Prod: `cast keccak "privacy-pools-v2:RelaySwaps:prod:v2"` → RelaySwaps `0xd0395c08DD8eA7671a7A65bDca8E473e8E8260a8` on mainnet/bsc (2026-09-18) and optimism/base/arbitrum/robinhood (2026-10-14; robinhood deployed with the `0x1231…` router arg for address parity, then its own diamond `0xB477…` approved and `0x1231…` removed) ( yield `executeUnwrapped` + zap registry + RC-01/03/32 fixes; supersedes `0x5936aEfB…` from `…:prod:v1`, 2026-09-01) |
| LiFi `Executor` (post-deploy) | Periphery contract LiFi routes contract-calls quotes through (swap+deposit flow) | `deployments/<chain>.json` in the LiFi registry. Per-chain address: mainnet `0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88`, arbitrum `0x2dFaDAB8266483beD9Fd9A292Ce56596a2D1378D`. Check it on-chain before approving, the registry can lag the live diamond. |

Leave `IS_TEST_DEPLOYMENT` unset (or set it to `false`). Production deploys never need it;
the deploy script will refuse to run if the pool addresses don't point at real PPv2
contracts.

## 2. Deploy

```bash
cd packages/swaps/contracts
forge build && forge test

export POOL_ADDRESS=0x...
export ENTRYPOINT_ADDRESS=0x...
export ROUTER=0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
export UPGRADER_ROLE=0x...

# Dry-run first (no --broadcast), check the logged constructor params
forge script script/DeployRelaySwaps.s.sol --rpc-url $RPC_URL -vv

# Real deploy + source verification
forge script script/DeployRelaySwaps.s.sol \
    --rpc-url $RPC_URL --broadcast \
    --private-key $PUBLISHER_PRIVATE_KEY \
    --verify --etherscan-api-key $ETHERSCAN_KEY -vv
```

## 3. Allowlist the LiFi Executor (needed for swap+deposit)

LiFi quotes come in two shapes. Plain swap/bridge quotes target the Diamond, which is
already allowlisted via `ROUTER`. Contract-calls quotes (what the SDK uses for
swap-and-deposit) target the per-chain Executor instead. Skip this step and those quotes
fail the allowlist check, so the swap never happens.

Both `transactionTo` and `approvalAddress` from a quote have to be allowlisted: the SDK
checks them against `approvedRouters` on-chain, and `RelaySwaps.execute()` enforces the
same thing.

As the owner (multisig tx if the owner is one):

```bash
cast send $RELAY_SWAPS "approveRouter(address)" <EXECUTOR_ADDRESS> --rpc-url $RPC_URL ...
```

Don't approve other LiFi periphery (`ERC20Proxy`, `LiFiDEXAggregator`, `Permit2Proxy`)
up front. Diamond + Executor is what we've been running on arbitrum and it has been
enough. If a quote ever comes back with a different address, say `ERC20Proxy` as
`approvalAddress`, review it before adding it: anything on this list can receive token
approvals and quote-supplied calldata.

The deploy script has an optional `APPROVAL_ADDRESS` env var that calls `approveRouter()`
during deploy, but it only works when the broadcaster is the owner. With a multisig
owner, skip it and send the tx above after deploy.

## 3b. Allowlist yield zaps (only on chains with ppUSDC / ppUSDT)

Yield notes hold ERC-4626 shares that no aggregator can route. `RelaySwaps.executeUnwrapped(…, zap)`
redeems the withdrawn shares into their underlying through the wrapper's `PPYieldTokenZap` right
after `POOL.transact`, then swaps the underlying exactly like `execute()`. The relayer calls it
instead of `execute()` for share assets. Nothing is allowlisted at deploy; add each wrapper's zap
as the owner:

```bash
RELAY_SWAPS_ADDRESS=$RELAY_SWAPS ZAP=<zap> \
  forge script script/ApproveZap.s.sol --rpc-url $RPC_URL --broadcast --private-key $OWNER_KEY -vv
```

`approveZap()` cross-checks `zap.A_TOKEN() == zap.VAULT().asset()`,
`zap.UNDERLYING() == aToken.UNDERLYING_ASSET_ADDRESS()` and `Entrypoint.assets(zap.VAULT()).enabled`,
so a mis-wired zap reverts instead of listing. `executeUnwrapped()` additionally requires
`zap.VAULT() == tokenIdOut`, so an allowlisted zap can only ever serve its own share. Removal
(`removeZap`) only makes `executeUnwrapped()` revert for that zap; it can never redirect an
in-flight proof. Known zaps (verified 2026-09-04):

| chain | share | zap |
|---|---|---|
| mainnet | ppUSDC `0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6` | `0x9Ea986BcDF6784D85B518b15bEEE1E65b585817B` |
| mainnet | ppUSDT `0xA4cF419558Ef36CC6FfB666195684dC963910426` | `0xDC3D922df81FC7B7f58229431ED91acB0482f3A5` |
| mainnet | ppETH `0x66051920D25af4E3596A8a46309F4D045F9D83B7` (native-mode router `0x77613D670BB9fD48A9898D0eac8ebf21B566F960`, underlying WETH) | `0x33c1eEf370bBb447414156CFc4fDABD434776EAf` |
| bsc | ppUSDT `0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2` | `0xc0FBB5D5936a6f089C1B30Ff0Fd0BEAd27b9F766` |
| optimism, base, arbitrum | ppETH `0x319aBEE703b5f6c3dB9c2f126475ef49B20Fdd49` (router `0xc0FBB5D5…`) | `0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2` |
| optimism, base, arbitrum | ppUSDC `0x4a5B11c3898367664D94B43bE1DcEA163BB1D094` (router `0xaaE55aFc…`) | `0x34F9F5c4788a60eae7A8901d83E0bbe56Ab43251` |
| optimism, arbitrum | ppUSDT `0xFe4DcdDD59027384462207c2b9101F9CDcd58a3C` (router `0x19918499…`) | `0x12a78A1EA6F12d2a2cF37070cF93c872BFC2Da7E` |

The OP/Base/Arbitrum zaps were read from each router's `ZAP()` and approved on RelaySwaps
`0xd0395c08…` on 2026-10-14. Note the same address means different contracts on different
chains: `0x6C17bE9c…` is the BSC ppUSDT *share* but the OP/Base/Arbitrum ppETH *zap*, and
`0xc0FBB5D5…` is the BSC ppUSDT *zap* but the OP/Base/Arbitrum ppETH *router*.

The relayer reads `approvedZapList()` at boot (`YieldZapRegistry`) and derives its
share -> zap map from it — the on-chain allowlist is authoritative, `supported_assets[].zap`
in the relayer config is only an optional cross-check. So `approveZap` must run **before**
the relayer boots (or the relayer for that chain restarted after) any yield chain.

Design, threat model and test plan: `docs/tech-design/future-ideas/relayswaps-yield-unwrap.md`.

## 4. Verification

```bash
cast call $RELAY_SWAPS "owner()(address)" --rpc-url $RPC_URL              # == UPGRADER_ROLE
cast call $RELAY_SWAPS "POOL()(address)" --rpc-url $RPC_URL               # == POOL_ADDRESS
cast call $RELAY_SWAPS "ENTRYPOINT()(address)" --rpc-url $RPC_URL         # == ENTRYPOINT_ADDRESS
cast call $RELAY_SWAPS "approvedRouters(address)(bool)" $ROUTER --rpc-url $RPC_URL      # true
cast call $RELAY_SWAPS "approvedRouters(address)(bool)" $EXECUTOR --rpc-url $RPC_URL    # true
cast call $RELAY_SWAPS "approvedZaps(address)(bool)" <zap> --rpc-url $RPC_URL             # true on yield chains
cast call $RELAY_SWAPS "approvedZapList()(address[])" --rpc-url $RPC_URL                 # every allowlisted zap; what the relayer reads at boot
cast call $RELAY_SWAPS "ROUTING_TYPEHASH()(bytes32)" --rpc-url $RPC_URL                  # must equal RELAY_SWAP_ROUTING_TYPEHASH in the SDK/relayer this deployment will serve
```

**Routing layout self-check (RC-32).** `SwapRouting` is decoded from opaque bytes inside
`execute()` — it's never part of any external function's ABI — so a freshly-deployed
`RelaySwaps` and the SDK/relayer builds pointed at it can silently disagree on the struct's
field list/types/order until a proof is wasted mid-decode. `ROUTING_TYPEHASH()` (`external
pure`, `keccak256` of the struct's EIP-712-style encodeType string) exists so a client can
check this before committing to a payload. After any deploy, confirm the value above matches
the `RELAY_SWAP_ROUTING_TYPEHASH` constant in both `packages/sdk` (`src/constant/PoolSessionTransact.ts`)
and `packages/relayer/relayer` (`src/relay/evm/swap_routing_abi.ts`) — the relayer additionally
refuses to boot against a chain where this mismatches (`RoutingLayoutBootValidator`), and the
SDK throws `RelaySwapsLayoutMismatch` pre-proof, so a drift here surfaces before it burns a
proof either way. `RoutingLayout.t.sol` (`packages/swaps/contracts/test/`) keeps the on-chain
string honest against the struct's actual compiled shape at build time.

## 5. Final wiring

Nothing uses the contract until it's configured everywhere, needs to be added to:

1. Relayer: add the RelaySwaps address to `allowed_processors` for the chain in
   `relayer.config.json`. The default is empty, which means swaps stay disabled.
2. SDK: publish the address as `RELAY_SWAPS_ADDRESS` / the `relaySwapsAddress`
   config of the swap pool sessions. 
