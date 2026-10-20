# Curve rate-provider oracle addresses per chain

`curve_quote_obtention.ts` needs a real, deployed `RateProvider` oracle contract per chain
(the one exposing `get_aggregated_rate(source, destination)`), plus a WETH-equivalent anchor
token to price against. Reusing another chain's oracle address would silently mis-price
everything — the same failure class `cowswap/anchor_tokens.md` exists to prevent, applied to
Curve's on-chain oracle instead of an HTTP API.

## Verification method

Curve exposes each chain's contract registry through an `AddressProvider` singleton
(`get_address(id)`, RateProvider is ID 18). Two independent checks per chain, not recalled
from memory:

1. **Registry lookup on-chain**: `eth_call` to the chain's `AddressProvider` for
   `get_address(18)`, confirming the resulting address is non-zero and has bytecode.
2. **Behavioral check**: call `get_aggregated_rate(source, destination)` on the candidate
   address with a known token pair and sanity-check the returned rate against an independent
   price source (CowSwap's live quote for the same pair, from `anchor_tokens.md`).

## Verified oracle contracts

| Chain | chainId | AddressProvider used | Oracle (`get_address(18)`) | Anchor |
|---|---|---|---|---|
| Ethereum Mainnet | 1 | `0x0000000022D53366457F9d5E68Ec105046FC4383` (canonical) | `0xA834f3d23749233c9B61ba723588570A1cCA0Ed7` (from curve-core's `deployments/prod/stable.yaml`) | WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| Arbitrum One | 42161 | `0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98` | `0xcbc1BE39ba277525E774976c61660f29fA75C5a4` | WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |

## Arbitrum: why a different AddressProvider

`curve-core`'s own `deployments/` directory has no `arbitrum.yaml` (only `debug`/`devnet`/
`examples`/`prod`, with `prod/` covering mostly newer stableswap-ng chains) — that does **not**
mean Arbitrum has no deployment, only that this particular repo doesn't track it. Confirmed
on-chain instead:

- The **canonical** `AddressProvider` (`0x0000...4383`) does exist on Arbitrum (has bytecode)
  and resolves other IDs fine (0, 1, 2), but `get_address(18)` returns the zero address —
  RateProvider simply isn't registered in that instance on this chain.
- A **separate** `AddressProvider` deployment exists on Arbitrum at
  `0x5ffe7FB82894076ECB99A30D6A32e969e6e35E98` (distinct bytecode, distinct address) — this one
  resolves ID 18 to `0xcbc1BE39ba277525E774976c61660f29fA75C5a4`, a real contract (has bytecode).
- Also checked the canonical `AddressProvider` on Gnosis Chain and Base: both exist, both
  return the zero address for ID 18. No equivalent alternate registry was searched for on
  those chains (out of scope for this pass) — treat Curve as unverified on Gnosis/Base until
  someone does the same lookup there.

## Live cross-check (Arbitrum)

`get_aggregated_rate(USDC, WETH)` against `0xcbc1BE39ba277525E774976c61660f29fA75C5a4` on
Arbitrum's public RPC (`arb1.arbitrum.io/rpc`) returned:

```
518102071140527  (≈ 5.181 × 10^14 wei WETH per 1 USDC)
```

CowSwap's live orderbook quote for the same pair on Arbitrum (`anchor_tokens.md`) returned:

```
sellAmount: 989691, buyAmount: 518175237205812  (≈ 5.18175 × 10^14 wei WETH per ~0.99 USDC)
```

Two independently-sourced prices (an on-chain oracle vs. a live aggregated-solver quote) agree
to 4 significant figures — strong evidence this is the correct, live oracle rather than a
coincidentally-deployed unrelated contract at that address.

## Chains still unverified

- **Gnosis Chain (100)** and **Base (8453)**: canonical `AddressProvider` has no ID-18 entry;
  no alternate registry (like Arbitrum's) has been searched for yet.
- Any other chain: no lookup attempted.
