//! Per-chain DEX used for `token -> wrapped native`. This is the one table the relayer config
//! doesn't carry; a chain must have an entry here to be swept. The wrapped native itself is not
//! listed: it is the router's `WETH9()` (see `profile::resolve`).

use alloy::primitives::{Address, address};

/// V3-style DEX: IV3SwapRouter (no-deadline `exactInputSingle`) + QuoterV2.
#[derive(Debug)]
pub struct Dex {
    pub chain_id: u64,
    pub name: &'static str,
    pub router: Address,
    pub quoter: Address,
    pub fee_tiers: &'static [u32],
    /// LI.FI quotes are requested here (its Diamond is `lifi::DIAMOND` on this chain). `false`:
    /// direct V3 only, whatever SWAP_VENUE says.
    pub lifi: bool,
}

/// Uniswap's cross-chain SwapRouter02 / QuoterV2 (mainnet, Optimism, Arbitrum).
const UNI_ROUTER: Address = address!("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45");
const UNI_QUOTER: Address = address!("0x61fFE014bA17989E743c5F6cB21bF9697530B21e");

// Routers and quoters verified live on-chain (WETH9(), code, a real quote): mainnet and BSC
// 2026-10-06 (and by the fork tests); Optimism, Arbitrum, Base and Robinhood 2026-10-14.
const DEXES: &[Dex] = &[
    Dex { chain_id: 1, name: "Uniswap V3", router: UNI_ROUTER, quoter: UNI_QUOTER, fee_tiers: &[100, 500, 3000], lifi: true },
    Dex {
        chain_id: 56,
        name: "PancakeSwap V3",
        router: address!("0x13f4EA83D0bd40E75C8222255bc855a974568Dd4"),
        quoter: address!("0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"),
        fee_tiers: &[100, 500, 2500],
        lifi: true,
    },
    Dex { chain_id: 10, name: "Uniswap V3", router: UNI_ROUTER, quoter: UNI_QUOTER, fee_tiers: &[100, 500, 3000], lifi: true },
    Dex { chain_id: 42161, name: "Uniswap V3", router: UNI_ROUTER, quoter: UNI_QUOTER, fee_tiers: &[100, 500, 3000], lifi: true },
    Dex {
        chain_id: 8453,
        name: "Uniswap V3",
        router: address!("0x2626664c2603336E57B271c5C0b26F421741e481"),
        quoter: address!("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
        fee_tiers: &[100, 500, 3000],
        lifi: true,
    },
    // Robinhood Chain (Arbitrum Orbit): Uniswap's own deployment. LI.FI runs a different Diamond
    // there (0xB477…), which `lifi::validate` would reject, so V3 only.
    Dex {
        chain_id: 4663,
        name: "Uniswap V3",
        router: address!("0xcaf681a66d020601342297493863e78c959e5cb2"),
        quoter: address!("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"),
        fee_tiers: &[100, 500, 3000],
        lifi: false,
    },
];

pub fn for_chain(chain_id: u64) -> Option<&'static Dex> {
    DEXES.iter().find(|d| d.chain_id == chain_id)
}

pub fn supported_chains() -> Vec<u64> {
    DEXES.iter().map(|d| d.chain_id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup() {
        assert_eq!(for_chain(1).unwrap().name, "Uniswap V3");
        assert_eq!(for_chain(56).unwrap().name, "PancakeSwap V3");
        assert!(for_chain(4114).is_none());
        assert_eq!(supported_chains(), vec![1, 56, 10, 42161, 8453, 4663]);
        assert!(!for_chain(4663).unwrap().lifi);
    }

    #[test]
    fn tables_are_sane() {
        for d in DEXES {
            assert!(!d.fee_tiers.is_empty());
            assert!(![d.router, d.quoter].iter().any(|a| a.is_zero()));
        }
    }
}
