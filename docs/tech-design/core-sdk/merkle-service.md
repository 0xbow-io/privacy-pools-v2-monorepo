# MerkleService

### MerkleService

MerkleService handles merkle tree operations: building proofs from a set of leaves and verifying proofs against a root. The protocol uses three merkle trees (commitments, key registry, association set) and every circuit requires merkle proofs for inclusion verification.

MerkleService uses IHashService internally as the tree's hash function (Poseidon). It does not store trees, it receives leaves per-call and computes proofs on the fly.

# Dependencies

| Dependency | Why |
| --- | --- |
| **IHashService** | Used as the hash function for computing merkle tree nodes. Each parent node is `hashService.hash([leftChild, rightChild])`. Injected rather than hardcoded so the same IHashService instance is shared across the SDK. |

# Methods

---

**`generateMerkleProof(leaves, leaf) → MerkleProof`**

Builds a merkle tree from the given leaves and generates an inclusion proof for the specified leaf.

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `leaves` | `Hash[]` | All leaves of the tree, in order. The tree is built bottom-up using hashService.hash() to compute each parent node. |
| `leaf` | `Hash` | The specific leaf to generate a proof for. Must exist in the leaves array. |

**Returns: `MerkleProof`**

| Field | Type | Description |
| --- | --- | --- |
| `root` | `Hash` | The computed merkle root. |
| `siblings` | `Hash[]` | Array of sibling hashes along the path from leaf to root. Length equals tree depth. |
| `pathIndices` | `number[]` | Array of 0/1 values indicating whether the leaf is the left (0) or right (1) child at each level. |

**Predicted-root pattern.** Because MerkleService is stateless and derives the root purely from the `leaves` argument, a *predicted* post-insertion root needs no dedicated API: append the hypothetical leaf to the fetched leaves and call `generateMerkleProof(leavesWithNewLeaf, newLeaf)` — the tree is rebuilt and the proof anchors to the root the tree *will* have after that insert. The relayed keystore-registration flow uses exactly this (via the witness input `appendPredictedKeystoreLeaf`) so a fresh recipient's withdrawal proof anchors to the keystore root that includes their not-yet-on-chain leaf, since the insert and the transact land in one transaction.

---

**`verifyMerkleProof(proof, root) → boolean`**

Verifies that a merkle proof is valid against a given root. Recomputes the root from the proof's leaf, siblings, and path indices using hashService.hash().

**Params:**

| Param | Type | Description |
| --- | --- | --- |
| `proof` | `MerkleProof` | The proof to verify, containing leaf, siblings, and pathIndices. |
| `root` | `Hash` | The expected merkle root to verify against. |

**Returns:** `boolean` — True if the recomputed root matches the expected root.

---

# Predicted Post-Insertion Root (relayed register-and-withdraw)

Because MerkleService is stateless — it takes leaves per call and never stores a tree — a caller can anchor a proof to a root the tree does **not yet have** by simply appending the leaf it is about to insert and computing over the extended set. `PoolSession.prepareRegisterAndWithdrawRelay` (see [pool-session.md](./pool-session.md)) uses this for the fresh-unfunded-recipient atomic flow, where the withdrawal proof must be valid against the keystore tree state that the bundled `setAuthPolicyWithSig` registration will produce.

Given the current `keystoreLeaves` fetched from chain and the owner's just-computed keystore leaf `ownerLeaf = Poseidon(owner, Poseidon(nk), authDigest)` — identical to what the contract inserts — the witness builder anchors keystore membership to the **predicted post-insertion root** by operating over `[...keystoreLeaves, ownerLeaf]`:

- `computeRoot([...keystoreLeaves, ownerLeaf])` yields the root the tree will have after the leaf is appended at the next index.
- `generateMerkleProof([...keystoreLeaves, ownerLeaf], ownerLeaf)` yields the inclusion proof for the owner's leaf against that same predicted root.

Because the appended leaf is byte-identical to the contract's insertion, the predicted root equals the actual post-registration root by construction. **No new MerkleService method is introduced** — this reuses the existing stateless `computeRoot` / `generateMerkleProof` primitives.

The prediction is **optimistic**: any concurrent keystore mutation lands a different leaf at the next index and invalidates the predicted root, so a proof anchored to it would revert. The atomic register-and-withdraw bundle should therefore be submitted via private orderflow, so a stale-root revert costs no gas.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.1.0 | 2026-07-08 — Documented the predicted-post-insertion-root usage for relayed register-and-withdraw (INTL-05): anchoring keystore membership to `computeRoot([...currentLeaves, ownerLeaf])` / a proof over the appended set, reusing existing stateless primitives (no new API), with the optimistic-staleness / private-orderflow caveat. Doc-only. |
| 1.0.0 | Initial spec. |