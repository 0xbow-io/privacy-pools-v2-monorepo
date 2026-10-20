# Yield Contracts — Tech Design

## Version History
| Version | Date | Notes |
|---|---|---|
| 0.1.0 | 2026-07-08 | Created during the v2.0 audit. Yield farming (#315) shipped 6 new contracts with only an SDK-side doc (`sdk/yield-sessions.md`); this is the missing contracts-layer spec (closes the alignment EXTENSION in `agents/output/audit/contracts_r1.md`). |
| 0.2.0 | 2026-07-08 | Remediation: `PPYieldTokenZap` uses balance-delta accounting (C-7); `DeployYieldFork` deploys via factory (C-6/L-6); yield real-proof E2E now runs `src/` (H-1); yield-layer invariants added (TEST). Resolved-gaps section replaces the corresponding open gaps. |
| 0.2.1 | 2026-07-30 | The three `Ownable` factories (`PPRouterFactory`, `PPYieldTokenFactory`, `PPYieldTokenZapFactory`) freeze `renounceOwnership` (revert `PP*Factory_RenounceDisabled`) so their sole owner-gated deploy function can never be permanently bricked (audit finding #233; mirrors `PPYieldToken`). |
| 0.2.2 | 2026-09-04 | Production deploy path added: `DeployYieldProduction.s.sol` (chain 1 only) deploys all three components **through their factories**, then enables ppUSDC on the Entrypoint. Documents that ppUSDC's asset-config literals are 18-decimal share amounts, not 6-decimal USDC. |
| 0.3.0 | 2026-09-05 | Native-ETH route: `PPNativeRouter` payable twin of `PPRouter` (ppETH over aWETH) — wraps `msg.value` on deposit (ceiling + in-tx refund), unwraps and pays native ETH on withdrawal; `withdrawToUnderlying` keeps `PPRouter`'s exact ABI so the relayer drives it with config only. New `IPPNativeRouter` + `IWETH9` interfaces. Resolves the dangling "ETH section" reference in `AddYieldAsset.s.sol`. |
| 0.4.0 | 2026-09-08 | `PPNativeRouter` merged into `PPRouter` as a construction-fixed **`NATIVE_MODE`** (single router codebase; `PPNativeRouter.sol`/`IPPNativeRouter.sol` removed, `IWETH9` kept). The merged ABI is a strict superset of the audited one (nothing removed, no mutability changes — the relayer stays config-only). Deployed routers are unaffected (immutable); future assets need a NEW `PPRouterFactory` deployment, which gains `createRouterNative`. 17-test native suite added (`test/unit/PPRouterNative.t.sol`). |

## Purpose
Let a user hold a **yield-bearing** position inside the privacy pool. USDC is wrapped into a
**non-rebasing ERC-4626 share token (ppUSDC)** whose share↔USDC exchange rate rises as Aave v3 interest
accrues. ppUSDC is registered as an ordinary pool asset (`tokenId`), so the core Entrypoint/PoolVault
are **unchanged** — the yield machinery sits entirely on top as a `processor`/router.

## Components (all in `packages/contracts/src/contracts/`)
| Contract | Role |
|---|---|
| `PPYieldToken` | Non-rebasing ERC-4626 wrapper over an Aave aToken (aUSDC → ppUSDC). Shares fixed at 18 dp via `_decimalsOffset = 18 − assetDecimals`. Protocol fee on **yield only** (≤ `MAX_FEE_BPS = 2000`). `Ownable2Step + Pausable + ReentrancyGuardTransient`. |
| `PPYieldTokenFactory` | `Ownable` factory; one wrapper per aToken of one trusted Aave pool. Seeds locked **dead shares** at `0xdEaD` (first-depositor-inflation defense-in-depth). |
| `PPYieldTokenZap` | Stateless `underlying ↔ pp-share` router (`depositUnderlying`, `buyFixedYieldToken`, `redeemToUnderlying`, `quoteBuy`). No storage, no reentrancy guard (see security notes). |
| `PPYieldTokenZapFactory` | `Ownable` factory, one zap per wrapper. |
| `PPRouter` | Combined deposit (`depositExactShares`) + withdraw (`withdrawToUnderlying`) router; acts as the PoolVault transact **`processor`**. Runs in one of two construction-fixed modes: ERC-20 mode (the audited flows, unchanged) or **native mode** (`NATIVE_MODE = true`, wrapped-native underlying — adds payable `depositExactSharesNative` and native-ETH delivery on withdrawal; see the ETH section). `ReentrancyGuardTransient`. |
| `PPRouterFactory` | `Ownable` factory, one router per wrapper regardless of mode: `createRouter` mints ERC-20 mode, `createRouterNative` mints native mode (shared internal `_createRouter`). |

Interfaces: `IPPYieldToken`, `IPPYieldTokenFactory`, `IPPYieldTokenZap`, `IPPYieldTokenZapFactory`,
`IPPRouter`, `IPPRouterFactory`, plus Aave shims `IAToken`, `IAavePool`, `IAaveRewardsController` and
the WETH9 shim `IWETH9`.

Ownership on these `Ownable`/`Ownable2Step` contracts is **transferable but not renounceable** —
`PPYieldToken` and the three factories override `renounceOwnership` to revert
(`PPYieldToken_RenounceDisabled`, `PPRouterFactory_RenounceDisabled`, `PPYieldTokenFactory_RenounceDisabled`,
`PPYieldTokenZapFactory_RenounceDisabled`), so an owner-gated deploy/admin function can never be permanently bricked.

## Deposit flow
`PPRouter.depositExactShares` → `ZAP.buyFixedYieldToken` supplies USDC to Aave and mints ppUSDC shares
→ `ENTRYPOINT.deposit` inserts a ppUSDC note (share amount hidden in the commitment). The share amount
is what value-conservation is enforced over — **not** the underlying USDC. See
[user-flows §1.9](../user-flows.md).

## Withdrawal flow (router as processor)
The user builds a `transact` proof with `processor = PPRouter` and `tokenIdOut = ppUSDC`. `PPRouter.
withdrawToUnderlying` requires `_transactParams.processor == address(this)` (`PPRouter.sol:170`), calls
`POOL_VAULT.transact` (the vault pays the ppUSDC shares to the processor), then `ZAP.redeemToUnderlying`
burns shares → USDC for the recipient and (as USDC) the relay fee, enforcing a `minUnderlyingOut` floor
on the Aave redeem leg. Because the router must be the processor, **a yield withdrawal can never be a
`relayBatch` item** (the batch relay is itself the processor) — the two paths are mutually exclusive.

## Native ETH (ppETH) — PPRouter native mode

An ERC-20-mode `PPRouter` cannot serve native ETH: `depositExactShares` is not `payable` and funds
itself with `UNDERLYING.safeTransferFrom`, and the zap's exit leg ends in Aave's `POOL.withdraw`, which
pays the **WETH** underlying straight to the recipient — there is no wrap/unwrap anywhere on either
path (Aave v3 itself only accepts WETH). A ppWETH asset behind an ERC-20-mode router would therefore be
WETH-denominated end to end. This section is the "ETH section of the yield spec" referenced by
`AddYieldAsset.s.sol` (which deliberately has no WETH entrypoint).

Native support lives in `PPRouter` itself as a second, construction-fixed mode: the 8th constructor
parameter `bool _nativeMode` sets the **`NATIVE_MODE`** immutable (the WETH9 shim `IWETH9` is the only
new interface). For a wrapper over aWETH (**ppETH**), a native-mode router runs the audited flow
statement for statement against the same unmodified wrapper/zap/Entrypoint/PoolVault, with native edges:

- **Deposit** — `depositExactSharesNative(proof, noteData, aspCiphertext)` is `payable` and gated to
  native mode; `msg.value` is BOTH the funding and the `maxUnderlyingIn` slippage ceiling (no separate
  parameter to mis-set). The router wraps exactly the quoted underlying (`WETH.deposit`), routes the
  Aave supply + exact `mint` through the zap, shields via `Entrypoint.deposit`, and refunds the
  unwrapped remainder of `msg.value` to the payer in the same transaction. One transaction, no ERC-20
  approval. The audited `depositExactShares` (ERC-20 WETH in) still works on a native-mode router — the
  two edges coexist.
- **Withdrawal** — `withdrawToUnderlying` keeps its **exact audited name and signature** (the merged
  ABI is a strict superset of the audited one: nothing removed, no mutability changes), so the
  relayer's `processorAddress` branch submits both modes through the same ABI with configuration only
  (an `allowed_processors` entry). In native mode both redeem legs pay WETH to the router itself, which
  unwraps once (`WETH.withdraw`) and delivers **native ETH**: the recipient receives their payout plus
  the submitter's `msg.value` gas funding in a single transfer, and the fee recipient receives the fee.
  A fresh recipient address is immediately liquid — nothing left to approve or unwrap. In ERC-20 mode
  the function is byte-for-byte the audited behavior. The delivery form is a property of the router
  instance, never of the call — a submitter cannot substitute it.
- **`receive()` is gated** to native mode AND the wrapped-native underlying (the only expected pusher,
  during unwrap; it fits WETH9's 2300-gas `transfer` stipend), so no ETH can be stranded by an
  accidental send; the router's ETH balance is transient within a transaction.
- **Construction probe** — a native-mode constructor calls `IWETH9(underlying).deposit{value: 0}()`, so
  deploying native mode over a plain ERC-20 underlying fails at construction rather than at the first
  user's deposit.
- **Stateless**, as audited: ≤ 2 wei of aToken dust per deposit (supply rounding), swept via `skim`.

Deployment: `PPRouterFactory.createRouterNative(vault, zap)` mints a native-mode router with the same
guards and registry write as `createRouter` (one router per wrapper, regardless of mode). The processor
is chosen per proof, so any processor named in a proof can serve the same ppETH `tokenId` — one
anonymity set.

Routers are **immutable** (no proxy — only the core Entrypoint/PoolVault/Keystore/ASPRegistry are
UUPS): "upgrading" a router means deploying a new one and flipping relayer/SDK configuration, never
changing code in place. The deployed mainnet ppUSDC/ppUSDT routers keep running the audited v1 code
(no migration needed — notes are not bound to a router), and the DEPLOYED `PPRouterFactory` has the v1
`PPRouter` bytecode baked in, so future assets on the merged router require a NEW factory deployment.

Test coverage: `test/unit/PPRouterNative.t.sol` (+ `.tree`, 17 tests) over `MockWETH9`, whose unwrap
pushes with a 2300-gas `transfer` exactly like canonical WETH9 — the withdrawal tests therefore also
prove the `receive()` stipend fit. All 44 audited router tests pass with only constructor-arity edits.

## Fee & rate model
- `PPYieldToken` charges the protocol fee only on the **yield** (balance increase since last
  checkpoint); `_checkpoint()` settles accrued yield at the *old* rate before a `setFeeBps` change (no
  retroactive fee). `totalAssets()` clamps `balance − fees` at 0 (avoids underflow-bricking on an Aave
  balance decrease).
- The share rate is monotonic non-decreasing under normal Aave accrual (invariant-tested:
  `invariant_RateMonotonic`, `invariant_Solvency`, `invariant_SharesFullyBacked`).

## Trust model & privileged surface
- **Owner (`Ownable2Step`)** of `PPYieldToken`: `setFeeBps` (≤20%, no timelock), `setRewardsController`
  (external-call target for `claimRewards`), `rescueToken` (any non-`asset()` token), `pause`. These
  are trusted-owner powers; none can move depositor backing (see `contracts_r1` L-4).
- **Aave v3** is a trusted external protocol (supply/withdraw/rewards).
- Factories are `Ownable`; the WRAPPER deploy routes through `PPYieldTokenFactory` so the dead-share seed is applied
  (`DeployYieldFork.s.sol` now deploys via `PPYieldTokenFactory.createWrapper` — C-6/L-6 fixed).

## Production deployment (chain 1)

`DeployYieldProduction.s.sol` (`--sig "runYieldProduction()"`) is the production path; `DeployYieldFork`
remains fork-only (it hardcodes the Aave v3 **Sepolia** market, bypasses the zap/router factories, and
never enables the asset). The production script deploys the wrapper, zap and router **through all three
factories** so `wrapperFor` / `zapFor` / `routerFor` are populated, then calls
`Entrypoint.setAssetConfiguration` — 8 transactions, `--slow` required.

Chain 1 is the only approved target: Aave v3 has no Citrea market, and USDC is not an enabled pool asset
on BSC. Addresses, all asserted in preflight: Aave v3 `Pool` `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`,
`aEthUSDC` `0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c` (6 dp), USDC
`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`.

### ppUSDC asset config is share-denominated

Shares are **always 18 decimals** (`_decimalsOffset = 18 - aToken decimals`), so ppUSDC's `minAmount` and
`maxRelayFee` are `1e12` larger than the plain-USDC entries in `ChainAssetRegistry._mainnetAssets()` for
the same dollar value: `minAmount = 10e18` (~$10) and `maxRelayFee = 1200e18`, against USDC's `10e6` /
`1200e6`. Because a share buys more USDC as Aave interest accrues, a share-denominated floor drifts
*upward* in dollar terms and should be re-tuned via `Entrypoint.setAssetConfiguration` over time.

### Not retroactive

ppUSDC is a distinct `tokenId`. A note deposited as plain USDC never accrues yield and cannot be
converted in place — the holder must withdraw and re-deposit through `PPRouter`, which burns the note and
creates a new one with a new label. The two assets are therefore also **separate anonymity sets**.

## Deliberate deviations
- `PPYieldTokenZap` has no reentrancy guard (stateless; ratified **INTL-04** in `agents/deviations.md`).
- SDK yield API uses `bigint` amounts (INTL-03).

## Zap accounting (C-7)
`PPYieldTokenZap` credits each call by the aToken **balance delta** it produces (before/after a supply
or redeem), never the zap's absolute `balanceOf`. Any aTokens donated to the (stateless) zap are left
stranded rather than swept into the next caller's shares or withdrawal, closing the last-caller-wins
donation-griefing vector. `depositUnderlying`, `buyFixedYieldToken`, and `redeemToUnderlying` all use
this pattern.

## Resolved gaps (were open in `agents/output/audit/contracts_r1.md`)
- Real-proof E2E now runs against `src/` yield contracts (the vendored copies were removed — H-1 fixed).
- Invariants added for `PPRouter`/`Zap`/factories (`test/invariant/InvariantYield.t.sol` — TEST fixed).
- `PPYieldTokenZap` donation griefing fixed via balance-delta accounting (C-7, see above).
