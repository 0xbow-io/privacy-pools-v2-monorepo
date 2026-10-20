# Uniswap V3 pool verification (JuiceSwap on Citrea, Uniswap V3 on Optimism, BSC and Robinhood)

All addresses below were independently verified on-chain (not taken on faith from docs)
using `cast` against the public RPCs already configured in this repo
(`https://rpc.mainnet.citrea.xyz`, `https://rpc.testnet.citrea.xyz`). No guessed addresses.

JuiceSwap is a Uniswap V3-style concentrated-liquidity AMM — the deployed pools implement
the standard V3 pool interface (`observe`, `slot0`, `liquidity`, `token0`/`token1`, etc.).

## Mainnet (chainId 4114)

Source for initial candidate addresses: [JuiceSwap docs](https://docs.juiceswap.com/swap)
and [Citrea's canonical contract addresses](https://docs.citrea.xyz/developer-documentation/canonical-contract-addresses).

| Contract | Address | Verified |
|---|---|---|
| UniswapV3Factory | `0xd809b1285aDd8eeaF1B1566Bf31B2B4C4Bba8e82` | bytecode present |
| WCBTC (wrapped native cBTC) | `0x3100000000000000000000000000000000000006` | `symbol()`="WCBTC", `decimals()`=18 |
| USDT.e | `0x9f3096Bac87e7F03DC09b0B416eB0DF837304dc4` | `symbol()`="USDT.e", `decimals()`=6 |
| USDC.e | `0xE045e6c36cF77FAA2CfB54466D71A3aEF7bbE839` | `symbol()`="USDC.e", `decimals()`=6 |
| ctUSD | `0x8D82c4E3c936C7B5724A382a9c5a4E6Eb7aB6d5D` | `symbol()`="ctUSD", `decimals()`=6 |

`factory.getPool()` was queried for WCBTC against all three stablecoins across the 0.01%,
0.05%, 0.3%, and 1% fee tiers. Every pair had at least one deployed pool with nonzero
`liquidity()`. All three stablecoins are wired into this provider, each via its deepest
verified pool — **all at the 0.3% fee tier**:

| Pair | Pool address | `liquidity()` | `token0()` | TWAP tick (`observe([900,0])`) |
|---|---|---|---|---|
| WCBTC/USDT.e | `0xB534E66Da34C0C9AA9f8d4028B43ca89BC9E911d` | ~7.38e10 | WCBTC | `-165764` |
| WCBTC/USDC.e | `0xD77f369715E227B93D48b09066640F46F0B01b29` | ~8.67e9 | WCBTC | `-165538` |
| WCBTC/ctUSD | `0xB02e86A9BEfDcd3Bc1628014663F418047eC3884` | ~9.79e10 (deepest of the three) | WCBTC | `-165752` |

All three pools order WCBTC as `token0` (its address is numerically smallest of the four
tokens involved). `slot0()`'s instantaneous tick and an independently computed 15-minute
TWAP agreed exactly for each pool (values above). Implied price from `slot0`, computed
independently for each pool from the raw `sqrtPriceX96`: **~$63,290–$63,360 per WCBTC** —
the three pools agree with each other within ~0.1%, and the figure is a realistic
real-world BTC price (not placeholder/garbage data).

## Testnet (chainId 5115)

Citrea's canonical-address docs don't cover testnet, and JuiceSwap's own docs don't list
concrete testnet token addresses either, so these were discovered directly from the
factory's `PoolCreated` event log (via the Blockscout API at
`https://explorer.testnet.citrea.xyz`, then cross-checked with `cast call` against the RPC)
rather than any documentation source.

| Contract | Address | Verified |
|---|---|---|
| UniswapV3Factory | `0xdd6Db52dB41CE2C03002bB1adFdCC8E91C594238` | bytecode present |
| WCBTC | `0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93` | `symbol()`="WCBTC", `decimals()`=18 |
| USDC | `0x36c16eaC6B0Ba6c50f494914ff015fCa95B7835F` | `symbol()`="USDC", `decimals()`=6 |

The factory's `PoolCreated` logs surfaced several other WCBTC pairs against obvious
test/meme tokens (`svJUSD`, a token literally named `"123"`, `NUSD`, `LFG`, `HODL3`) — none
of those are usable as a real anchor, so USDC was the only legitimate stablecoin pairing
found. Pool used by this provider — **USDC/WCBTC @ 0.3%**:

- Pool address: `0x2763C50cF1176DEfBAfaD602EF3c160BB05210B8`
- `liquidity()`: ~5.48e11
- `token0()` = USDC (`0x36c1...835F`), i.e. USDC < WCBTC by address — **opposite ordering
  from mainnet**, where WCBTC is token0. `quote_obtention.ts` derives direction from
  address comparison per-config rather than assuming a fixed side.
- `observe([900, 0])` succeeds and returns a consistent 15-minute TWAP
- Testnet liquidity is not real capital — the implied price does **not** reflect actual
  BTC/USD market value, unlike the mainnet pool above. This is expected for a testnet and
  doesn't affect the correctness of the query mechanics being verified.

## Optimism mainnet (chainId 10)

Added 2026-08-16. Unlike Citrea's JuiceSwap fork, this is canonical Uniswap V3 —
factory `0x1F98431c8aD98523631AE4a59f267346ea31F984` (Uniswap's cross-chain deployment).
Pool addresses were not taken from docs: both were resolved on-chain via
`factory.getPool(WETH, <token>, 500)` with `cast` against `https://opt-mainnet.g.alchemy.com`.

| Contract | Address | Verified |
|---|---|---|
| UniswapV3Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | `getPool()` resolves both pools |
| WETH (anchor) | `0x4200000000000000000000000000000000000006` | OP-stack predeploy |
| USDC (native, not USDC.e) | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `symbol()`="USDC", `decimals()`=6 |
| USDT | `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` | `symbol()`="USDT", `decimals()`=6 |

Pools wired in — **both at the 0.05% fee tier** (the deepest tier for these pairs on OP):

| Pair | Pool address | `liquidity()` | `token0()` | `slot0` tick | 15-min TWAP tick (`observe([900,0])`) |
|---|---|---|---|---|---|
| USDC/WETH | `0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b` | ~2.64e16 | USDC | `200861` | `200865` |
| WETH/USDT | `0xc858A329Bf053BE78D6239C4A4343B8FbD21472b` | ~2.97e16 | WETH | `-200853` | `-200856` |

Note the token ordering differs between the two pools (USDC < WETH < USDT by address), so
quote direction must come from the address comparison in `quote_obtention.ts`, not
be assumed — same situation the code already handles for Citrea.

Implied price computed independently from each pool's tick: **~$1,889–$1,891 per ETH** —
the pools agree within ~0.1% and the figure matched the market ETH price at verification
time (not placeholder/garbage data). `slot0` instantaneous tick and the 15-minute TWAP
agreed within 5 ticks (~0.05%) on both pools.

For contrast: Curve's rate-provider oracle on OP (`0x3f4a2BffA78D50CD61401a440526378E2155A8aE`,
via AddressProvider `get_address(18)`) was evaluated the same day and rejected — it has no
WETH→USDC route at all and its only USDC/USDT pool held dust liquidity (~0.06 USDT),
quoting 1 USDC → 0.065 USDT. CowSwap does not operate on Optimism.

## BNB Smart Chain (chainId 56)

Added 2026-09-01. Canonical Uniswap V3 on BSC (factory
`0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7`, QuoterV2 `0x78D78E420Da98ad378D7799bE8f4AF69033EB077`,
both bytecode-present). Pool addresses resolved on-chain via `factory.getPool()` with
`cast` against `https://bsc-dataseed.bnbchain.org`, not taken from docs.

| Contract | Address | Verified |
|---|---|---|
| UniswapV3Factory | `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7` | `getPool()` resolves every tier below |
| WBNB (anchor) | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | `symbol()`="WBNB", `decimals()`=18 |
| USDT | `0x55d398326f99059fF775485246999027B3197955` | `symbol()`="USDT", **`decimals()`=18** |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | `symbol()`="USDC", **`decimals()`=18** |

BSC's USDT and USDC are 18-decimal tokens, unlike their 6-decimal mainnet/OP/Arbitrum
counterparts — `inputToken.decimals` in `UNISWAP_V3_POOLS[56]` reflects the on-chain value.

`getPool()` was queried for WBNB against both stablecoins across the 0.01%, 0.05% and
0.3% tiers; every tier exists with nonzero liquidity. The deepest tier per pair is wired:

| Pair | Fee | Pool address | `liquidity()` | `token0()` | `slot0` tick | 15-min TWAP tick |
|---|---|---|---|---|---|---|
| USDT/WBNB | 0.05% | `0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869` | ~2.4e24 | USDT | `-65235` | `-65276` |
| USDC/WBNB | 0.01% | `0x4141325bAc36aFFe9Db165e854982230a14e6d48` | ~1.2e21 | USDC | `-65235` | `-65270` |

Other tiers seen (not wired): WBNB/USDT 0.01% `0x47a90A2d…` (~2.0e23), 0.3% `0x7862D9B4…`
(~3.4e22); WBNB/USDC 0.05% `0x5289A8Db…` (~7.5e19), 0.3% `0x6bcb0Ba3…` (~5.2e20).

**FDUSD (added 2026-09-25, pegged).** FDUSD `0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409`
(`decimals()`=18) is enabled on the prod BSC Entrypoint, but `getPool(FDUSD, WBNB, fee)` returns
the zero address for the 0.01%, 0.05% and 0.3% tiers: there is no Uniswap V3 FDUSD/WBNB pool on
BSC. It is wired with `pricedAs: USDT` on the USDT/WBNB 0.05% pool above, i.e. priced 1:1 as USDT.
Risk accepted for the hotfix: a FDUSD depeg is not detected and under-prices the relayer's fee
(paid in FDUSD) by the depeg size.

In both wired pools the stablecoin is `token0` (its address is numerically below WBNB's),
so the input token is token0 — the opposite of Citrea mainnet (WCBTC is token0 there)
and handled by the same address-comparison direction logic in `quote_obtention.ts`.

Implied price computed independently from each pool: **~$683 per BNB** from both the
instantaneous `slot0` tick and the 15-minute TWAP (spot vs TWAP within ~0.05%, pools
agreeing within ~0.1%), matching the market BNB price at verification time. For
contrast, the previous BSC setup priced BNB via the `Mock` provider's hardcoded $800.

Alternatives evaluated the same day and rejected: Curve has no AddressProvider / rate-
provider oracle on BSC (`0x5ffe7FB8…` has no code, no `bsc.yaml` in curve-core prod
deployments); CowSwap's orderbook does serve BSC (`api.cow.fi/bnb`, live quote worked)
but the pinned `@cowprotocol/cow-sdk` 5.10.3 `SupportedChainId` enum has no chainId 56,
so `toSupportedChainId()` throws until the SDK is bumped.

## Robinhood Chain (chainId 4663)

Added 2026-10-14. Canonical Uniswap V3 on Robinhood Chain (Arbitrum Orbit L2, ETH gas), factory
`0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (from Uniswap's deployment docs, bytecode-present).
Pool addresses resolved on-chain via `factory.getPool()` with `cast` against
`https://rpc.mainnet.chain.robinhood.com`.

| Contract | Address | Verified |
|---|---|---|
| UniswapV3Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | `getPool()` resolves every tier below |
| WETH (anchor) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | `symbol()`="WETH", `decimals()`=18 |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | `symbol()`="USDG", `decimals()`=6; the asset enabled on the prod Robinhood Entrypoint |

`getPool(WETH, USDG, fee)` exists on all four tiers; the deepest is wired:

| Pair | Fee | Pool address | `liquidity()` | `token0()` | `slot0` tick | 15-min TWAP tick |
|---|---|---|---|---|---|---|
| WETH/USDG | 0.01% | `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` | ~1.6e18 (~3.9M USDG held) | WETH | `-198386` | `-198385` |

Other tiers seen (not wired): 0.05% `0x69BfaF19…` (~1.7M USDG), 0.3% `0xa9188730…` (~393k USDG),
1% `0x5f009E07…` (~33k USDG).

WETH is `token0` (its address is numerically below USDG's), the opposite of the BSC pools.
Implied price **~$2,425 per ETH** from both spot and the 15-minute TWAP, matching the
CowSwap/LI.FI ETH price on other chains the same day. CowSwap, Curve and the Uniswap quoter's
other chains do not cover chainId 4663.

## Limitations

This provider only prices the exact (chainId, input token) pairs listed in
`UNISWAP_V3_POOLS` in `quote_obtention.ts` — verified above. A raw Uniswap V3 pool
(unlike Curve's aggregating oracle) can only price the two tokens it was actually created
for, so adding another asset means verifying its own pool the same way before adding it
here — never assume liquidity/pricing carries over from a different pair. Testnet
currently has only one legitimate pair (USDC/WCBTC); the other WCBTC pools discovered
there pair against obvious test/meme tokens and are deliberately not wired in.

## Verification date

2026-08-03, against Citrea mainnet and testnet at their then-current chain tip.
Optimism: 2026-08-16. BNB Smart Chain: 2026-09-01. Robinhood Chain: 2026-10-14.
