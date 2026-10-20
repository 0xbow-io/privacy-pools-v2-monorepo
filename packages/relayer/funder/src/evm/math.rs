//! Pure wei arithmetic for the sweep. Everything here is unit-tested; nothing touches the chain.

use alloy::primitives::U256;

pub const BPS: u64 = 10_000;
pub const MAX_SLIPPAGE_BPS: u64 = 300;

/// Worst-case gas per step, used for the dust gate and the dry-run projection.
pub const GAS_REDEEM: u64 = 360_000; // ERC-4626 redeem (~158k) + Aave Pool.withdraw (~173-185k), mainnet fork 2026-10-11
pub const GAS_SWAP: u64 = 250_000; // approve (+ USDT reset) + exactInputSingle + unwrapWETH9
pub const GAS_UNWRAP: u64 = 40_000; // WETH.withdraw
pub const GAS_WITHDRAW: u64 = 220_000; // Aave Pool.withdraw alone (parked aTokens), measured ~185k
pub const GAS_SEND: u64 = 60_000; // final native send to a possibly 7702-delegated recipient, with headroom
pub const GAS_SWAP_APPROVE: u64 = 70_000; // approve (+ USDT reset) ahead of a LI.FI swap

/// Swap floor: `quote` minus `slippage_bps`, rounded down.
pub fn min_out(quote: U256, slippage_bps: u64) -> U256 {
    assert!(slippage_bps <= BPS);
    quote * U256::from(BPS - slippage_bps) / U256::from(BPS)
}

/// EIP-1559 max fee the sweep sends with: 2x base fee (survives ~6 full blocks of +12.5%) + tip.
pub fn max_fee_per_gas(base_fee: u128, tip: u128) -> u128 {
    2 * base_fee + tip
}

/// Expected cost of `gas` units at today's fee (base + tip), for dust gates and venue comparison.
pub fn expected_cost(gas: u64, base_fee: u128, tip: u128) -> U256 {
    U256::from(gas) * U256::from(base_fee + tip)
}

/// Worst-case cost of `gas` units: what the tx may actually pay (max fee = 2x base + tip), and what
/// the node checks the balance against before accepting it. For projections and reserves.
pub fn worst_cost(gas: u64, base_fee: u128, tip: u128) -> U256 {
    U256::from(gas) * U256::from(max_fee_per_gas(base_fee, tip))
}

/// A swap is worth doing only if its output is at least `multiple` x its gas cost.
pub fn worth_swapping(out: U256, gas_cost: U256, multiple: u64) -> bool {
    out >= gas_cost * U256::from(multiple)
}

/// Gas limit for a contract call: estimate + 30%. An exact estimate is not enough: e.g. a PP
/// vault redeem estimated in the deposit's second skips its fee-checkpoint write, but one block
/// later yield has accrued, the write happens, and the tx reverts out of gas (seen on a fork:
/// estimate 151k, needed 158k).
pub fn call_gas_limit(estimate: u64) -> u64 {
    estimate * 13 / 10
}

/// Gas limit for the final native send: estimate + 20% (the recipient may be a 7702-delegated
/// EOA or a contract whose receive path costs more than its estimate at inclusion).
pub fn send_gas_limit(estimate: u64) -> u64 {
    estimate * 12 / 10
}

/// Native held back for the final send's fee: 2x `gas_limit * max_fee`, covering the node's
/// `value + gas_limit * max_fee` balance check when the fee is re-read at send time. Whatever the
/// tx doesn't burn stays in the wallet. (The pipeline subtracts this and `keep` from the balance.)
pub fn transfer_reserve(gas_limit: u64, max_fee: u128) -> U256 {
    U256::from(gas_limit) * U256::from(max_fee) * U256::from(2u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GWEI: u128 = 1_000_000_000;

    fn u(v: u128) -> U256 {
        U256::from(v)
    }

    #[test]
    fn min_out_rounds_down() {
        assert_eq!(min_out(u(10_000), 50), u(9_950));
        assert_eq!(min_out(u(1_999), 50), u(1_989)); // 1989.005 -> 1989
        assert_eq!(min_out(u(123), 0), u(123));
    }

    #[test]
    fn max_fee_is_double_base_plus_tip() {
        assert_eq!(max_fee_per_gas(10 * GWEI, GWEI / 10), 20 * GWEI + GWEI / 10);
    }

    #[test]
    fn worst_cost_prices_at_max_fee() {
        assert_eq!(worst_cost(100_000, 10 * GWEI, GWEI / 10), expected_cost(100_000, 20 * GWEI, GWEI / 10));
        assert!(worst_cost(1, 1, 0) > expected_cost(1, 1, 0));
    }

    #[test]
    fn dust_gate() {
        let cost = expected_cost(250_000, GWEI, 0); // 0.00025 ETH
        assert!(worth_swapping(cost * u(5), cost, 5));
        assert!(!worth_swapping(cost * u(5) - u(1), cost, 5));
    }

    #[test]
    fn call_gas_limit_adds_30_percent() {
        assert_eq!(call_gas_limit(151_293), 196_680);
        assert!(call_gas_limit(151_293) > 157_874); // the redeem that reverted at the bare estimate
    }

    #[test]
    fn send_gas_limit_adds_20_percent() {
        assert_eq!(send_gas_limit(21_000), 25_200);
        assert_eq!(send_gas_limit(21_062), 25_274);
    }

    #[test]
    fn transfer_reserve_is_double_worst_case_fee() {
        // 25_200 gas * 20 gwei * 2 = 0.001008 ETH
        assert_eq!(transfer_reserve(25_200, 20 * GWEI), u(1_008_000_000_000_000));
        assert_eq!(transfer_reserve(0, 20 * GWEI), U256::ZERO);
    }

    #[test]
    fn handles_values_above_u64() {
        // The bash harness overflowed at ~9.2 ETH; U256 must not.
        let big = transfer_reserve(30_000_000, 1_000_000 * GWEI); // 60k ETH
        assert_eq!(big, u(60_000 * 10u128.pow(18)));
    }
}
