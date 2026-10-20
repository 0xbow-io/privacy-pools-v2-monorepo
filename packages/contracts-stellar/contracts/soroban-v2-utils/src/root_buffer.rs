//! Circular root history buffer.
//!
//! Maintains a fixed-size circular buffer of recent Merkle roots.
//! Used by both the pool (state tree roots) and keystore (keystore tree roots)
//! to allow proofs against recent (not just latest) roots.

use soroban_sdk::{Env, U256};

/// Record a new root in the circular buffer.
///
/// # Arguments
/// * `new_root` - The root to record
/// * `get_current_index` - Current write position in the buffer
/// * `history_size` - Maximum number of roots in the buffer
/// * `set_root` - Function to write root at index
/// * `set_current_index` - Function to update the current write index
pub fn record_root(
    new_root: &U256,
    current_index: u32,
    history_size: u32,
    set_root: &dyn Fn(u32, &U256),
    set_current_index: &dyn Fn(u32),
) {
    set_root(current_index, new_root);
    let next_index = current_index
        .checked_add(1)
        .expect("index overflow")
        .checked_rem(history_size)
        .expect("history_size is zero");
    set_current_index(next_index);
}

/// Check if a root exists in the history buffer.
///
/// # Arguments
/// * `root` - The root to search for
/// * `history_size` - Maximum number of roots in the buffer
/// * `get_root` - Function to read root at index
///
/// # Returns
/// `true` if the root is found in the buffer.
pub fn is_known_root(
    env: &Env,
    root: &U256,
    history_size: u32,
    get_root: &dyn Fn(u32) -> Option<U256>,
) -> bool {
    // Zero root is never valid (defense-in-depth; callers also guard).
    let zero = U256::from_u32(env, 0);
    if *root == zero {
        return false;
    }
    for i in 0..history_size {
        if let Some(stored) = get_root(i) {
            if stored == *root {
                return true;
            }
        }
    }
    false
}

/// Get the latest root from the buffer.
///
/// The latest root is at `(current_index - 1) % history_size`.
///
/// # Arguments
/// * `current_index` - Current write position
/// * `history_size` - Buffer size
/// * `get_root` - Function to read root at index
///
/// # Returns
/// The most recently recorded root, or `None` if buffer is empty.
pub fn latest_root(
    current_index: u32,
    history_size: u32,
    get_root: &dyn Fn(u32) -> Option<U256>,
) -> Option<U256> {
    if current_index == 0 {
        // Check if any root exists (might have wrapped or be initial state)
        let last_idx = history_size.checked_sub(1).expect("history_size is zero");
        get_root(last_idx).or_else(|| {
            // Nothing at end either — buffer might be empty or at position 0
            get_root(0)
        })
    } else {
        let prev = current_index.checked_sub(1).expect("underflow");
        get_root(prev)
    }
}
