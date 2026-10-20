//! LeanIMT (Lean Incremental Merkle Tree) for Soroban persistent storage.
//!
//! A space-efficient binary Merkle tree that stores only the "side nodes"
//! (one per level) instead of all tree nodes. Supports incremental inserts
//! with O(log n) state reads/writes per insert.
//!
//! Port from the Solana implementation, adapted for Soroban key-value storage.

use soroban_sdk::{Bytes, Env, U256};

use crate::poseidon::{poseidon_hash_two, poseidon_hash_two_ctx, PoseidonT3Ctx};
use contract_types::SNARK_SCALAR_FIELD_BYTES;

/// Insert a single leaf into the LeanIMT.
///
/// Returns the new root after insertion.
///
/// # Arguments
/// * `env` - Soroban environment
/// * `leaf` - The leaf value to insert (BN254 field element)
/// * `get_side_node` - Function to read side node at level from storage
/// * `set_side_node` - Function to write side node at level to storage
/// * `tree_size` - Current number of leaves in the tree
///
/// # Returns
/// The new Merkle root after inserting the leaf.
pub fn lean_imt_insert(
    env: &Env,
    leaf: &U256,
    get_side_node: &dyn Fn(u32) -> Option<U256>,
    set_side_node: &dyn Fn(u32, &U256),
    tree_size: u32,
) -> U256 {
    // Build the Poseidon-2 constants context once here and forward to
    // the _ctx variant — saves ~300K CPU per level on the tree walk.
    let ctx = PoseidonT3Ctx::new(env);
    lean_imt_insert_ctx(env, &ctx, leaf, get_side_node, set_side_node, tree_size)
}

/// Insert a single leaf with a pre-built Poseidon-2 context. Identical
/// semantics to [`lean_imt_insert`], avoids rebuilding Poseidon MDS/RCs
/// on every level hash.
pub fn lean_imt_insert_ctx(
    env: &Env,
    ctx: &PoseidonT3Ctx,
    leaf: &U256,
    get_side_node: &dyn Fn(u32) -> Option<U256>,
    set_side_node: &dyn Fn(u32, &U256),
    tree_size: u32,
) -> U256 {
    let zero = U256::from_u32(env, 0);
    assert!(*leaf != zero, "leaf must be non-zero");
    let field = U256::from_be_bytes(env, &Bytes::from_slice(env, &SNARK_SCALAR_FIELD_BYTES));
    assert!(*leaf < field, "leaf must be less than SNARK_SCALAR_FIELD");

    let mut node = leaf.clone();
    let mut size = tree_size;
    let mut level: u32 = 0;

    while size > 0 {
        if size & 1 == 1 {
            let side = get_side_node(level).expect("side node must exist");
            node = poseidon_hash_two_ctx(env, ctx, &side, &node);
        } else {
            set_side_node(level, &node);
        }
        size >>= 1;
        level = level.checked_add(1).expect("level overflow");
    }

    set_side_node(level, &node);
    node
}

/// Insert multiple leaves into the LeanIMT. Identical root to sequential
/// insertion, but builds the Poseidon-2 constants once and reuses them
/// across all per-leaf hashes — ~25M CPU savings at 5x5 transact.
///
/// The resulting root is the tree's state after `leaves.len()` sequential
/// inserts, starting from `initial_tree_size`. Side nodes are updated
/// incrementally per leaf, matching the current on-chain semantics.
///
/// # Safety / equivalence
///
/// This function is byte-equivalent to calling [`lean_imt_insert`] in a
/// loop with `tree_size = initial_tree_size + i` for each leaf `i`.
/// Only the Poseidon constants cache is reused — all storage read/write
/// semantics and intermediate roots match sequential insertion exactly.
pub fn lean_imt_insert_many(
    env: &Env,
    leaves: &[U256],
    get_side_node: &dyn Fn(u32) -> Option<U256>,
    set_side_node: &dyn Fn(u32, &U256),
    initial_tree_size: u32,
) -> U256 {
    let ctx = PoseidonT3Ctx::new(env);
    lean_imt_insert_many_ctx(env, &ctx, leaves, get_side_node, set_side_node, initial_tree_size)
}

/// `lean_imt_insert_many` variant that accepts an externally-built
/// Poseidon-2 context. Use from callers that build the ctx once and
/// share it across multiple hash/insert operations (e.g. timestamped
/// leaf construction + tree insertion in the same entrypoint).
pub fn lean_imt_insert_many_ctx(
    env: &Env,
    ctx: &PoseidonT3Ctx,
    leaves: &[U256],
    get_side_node: &dyn Fn(u32) -> Option<U256>,
    set_side_node: &dyn Fn(u32, &U256),
    initial_tree_size: u32,
) -> U256 {
    let mut root = U256::from_u32(env, 0);
    for (i, leaf) in leaves.iter().enumerate() {
        let current_size = initial_tree_size
            .checked_add(u32::try_from(i).expect("index overflow"))
            .expect("tree size overflow");
        root = lean_imt_insert_ctx(env, ctx, leaf, get_side_node, set_side_node, current_size);
    }
    root
}

/// Verify a Merkle inclusion proof and return the computed root.
///
/// Given a leaf value, its index, sibling nodes, and the tree size,
/// re-walks the tree path and computes the root. The caller should
/// compare the returned root against known roots.
///
/// # Arguments
/// * `env` - Soroban environment
/// * `leaf` - The leaf value to verify
/// * `leaf_index` - Index of the leaf in the tree
/// * `sibling_nodes` - Sibling hashes from leaf to root
/// * `tree_size` - Current number of leaves in the tree
///
/// # Returns
/// The computed root, or `None` if the proof structure is invalid.
pub fn lean_imt_verify_proof(
    env: &Env,
    leaf: &U256,
    leaf_index: u32,
    sibling_nodes: &[U256],
    tree_size: u32,
) -> Option<U256> {
    if tree_size == 0 {
        return None;
    }
    let depth = lean_imt_depth(tree_size);
    let last_index = tree_size.checked_sub(1).expect("underflow");
    let mut node = leaf.clone();
    let mut sibling_idx: usize = 0;

    for level in 0..depth {
        let index_bit = (leaf_index >> level) & 1;
        let index_prefix = leaf_index >> level;
        let last_prefix = last_index >> level;

        if index_bit == 1 {
            // Leaf is right child — hash(sibling, node)
            if sibling_idx >= sibling_nodes.len() {
                return None;
            }
            node = poseidon_hash_two(env, &sibling_nodes[sibling_idx], &node);
            sibling_idx = sibling_idx.checked_add(1).expect("sibling index overflow");
        } else if index_prefix != last_prefix {
            // Leaf is left child, not on rightmost path — hash(node, sibling)
            if sibling_idx >= sibling_nodes.len() {
                return None;
            }
            node = poseidon_hash_two(env, &node, &sibling_nodes[sibling_idx]);
            sibling_idx = sibling_idx.checked_add(1).expect("sibling index overflow");
        }
        // Else: on rightmost path, no sibling needed (node IS the side node)
    }

    Some(node)
}

/// Update a leaf in the LeanIMT at a given index.
///
/// Replaces the leaf at `leaf_index` with `new_leaf` and recomputes
/// the root. Uses sibling nodes as the Merkle path.
///
/// # Arguments
/// * `env` - Soroban environment
/// * `leaf_index` - Index of the leaf to replace
/// * `new_leaf` - The new leaf value
/// * `sibling_nodes` - Sibling hashes from leaf to root
/// * `set_side_node` - Function to write side node at level
/// * `tree_size` - Current number of leaves in the tree
///
/// # Returns
/// The new root after updating the leaf.
#[allow(clippy::too_many_arguments)]
pub fn lean_imt_update(
    env: &Env,
    leaf_index: u32,
    old_leaf: &U256,
    new_leaf: &U256,
    sibling_nodes: &[U256],
    get_side_node: &dyn Fn(u32) -> Option<U256>,
    set_side_node: &dyn Fn(u32, &U256),
    tree_size: u32,
) -> U256 {
    // New leaf must be non-zero and within the BN254 scalar field.
    let zero = U256::from_u32(env, 0);
    assert!(*new_leaf != zero, "new_leaf must be non-zero");
    let field = U256::from_be_bytes(env, &Bytes::from_slice(env, &SNARK_SCALAR_FIELD_BYTES));
    assert!(*new_leaf < field, "new_leaf must be less than SNARK_SCALAR_FIELD");

    let depth = lean_imt_depth(tree_size);
    let last_index = tree_size.checked_sub(1).expect("underflow");
    let mut node = new_leaf.clone();
    // Walks the OLD intermediate value in parallel with `node`. This is what
    // makes the cached side-node refresh below decidable — see the comment there.
    let mut old_node = old_leaf.clone();
    let mut sibling_idx: usize = 0;

    for level in 0..depth {
        let index_bit = (leaf_index >> level) & 1;
        let index_prefix = leaf_index >> level;
        let last_prefix = last_index >> level;

        if index_bit == 1 {
            // Right child: hash(sibling, node)
            let sib = &sibling_nodes[sibling_idx];
            node = poseidon_hash_two(env, sib, &node);
            old_node = poseidon_hash_two(env, sib, &old_node);
            sibling_idx = sibling_idx.checked_add(1).expect("sibling index overflow");
        } else if index_prefix != last_prefix {
            // Left child with a right sibling, i.e. NOT on the rightmost path.
            //
            // Refresh the cached side node when it still holds the OLD
            // intermediate we are replacing — mirroring EVM's
            // `if (self.sideNodes[level] == oldRoot) self.sideNodes[level] = node`
            // (@zk-kit/lean-imt.sol InternalLeanIMT._update).
            //
            // Omitting this does NOT corrupt the root returned by this call —
            // the local `node` carries the correct value to the top. The damage
            // is LATENT: the stale cache is read by the NEXT `lean_imt_insert`,
            // which then derives a root for a leaf set that no longer exists.
            // From that point the on-chain tree has permanently forked from any
            // honestly-reconstructed client tree, and no valid membership proof
            // can ever land again.
            //
            // Regression: keystore `test_rotation_then_insert_keeps_canonical_root`.
            if let Some(cached) = get_side_node(level) {
                if cached == old_node {
                    set_side_node(level, &node);
                }
            }
            let sib = &sibling_nodes[sibling_idx];
            node = poseidon_hash_two(env, &node, sib);
            old_node = poseidon_hash_two(env, &old_node, sib);
            sibling_idx = sibling_idx.checked_add(1).expect("sibling index overflow");
        } else {
            // Rightmost path: node becomes the new side node
            set_side_node(level, &node);
            old_node = old_node.clone();
        }
    }

    // Store root as top-level side node
    set_side_node(depth, &node);
    node
}

/// Compute the expected depth (number of levels) for a tree with `size` leaves.
///
/// The depth is `ceil(log2(size))`, or 0 for an empty tree.
pub fn lean_imt_depth(size: u32) -> u32 {
    if size <= 1 {
        return 0;
    }
    32u32.checked_sub(
        size.checked_sub(1)
            .expect("underflow")
            .leading_zeros()
    ).expect("underflow")
}
