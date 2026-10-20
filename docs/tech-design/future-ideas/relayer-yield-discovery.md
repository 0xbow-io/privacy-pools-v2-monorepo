# Relayer-published yield & processor discovery — plan

Status: IMPLEMENTED 2026-09-17 (branch fat/fixes/030, vuln-mining #30) — relayer §2 and SDK §3.1/§3.3 (§3.2 landed earlier in #397); frontend §4 pending. Originally: planned extension (not spec). Author: Claude, 2026-09-05. Motivation: prod incident where
the frontend paid ppUSDC on withdrawal because it never routed yield notes through `PPRouter`;
root gap = nothing tells a client which routers / wrappers a relayer supports, so addresses get
hardcoded per app and drift (same failure class as the 2026-09-02 RelaySwaps address mismatch).

**Partly delivered (2026-09-10, PR-1).** The relayer-side boot derivation + cross-check now
exists for the *swap* path: `YieldZapRegistry` reads `RelaySwaps.approvedZapList()` at boot,
resolves each zap's share via `zap.VAULT()`, fails boot on inconsistency with the configured
`"Underlying"` assets (a chain with yield assets but no `relay_swaps_contract` is warned about and
skipped since 2026-10-14 — yield swaps off there, `PPRouter` withdrawals unaffected), and is the authoritative source of the zap `relaySwap` / `quoteSwap` use
(`supported_assets[].zap` demoted to an optional cross-check). See
`relayswaps-yield-unwrap.md` §0a. Still pending here: the `/v1/details` `yield[]` publication,
the SDK `getChainDetails` / `withRelayerDetails` hooks, and the `PPRouter`-based withdraw-path
discovery (§2.2) — this PR only covered the RelaySwaps zap list, not the routers.

## 0. TL;DR

1. **Relayer** derives, at boot, one `yield[]` entry per allowlisted `PPRouter` by reading the
   router on-chain (`VAULT()`, `UNDERLYING()`, `ZAP()`), cross-checks it against the configured
   `Underlying`-quoted assets, and publishes it on `/v1/details` (per-chain and full). Fails boot
   on inconsistency (a router whose share isn't a configured asset, or an `Underlying` asset with
   no router).
2. **SDK** gains `RelayerInteractor.getChainDetails(relayerInfo)` (typed, zod-validated) and a
   builder hook `withRelayerDetails(details)` that derives `relaySwapsAddress` and the yield
   wrappers from it, so nothing is hand-copied.
3. **SDK yield namespace** becomes multi-wrapper (`session.yield.for(ppToken)` / a map keyed by
   share address) so ppUSDC and ppUSDT coexist on mainnet.
4. **Frontend** builds sessions from `details` and routes any note whose `tokenId` is a known
   share through `prepareYieldWithdrawRelay`.

## 1. Current state (verified 2026-09-05)

- `GET /v1/details/evm/:chainId` → `{ id, name, type, contracts{entrypoint, poolVault, relay,
  relaySwaps?}, swapsSupported, assets[{address, ticker, fixedFeeAmount, feeBPS?}] }`
  (`details.schemas.ts`, `evm.details.service.ts`). Prod already lists ppUSDC/ppUSDT in `assets`
  but with no quoter / underlying / router info.
- `allowed_processors` (routers) is config-only; never surfaced.
- SDK `RelayerInteractor` has no details call. `RelayerInfo` (url, chainId, address,
  processorAddress) is caller-supplied. `PoolSessionConfig.yieldDeployment` is singular; the
  factory builds one `PPRouterInteractor` + one `PPYieldTokenInteractor`.
- Prod relayer (`relayer-v2-prod-…run.app`) runs the config with the three routers and the
  `Underlying` quoter; a 100-ppUSDC quote returns 0.124 shares (= the USDC gas cost at the live
  redeem rate), so the relayer side of yield withdrawals is live. Only discovery is missing.

## 2. Relayer changes (`packages/relayer/relayer`)

### 2.1 Wire shape (additive, optional → non-breaking for old clients)
```ts
// details.schemas.ts
export const zYieldWrapper = z.object({
    ppToken: zEvmAddress,        // PPYieldToken share (the shielded asset)
    underlying: zEvmAddress,     // ERC-20 the user deposits/receives
    router: zEvmAddress,         // PPRouter — the processor to bind for yield withdrawals
    zap: zEvmAddress,            // PPYieldTokenZap (loose-share exits, RelaySwaps unwrap registry)
    ppDecimals: z.number(),      // 18
    underlyingDecimals: z.number(),
    underlyingSymbol: z.string(),
});
zChainConfig = zChainConfig.extend({
    yield: z.array(zYieldWrapper),   // [] when the chain has no allowlisted routers
    processors: z.array(zEvmAddress) // = allowed_processors, verbatim (routers today)
});
```
`IChainConfig` / `ChainConfigDto` (`@ApiProperty` each) / `relayer.types.ts` mirror it.

### 2.2 Derivation (`src/details/yield-discovery.service.ts`, new)
For each chain, for each `allowed_processors[i]`:
- read `VAULT()`, `UNDERLYING()`, `ZAP()` via `EVMChainService.readContract` with a minimal
  `PPROUTER_VIEWS_ABI` (add next to `pprouter.abi.ts`; keep the existing pinned write ABI
  untouched);
- read `decimals()` on `VAULT` and `UNDERLYING`, `symbol()` on `UNDERLYING`;
- require: `VAULT` is a configured asset with `quoter: "Underlying"` whose `underlying` equals
  the router's `UNDERLYING()`; `UNDERLYING` is a configured asset (already enforced for the quoter).
  Mismatch → boot error naming the router and the field.
- require the reverse: every `Underlying`-quoted asset has exactly one router → else boot error
  ("ppUSDT configured but no PPRouter allowlisted: yield withdrawals would be rejected").
- cache the result per chain for the process lifetime (routers are immutable per config); a
  read failure at boot is fatal (same posture as `RateProviderBootValidator`).
Runs from `OnApplicationBootstrap` (after `RateProviderBootValidator`), exposes
`wrappersFor(chainId): YieldWrapper[]`.

### 2.3 Service / controller
`EvmDetailsService.chainDetails` / `allDetails` add `yield: discovery.wrappersFor(id)` and
`processors: chain.allowedProcessors()`. Asset-level endpoint (`/details/:chainType/:chainId/:asset`)
unchanged.

### 2.4 Tests
- `yield-discovery.service.spec.ts`: happy path (2 routers, 2 wrappers), router whose VAULT is not
  configured, `Underlying` asset without router, `UNDERLYING()` mismatch, RPC read failure → boot
  error text.
- `evm.details.service.spec.ts`: `yield` and `processors` present; `[]` on chains without routers.
- `schemas.processor-wire.spec.ts` untouched (relay path unchanged).

### 2.5 Docs
README config table (`allowed_processors` row) + a "Yield discovery" paragraph under the details
section; `deploy.md` §5 "Final wiring" gains "restart relayer; verify `/v1/details … yield[]`".

## 3. SDK changes (`packages/sdk`)

### 3.1 Details client
- `schemas/RelayerInteractor.ts`: `zRelayerChainDetails` (mirror of §2.1, optional `yield`/
  `processors` so older relayers still parse), inferred `RelayerChainDetails`.
- `IRelayerInteractor.getChainDetails(relayerInfo): Promise<RelayerChainDetails>` →
  `GET {url}/v1/details/evm/{chainId}`.
- Helper `relayerInfoFromDetails(url, name, details)`: fills `address`?? (not in details today —
  add `relayerAddress`/`feeReceiver` to the wire shape in §2.1 so `RelayerInfo.address` is also
  discovered; today it is hand-copied too) and `processorAddress = contracts.relaySwaps`.

### 3.2 Multi-wrapper yield namespace
- `PoolSessionConfig.yieldDeployment?: YieldDeployment` → `yieldDeployments?: YieldDeployment[]`
  (keep the singular as a deprecated alias mapped to a one-element list).
- `YieldSessions` becomes `{ wrappers: Map<Address, {deposit, withdraw, token, router,
  deployment}>, for(ppToken): … }`; existing `session.yield.deposit/withdraw/token/router` stay as
  accessors for the first wrapper (deprecated) so current callers don't break.
- `PoolSessionWithdrawAndSwap.yieldWrappers` already takes a list (done 2026-09-05); factory feeds
  it from the same array.

### 3.3 Builder
- `withRelayerDetails(details: RelayerChainDetails)`: sets `deployment.relaySwapsAddress` when
  unset, and `yieldDeployments` from `details.yield` (`ppRouter=router, ppUSDC=ppToken,
  underlying, decimals, symbol, zap`). Explicit `withYieldDeployment(s)` still wins.
- `isYieldNote(tokenId)` convenience on the session (true when `tokenId` matches a wrapper).

### 3.4 Tests / docs
Unit: details schema parse (with/without `yield`), builder derivation, multi-wrapper factory,
`for(ppToken)` lookup. Docs: `sdk/relayer-interactor.md` (new endpoint + version row),
`sdk/yield-sessions.md` (multi-wrapper + discovery, version row).

## 4. Frontend (privacy-pools-website, not in this repo)
- On chain init: `details = await relayerInteractor.getChainDetails(relayerInfo)`; build the
  session with `.withRelayerDetails(details)`.
- Withdraw flow: `if (session.isYieldNote(note.tokenId))` → `session.yield.for(tokenId).withdraw
  .prepareYieldWithdrawRelay(...)` → `relayWithdrawal(relayParams)`; hide batch / stealth / extraGas
  options for yield notes; drop the "you will hold ppUSDC" copy (recipient gets the underlying).
- Remove hardcoded RelaySwaps / router addresses from `chainData.ts`.

## 5. Rollout order
1. Relayer §2 (additive) → deploy → `curl /v1/details/evm/1` shows `yield[]` with 2 wrappers,
   `/evm/56` with 1.
2. SDK §3 → publish.
3. Frontend §4.
Old SDKs keep working throughout (fields optional).

## 6. Open questions
- Publish `relayerAddress` in details too (closes the last hand-copied `RelayerInfo` field)? Proposed: yes.
- Should `/details` also publish RelaySwaps' `unwraps(share)` state once the yield-unwrap contract
  ships (`swapsSupported` per share)? Proposed: yes, same discovery service, when P3 of
  `relayswaps-yield-unwrap.md` lands.
- Boot-fatal vs warn on inconsistency: proposed fatal (matches the rate-provider validator posture).
