//! LI.FI as a swap venue: `GET /quote` for `token -> native`, then a strict check of the returned
//! transaction before anything is signed. We sign calldata an API built, so nothing in the JSON is
//! trusted except what the calldata itself enforces on-chain:
//!
//! - target and approval address are the LI.FI Diamond (never the Executor or anything else)
//! - chain id matches, no native value attached
//! - the calldata is one of the Diamond's same-chain swap entrypoints, and decodes to: receiver ==
//!   who we asked for, first leg is the only deposit and spends exactly our token and amount, last
//!   leg pays out native
//! - the guaranteed output is the calldata's `_minAmountOut` (the Diamond reverts below it), not
//!   the JSON's `toAmountMin`
//!
//! Price sanity (vs. the on-chain V3 quote) is the caller's job; see `steps::pick_venue`.

use std::time::Duration;

use alloy::{
    primitives::{Address, Bytes, U256, address},
    sol_types::SolInterface,
};
use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use tracing::debug;

use crate::evm::abi::{ILiFiSwap::ILiFiSwapCalls, LiFiSwapData};

/// LI.FI Diamond, same address on mainnet and BSC (and most EVM chains).
pub const DIAMOND: Address = address!("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
/// How LI.FI names the native coin.
const NATIVE: Address = Address::ZERO;
/// Never send a LI.FI swap with more gas than this, whatever the quote says.
const MAX_GAS_LIMIT: u64 = 15_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub tool: String,
    pub transaction_request: TxRequest,
    pub estimate: Estimate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxRequest {
    pub to: Address,
    pub data: Bytes,
    pub value: U256,
    pub chain_id: u64,
    #[serde(default)]
    pub gas_limit: Option<U256>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub approval_address: Address,
    #[serde(default)]
    pub gas_costs: Vec<GasCost>,
}

#[derive(Debug, Deserialize)]
pub struct GasCost {
    pub estimate: U256,
}

/// A validated LI.FI swap, ready to approve + send.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub tool: String,
    pub data: Bytes,
    pub receiver: Address,
    /// Enforced on-chain by the Diamond.
    pub min_out: U256,
    /// LI.FI's expected gas, for the venue comparison.
    pub gas_expected: u64,
    /// Minimum gas limit to send with. Aggregator routes fool `eth_estimateGas` (they try paths
    /// and catch failures, so a tight budget "succeeds" in simulation): a 2M USDC route estimated
    /// at ~0.8M reverted at 1.05M on a fork but needs ~3.1M. LI.FI's own limit covers it.
    pub gas_limit: u64,
}

/// What we asked LI.FI for.
#[derive(Debug, Clone, Copy)]
pub struct Request {
    pub chain_id: u64,
    pub token: Address,
    pub amount: U256,
    pub from: Address,
    pub receiver: Address,
    pub slippage_bps: u64,
}

pub struct Client {
    http: reqwest::Client,
    base: String,
    integrator: String,
}

impl Client {
    pub fn new(base: &str, integrator: &str) -> Result<Self> {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(20)).build()?;
        Ok(Self { http, base: base.trim_end_matches('/').to_string(), integrator: integrator.to_string() })
    }

    pub async fn quote(&self, r: &Request) -> Result<Quote> {
        debug!(
            "    LI.FI quote: {} {} -> native on chain {}, receiver {}, slippage {}bps ({})",
            r.amount,
            r.token,
            r.chain_id,
            r.receiver,
            r.slippage_bps,
            crate::redact::text(&self.base)
        );
        let started = std::time::Instant::now();
        let resp = self
            .http
            .get(format!("{}/quote", self.base))
            .query(&[
                ("fromChain", r.chain_id.to_string()),
                ("toChain", r.chain_id.to_string()),
                ("fromToken", r.token.to_string()),
                ("toToken", NATIVE.to_string()),
                ("fromAmount", r.amount.to_string()),
                ("fromAddress", r.from.to_string()),
                ("toAddress", r.receiver.to_string()),
                ("slippage", format!("{}", r.slippage_bps as f64 / 10_000.0)),
                ("integrator", self.integrator.clone()),
            ])
            .send()
            .await
            .context("LI.FI request")?;
        let status = resp.status();
        let body = resp.text().await.context("LI.FI body")?;
        debug!("    LI.FI quote: HTTP {status}, {} bytes in {}ms", body.len(), started.elapsed().as_millis());
        ensure!(status.is_success(), "LI.FI HTTP {status}: {}", body.chars().take(200).collect::<String>());
        serde_json::from_str(&body).context("LI.FI quote JSON")
    }
}

/// The receiver, guaranteed minimum and swap legs of a Diamond same-chain swap call.
fn decode(data: &[u8]) -> Result<(Address, U256, Vec<LiFiSwapData>)> {
    let call = ILiFiSwapCalls::abi_decode(data).context("calldata is not a LI.FI same-chain swap entrypoint")?;
    Ok(match call {
        ILiFiSwapCalls::swapTokensGeneric(c) => (c._receiver, c._minAmountOut, c._swapData),
        ILiFiSwapCalls::swapTokensSingleV3ERC20ToNative(c) => (c._receiver, c._minAmountOut, vec![c._swapData]),
        ILiFiSwapCalls::swapTokensMultipleV3ERC20ToNative(c) => (c._receiver, c._minAmountOut, c._swapData),
    })
}

pub fn validate(q: Quote, r: &Request) -> Result<Plan> {
    let tx = &q.transaction_request;
    ensure!(tx.chain_id == r.chain_id, "quote is for chain {}, not {}", tx.chain_id, r.chain_id);
    ensure!(tx.to == DIAMOND, "tx target {} is not the LI.FI Diamond {DIAMOND}", tx.to);
    ensure!(q.estimate.approval_address == DIAMOND, "approval address {} is not the LI.FI Diamond", q.estimate.approval_address);
    ensure!(tx.value.is_zero(), "tx carries {} native value for an ERC-20 swap", tx.value);

    let (receiver, min_out, legs) = decode(&tx.data)?;
    ensure!(receiver == r.receiver, "calldata receiver {receiver} != requested {}", r.receiver);
    let (Some(first), Some(last)) = (legs.first(), legs.last()) else { bail!("calldata has no swap legs") };
    ensure!(first.sendingAssetId == r.token, "first leg spends {} instead of {}", first.sendingAssetId, r.token);
    ensure!(first.fromAmount == r.amount, "first leg spends {} instead of {}", first.fromAmount, r.amount);
    // Only the first leg may pull from the wallet (`requiresDeposit`): a later deposit leg could
    // spend some other allowance the wallet happens to hold toward the Diamond.
    ensure!(first.requiresDeposit, "first leg doesn't take the deposit");
    ensure!(legs.iter().skip(1).all(|l| !l.requiresDeposit), "a later swap leg also pulls tokens from the wallet");
    ensure!(last.receivingAssetId == NATIVE, "last leg pays out {} instead of native", last.receivingAssetId);
    ensure!(!min_out.is_zero(), "calldata minAmountOut is zero");

    let gas_limit = tx.gas_limit.and_then(|g| u64::try_from(g).ok()).context("quote has no gasLimit")?;
    ensure!(gas_limit <= MAX_GAS_LIMIT, "quote wants {gas_limit} gas (> {MAX_GAS_LIMIT})");
    let expected: U256 = q.estimate.gas_costs.iter().map(|g| g.estimate).sum();
    let gas_expected = u64::try_from(expected).ok().filter(|g| *g > 0).unwrap_or(gas_limit).min(gas_limit);
    debug!("    LI.FI quote ok: tool {}, {} legs, min_out {min_out}, gas expected {gas_expected} limit {gas_limit}", q.tool, legs.len());
    Ok(Plan { tool: q.tool, data: tx.data.clone(), receiver, min_out, gas_expected, gas_limit })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Live quotes captured 2026-10-12 (fromAddress 0x..bEEF, toAddress 0x..cafE, slippage 0.5%).
    const MAINNET: &str = include_str!("../../tests/fixtures/lifi-quote-mainnet-usdc-eth.json");
    const BSC: &str = include_str!("../../tests/fixtures/lifi-quote-bsc-usdt-bnb.json");
    const BEEF: Address = address!("0x000000000000000000000000000000000000bEEF");
    const CAFE: Address = address!("0x000000000000000000000000000000000000cafE");
    const USDC: Address = address!("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    const BSC_USDT: Address = address!("0x55d398326f99059fF775485246999027B3197955");

    fn mainnet_req() -> Request {
        Request { chain_id: 1, token: USDC, amount: U256::from(100_000_000u64), from: BEEF, receiver: CAFE, slippage_bps: 50 }
    }

    fn quote(json: &str) -> Quote {
        serde_json::from_str(json).unwrap()
    }

    fn json_min(json: &str) -> U256 {
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        v["estimate"]["toAmountMin"].as_str().unwrap().parse().unwrap()
    }

    #[test]
    fn accepts_real_quotes_and_reads_min_from_calldata() {
        let p = validate(quote(MAINNET), &mainnet_req()).unwrap();
        assert_eq!(p.receiver, CAFE);
        assert_eq!(p.min_out, json_min(MAINNET)); // calldata agrees with the JSON here
        assert_eq!((p.gas_expected, p.gas_limit), (476_876, 619_939));

        let req = Request { chain_id: 56, token: BSC_USDT, amount: U256::from(10u128.pow(20)), ..mainnet_req() };
        let p = validate(quote(BSC), &req).unwrap();
        assert_eq!(p.min_out, json_min(BSC));
        assert_eq!((p.gas_expected, p.gas_limit), (1_625_211, 2_437_817));
    }

    fn rejects(mutate: impl FnOnce(&mut Quote, &mut Request), needle: &str) {
        let (mut q, mut r) = (quote(MAINNET), mainnet_req());
        mutate(&mut q, &mut r);
        let err = format!("{:#}", validate(q, &r).unwrap_err());
        assert!(err.contains(needle), "expected {needle:?} in {err:?}");
    }

    #[test]
    fn rejects_anything_off() {
        let evil = address!("0x00000000000000000000000000000000DeaDBeef");
        rejects(|_, r| r.receiver = evil, "receiver");
        rejects(|_, r| r.amount = U256::from(1u64), "first leg spends");
        rejects(|_, r| r.token = evil, "first leg spends");
        rejects(|_, r| r.chain_id = 56, "chain");
        rejects(|q, _| q.transaction_request.to = evil, "not the LI.FI Diamond");
        rejects(|q, _| q.estimate.approval_address = evil, "approval address");
        rejects(|q, _| q.transaction_request.value = U256::from(1u64), "native value");
        rejects(|q, _| q.transaction_request.data = Bytes::from_static(&[0xde, 0xad, 0xbe, 0xef, 0, 0]), "not a LI.FI same-chain swap");
        rejects(|q, _| q.transaction_request.gas_limit = Some(U256::from(MAX_GAS_LIMIT + 1)), "gas");
        rejects(|q, _| q.transaction_request.gas_limit = None, "no gasLimit");
    }

    #[test]
    fn rejects_extra_deposit_legs() {
        use alloy::sol_types::SolCall;
        // Re-encode the real mainnet quote with a second leg that also deposits (e.g. pulls a
        // stale USDT allowance): must be rejected even though receiver/min/first leg are fine.
        let (mut q, r) = (quote(MAINNET), mainnet_req());
        let (receiver, min_out, mut legs) = decode(&q.transaction_request.data).unwrap();
        let mut sneaky = legs[1].clone();
        sneaky.requiresDeposit = true;
        sneaky.sendingAssetId = address!("0xdAC17F958D2ee523a2206206994597C13D831ec7");
        legs.insert(1, sneaky);
        let call = crate::evm::abi::ILiFiSwap::swapTokensMultipleV3ERC20ToNativeCall {
            _transactionId: Default::default(),
            _integrator: "x".into(),
            _referrer: "".into(),
            _receiver: receiver,
            _minAmountOut: min_out,
            _swapData: legs,
        };
        q.transaction_request.data = call.abi_encode().into();
        let err = format!("{:#}", validate(q, &r).unwrap_err());
        assert!(err.contains("later swap leg also pulls"), "{err}");
    }

    #[test]
    fn tampered_calldata_receiver_is_caught() {
        // Flip the receiver inside the calldata itself (4-byte selector + 3 words, then the address).
        let mut q = quote(MAINNET);
        let mut data = q.transaction_request.data.to_vec();
        let at = 4 + 32 * 3 + 12;
        assert_eq!(&data[at..at + 20], CAFE.as_slice());
        data[at + 19] ^= 1;
        q.transaction_request.data = data.into();
        assert!(format!("{:#}", validate(q, &mainnet_req()).unwrap_err()).contains("receiver"));
    }
}
