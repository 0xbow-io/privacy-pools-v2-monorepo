# Note merging

<aside>
💡

For a full idea draft, refer here:

[Note merging idea draft](note-merging-idea-draft.md)

</aside>

## The Problem: Label Fragmentation

Users who receive funds from multiple sources accumulate notes with different labels that cannot be combined. A freelancer receiving payments from 20 clients holds 20 notes with 20 different labels. The protocol won't let them combine notes with different labels in a single transaction, leading to painful UX.

## Core Design: Self-Describing Labels

A merged label looks identical to an atomic label from the outside, but internally encodes the full lineage of its origins as a **Merkle root**:

```
leaf_A = Poseidon(label_A, 400_000)   // 40% contribution
leaf_B = Poseidon(label_B, 300_000)   // 30% contribution
leaf_C = Poseidon(label_C, 300_000)   // 30% contribution

mergeLabel = MerkleRoot([leaf_A, leaf_B, leaf_C])
```

This structure is invisible during normal operation but can be *opened* later for surgical cleaning when contamination is discovered.

## ASP-Relayed Architecture

The recommended architecture has the ASP verify compositions off-chain:

1. User generates a merge proof (ownership + value conservation)
2. ASP verifies the composition matches the claimed `mergeLabel`
3. ASP stores the composition privately and relays the transaction
4. ASP maintains a graph of label relationships for revocation propagation

**Key properties:**

- Circuits stay simple (no Merkle tree computation in-circuit)
- Nested merges are allowed (arbitrary depth)
- Compositions are private (prevents mutual interaction analysis)
- Users can always ragequit if ASP is uncooperative

## Late Discovery and Cleaning

When an atomic label is revoked:

1. ASP queries its graph to find all merged labels containing the tainted source
2. ASP revokes those merged labels and publishes: `Contaminated(mergeLabel, taintedFraction, newCleanLabel)`
3. Users check the public revocation list, compute their withdrawal amount, and submit a cleaning proof
4. The tainted fraction is withdrawn publicly; the clean remainder gets a new flat merged label

**What stays private:** Full composition, note holders, actual ETH amounts.
**What is revealed:** That the merged label is contaminated, the tainted percentage, and the clean label.

## Security Properties

- **Taint Containment:** A tainted atomic label affects only its fraction of a merged note
- **No Fund Washing:** ASP graph ensures revocation propagates through all merged labels
- **Griefing Resistance:** Only the owner can merge their notes
- **User Sovereignty:** Ragequit always available as escape hatch

## Open Questions

- **Maximum merge size:** Probably 16-32 atomic labels is reasonable
- **Batch cleaning:** Can we clean multiple revoked labels in one transaction?
- **Self-sovereign fallback:** Higher complexity but censorship-resistant (requires mandatory flattening)