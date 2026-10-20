/**
 * Plans the ERC-20 approval transactions needed to raise `current` to at least `needed`,
 * in submission order.
 *
 * Tether-style tokens (mainnet USDT) revert `approve(spender, n)` when the current allowance
 * is non-zero and `n` is non-zero, so a residual allowance (an abandoned approval, or the
 * rate headroom a yield deposit approved but the router never pulled) must be reset to zero
 * first. Applied to every token — the extra transaction only happens on a residual, and
 * costs nothing on the tokens that don't need it (vuln-mining #28).
 *
 * @param current - The spender's current allowance.
 * @param needed - The allowance the next call requires.
 * @param encode - Builds `approve(spender, amount)` for this token/spender.
 * @returns `[]` when the allowance already suffices, `[approve(needed)]` from zero, or
 *   `[approve(0), approve(needed)]` on a non-zero residual.
 */
export function planApprovals<TTx>(
    current: bigint,
    needed: bigint,
    encode: (amount: bigint) => TTx,
): TTx[] {
    if (current >= needed) return [];
    return current === 0n ? [encode(needed)] : [encode(0n), encode(needed)];
}
