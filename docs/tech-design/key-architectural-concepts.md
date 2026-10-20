# Key Architectural Concepts

This section details the core heuristics and cryptographic primitives that underpin the protocol's design. The architecture presented here is an evolution of the concepts from the original Privacy Pool protocol, with the primary goal of enabling private, compliant peer-to-peer transfers. This transforms the protocol from a simple deposit/withdraw privacy mixer into a true private payment system.

To support this new transfer capability in a private and usable way, several core enhancements to the original model were necessary:

- **To solve sender privacy during a transfer,** labels were made private through the use of a user-generated `depositSecret`.
- **To solve the "cold start" problem of sending a transfer to a new user,** ownership was made flexible with an explicit `ownerAddress` for each note.

These enhancements, built upon the original system's foundation of non-fungible `labels` for taint containment, are detailed in the following subsections.

**Core data structures at a glance:**

The protocol relies on three Merkle trees and one mapping:

- **`stateTree`:** A single on-chain Merkle tree that stores both commitment and nullifier leaves, each wrapped with a leaf-type tag and the on-chain insertion timestamp (`Poseidon(tag, value, block.timestamp)`). Deposits and transfer outputs append commitment leaves; spends and ragequits append nullifier leaves. To spend, you prove your commitment leaf exists in this tree without revealing which one.
- **`keystore` tree:** Stores user authorization data. You register once, linking your address to your keys. To spend, you prove your address is registered and you control the associated keys.
- **`associationSet` tree:** Stores compliant labels (maintained off-chain by the ASP, only the root is on-chain). To spend, you prove your note's label is in the ASP's current set.
- **`spentNullifiers` mapping:** Records spent notes alongside their spend timestamp. When you spend, a nullifier is published; the contract rejects duplicates to prevent double-spending. The same nullifier is also appended as a tagged leaf in the `stateTree`.

These structures are detailed in [Contracts - Tech Design](contracts/contracts-tech-design.md). The subsections below explain the architectural decisions that shaped them.

## **3.1 Lineage Tracking via Non-Fungible Labels**

To solve the challenge of taint propagation, the protocol abandons the concept of a single, fungible anonymity pool. Instead, every deposit creates a unique, non-fungible **`label`** that acts as a permanent, cryptographic identifier for that specific lineage of funds.

<aside>
🔥

Why labels are guaranteed unique: Labels are derived from commitments (`label = Poseidon(precommitment, depositSecret)`), and the contract rejects duplicate commitments at insertion time. Since each commitment can only exist once in the tree, and each commitment produces exactly one label, label uniqueness is enforced by construction.

However, multiple notes can share the same label: when you split a note (e.g., sending 3 ETH to Bob and keeping 7 ETH as change), both output notes inherit the input's label. This is why same-label merging exists—you're recombining notes that were previously split from the same lineage, not merging notes from different deposits that somehow got the same label.

</aside>

- **Per-Label Value Conservation:** The protocol's circuits enforce a strict set of rules governing how value can be transferred:
    - **Same-Label Merging:** Users can consolidate multiple input notes into a single output note *if and only if* all input notes share the exact same `label`.
    - **Cross-Label Mixing Prohibited (v2.0):** In this version, it is cryptographically impossible to create an output note that combines value from input notes with different `label`s. A future extension will enable cross-label merging through self-describing composite labels—see [Note merging](future-ideas/note-merging.md) for the planned design.
    - **Independent Conservation:** Consequently, in a single transaction that involves notes from multiple distinct lineages, the total value for each label must be conserved independently.
- **Taint Containment:** This mechanism ensures that if a deposit is later found to be non-compliant, the taint is cryptographically contained to only the notes that share its specific `label`.

## **3.2 Private Lineage Identifiers via `depositSecret`**

A core design shift from previous privacy pool models is the privatization of the lineage identifier, or `label`. In earlier iterations, the `label` was computed openly on-chain and emitted in the public `Deposit` event, creating a permanent, public link between a specific deposit and the entire future transaction history of its funds. This public linkage created a privacy vulnerability: since the `label` must be shared with any recipient for compliance proofs, a recipient could trace the funds back to their origin, deanonymizing the sender.

This protocol solves the problem by moving the `label` computation from public smart contract logic into the private `deposit` circuit. The `label` is derived from a **`depositSecret`**:

1. The user's wallet generates a random `depositSecret` and stores it locally.
2. The `label` is computed inside the **`deposit` circuit** as a private value: `label = Poseidon(precommitment, depositSecret)`.
3. The final `commitment` (`Poseidon(precommitment, label)`) is what is published on-chain in the `Deposit` event.

This creates a one-way cryptographic function. The on-chain `Deposit` event is associated with a `commitment`, but provides no information about the underlying `label`. When a sender later shares the `label` with a recipient, the recipient has no cryptographic means to reverse the calculation and discover the original public `commitment`. This mechanism is the key to preserving sender privacy from recipients.

<aside>
🦺

Safety Note: If a user loses their `depositSecret`, no funds are at risk. They cannot compute the label and therefore cannot register it with the ASP for compliant spending—but they can still recover their funds via `ragequit` (see [Section 5](#37-note-level-polymorphism-via-reserved-metadata)).

</aside>

<aside>
🛁

**Hygiene Note:** The `depositSecret` could technically be the same value as the `noteSecret`—the system would still work. We use separate secrets as a matter of cryptographic hygiene: each secret serves a distinct purpose (label derivation vs. address obfuscation), and reusing values across domains creates unnecessary coupling. In practice, wallets should generate fresh random values for each.

</aside>

## **3.3 Mandatory ASP Proof for Spending**

The protocol enforces compliance through a universal requirement on its core spending function (`transact`). To execute any spending action (private transfer or public withdrawal), a user must provide a valid ZK proof that demonstrates the `label` of each note being spent is present in the ASP's `associationSet` tree.

A note's state is therefore either **not registered** or **registered**:

- **Not Registered:** A note whose `label` is not in the `associationSet`. The only available actions are to engage with the ASP to register the label or to `ragequit`.
- **Registered:** A note whose `label` is in the `associationSet`. The note can be used in the `transact` function, assuming all other proof constraints (e.g., ownership, value conservation) are met.

The process of changing a note's state to **registered** is called **Label Registration**. It is a permissionless on-chain event emission: the user (or any caller) invokes `ASPRegistry.registerLabel(bytes ciphertext)`, which emits a `LabelRegistered(ciphertext)` event. The `ciphertext` is an encrypted payload — only the ASP can decrypt — containing the data necessary for verification, typically `{label, depositCommitment}`. No dedicated ZK proof is produced on-chain for label registration.

To avoid an extra transaction, `Entrypoint.deposit` accepts an optional `aspCiphertext` argument and forwards it to `ASPRegistry.registerLabel` inline when present, so a deposit and its label registration can share a single transaction.

The ASP listens for `LabelRegistered` events, decrypts each payload with its private key, and checks the `depositCommitment` against its list of compliant deposits. If compliant, the ASP includes a hash of the `label` in its next published `associationSet` root. Because the payload is opaque to everyone except the ASP, observers cannot link a given deposit to the registration event.

## **3.4. Recipient Privacy via Obfuscated Addresses**

A key UX feature of the protocol is that recipients never need to share their raw EVM address to receive a private transfer. Instead, a recipient shares an **obfuscated address commitment**:

```
addressCommitment = Poseidon(evmAddress, noteSecret)
```

This design provides two important properties:

1. **Sender never learns recipient's address:** The sender constructs the output note using the `addressCommitment` directly. They cannot reverse the hash to discover the recipient's actual `evmAddress`. The recipient's on-chain identity remains hidden even from the sender.
2. **Recipient controls note discovery:** By choosing their own `noteSecret`, the recipient ensures they can efficiently discover and decrypt incoming notes. The `noteSecret` is known only to the recipient, making note scanning straightforward—no trial decryption required.

**Who chooses the `noteSecret`?** Either party can:

- **Recipient chooses (preferred):** Recipient generates a fresh `noteSecret`, computes `noteAddressHash = Poseidon(evmAddress, noteSecret)`, and shares only the `noteAddressHash` with the sender. This is ideal—the recipient already knows the secret for discovery, the sender learns nothing about the recipient's address, and **the sender never learns the `noteSecret`**. The recipient has immediate exclusive spending capability.
- **Sender chooses (cold start):** When the sender knows the recipient's address but has no way to communicate with them (e.g., cold start deposits, airdrops), the sender generates the `noteSecret` and must communicate it to the recipient out-of-band or via encrypted on-chain events. This works but requires the recipient to discover and decrypt the `noteSecret` before they can spend. The sender retains knowledge of the note secrets but cannot spend on-chain without the recipient's keystore authorization: `transact` requires the owner's nullifying keys, and `ragequit` must be invoked by `ownerAddress` (the recipient).

**Deposit-as-transfer:** This pattern enables private transfers from public funds. Alice can deposit ETH and specify Bob's `noteAddressHash` as the owner. From Alice's perspective, she's depositing; from Bob's perspective, he's receiving a private transfer. The label comes from Alice's deposit (her KYC lineage), but Bob owns the note. This is useful for gifting, payroll, or any scenario where the depositor wants to fund someone else privately. The deposit circuit accepts `noteAddressHash` directly (not the preimage), so Bob never needs to share his `evmAddress` or `noteSecret` with Alice—just the hash.

<aside>
⚠️

**Risk: note secrets never reach the recipient.** In cold start and deposit-as-transfer flows, the sender must reliably deliver material such as `noteSecret` (and related data the recipient needs to discover or spend). If that delivery fails—wrong channel, lost message, or undecryptable payload—the recipient may never learn the secrets. The note's `ownerAddress` is still the recipient, so the sender **cannot** recover via `ragequit` (only the owner may call it). The recipient **cannot** spend without those secrets and a registered keystore. **The protocol offers no on-chain recovery**; funds remain locked in the commitment. Treat secret delivery as part of the payment, not an optional follow-up.

> The locking factor here is **undelivered secrets**, not registration cost. A recipient who *does* hold the secrets can spend even from a fresh, unfunded address: a relayer pays the registration fee against the recipient's off-chain authorization — on EVM `Keystore.setAuthPolicyWithSig` / `registerAndRelay` with an EIP-712 signature, on Stellar `relay.register_and_relay` with a signed Soroban auth entry over `keystore.set_auth_policy` (bundled with the first withdrawal) — so the recipient never has to fund (and thereby link a funding source to) the fresh address. Registration is not a gating cost; secret delivery is. See `contracts/contracts-tech-design.md` §3 (Keystore) and §5 (Privacy Pool Relay).

</aside>

This eliminates the "address book leak" problem where senders accumulate knowledge of recipient addresses over time. Each transfer can use a fresh `noteSecret`, providing unlinkability across transactions even with the same counterparty.

<aside>
😀

Note on `noteSecret` and spending: The `noteSecret` is required to spend a note—without it, you cannot reconstruct the `noteAddressHash` needed for the proof. In this sense it acts as a soft authorization factor alongside keystore ownership. However, in v2.0 the actual nullifier derives from the keystore's `privateNullifyingKey`, not the noteSecret. Future note types (e.g., ownerless settlement notes) may use the `noteSecret` directly as the nullifier source, which is valid as long as the invariant of one nullifier per commitment is maintained.

</aside>

## **3.5 Authorization Model**

A note's ownership is always cryptographically tied to the recipient's `ownerAddress`, which is baked into the note's commitment. The protocol recognizes this address as the rightful owner.

The protocol supports an **extensible authorization model** via the `authorizerDigest` field in the `keyRegistry`. This field commits to an `authType` that determines which authorization circuit is used, along with the method-specific data required for verification.

<aside>
🆓

**Note Ownership Model**

In this version, all notes have explicit ownership tied to an `ownerAddress`. The protocol is designed to be extensible, and future versions will support alternative authorization methods, including per-note nullifier secrets (similar to Privacy Pool v1). These extensions will enable more advanced features and flexible ownership models.

The current implementation uses a Keystore to streamline user experience. Accounts registered in the keystore function as private accounts, providing familiar account-based behavior while maintaining strong privacy guarantees.

</aside>

**Nullifying Key:**
The `privateNullifyingKey` is used exclusively for nullifier derivation. It is an arbitrary secret with no special constraints—see the Security Note below.

**Authorization Digest Structure:**

Each `authType` defines its own digest structure with only the fields it needs. The circuit for each type opens the digest according to its expected format:

- `authType = 0` (Direct Key): `authorizerDigest = Poseidon(0, privateRevocableKey)`. The circuit verifies knowledge of `privateNullifyingKey` via hash preimage. The `revocableKeyHash` enables key rotation without changing the immutable `nullifyingKeyHash`.
- `authType = 1` (BabyJubJub): `authorizerDigest = Poseidon(1, bjjPublicKey)`. The circuit verifies an EdDSA signature against the registered BJJ public key. No separate revocable key is needed—the BJJ public key itself is rotatable. The `privateNullifyingKey` is provided separately for nullifier derivation—it is **not** the BJJ signing key.
- `authType = 2` (Intent-based): `authorizerDigest = Poseidon(2, revocableKeyHash, authorizerAddress)`. For contract-based accounts, adds the stealth multisig address ([Multisig support](future-ideas/multisig-support.md) ).

Each authorization method has its own dedicated circuit. The circuit verifies that `authType` matches the expected fixed value for that method, then performs the method-specific checks. The contract routes proof verification to the appropriate circuit based on the user's registered `authType`.

<aside>
📌

**Current Version:**
This version implements `authType = 0` (Direct Key Authorization): users prove ownership by demonstrating knowledge of `privateNullifyingKey` via hash preimage. See Appendix D for the intent-based authorization design for multisigs.

</aside>

**Auth Migration:**
Because `authType` lives in the keystore (not in individual note commitments), users can migrate between authorization methods with a single keystore update. All existing notes become spendable under the new auth method without requiring per-note migration. The nullifier derivation remains unchanged (`Poseidon(privateNullifyingKey, commitment)`) regardless of auth method, preventing double-spend across auth migrations.

<aside>
💡

**Design Note** 
Hardware Wallet Migration
When hardware wallets add native BJJ support in the future, users who want to use their hardware wallet's BJJ key (rather than their existing privateNullifyingKey) should create a new account with the hardware wallet key and transfer their notes. This is a note transfer, not a protocol limitation: the nullifier key is immutable to prevent double-spending.

</aside>

<aside>
🔥

**Security Note: BJJ Private Key Isolation**

When using BJJ-based authorization, the BJJ private key must never be passed as a circuit input—especially when the key resides in a hardware wallet. The architecture separates concerns:

- **Authorization:** The circuit verifies a BJJ signature against the registered public key (committed in the `authorizerDigest`).
- **Nullifier derivation:** The `privateNullifyingKey` is provided as a separate circuit input.

The `privateNullifyingKey` can be deterministically derived from a BJJ signature using a signature-based secret derivation protocol (see: Randomness Signature specification). This approach extracts high-entropy material (the `r` component) from a deterministic RFC 6979 signature on a fixed message, then applies HKDF to produce the `nullifyingKey`. This ensures the nullifying key is reproducible from the hardware wallet's master seed without ever exposing the BJJ private key to the circuit.

</aside>

## **3.6 Guaranteed Fund Safety via `ragequit`**

A core invariant of the protocol is that user funds can never be destroyed or seized by the compliance mechanism. The **`ragequit`** function serves as the ultimate failsafe.

If a user's note becomes unspendable for any reason (e.g., its `label` is revoked), they can execute a `ragequit`. This generates a special ZK proof that bypasses the standard ASP compliance check and proves only ownership of the note. The contract will then forcibly withdraw the note's underlying value to the ownerAddress baked into its commitment. This transforms the risk of a compliance action from an irreversible loss of funds to a public withdrawal that preserves capital at the cost of privacy. Because this withdrawal is public and ties the funds directly to the `ownerAddress`, any future attempts by this address to deposit funds back into the pool would be subject to heightened scrutiny by the ASP.

<aside>
💡

**Label Emission**

The ragequit transaction publicly emits the note's label. This allows the ASP to definitively associate the withdrawal with a specific lineage, enabling precise risk tracking. While this reveals information about the user's transaction history, it is an acceptable trade-off given that ragequit is already a privacy-sacrificing escape hatch by design.

</aside>

## **3.7. Note-Level Polymorphism via Reserved Metadata**

The commitment structure includes a `metadata` field that enables different note types to coexist in the same Merkle tree. This extends the protocol's expressiveness beyond what the keystore alone can provide.

**What metadata enables:** Per-note conditions and behaviors. The keystore's `authType` determines how a user authorizes spending—that's per-account and applies to all notes owned by that address. The `metadata` field lives in the commitment itself, so each note can carry its own conditions independent of the owner's authorization method.

For standard notes in v2.0, `metadata = 0`. The circuits enforce this constraint. Future note types—settlement notes, time-locked notes, conditional spending—use non-zero metadata values that specialized circuits interpret.

**Example.** Alice could hold:

- A standard note (`metadata = 0`)
- A time-locked note (`metadata = Poseidon(1, unlockTimestamp)`) that can only be spent after a certain time
- A settlement note (`metadata = Poseidon(2, settlementConditions)`) that can only be spent when certain conditions are met

All three notes are owned by Alice and authorized via her keystore. But each note has different spending conditions encoded in its metadata. The authorization method is fixed per-account; the note conditions are per-note.

**The upgrade path:** When a new note type is needed, a new circuit is deployed that interprets specific metadata values. This circuit is registered under a new `authType`. Users who want to create or spend notes with non-zero metadata update their keystore to the new `authType`. Existing notes with `metadata = 0` remain valid under the original circuit. No note migration required—the commitment structure is unchanged.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.1 | 2026-10-01 — §3.4: relayed-registration wording made chain-neutral (EVM EIP-712 `setAuthPolicyWithSig` / `registerAndRelay`; Stellar signed Soroban auth entry via `relay.register_and_relay`). |
| 1.0 | Original concepts (history prior to this table not tracked here). |
