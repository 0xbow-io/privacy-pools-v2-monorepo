# Code Review + Coherence — Swaps PR #333

- **Commit:** `7a0b764e` (`7a0b764ebf9009f3f4fd0c2c62a05c65071f98a9`)
- **Branch:** `review/swaps-333`
- **Scope:** `packages/swaps/` (RelaySwaps.sol + scripts), SDK swap sessions / `LiFiSwapQuoteProvider` / `RelaySwapRouting` util / interfaces / errors, relayer swap ABIs + quote/relay wiring.
- **Lens:** conventions (contracts + sdk + relayer `CLAUDE.md`) + cross-layer coherence. Security-exploitability is out of scope (Audit lens); this run confirms the seams hold.

---

## PRIMARY: SwapRouting tuple coherence — PASS (no drift)

The 11-field `SwapRouting` tuple is **byte-for-byte identical** across every encode/decode point. Field order, ABI types, and TS field names all agree:

| # | Field | Contract `RelaySwaps.sol:64-76` | Relayer `swap_routing_abi.ts:22-33` | SDK `RELAY_SWAP_ROUTING_ABI` (`constant/PoolSessionTransact.ts:42-59`) | Design doc `withdraw-and-swap.md:182-194` |
|---|-------|---|---|---|---|
| 1 | swapTarget | address | address | address | address |
| 2 | approvalAddress | address | address | address | address |
| 3 | outputToken | address | address | address | address |
| 4 | recipient | address | address | address | address |
| 5 | feeRecipient | address | address | address | address |
| 6 | fallbackAddress | address | address | address | address |
| 7 | dustRecipient | address | address | address | address |
| 8 | feeAmount | uint256 | uint256 | uint256 | uint256 |
| 9 | minOutputAmount | uint256 | uint256 | uint256 | uint256 |
| 10 | nativeGas | uint256 | uint256 | uint256 | uint256 |
| 11 | swapCalldata | bytes | bytes | bytes | bytes |

The SDK TS type (`utils/RelaySwapRouting.ts:11-23`) and relayer TS interface (`swap_routing_abi.ts:5-17`) list the same 11 fields in the same order with matching types (`Address`/`bigint`/`Hex`/`Bytes`).

**Encode/decode topology is clean:** the relayer is the **sole encoder** (`encodeRelaySwapRouting`, called at commit time in `evm.quote.service.ts:381`); the SDK (`decodeRelaySwapRouting`) and the contract (`abi.decode` at `RelaySwaps.sol:212`) only decode. No competing encoders to drift.

**Zero-recipient sentinel semantics agree across all three layers.** `recipient == address(0)` ⇒ `nativeGas == 0` and `minOutputAmount == 0`, enforced identically in:
- Contract `execute()` — `RelaySwaps.sol:241-247` (`RelaySwaps_NativeGasWithoutRecipient` / `RelaySwaps_MinOutputWithoutRecipient`).
- Relayer — quote-time `zEvmSwapQuoteRequest.superRefine` (`evm.schemas.ts:142-157`) **and** relay-time re-decode (`evm.relay.service.ts:373,391`).
- SDK — `PoolSessionWithdrawAndSwap` (cross-chain branch, lines 90-101, 300-312) and `PoolSessionReshield.assertReshieldRouting` (hard-asserts recipient==0, minOutputAmount==0, nativeGas==0, lines 550-564).

The flow steps (prelim quote → LiFi quote → committed quote → decode-once + field asserts → proof → relay) match the design doc's Steps 1-8. **No coherence finding.**

---

## Findings

Severity: Blocker / Major / Minor / Nit. (C)=confirmed mechanical, (J)=judgment call.

### CR-1 — Major (J) — SwapRouting ABI defined 3× across the wire boundary (drift risk)
The routing ABI tuple exists as three independent definitions: contract struct, relayer `relaySwapRoutingParams` (`swap_routing_abi.ts:19-36`), and SDK `RELAY_SWAP_ROUTING_ABI` (`constant/PoolSessionTransact.ts:42-59`). Relayer encodes with its copy; SDK decodes with its copy — the two sides of the wire. They are identical **today**, so no live bug, but a future edit to one and not the other silently mis-decodes routing (exactly the recurring "single-source derivation across a boundary" defect, and the class of bug this review is chartered to catch). Relayer `CLAUDE.md` rule 7 already establishes the pattern — `PAYOUT_ROUTING_ABI` is *imported* from the SDK, not redefined.
**Fix:** export `RELAY_SWAP_ROUTING_ABI` from the SDK public entry and import it in the relayer; derive both relayer encode and SDK/relayer decode from that one constant.

### CR-2 — Major (J) — 5 validation helpers copy-pasted between the two relayer sessions
`decodeRelaySwapRouting` genuinely removed the 5 duplicated *decode* blocks (doc claim verified). But five *validator* privates are still byte-identical between `PoolSessionWithdrawAndSwap.ts` and `PoolSessionReshield.ts`:
`assertRelayerChainMatchesPool`, `assertAmountSentMatchesAmountPlusFee`, `assertSwapCalldataMatches`, `assertFeeWithinBounds`, `assertSwapQuoteMatchesRequest` (WithdrawAndSwap `357-456` vs Reshield `418-530`); `assertSwapRouting` vs `assertReshieldRouting` also overlap heavily. A security-relevant fix applied to one copy can miss the other.
**Fix:** extract into a shared `RelaySwapSessionValidators` util (mirroring the `decodeRelaySwapRouting` dedup).

### CR-3 — Minor (C) — RelaySwaps.sol is not `forge fmt`-clean
`forge fmt --check src/RelaySwaps.sol` reports diffs: mis-indented constructor (`153-158`), non-collapsed `RouterAdded`/`RouterRemoved` events (`118-123`), and a single-quote import at line 7 (`'main_contracts_libs/ProofLibV2.sol'`) inconsistent with the double-quote imports above it. **Fix:** run `forge fmt`. (Aside: the main `packages/contracts` guide specifies `quote_style='single'`, but `packages/swaps/contracts/foundry.toml` has no `[fmt]` block, so foundry defaults to double quotes — pick one and make the package consistent.)

### CR-4 — Minor (J) — struct/interface convention: `SwapRouting` lives in the contract (task-flagged)
`struct SwapRouting` is defined **inside** `contract RelaySwaps` (`RelaySwaps.sol:64`), violating contracts `CLAUDE.md` ("All structs must be defined in interfaces"). There is no `IRelaySwaps` interface at all; public getters (`approvedRouters`, `POOL`, `ENTRYPOINT`, `NATIVE_ASSET`) are undeclared by any interface, and `IPool`/`IEntrypoint` are declared inline in the same `.sol` file rather than under `interfaces/`. Defensible for a standalone package, but it is a written-guide deviation. **Fix:** add `IRelaySwaps` holding `SwapRouting` + getters, or log as an intentional deviation in `deviations.md`.

### CR-5 — Minor (C) — function params not `_camelCase`
`approveRouter(address routerAddress)` (`178`), `removeRouter(address routerAddress)` (`185`), `changeOwnership(address newOwner)` (`191`) — guide requires `_routerAddress` / `_newOwner`. These `public` fns are never called internally and could be `external`.

### CR-6 — Minor (C) — `changeOwnership` is a dead wrapper
`changeOwnership` (`191-193`) just calls OZ `Ownable.transferOwnership`, which is already `public onlyOwner`. Redundant surface; the `// Allow ownership transfer` line is a plain comment, not NatSpec. **Fix:** delete it and use the inherited `transferOwnership`.

### CR-7 — Minor (C) — unnamed global import
`import "@openzeppelin/contracts/access/Ownable.sol";` (line 6) — every other import uses named `{Symbol}` form. **Fix:** `import {Ownable} from "...";`.

### CR-8 — Major (J) — `packages/swaps/package.json` is boilerplate that misdescribes the package
There is **no `src/`**, no `index.ts`, no `main.ts` in `packages/swaps/` (the package holds only Solidity contracts under `contracts/` + `*.integration.test.ts`). Yet the manifest: points `main`/`module`/`types` at `./dist/*`; runs `build: tsup`; declares `start: tsx src/main.ts` and `start:dev: tsx watch src/main.ts` (**nonexistent file**); `test:unit: vitest run spec` matches **zero** files (no `*.spec.ts` exist); and lists a full NestJS/express/rxjs/winston/nanoid/nestjs-cls/nestjs-zod dependency stack that nothing in the package imports. `description` says "Cross-Chain Swaps via Intents" but the implementation is LiFi-backed, not intents. **Fix:** prune to what the package is (contracts + integration tests), drop unused deps and the dead `start`/`build`/`test:unit` scripts, fix the description.

### CR-9 — Minor (C/J) — orphaned test/debug artifacts committed
Git-tracked but with **no static reference** in any `.ts`/`.sol` (grepped the literal filenames): `test/full_swap_response.json` (395 ln), `test/full_swap_and_contract_response.json` (566 ln), `test/example_swap_request.http`, `test/relayer.config.real.json`. Caveat: they could be loaded via a dynamically constructed path — I only confirmed no literal reference. `relayer.config.real.json` carries `signer_private_key: 0x00…01` — the well-known anvil/test key, **not a real secret**, but a committed file named `.real.json` with a `private_key` field invites a real key being pasted there later. `contracts/deploy-v0.1.json` is a committed Arbitrum deployment record. The package `.gitignore` already covers `broadcast/`, `.deposits/`, `*.gpg`, and dotfiles — these slip through only because they are non-dotfiles. **Fix:** delete the orphaned fixtures (or move under a referenced fixtures path) and add `*.real.json` to `.gitignore`.

---

## Notable PASSes (evidence)

- **SDK conventions:** internal-barrel imports throughout the swap files (`import { … } from "../internal.js"`); public-above-private method order in all three sessions + `LiFiSwapQuoteProvider`; single typed config object DI (`PoolSession*Config` + optional `…Dependencies`); two-layer JSDoc — interface `IPoolSessionWithdrawAndSwap` uses base `@throws {PoolSessionTransactBaseError}` only, impls use `@inheritdoc` + specific `@throws` (e.g. `PoolSessionWithdrawAndSwap.ts:62-66`); `Hex` at the public boundary; error domain files use one `<Domain>BaseError` + subclasses each setting `this.name` (`errors/PoolSessionTransact.ts`).
- **Relayer conventions:** endpoint follows pipe→schema→service (`relay.controller.ts:136-144` `SwapValidationPipe` → `relayService.relaySwap`); `zEvmSwapQuoteRequest`/`zEvmRelaySwapRequest` schema-first with `z.infer` types; `NotImplementedException` for unsupported chain; **type⟺schema parity holds** — every field the SDK sends (`asset, amount, outputToken, recipient, fallbackAddress?, minOutputAmount, nativeGas?, swapCalldata?, swapTarget?, approvalAddress?, dustRecipient, commit`) has a matching key in `zEvmSwapQuoteRequest` (`evm.schemas.ts:103-116`); `commit`-gated signing preserved (schema requires calldata/target only when `commit`).
- **Signing single-encoder:** relayer sets `feeRecipient = feeReceiverAddress`, `fallbackAddress ?? recipient`, `approvalAddress ?? swapTarget` (`evm.quote.service.ts:355-387`) then re-decodes and re-asserts contract invariants at relay time (`evm.relay.service.ts:373-413`).
- **Wiring:** sessions exported via `external.ts:28-31`; `PoolSessionFactory` threads `entrypointInteractor` + `swapQuoteProvider` into all three sessions (`PoolSessionFactory.ts:194-231`) — matches the design doc's "`…Config` now require `entrypointInteractor`".

## Observation (not a finding)
In `PoolSessionWithdrawAndSwap.relayWithdrawAndSwap`, the same-chain path passes `nativeGas: undefined` to `assertSwapRouting` (line 309), so routing `nativeGas` is not re-checked at relay time (it is checked at prepare time, is proof-bound via the context hash, and the contract enforces `msg.value == nativeGas`). Defense-in-depth relaxation, not exploitable — noted for the Audit lens.

## What I ran
- `forge fmt --check src/RelaySwaps.sol` → diffs (CR-3).
- `git ls-files packages/swaps` + `grep` for fixture references → CR-9 (no literal reference found).
- `ls packages/swaps` / `find` → confirmed no `src/`, `main.ts`, `index.ts` (CR-8).
- Field-by-field diff of the 4 tuple definitions + design doc (PRIMARY PASS).
