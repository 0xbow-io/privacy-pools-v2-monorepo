# Privacy Pool v2.0 - Tech Design

# Background

Privacy Pools v1 enables private sends. Users deposit assets, wait for ASP approval, and can later withdraw to any address through a relayer who broadcasts the transaction on their behalf, hiding the sender's identity. However, v1 only supports the deposit to withdrawal path. Funds cannot be transferred internally, every spend requires exiting the pool.

There is a need for a v2 that functions as a complete private payment system: private by default, with support for private receives where the sender never learns the recipient's address, and internal transfers that allow funds to move entirely within the shielded layer. Transactions become opaque to external observers, and the anonymity set grows as users transact rather than exit.

Critically, v2 must be future-proof. The transition from v1 to v2 resets the anonymity set entirely. This is acceptable once, but v2 architecture must be composable enough to support future features (multisig, hardware wallets, DeFi interaction, new compliance models, etc.) without forcing another reset. 

# General

Privacy Pool v2 is an EVM-based UTXO privacy system designed to enable private, compliant, and secure peer-to-peer transfers. This specification details a unified architecture that enforces a consistent, mandatory compliance framework while providing users with flexibility in how they manage their private data and recovery options.

### **Core Challenges**

A private transfer protocol with compliance must solve several fundamental challenges:

1. **Late Discovery & Taint Propagation:** A deposit considered "clean" may later be associated with illicit activity. This can lead to taint spreading throughout the pool, freezing the assets of innocent users.
2. **The Sender Privacy Leak:** For a recipient to be able to spend a note, they must know its lineage identifier (`label`) to prove its inclusion in the ASP's compliance set during a future transaction. In a naive design, this would create a permanent on-chain link back to the sender, deanonymizing them.
3. **Onboarding Friction for New Recipients:** A major usability hurdle is enabling a user to send funds to a recipient who has never interacted with the protocol. Without a smooth "cold start" process, the network effect is stifled.
4. **Tension Between Compliance and User Sovereignty:** A core design tension exists between enforcing a rigid, universal compliance standard and providing users with the sovereignty to manage their own private data and recovery methods.

### **The Privacy Pool v2 Solution: A Unified and Flexible Architecture**

This specification presents a protocol architected to solve these challenges through a unified and flexible model that cleanly separates the core on-chain logic from off-chain user strategies.

1. **Guaranteed Fund Safety:** A **`ragequit` failsafe mechanism** ensures user's funds can never be frozen, by allowing them to exit the pool at any moment.
2. **Unified Protocol Core:** All deposits and transfers are processed through a single, unified set of circuits. From the protocol's perspective, all notes are treated identically once they are registered as compliant. (Note: The choice between a single monolithic circuit vs. multiple modular circuits is an active discussion—see [](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Circuits%20-%20Tech%20Design%202d59a4c092c7807e9366d18342c415d2.md) .)
3. **Direct Compliance Path:** The protocol enforces a single, direct method for compliance where the user provides a cryptographic link between their deposit and their note's `label` to the ASP.
4. **Mandatory ASP Registration:** To become spendable, every note's `label` must be registered with the ASP by providing a ZK proof of its origin from a compliant deposit. This is the single, universal compliance checkpoint.
5. **Sender Privacy:** A per-user `depositSecret` is used to create a private `label` that is not publicly linkable back to the original deposit, protecting sender history from recipients.

### **System Overview**

The protocol operates as a closed loop where funds are deposited, privately transferred, and eventually withdrawn. Crucially, spendability is gated by a separation of concerns between **Ownership** (User) and **Compliance** (ASP).

- **The User:** holds **Notes** (private UTXOs) and **Keys** (authorization).
- **The Pool:** holds the **Assets** and verifies **Proofs**.
- **The ASP (Association Set Provider):** provides **Compliance Data** (allowlists/blocklists) off-chain.
- **The Relayer:** (optional) executes transactions to preserve gas anonymity.

**Key Features:**

- **Key Rotation:** Users can rotate their spending keys without moving funds or changing their identity.
- **Cold Start:** Users can receive private transfers to their public address without prior registration.

To spend a note, a user must prove in Zero-Knowledge:

1. **Authorization:** "I own this note" (via private key knowledge).
2. **Compliance:** "This note is clean" (via ASP inclusion).
3. **Integrity:** "I am not double-spending, and value is conserved."

## Invariants

These are the core properties and invariants the system should maintain.

- **Core Functional Properties**
    
    This section defines the basic features of the system from a user's perspective.
    
    1. **Private Withdrawals:** Users can withdraw funds from the pool to a public EVM address without creating an on-chain link between the withdrawal and the original deposit.
    2. **Private Internal Transfers:** Within the privacy pool, users can transfer funds without revealing any transaction details. The sender, recipient, amount, and asset all remain private.
    3. **Splitting and Merging of Balance:** Balances can be split and merged. These properties align with the standard operations of UTXO systems. The way in which this happen will depend on the compliance constraints.
    4. **EVM Address Receipt:** Senders can send private payments using only the recipient's standard EVM address. Recipients don't need to perform on-chain actions or generate special keys before receiving funds. To spend received funds, recipients will need to perform a one-time on-chain action to register their privacy protocol keys.
    5. **Multi-Asset Support:** The protocol supports multiple ERC20 tokens within the same privacy pool. That is, the same contract will hold all ERC20s. This property
        1. Improves the anonymization properties of the pool.
        2. Could unlock advanced features such as in-pool swap.
    6. **Private Payment request:** Users can create private payment requests without exposing neither sender nor recipient address. With a method for recipients to easily identify the payment.
    7. **Native Multisig Support:** The protocol should support multisig operations. No single member of the multisig should be able to individually process private transactions.
        1. **Hardened version:** Smart contract and EOA interaction is fully indistinguishable.
    8. **Efficient Proof Generation:** Zero-knowledge proofs can be quickly generated within **consumer hardware constraints**.
    9. **Dumb proof:** The protocol should be easy to use, and especially hard to misuse.
    10. **Extensibility:** The protocol should be flexible enough to be extended.
- **Security & Cryptographic Properties**
    
    This section covers the security guarantees built into the protocol.
    
    1. **Ownership:** Users have spending keys that they can use to spend their private balance.
    2. **Key Rotation and Revocation:** Users can revoke their spending keys and rotate to new ones without losing their funds nor privacy.
    3. **Protocol Trustlessness:** The protocol should not be able to compromise funds and user private information.
        1. **Soft version:** within a certain time window.
    4. **Uncensorable Balance Discovery:** The users will always be able to recover their private balance, without trusting on centralized third parties.
- **Compliance Properties**
    1. **Flexible Proof of Origin:** Users should be able to prove their funds aren't linked to specific custom lists of addresses provided by third parties. This proof can be generated against any list, enabling compatibility with diverse compliance standards.
    2. **Non custodial:** Users will always be able to publicly withdraw their funds, even if they cannot present a valid Proof of Origin. No funds can be permanently locked by compliance failures.
    3. **Optional Selective Disclosure:** Users can choose to reveal private balance information to specific third parties, without revealing any spending keys. Third parties cannot spend the user's funds, and disclosure is always controlled by the user.
    4. **Deposit Isolation (Taint Containment):** Deposits are tracked individually inside the pool and cannot be merged to avoid taint propagation. This ensures that suspicious funds cannot "infect" clean funds through mixing.
        1. This might eventually relax
    5. **Restricted Handling of Suspicious Funds:** If funds are found suspicious, they cannot be transferred within the pool. They can only perform a tainted withdraw.
        1. You should be able to prove the label you posses is not a compromised one.

# In-Depth

## **Data Structures**

The protocol uses a combination of on-chain data structures for its core operations, including a sophisticated key management system that separates spending authorization from note discovery.

- **`stateTree` (LeanIMT):** A fully on-chain Merkle tree that stores both commitment and nullifier leaves interleaved. Each leaf is tagged with its type and the on-chain insertion timestamp, so that the same leaf scheme can represent both the existence of a note and the spending of one:
    - Commitment leaf: `Poseidon(COMMITMENT_LEAF_TAG, commitment, block.timestamp)`
    - Nullifier leaf: `Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, block.timestamp)`

    The contract manages all leaf insertions directly. Deposits and `transact` outputs append commitment leaves; `transact` spends and `ragequit` exits append nullifier leaves.

    ### **Note Commitment Construction**

    The note commitment is constructed identically for all **deposit** paths. This is the most important scheme to be maintained across upgrades to prevent a fragmentation of the anonymity set.

    1. **`noteAddressHash`**: `Poseidon(ownerAddress, noteSecret)`
    2. **`precommitment`**: `Poseidon(noteAddressHash, tokenId, value, metadata)`
    3. **`label`**: `Poseidon(precommitment, depositSecret)`
    4. **`commitment`**: `Poseidon(precommitment, label)`
- **`commitments` Mapping:** A fully on-chain `mapping(uint256 => uint256)` that maps each note `commitment` to the `block.timestamp` at which it was inserted into the `stateTree`. Used to reject duplicate commitments and to time-stamp existence for the circuits.
- **`spentNullifiers` Mapping:** A fully on-chain `mapping(uint256 => uint256)` that maps each spent nullifier hash to its spend `block.timestamp`. Used to reject double-spends. The same nullifier is also appended to the `stateTree` as a tagged leaf.
    - `nullifierHash = Poseidon(commitment, privateNullifyingKey)`
- `label`: is defined exclusively at deposit time, binding a note to its deposit context via the deposit’s `precommitment`, for any subsequent notes derived from a deposited note, the original `label` is carried forward unchanged.
- **`associationSet` Tree:** For this tree, the contract only stores the **on-chain Merkle root**. The full tree structure is built and maintained off-chain by the ASP.
    - **Leaf Structure:** To prevent observers from partitioning the anonymity set by brute-forcing a public `status` flag, the leaves of this tree commit only to a hash of the label: `leaf = Poseidon(label)`.
    - **Data Availability:** Clients query the ASP for the specific Merkle path data required to generate a proof for their own notes.
- `keystore` Tree: A fully on-chain Merkle tree containing all keystore registrations. This serves as the primary authentication method for note spending in v2.0. The contract manages all leaf insertions directly. Each leaf contains:
    1. `addressHash`: `Poseidon(ownerAddress)`
    2. `nullifyingKeyHash`: `Poseidon(privateNullifyingKey)`
    3. `authorizerDigest`: `Poseidon(authType, ...methodSpecificData)`
    4. `keystoreLeaf`: `Poseidon(addressHash, nullifyingKeyHash, authorizerDigest)`
    

<aside>
🆓

**Design Note**
Privacy Pool v2.0 uses an account-based model where every note is tied to an ownerAddress via the keystore. This provides a clean mental model: users register once, and all their notes are spendable through their registered authorization method.

However, the protocol is extensible enough to support authorization methods that don't tie notes to owners. This enables ownerless, conditional notes for use cases like atomic swaps where the spender isn't known at creation time.

</aside>

## Key Architectural concepts

Covers lineage tracking, private label derivation, ASP-enforced spending, recipient address obfuscation, authorization models, fund safety via `ragequit`, and note-level metadata polymorphism.

[**Key Architectural Concepts**](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Key%20Architectural%20Concepts%202d29a4c092c7808aa2b9d21328247df1.md)

## User Flows

This section specifies all protocol flows, including Core User Flows (key registration, deposits, transfers, withdrawals, key rotation), Compliance & Safety Flows (label registration, late discovery, ragequit), Note Discovery mechanisms (targeted, catch-all, and cold start), and Private Payment Requests.

[User Flows](Privacy%20Pool%20v2%200%20-%20Tech%20Design/User%20Flows%202d59a4c092c780d0855cd9ebdfd769a2.md)

## Circuits

This section specifies the three core circuits: `deposit` creates initial commitments, `transact` enforces ASP compliance while generating nullifiers and output commitments, and `ragequit` provides emergency withdrawal, bypassing ASP. Label registration is handled off-circuit by an opaque encrypted event emission (`ASPRegistry.registerLabel`), optionally inlined inside `Entrypoint.deposit`. Each circuit and its helpers are specified in the following doc:

[ Circuits - Tech Design](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Circuits%20-%20Tech%20Design%202d59a4c092c7807e9366d18342c415d2.md)

## Smart Contracts

This section describes the protocol’s contract architecture, covering the `PoolVault`, `Entrypoint`, `Keystore`, `ASPRegistry`, `PrivacyPoolRelay`, and `Manager`, along with protocol flows, security considerations, and the upgrade mechanism.

[Contracts - Tech Design](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Contracts%20-%20Tech%20Design%202d59a4c092c780b09c28d6003dd6b482.md)

## SDK

[To be completed once the off-chain tech design phase begins].

[SDK - Tech Design](Privacy%20Pool%20v2%200%20-%20Tech%20Design/SDK%20-%20Tech%20Design%202e19a4c092c78087a62edef45c26c3a6.md)

# External Requirements

### 1. Relayer

The relayer is responsible for executing user operations on-chain on behalf of users and collecting fees publicly.

- **Supported operations**
    - Executes `transact` operations for private transfers.
    - Executes public withdrawals.
- **Fee handling**
    - Relayer fees are paid **publicly**.
    - Uses a **flat fee model** (unlike v1) to enable exact payments.
- **Contract interactions**
    - For private transfers, the relayer interacts directly with the `PoolVault` contract.
    - For withdrawals, the relayer interacts with the `PrivacyPoolRelay` contract, which:
        - Supports execution callbacks.
        - Allows post-withdrawal logic such as asset swaps.
- **Asset handling**
    - Supports relaying both **native ETH and ERC20 tokens**.
    - Must be capable of executing swaps when required and accurately quoting relayer fees.
    
    **Use case:** A fresh EOA may want to receive native ETH and/or an ERC20 token to avoid doxxing themselves by funding the account externally after a private transfer.
    
- **Quoting API**
    - Exposes an endpoint to quote relayer fees.
    - Fee quotes must include: `{chain, sourceAsset, targetAsset, feeAmount}`
- **Relayer network support**
    - Private transfers support a relayer network model by passing `processor = 0` indicates an open request, allowing any listening relayer to execute the transfer.

### 2. ASP

The ASP is responsible for compliance-related verification and on-chain state publication.

- **Deposit whitelisting**
    - Listens for encrypted `labelRegistry` events emitted and decrypt the payload using its private key.
    - Verifies that the referenced `commitment` exists in the protocol’s `stateTree`.
- **RageQuit handling (v2 changes)**
    - Listens for `rageQuit` events, which now publicly emit the associated `label` as an encrypted payload ASP can decrypt.
    - Uses the exposed label to determine whether the rageQuit corresponds to an approved or non-approved lineage.
    - If the label is not approved, performs an internal lookup to identify the original depositor associated with that label.

# Future idea drafts proposal

The pages below outline planned extensions to the core protocol. These are ordered roughly by priority and implementation readiness. None are required for v2.0 launch, but the core architecture has been designed to accommodate them without breaking changes.

[Note merging](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Note%20merging%202d59a4c092c7807e834acc8df064418f.md)

[Multisig support](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Multisig%20support%202d59a4c092c78059acfbfd747069ea34.md)

[Conditional spending (Intents)](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Conditional%20spending%20(Intents)%202d59a4c092c780acaaa8d7aa880bb810.md)

[Inverted Authorization](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Inverted%20Authorization%202d59a4c092c780638249e8352c1fe7db.md)

[ASP Detachment](Privacy%20Pool%20v2%200%20-%20Tech%20Design/ASP%20Detachment%202d59a4c092c78073a5dff9873de39438.md)

# Milestones and Estimates

<aside>
❕ **Note:** The estimates provided in this document for the SDK are rough estimates and may be subject to change. After the *SDK* *Tech Design* phase, more precise estimates will be provided.

</aside>

# Timeline

Project started on November 24th, 2025, development phase will start on the first week of January, 2026 and aims to finish development by March, 27th with corresponding internal review to be conducted afterwards and external review after it with an estimation of finalization total by May 22nd. As of now, it will require a total of 133.5 FTE weeks.

[Timeline (5)](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Timeline%20(5)%202e39a4c092c780f4b918c559069bfe37.csv)

# Open Questions and Thoughts

1. Should we use our LeanIMT Implementation or PSE’s BinaryMerkleRoot implementation?
    
    Research on the Lean Incremental Merkle Tree implementation was necessary. For implementation details, see [PSE vs Our LeanIMT Implementation](https://www.notion.so/PSE-vs-Our-LeanIMT-Implementation-2b69a4c092c78019ba48e557e0bd187c?pvs=21).
    
2. Should we keep a `metadata` signal in `deposit`, `transact`, and `ragequit`, or hardcode it to 0 for now? What's the best practice? 
3. Should `ragequit` only return funds to the note owner, or should it support the note owner being the only one authorized to call `ragequit` while allowing the funds to be transferred publicly to a different address?
4. Should we simplify by using `noteSecret` for label computation instead of separate `depositSecret`? Using `noteSecret` would simplify the system, but separate secrets follow better cryptographic practices by maintaining separation of concerns.
5. Should `timestamps` be included in the noteScheme? Is `metadata` opaque field good enough as it enables `timestamp` support in the future? This item requieres an idea draft from 0xbow’s team, please review the following doc for more details: 
    
    [Timestamps in Note Scheme](Privacy%20Pool%20v2%200%20-%20Tech%20Design/Timestamps%20in%20Note%20Scheme%202e29a4c092c780eb8970d28120c48d4a.md)
    
6. It remains to be defined which information is leaked publicly when doing a `ragequit` for the ASP to link it back to its original deposit
7. Should we remove the notion of `tokenId` and use the asset address instead? Would simplify the onchain interface and maybe it doesn’t add much value

### **Why Separate Deposit and RegisterLabel?**

By separating deposit from label registration, users can introduce arbitrary delays and use different relayers for each transaction. This breaks the on-chain link between the deposit action and the ASP registration, preventing temporal analysis attacks.

Users can deposit funds immediately and register labels later when convenient, enabling better UX for batching registrations or waiting for optimal privacy sets.

### Merkle Tree definition for StateMerkleTree

We’re still figuring out which merkle data structure to use for storing the commitments. 

- LeanIMT is production ready
- MMR is more efficient in terms of gas cost, but requires developing the Solidity library and the Circom circuit

# Signatures

- January 8, 2026, @Titi 0x