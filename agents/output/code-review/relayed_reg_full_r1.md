# Code Review — Relayed Key-Registration (#310 / INTL-05)

- **Commit:** `2ef7b958` (`git rev-parse HEAD` → `2ef7b95818c09fafa19c2952b8d2e0542869313e`)
- **Branch:** `v2.0-features`
- **Base for convention pinning:** `v2.0` @ `d91112f2` (contracts + sdk `CLAUDE.md` present & unchanged; relayer `CLAUDE.md` validated against base-v2 relayer code)
- **Scope:** `Keystore.setAuthPolicyWithSig` + `PrivacyPoolRelay.registerAndRelay`, their interfaces, the SDK relayed-registration path (EIP-712 builder, `PoolSessionKeystore`, `PoolSessionWithdraw`, `WitnessPreparationService`, `TransactOrchestrator`, `RelayerInteractor`), and the relayer register-and-relay endpoint (controller/service/schemas/types/chain-service/contract_errors/relayer_abi).
- **Verdict:** APPROVE WITH MINOR FIXES. Core feature (`relayRegisterAndWithdrawal` → `/register-and-relay` → `registerAndRelay`) is coherent across all three layers and the EIP-712/predicted-root conventions are exact. Three findings: one Major (a *sibling* standalone-registration method wired to a non-existent endpoint), two Minor (stale relay ABI errors, dead error-decoder helper).

---

## Coherence checks (all PASS)

**C1 — EIP-712 SetAuthPolicy payload: SDK ⇔ contract — PASS (exact).**
`constant/PoolSessionKeystore.ts` sets `KEYSTORE_EIP712_DOMAIN_NAME = "PrivacyPoolsKeystore"`,
`KEYSTORE_EIP712_DOMAIN_VERSION = "1"`, and `SET_AUTH_POLICY_TYPES.SetAuthPolicy = [account:address,
authDigest:uint256, nullifyingKeyHash:uint256, deadline:uint256]`. These match `Keystore.sol`
`__EIP712_init('PrivacyPoolsKeystore', '1')` (line 64/73) and
`SET_AUTH_POLICY_TYPEHASH = keccak256('SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)')`
(line 33-34) — same primary type, same field order, same types. The on-chain digest is
`_hashTypedDataV4(keccak256(abi.encode(TYPEHASH, _account, _authDigest, _nullifyingKeyHash, _deadline)))`
(Keystore.sol:93-95); `keystoreEip712.ts` carries the three uint256 fields as `bigint` so viem's
`hashTypedData` reproduces that `abi.encode`. **Verified by `keystoreEip712.test.ts` "hash to the same
EIP-712 digest the contract reconstructs on-chain"**, which independently rebuilds
`keccak256(0x1901 ‖ domainSeparator ‖ structHash)` from the raw type strings — a real drift guard, not a
tautology. Ran the suite: **5/5 pass**.

**C2 — register-and-relay wire shape: SDK params ⇔ relayer schema ⇔ contract ABI — PASS.**
SDK `RegisterAndWithdrawalRelayParams` = `WithdrawalRelayParams` + `registration{account, authDigest,
nullifyingKeyHash, deadline, signature}` (`schemas/RelayerInteractor.ts:163-168`, `types/RelayerInteractor.ts:284-287`).
Relayer `zEvmRegisterAndRelayRequest` = `zBaseRelayRequest` + `signedFeeCommitment` + optional
`processorAddress`/`minUnderlyingOut` + `registration: zRegistration{account, authDigest, nullifyingKeyHash,
deadline, signature}` (`schemas.ts:162-184`). Chain service unpacks the same five fields and passes
`[account, BigInt(authDigest), BigInt(nullifyingKeyHash), BigInt(deadline), signature, {pA,pB,pC,pubSignals},
{data,processor}, noteData]` (`evm.chain.service.ts:459-481`), matching `PP_RELAY_ABI` `registerAndRelay`
arg order exactly (`relayer_abi.ts:120-179`) and `IPrivacyPoolRelay.registerAndRelay` (interface:194-203).
The `registration` object is an **explicit key** on both zod schemas (recurring-defect F-1 avoided — no
silent key-strip), confirmed in the schema comments and by `types.ts` `Registration = z.infer<zRegistration>`.

**C3 — predicted post-insertion keystore root ⇔ on-chain insert index — PASS (single-sourced).**
`WitnessPreparationService.buildTransactWitness` computes `keystoreLeaf` once via `computeKeystoreLeaf`
(same owner + `Poseidon(privateNullifyingKey)` + authDigest the contract will insert), then for a pending
registration proves membership against `[...keystoreLeaves, keystoreLeaf]` (line 142-148) — appending at the
END, i.e. index = current size. `Keystore._setAuthPolicy` → `_insertInTree` → `LeanIMT.insert` inserts at
index = `keystoreTree.size` (Keystore.sol:212, 262-265). So the predicted `keystoreProof.index` equals the
actual insert index, and "proven leaf == inserted leaf" holds by construction (one derivation, reused) —
satisfies the D-rule single-source check. The empty-tree first-registration case is correctly permitted by
`schemas/WitnessPreparationService.ts:48-49` (`keystoreLeaves.length >= 1 || pendingKeystoreRegistration`).
(The residual off-chain risk — SDK's `keystoreLeaves` snapshot must equal on-chain leaves at execution — is
documented on `IPrivacyPoolRelay.registerAndRelay` and mitigated via private orderflow; not a code defect.)

**C4 — already-registered guards agree across layers — PASS.**
Contract: `registerAndRelay` skips registration when `keystore.nullifyingKeys(_account) == _nullifyingKeyHash`
(front-run robustness), and a *mismatched* existing key still reverts via the `setAuthPolicyWithSig`
one-time guard (`PrivacyPoolRelay.sol:102-111`, `Keystore._setAuthPolicy:206`). SDK
`prepareRelayedRegistration` rejects an already-registered account up front with `KeystoreAlreadyRegistered`
(PoolSessionKeystore.ts:187-189) — a courtesy fail-fast, consistent with (not contradicting) the contract's
idempotent-skip. Behavior is coherent.

---

## Findings

### RR-1 (Major, judgment) — `submitRelayedRegistration` posts to a relayer route that does not exist
`packages/sdk/src/services/RelayerInteractor.ts:322-324` POSTs to
`${relayer.url}/v1/relay/${chainType}/${chainId}/register`, but the relay controller exposes only
`withdrawal`, `register-and-relay`, `relay-and-announce`, `transfer`, `batch` — there is **no `register`
route** (`relay.controller.ts`, confirmed by grep: the sole "register" match is `register-and-relay`). Any
call to this public API method therefore 404s. `submitRelayedRegistration` has no in-SDK caller; it is the
*standalone* relayed-registration path (`setAuthPolicyWithSig` only, no withdrawal), a sibling of the atomic
feature under review. **Impact:** a shipped public method that cannot succeed. **Fix:** either (a) add the
standalone `@Post("register")` relayer endpoint + service method (`setAuthPolicyWithSig`), or (b) if the
standalone path is intentionally deferred, remove `submitRelayedRegistration`/`RegisterKeystoreRelayParams`
or mark them unimplemented so integrators are not misled. The **atomic** path
(`relayRegisterAndWithdrawal` → `/register-and-relay`) is correctly wired and unaffected.
Confidence: high on the 404; Major-vs-Minor depends on whether standalone registration is in-scope.

### RR-2 (Minor) — `PP_RELAY_ABI` is stale: 4 contract errors + 1 constructor arg missing
`packages/relayer/relayer/src/sdk/relayer_abi.ts`. The error list omits four errors that exist on the current
`PrivacyPoolRelay`/`IPrivacyPoolRelay`: `PrivacyPoolRelay_ZeroRecipient`,
`PrivacyPoolRelay_AnnouncementRecipientMismatch`, `PrivacyPoolRelay_ZeroAnnouncer`,
`PrivacyPoolRelay_RootHistoryTooSmall`. Because `ALL_CONTRACT_ERRORS` sources relay-contract errors *only*
from `PP_RELAY_ABI` (`contract_errors.ts:76`), and that merged ABI is what viem uses to decode simulate
reverts (`evm.chain.service.ts:470`), a register-and-relay simulation that reverts with
`PrivacyPoolRelay_ZeroRecipient` (reachable via `_relay`) surfaces as a raw selector, not a name — the exact
error-message-quality gap the harvest work set out to close, but only closed for the Keystore leg. The
constructor entry also lists only `_pool, _entrypoint` and is missing the third arg `_announcer` (harmless —
the relayer never deploys, but it is drift against "synced from compiled output"). **Fix:** re-sync
`PP_RELAY_ABI` from the current compiled artifact (or add the four error entries + the `_announcer`
constructor param).

### RR-3 (Minor) — `decodeContractError` is dead production code
`packages/relayer/relayer/src/chain.service/contract_errors.ts:98`. The function is fully spec'd
(`contract_errors.spec.ts`, 7 tests, ran **7/7 pass**) but is **never called by any production path** — every
chain-service catch block uses `error instanceof BaseError ? error.message : String(error)`
(`evm.chain.service.ts:381,420,441,487,529,566`). viem already decodes revert reasons into `error.message`
using the `ALL_CONTRACT_ERRORS` ABI passed to `simulateContract`, so the helper is redundant. The harvest's
stated goal ("registerAndRelay ... registration-leg reverts surface here") is in fact achieved by the
exported `ALL_CONTRACT_ERRORS` const being spread into the simulate ABI, **not** by `decodeContractError`.
**Fix (judgment):** either wire `decodeContractError` into the catch blocks (it adds cause-chain `walk()`
robustness over `error.message`) or delete it and its spec to avoid a tested-but-unreachable helper.

---

## Style conformance

**Solidity (`Keystore.sol`, `PrivacyPoolRelay.sol`, interfaces) — PASS.**
Single-line `///` NatSpec throughout (no `/** */`); custom errors contract-name-prefixed and delivered via
`require(cond, Keystore_/PrivacyPoolRelay_Error())` (Keystore.sol:92,96; not if-revert); `SET_AUTH_POLICY_TYPEHASH`
is SCREAMING_SNAKE; `_camelCase` params and named `_result`-style returns; section banners present and ordered;
structs (`PayoutRouting`, `Announcement`, `KeystoreRootStorage`) live in interfaces; the public constant getter
`SET_AUTH_POLICY_TYPEHASH()` is declared in `IKeystore`. NatSpec tag order on the constant (`@dev` then
`@inheritdoc`) is valid. No violations introduced by this feature.

**SDK — PASS.** Every reviewed `src`/`test` import routes through `internal.js`; `Hex` at all public
boundaries (`authDigest`/`nullifyingKeyHash`/`deadline`/`signature` are `Hex`); DI via typed config objects;
two-layer JSDoc honored (`IPoolSessionKeystore` `@throws {PoolSessionKeystoreBaseError}` base only; impl uses
`@inheritdoc` + specific subclasses); one error domain file with each class setting `this.name`; test names
verb-first (`keystoreEip712.test.ts`: build/emit/convert/hash/bind).

**Relayer — PASS.** Pipe → zod → service → chain-service flow (`RegisterAndRelayValidationPipe` →
`zEvmRegisterAndRelayRequest` → `EvmRelayService.registerAndRelay` → `simulateAndWriteRegisterAndRelay`);
`zXxx` naming (`zRegistration`, `zEvmRegisterAndRelayRequest`); `BadRequestException` for client faults with
matching `logger.error`; unbounded arrays bounded (`items` `.max(MAX_BATCH)`); logger-first constructor.

---

## Pre-existing items (NOT introduced by this feature — noted for honesty, not counted as findings)

- **Method-order interleaving in `PoolSessionKeystore.ts`.** Private `isViewingKeySet`/`buildAuthPolicyCalldata`/
  `buildViewingKeyCalldata` (lines 241-280) sit above public `registerKeystore`/`executeRegisterKeystore`/…
  (285+), violating SDK rule 2 ("all public above all private"). `git show v2.0:…PoolSessionKeystore.ts`
  confirms this interleaving **predates the branch** (private methods before `registerKeystore` at base). The
  feature's new public method `prepareRelayedRegistration` is correctly placed above the privates. Per the
  code-review agent's base-pinning rule, this is not a feature finding.
- **`WitnessPreparationService.computeCommitment` (line 316) is unused.** The `v2.0..HEAD` diff for this file
  touches only the `pendingKeystoreRegistration` logic (+12/-2), so the dead private predates the branch.
- **`IKeystore` declares `initialize`/`initializeEIP712`** (operational methods the contracts `CLAUDE.md`
  says to keep out of interfaces). `initializeEIP712` mirrors the pre-existing `initialize` declaration —
  consistent-with-neighbor, not newly divergent.
- **`signature` validated with `HexIntegerSchema`** (alias of `HexSchema`) in `schemas/RelayerInteractor.ts:158`
  — semantically a byte string, not an integer. `HexSchema` (common.ts:5-26) only regex-checks `^0x[0-9a-fA-F]+$`
  and passes the string through unchanged (no normalization/leading-zero stripping), so a 65-byte signature is
  transmitted intact — functionally correct. Nit only.

## What I ran
- `npx vitest run test/unit/services/keystoreEip712.test.ts` → **5 passed** (incl. the on-chain-digest
  reconstruction test).
- `npx jest src/chain.service/contract_errors.spec.ts` → **7 passed**.
- `git show v2.0:…PoolSessionKeystore.ts` + `git diff --stat v2.0 HEAD` to confirm pre-existing vs.
  feature-introduced structure.
