# Relayed Key Registration

> **Status: promoted to implementation (2026-06-24).** The auth-policy scope (§4, §4a) has been
> implemented and the source-of-truth specs updated — see `contracts/contracts-tech-design.md` §3
> (Keystore) and §5 (Privacy Pool Relay). This document is retained for the design rationale
> (motivation, security analysis, the predicted-root race in §4a). Relayed **viewing-key** registration
> (§6) remains a future idea and is *not* implemented.

The protocol version described in this specification requires a user to register their authorization policy in the keystore by calling `Keystore.setAuthPolicy` *from the address being registered*. This couples registration to gas: the address must hold native funds to pay for its own registration transaction. For most flows this is fine — the user funded the account they deposit from. It breaks down, however, for a recipient who is handed a fresh, unfunded address and now needs to spend a note sent to it. This document lays out that flow, explains why the current design blocks it, and proposes a relayed registration path that decouples *who pays gas* from *which address gets registered*.

### Contract changes at a glance

Scope is **auth policy only** (relayed viewing-key registration is deferred — Section 6). The circuits are **unaffected**. For v2.0 this landed as a **contracts-only** change; the SDK glue this doc scopes (§§ below) is **DEFERRED** — see `agents/deviations.md` INTL-05. Two contracts are touched:

| Contract | Change | Purpose |
| --- | --- | --- |
| `Keystore` | New `setAuthPolicyWithSig(account, authDigest, nullifyingKeyHash, signature)`; inherit `EIP712Upgradeable`; add `SET_AUTH_POLICY_TYPEHASH` + `__EIP712_init`; refactor so it and `setAuthPolicy` share an internal `_setAuthPolicy`; new error `Keystore_InvalidSignature`. | Let any caller pay gas to register an `account`, authorized by that account's EIP-712 signature (EOA or EIP-1271 via `SignatureChecker`). Reuses the `AuthPolicySet` event, so the relayed path is indistinguishable on-chain. (Section 4) |
| `PrivacyPoolRelay` | New `registerAndRelay(...)` = `setAuthPolicyWithSig` then the existing relay path, atomically; add a `Keystore` reference. | Close the economic loop: the withdrawal fee repays registration gas in the same transaction, so the relayer needn't trust the recipient to return. (Section 4a) |

No new roles or storage mappings. The `setAuthPolicyWithSig` one-time guard (`nullifyingKeys[account] == 0`) makes the signature self-limiting, so **no nonce is needed**. The batched path carries one intrinsic, off-chain risk — the withdrawal proof must target the *predicted post-registration keystore root*, which any concurrent keystore write invalidates; this is the relayer's to manage via simulation + private orderflow (Section 4a).

### 1. Motivation

Consider two protocol users:

1. **Alice** is an existing user with spendable notes.
2. **Bob** is new. He generates a fresh address and gives it to Alice to receive a payment. The address has never transacted and holds no native funds.

Alice performs a private transfer, creating an output note whose `ownerAddress` is Bob's fresh address. The payment itself is privacy-preserving. The problem surfaces the moment Bob tries to *spend* that note:

- To spend, Bob must prove his `ownerAddress` is registered in the keystore (see Section 3).
- Registering requires an on-chain `setAuthPolicy` transaction sent **from** Bob's fresh address.
- That transaction needs gas, so Bob must first fund the fresh address.
- Any funding transfer creates an on-chain link between Bob's funding source and the "fresh" address — defeating the reason the address was fresh in the first place.

Bob is therefore stuck: he holds a note he provably owns, but cannot register to spend it without sacrificing the privacy the fresh address was meant to provide. The protocol offers no relayed registration path, and (per `key-architectural-concepts.md`, "Risk: note secrets never reach the recipient") no on-chain recovery for a recipient who cannot register.

This is a real onboarding gap: it makes "receive into a fresh address" — arguably the most natural privacy posture for a new recipient — unusable without a privacy-leaking funding step.

### 2. Why the spend itself is *not* the problem

It is worth isolating what already works, so the proposed change stays minimal.

The *spend* (transact / withdraw) is already gas-decoupled. The `processor` / relayer pattern (`contracts-tech-design.md`, `PrivacyPoolRelay`) lets a relayer submit the transaction and pay gas, recovering a fee out of the withdrawn amount. A funded address is never required to spend.

**Registration is the sole remaining step that hard-requires the registering party to pay its own gas.** Closing that one gap is sufficient to make the Alice → Bob flow work end to end.

### 3. Why the current design blocks it

Registration today is a single call (`contracts-tech-design.md`, §3 Keystore):

```solidity
function setAuthPolicy(uint256 _authDigest, uint256 _nullifyingKeyHash) external {
    require(nullifyingKeys[msg.sender] == 0, Keystore_AuthPolicyAlreadySet());
    uint256 _authLeaf = PoseidonT4.hash([uint256(uint160(msg.sender)), _nullifyingKeyHash, _authDigest]);
    _insertInTree(_authLeaf);
    nullifyingKeys[msg.sender] = _nullifyingKeyHash;
    ...
}
```

The keystore leaf is `Poseidon(msg.sender, nullifyingKeyHash, authDigest)`. The registered address is taken **directly and only** from `msg.sender`. There is no way to register an address other than the caller.

That binding cannot simply be re-pointed at spend time, because the circuits enforce it. The transact and ragequit circuits (`circuits-tech-design.md`) compute `noteAddressHash = Poseidon(ownerAddress, noteSecret)` and, *for the same `ownerAddress`*, prove a keystore Merkle inclusion of a leaf built from that address. Alice's note hard-codes `ownerAddress = Bob's fresh address`, so spending that specific note requires *that specific address* to have a leaf in the keystore tree. Bob cannot substitute some other, already-funded address he controls.

One subtlety makes the fix tractable: the protocol keys are derived off-chain from a wallet signature over an EIP-712 payload (`keystore-manager.md`, `crypto-service.md`). **Signing is free and offline** — only the `setAuthPolicy` *transaction* costs gas. Bob can produce a valid authorization signature for his fresh address without ever funding it. The missing piece is purely a contract entry point that accepts that signature and lets someone else pay.

### 4. Proposed solution

Add a signature-authorized, relayer-submittable registration entry point to the `Keystore` contract. The relayer (or any third party) pays gas; the leaf still binds Bob's address because Bob's signature authorizes the exact key material. The direct and relayed paths funnel through one shared internal `_setAuthPolicy(_account, …)` so their validation, leaf construction, and events cannot drift apart:

```solidity
// New constant + inheritance on the Keystore contract:
//   contract Keystore is IKeystore, RootBufferUpgradeable, UUPSUpgradeable, EIP712Upgradeable, Permissioned
// NOTE (superseded): this planning doc shows the ORIGINAL proposal. The SHIPPED form additionally
// binds a `uint256 deadline` (staleness protection, audit C-8) — the live typehash is
// `SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)` and
// `setAuthPolicyWithSig`/`registerAndRelay` take a `_deadline` param. See contracts-tech-design.md §3 (v1.4).
bytes32 public constant SET_AUTH_POLICY_TYPEHASH =
    keccak256("SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash)");

// In initialize():  __EIP712_init("PrivacyPoolsKeystore", "1");

function setAuthPolicy(uint256 _authDigest, uint256 _nullifyingKeyHash) external {
    _setAuthPolicy(msg.sender, _authDigest, _nullifyingKeyHash);
}

function setAuthPolicyWithSig(
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    bytes calldata _signature
) external {
    bytes32 _digest = _hashTypedDataV4(
        keccak256(abi.encode(SET_AUTH_POLICY_TYPEHASH, _account, _authDigest, _nullifyingKeyHash))
    );
    require(SignatureChecker.isValidSignatureNow(_account, _digest, _signature), Keystore_InvalidSignature());
    _setAuthPolicy(_account, _authDigest, _nullifyingKeyHash);
}

function _setAuthPolicy(address _account, uint256 _authDigest, uint256 _nullifyingKeyHash) internal {
    // existing field-range + one-time + nonzero guards, keyed on _account (not msg.sender)
    // leaf = Poseidon(_account, _nullifyingKeyHash, _authDigest); insert; nullifyingKeys[_account] = …
    // emit AuthPolicySet(_account, …)  — same event as the direct path
}
```

Why these choices:

- **EIP-712, not a raw signed hash.** `_hashTypedDataV4` is provided by `EIP712Upgradeable`; the domain separator (`name = "PrivacyPoolsKeystore"`, `version = "1"`) automatically binds `chainId` and `verifyingContract`, so the signed struct only needs to carry `(account, authDigest, nullifyingKeyHash)`.
- **`SignatureChecker.isValidSignatureNow`, not `ecrecover`.** It accepts both EOA signatures and **EIP-1271** contract-wallet signatures, so the fresh recipient address may be a smart-contract wallet.
- **Events reused.** Both paths emit `AuthPolicySet(_account, …)` with the registered account (never the relayer), so the relayed path is indistinguishable on-chain from self-registration and no indexer / note-discovery code needs to change.

Decisions already made for this design:

- **Scope: auth policy only.** The viewing key has the same `msg.sender`-bound gas problem, but the actual Alice → Bob *spend* flow only needs the auth policy registered (the viewing key is about *receiving future* notes, not spending one already held — see Section 2). A relayed `setViewingKeyWithSig` is intentionally **deferred** because, unlike the auth policy, the viewing key is updatable and needs genuine replay protection (Section 6).
- **Entry point lives on `Keystore` directly** (not behind a separate forwarder contract). The keystore already owns all auth state; a direct method keeps a single source of truth and avoids a trusted-forwarder surface.
- **Relayer compensation is deferred.** Registration moves no funds, so there is nothing to skim the way withdrawal relaying does. The fee model (out-of-band payment, recoup at first transact, or sponsored/subsidized) is left as an open question (Section 6) and does not block the contract/SDK mechanics.

What does **not** change:

- **Circuits.** Leaf math, `noteAddressHash`, and the keystore inclusion proof are untouched. Only *how the leaf is inserted* changes; *what* the leaf is stays identical.
- **The self-registration path.** `setAuthPolicy` / `setViewingKey` remain for users who can pay their own gas.

### 4a. Closing the economic loop: batched `registerAndRelay`

`setAuthPolicyWithSig` lets *anyone* pay for Bob's registration, but on its own it gives the relayer no guarantee of being repaid: it fronts the gas in one transaction and must trust Bob to return and withdraw through it. Batching registration and the first withdrawal into a single relay call makes repayment atomic — the withdrawal fee provably covers both steps, or neither happens. This turns the "recoup at first transact" fee option (Section 6) from a trust assumption into an enforced one.

The method lives on `PrivacyPoolRelay` as a sibling to the existing `relay(...)`:

```solidity
// PrivacyPoolRelay — atomic register-then-withdraw
function registerAndRelay(
    address _account,
    uint256 _authDigest,
    uint256 _nullifyingKeyHash,
    bytes calldata _signature,
    ProofLibV2.TransactProof calldata _proof,
    IPoolVault.TransactParams calldata _transactParams,
    IPoolVault.NoteData[] calldata _noteData
) external payable {
    KEYSTORE.setAuthPolicyWithSig(_account, _authDigest, _nullifyingKeyHash, _signature); // step 1
    // step 2: existing relay path — POOL.transact(...) then split amountOut into recipient / fee
}
```

Properties and constraints:

- **No new trust surface.** `setAuthPolicyWithSig` is permissionless and the signature binds the key material, so routing it through the relay contract adds no authority the relayer didn't already have. The relay contract needs a `Keystore` reference (immutable, or resolved off the pool). **Circuits are unaffected** — for v2.0 this is purely a contracts addition (the SDK glue below is deferred, INTL-05).
- **Ordering is fixed.** Registration must execute strictly before `transact`; otherwise the keystore-membership check has no leaf to find.
- **Fee must cover registration gas.** The withdrawal `feeAmount` (bounded by the per-asset `maxRelayFee`) now also absorbs the `setAuthPolicyWithSig` gas, so deployments must set `maxRelayFee` with headroom.

**The predicted-root race (intrinsic, cannot be removed on-chain).** The withdrawal proof must be anchored to the keystore root *that includes Bob's just-inserted leaf* — a root that does not yet exist when Bob builds the proof. So the SDK must **predict the post-insertion root**: take the current keystore tree, append Bob's leaf at the next index, compute the resulting root, and prove membership against it. That prediction is invalidated by **any concurrent keystore mutation** — not only a malicious key update aimed at Bob, but *any other account's* `setAuthPolicy` landing first, because the append-only LeanIMT shifts Bob's index and sibling path. It is therefore fundamentally a concurrency/liveness race that an attacker can *weaponize* (spamming cheap registrations), not a Bob-specific exploit. The circuit must commit to a concrete root as a public signal, so there is no on-chain fix.

**Bundle semantics convert the risk from lost gas to retry.** In a public mempool, a withdrawal that reverts because the predicted root went stale still costs the relayer gas — genuinely lossy. Submitted as a Flashbots-style bundle, a bundle that would revert on simulation is simply not included, so the relayer pays nothing and retries with a freshly predicted root. Simulation + private orderflow is therefore not polish but the mechanism that makes the failure mode *latency* rather than *burned gas*. A residual, non-zero risk remains (mempool leakage if unbundled, builder misbehavior, reorgs); taking it is correctly the relayer's call, since the relayer is the party being paid.

### 5. Security considerations

- **Signature binds the key material.** The signed struct carries `(_account, _authDigest, _nullifyingKeyHash)`, so a malicious relayer cannot register different keys than Bob authorized — it can only submit, or withhold, the exact registration.
- **Cross-chain / cross-contract replay** is covered by the EIP-712 domain separator (`chainId` + `verifyingContract`); the struct does not need to repeat them. The keystore is per-chain (`keystore-manager.md`).
- **Replay is self-limiting for the auth policy — no nonce needed.** The existing `nullifyingKeys[_account] == 0` guard makes auth-policy registration one-time per address, so a captured signature is inert after first use: it cannot double-register or overwrite. This self-protection is *specific to the one-time auth policy* and is the reason the relayed path is scoped to it.
- **Why a relayed viewing key would need a monotonic nonce (and why CAS is not enough).** `setViewingKey` is updatable, so it has no one-time guard and a relayed signature could be replayed. A tempting shortcut — compare-and-swap, i.e. sign `(oldViewingKey, newViewingKey)` and require the current value equals `oldViewingKey` — is **insufficient**: it only blocks *immediate* replay, not the case where a viewing-key *value recurs*. If the key cycles V1 → V2 → V1, the original `(old=V1, new=V2)` signature's precondition is satisfied again and it replays. A **monotonic per-account nonce** is the safe mechanism: each nonce value is consumed exactly once and never recurs by construction, independent of what the key values do. This is recorded so that, if relayed viewing-key registration is ever scoped in, CAS is not mistaken for adequate protection.
- **Smart-contract recipients.** `SignatureChecker.isValidSignatureNow` handles both EOA `ecrecover` and EIP-1271, so the fresh recipient address may be a contract wallet.
- **No new griefing vector on the auth policy.** A relayer cannot register a *wrong* policy (signature binds it) and cannot prevent registration (anyone, including Bob via a different relayer, can submit a valid signature).

### 6. Open questions

- **Relayer fee economics.** Deferred. Since registration transfers no value, the withdrawal-style "skim from output" model does not apply. Options to evaluate later: Bob pays the relayer out-of-band; the relayer fronts gas and recoups it from the fee on Bob's first relayed transact (**made atomic by the batched `registerAndRelay` in Section 4a**); or the operator sponsors registration as an onboarding cost.
- **Relayed viewing-key registration (deferred, not part of this scope).** If scoped in later, it requires a monotonic per-account nonce for replay protection (see Section 5 for why CAS is insufficient), plus a decision on whether to batch it with auth-policy registration in a single relayed call.

### 7. Spec impact — mechanical change list to apply on acceptance

This idea is self-contained; the source-of-truth specs are **not** edited while it is a proposal. The list below is precise enough to apply mechanically once the idea is accepted (i.e. promoted to implementation). Scope is **auth policy only**; relayed viewing-key registration is out of scope.

**`contracts/contracts-tech-design.md` §3 (Keystore):**
- *Storage* — note the EIP-712 domain (`name = "PrivacyPoolsKeystore"`, `version = "1"`); separator binds `chainId` + `verifyingContract`. No new mappings.
- *Interface* — add `setAuthPolicyWithSig(address _account, uint256 _authDigest, uint256 _nullifyingKeyHash, bytes calldata _signature)`.
- *Events* — annotate `AuthPolicySet`: emitted by both the direct and relayed paths, always carrying the registered `_account`. No new events.
- *Pseudocode* — add `EIP712Upgradeable` to the inheritance list; add `SET_AUTH_POLICY_TYPEHASH`; add `__EIP712_init("PrivacyPoolsKeystore", "1")` to `initialize`; refactor `setAuthPolicy` + new `setAuthPolicyWithSig` to share internal `_setAuthPolicy(_account, …)`. New error `Keystore_InvalidSignature` (inline, per existing convention).
- *Version History* — add a row.

**`contracts/contracts-tech-design.md` §5 (Privacy Pool Relay):**
- *Interface* — add `registerAndRelay(address _account, uint256 _authDigest, uint256 _nullifyingKeyHash, bytes _signature, TransactProof _proof, TransactParams _transactParams, NoteData[] _noteData)`: atomic `setAuthPolicyWithSig` then the existing relay path (Section 4a).
- *Storage / refs* — add a `Keystore` reference (immutable, or resolved off the pool).
- *Note* — registration executes strictly before `transact`; `feeAmount` (bounded by `maxRelayFee`) must cover the added registration gas, so `maxRelayFee` deployment config needs headroom. No new roles (`setAuthPolicyWithSig` is permissionless).
- *Version History* — add a row.

**`key-architectural-concepts.md`:**
- In the "Risk: note secrets never reach the recipient" aside, add a clarification that the risk is about *secret delivery*, not registration: a recipient holding a fresh, unfunded address can register without funding it (and without linking a funding source) via `setAuthPolicyWithSig`. The locking factor is undelivered secrets, never registration cost.

> **LANDED for v2.0 (INTL-05, 2026-07-08), standard withdrawal path:** the SDK + relayer items below
> are implemented — `PoolSessionKeystore.prepareRelayedRegistration` (signed/unsigned EIP-712 payload),
> the `pendingKeystoreRegistration` predicted-post-insertion-root witness, `PoolSessionWithdraw.
> prepareRegisterAndWithdrawRelay`, `RelayerInteractor.{submitRelayedRegistration,relayRegisterAndWithdrawal}`,
> and the relayer `POST .../register-and-relay` endpoint — with a real-proof end-to-end test. **Two
> mechanical follow-ups remain deferred:** the yield-specific atomic variant on `PoolSessionYieldWithdraw`,
> and the standalone `POST .../register` (`setAuthPolicyWithSig`) endpoint (blocked on the §6 fee-economics
> question). See `agents/deviations.md` INTL-05.

**`sdk/keystore-manager.md` / `sdk/pool-session.md`:** a "prepare relayed registration" method that produces the signed EIP-712 payload (typed data matching `SET_AUTH_POLICY_TYPEHASH`). Exact placement TBD — see open SDK design question below.

**`sdk/merkle-service.md` (and the witness/proof path):** the withdrawal that follows a batched `registerAndRelay` must build its keystore-membership proof against the **predicted post-insertion root** (current keystore tree + Bob's leaf appended at the next index), not the current on-chain root — see Section 4a.

**`sdk/relayer-interactor.md`:** methods to submit (a) the standalone relayed registration (`setAuthPolicyWithSig`) and (b) the batched `registerAndRelay`, on the account's behalf. Submission of the batched form should default to private orderflow / bundle semantics so a stale-predicted-root revert costs no gas (Section 4a).

*Open SDK design question (resolve before promoting the SDK edits):* whether the prepare/sign step lives on `KeystoreManager`, `PoolSessionKeystore`, or `RelayerInteractor`, mirroring the existing prepare/execute split used for revocable-key rotation.

**Circuits specs:** unaffected.
