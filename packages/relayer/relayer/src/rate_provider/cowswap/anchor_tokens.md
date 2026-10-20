# CowSwap anchor tokens per chain

`quote_obtention.ts` needs a fixed "anchor" (destination) token to price every quote
against, per chain — CoW Protocol's SDK officially supports 5 chains (`SupportedChainId`:
`MAINNET`, `GNOSIS_CHAIN`, `ARBITRUM_ONE`, `BASE`, `SEPOLIA`), but each chain needs its own
verified anchor address; reusing mainnet's WETH address on another chain would silently
mis-price everything (the same failure class this whole change exists to prevent).

Only mainnet was wired into `ANCHOR_TOKEN_BY_CHAIN_ID` initially. The other four below are
now verified and ready to wire in.

## Verification method

Two independent checks per address, not just recalled from memory:

1. **On-chain**: direct `eth_call` to each chain's public RPC for `symbol()`, `name()`,
   and `decimals()` at the candidate address — confirms it's a real, correctly-shaped
   token contract.
2. **Live CoW API smoke test**: a real quote request against CoW's production orderbook
   API (`https://api.cow.fi/{network}/api/v1/quote`) pairing the anchor against a
   well-known token on that chain — confirms CoW actually has liquidity/routing for it,
   not just that the contract exists.

## Verified anchor tokens

| Chain | chainId | `SupportedChainId` | CoW API network slug | Address | symbol | name | decimals |
|---|---|---|---|---|---|---|---|
| Ethereum Mainnet | 1 | `MAINNET` | `mainnet` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | WETH | Wrapped Ether | 18 |
| Gnosis Chain | 100 | `GNOSIS_CHAIN` | `xdai` | `0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1` | WETH | Wrapped Ether on xDai | 18 |
| Arbitrum One | 42161 | `ARBITRUM_ONE` | `arbitrum_one` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | WETH | Wrapped Ether | 18 |
| Base | 8453 | `BASE` | `base` | `0x4200000000000000000000000000000000000006` | WETH | Wrapped Ether | 18 |
| Sepolia | 11155111 | `SEPOLIA` | `sepolia` | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` | WETH | Wrapped Ether | 18 |

Note on Gnosis Chain: its native gas token is xDAI, not ETH — the address above is a
legitimate *bridged* WETH (its own `name()` literally says "Wrapped Ether on xDai"), not a
native wrapped-gas-token like the other four. Conceptually different, but equally valid and
liquid as an anchor — confirmed by the live quote below.

## Live smoke test results

Both run against CoW's production API (not testnet/staging), each returning
`"verified": true`:

**Arbitrum One** — sell 1 USDC (`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`) for WETH:
```json
{"sellAmount":"989691","buyAmount":"518175237205812","verified":true,...}
```

**Gnosis Chain** — sell 1 WXDAI (`0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d`) for
WETH-on-xDai:
```json
{"sellAmount":"999999936448930429","buyAmount":"522891778868198","verified":true,...}
```

Arbitrum and Base share the identical predeploy-style address
(`0x4200...0006` is Base's OP-stack predeploy convention; Arbitrum's is its own canonical
gateway WETH) — both independently confirmed on-chain, not assumed from the pattern.

## Next step

Wire all four into `ANCHOR_TOKEN_BY_CHAIN_ID` in `quote_obtention.ts`, replacing the current
single-entry (mainnet-only) map.
