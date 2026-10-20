//! The EVM steps behind [`crate::pipeline::Family`]:
//!   collect: redeem PP yield shares (ERC-4626 over an Aave aToken) and withdraw the aTokens
//!            from Aave into the underlying
//!   convert: sell the wallet's whole stablecoin balances for native, on direct V3 (best fee tier
//!            by on-chain QuoterV2, minOut = quote - slippage) or LI.FI (validated quote), output
//!            paid straight to the recipient unless the fee wallet needs a refill; then unwrap the
//!            wallet's whole wrapped-native balance (e.g. from ppETH)
//!
//! In dry-run mode nothing is sent; each step returns its projected native gain and worst-case
//! gas (at max fee) instead, and redeem proceeds are carried into the swap and unwrap via
//! `Evm::redeemed`.
//!
//! One share, token or the unwrap failing doesn't stop the others (nor the final send): its error goes to `Evm::failures`, and
//! the chain is reported failed after the rest of the sweep ran.

use std::collections::HashSet;

use alloy::{
    primitives::{Address, U256, aliases::U24},
    providers::Provider,
    rpc::types::{Log, TransactionReceipt, TransactionRequest},
    sol_types::{SolCall, SolEvent},
    transports::TransportError,
};
use anyhow::{Context, Result, ensure};
use clap::ValueEnum;
use tracing::{debug, error, info, warn};

use super::{
    Evm,
    abi::{IAToken, IAavePool, IERC20, IERC4626, ILiFiEvents, IQuoterV2, IV3SwapRouter, IWrappedNative},
    fmt_units, lifi, math,
    profile::{SwapToken, YieldShare},
};
use crate::{
    pipeline::{Settings, Step},
    redact,
};

/// How long a router swap stays valid after we build it.
const SWAP_DEADLINE_SECS: u64 = 30 * 60;

/// SwapRouter02 / PancakeSwap SmartRouter `Constants.ADDRESS_THIS`: "the router itself" as a
/// recipient, so a following `unwrapWETH9` in the same multicall can pay out native.
const ROUTER_ADDRESS_THIS: Address = Address::with_last_byte(2);

/// `SWAP_VENUE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum SwapVenue {
    /// LI.FI vs. direct V3: the higher guaranteed output after gas.
    Best,
    /// LI.FI whenever its quote passes the checks and its floor beats V3's quote; V3 otherwise.
    Lifi,
    /// Direct V3 only (no off-chain API).
    V3,
}

/// One venue's guaranteed output, expected gas cost, and (V3) raw quote.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Offer {
    pub min_out: U256,
    pub gas_cost: U256,
    /// V3: the quote before slippage; LI.FI: same as `min_out`.
    pub quote: U256,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pick {
    V3,
    Lifi,
}

/// Chooses a venue. The on-chain V3 quote is the price reference: without it nothing is picked
/// (a LI.FI quote can't be sanity-checked), and LI.FI is only taken when its *guaranteed* output
/// beats V3's *raw quote*. Comparing floor to floor would let a bad quote keep up to the whole
/// slippage margin on every swap.
pub fn pick_venue(mode: SwapVenue, v3: Option<Offer>, lifi: Option<Offer>) -> (Option<Pick>, String) {
    let Some(v3) = v3 else {
        return (None, "no V3 pool quote to price against".into());
    };
    let Some(lifi) = lifi else {
        return (Some(Pick::V3), "LI.FI not available".into());
    };
    if lifi.min_out < v3.quote {
        return (Some(Pick::V3), "LI.FI floor below V3 quote".into());
    }
    let net = |o: Offer| o.min_out.saturating_sub(o.gas_cost);
    match mode {
        SwapVenue::V3 => (Some(Pick::V3), "SWAP_VENUE=v3".into()),
        SwapVenue::Lifi => (Some(Pick::Lifi), "SWAP_VENUE=lifi".into()),
        SwapVenue::Best if net(lifi) > net(v3) => (Some(Pick::Lifi), "LI.FI nets more after gas".into()),
        SwapVenue::Best => (Some(Pick::V3), "V3 nets at least as much after gas".into()),
    }
}

impl Evm {
    fn from(&self) -> Address {
        self.tx.from
    }

    /// Expected cost of `gas` at today's fee (dust gates, venue comparison).
    async fn cost(&self, gas: u64) -> Result<U256> {
        Ok(math::expected_cost(gas, self.tx.base_fee().await?, self.tx.tip))
    }

    /// Worst-case cost of `gas` at max fee (projection, reserves, upfront affordability).
    async fn worst(&self, gas: u64) -> Result<U256> {
        Ok(math::worst_cost(gas, self.tx.base_fee().await?, self.tx.tip))
    }

    pub(super) fn fail(&mut self, what: &str, e: &anyhow::Error) {
        let msg = format!("{what}: {}", redact::error(e));
        error!("    FAILED {msg}");
        self.failures.push(msg);
    }

    /// Sets the allowance to exactly `amount` (never more, never left larger): resets a nonzero
    /// allowance first (mainnet USDT reverts on nonzero -> nonzero).
    async fn approve(&mut self, token: Address, spender: Address, amount: U256) -> Result<()> {
        let erc20 = IERC20::new(token, self.tx.provider.clone());
        let current = erc20.allowance(self.from(), spender).call().await.with_context(|| format!("read allowance of {token} for {spender}"))?;
        debug!("    allowance {token} -> {spender}: {current}, want {amount}");
        if current == amount {
            info!("    allowance already exact, skipping approve");
            return Ok(());
        }
        if !current.is_zero() {
            self.tx.send(erc20.approve(spender, U256::ZERO).into_transaction_request(), "approve(0)").await?;
        }
        self.tx.send(erc20.approve(spender, amount).into_transaction_request(), "approve").await?;
        Ok(())
    }

    /// Any allowance the LI.FI Diamond still holds on `token` (a failed or killed earlier attempt)
    /// goes back to 0: a standing approval to an upgradeable aggregator is exactly what LI.FI's
    /// July 2024 exploit drained.
    async fn revoke_lifi(&mut self, s: &Settings<Self>, token: &SwapToken) -> Result<()> {
        let erc20 = IERC20::new(token.token, self.tx.provider.clone());
        let current = erc20.allowance(self.from(), lifi::DIAMOND).call().await.context("read LI.FI Diamond allowance")?;
        if current.is_zero() {
            debug!("{}: no LI.FI Diamond allowance", token.ticker);
            return Ok(());
        }
        if !s.send {
            warn!("{}: stale LI.FI Diamond allowance {current}, would revoke", token.ticker);
            return Ok(());
        }
        warn!("{}: revoking stale LI.FI Diamond allowance {current}", token.ticker);
        self.tx.send(erc20.approve(lifi::DIAMOND, U256::ZERO).into_transaction_request(), "revoke LI.FI approval").await?;
        Ok(())
    }

    /// Redeems every share for its aToken (`ERC4626.redeem`, no approve: we own the shares), then
    /// withdraws the wallet's aToken balance from Aave (`withdraw(max)`). aTokens left by a run
    /// that died between the two are withdrawn too.
    pub(super) async fn redeem_shares(&mut self, s: &Settings<Self>) -> Result<Step<U256>> {
        let mut step = Step::default();
        let mut seen_atokens = HashSet::new();
        for share in self.chain.shares.clone() {
            if !s.selected(&share.ticker) {
                info!("{}: skipped (ONLY)", share.ticker);
                continue;
            }
            match self.redeem_one(s, &share, &mut seen_atokens).await {
                Ok(st) => step = step + st,
                Err(e) => self.fail(&share.ticker, &e),
            }
        }
        Ok(step)
    }

    async fn redeem_one(&mut self, s: &Settings<Self>, share: &YieldShare, seen_atokens: &mut HashSet<Address>) -> Result<Step<U256>> {
        let provider = self.tx.provider.clone();
        let me = self.from();
        let vault = IERC4626::new(share.share, provider.clone());
        let a_token = IAToken::new(share.a_token, provider.clone());
        let shares = vault.balanceOf(me).call().await.context("read share balance")?;
        // A wallet-wide balance: count it once even if two shares wrap the same aToken.
        let parked = if seen_atokens.insert(share.a_token) { a_token.balanceOf(me).call().await.context("read aToken balance")? } else { U256::ZERO };
        debug!("{}: shares={shares} parked aTokens={parked} (vault {}, aToken {})", share.ticker, share.share, share.a_token);
        if shares.is_zero() && parked.is_zero() {
            info!("{}: 0 shares", share.ticker);
            return Ok(Step::default());
        }
        // aTokens are 1:1 with the underlying, so previewRedeem is the underlying amount. A share
        // balance that redeems to 0 (anyone can send dust) would make the vault revert
        // (ZeroAssets) every run: leave it alone.
        let preview = if shares.is_zero() { U256::ZERO } else { vault.previewRedeem(shares).call().await.context("previewRedeem")? };
        debug!("{}: previewRedeem({shares}) = {preview}", share.ticker);
        let redeem = !preview.is_zero();
        if !shares.is_zero() && !redeem {
            info!("{}: {shares} shares redeem to 0 (dust), left alone", share.ticker);
        }
        let amount = preview + parked;
        if amount.is_zero() {
            return Ok(Step::default());
        }
        let dec = share.underlying_decimals;
        let sym = self.chain.native_symbol.clone();

        // Same economics as swaps: don't spend more on gas than the position is worth.
        let gas = if redeem { math::GAS_REDEEM } else { math::GAS_WITHDRAW };
        let value = if share.underlying == self.chain.wrapped_native {
            Some(amount)
        } else {
            self.best_quote(share.underlying, amount).await?.map(|(_, q)| q)
        };
        let cost = self.cost(gas).await?;
        debug!(
            "{}: worth {} {sym}, {gas} gas ~{} {sym}, gate {}x",
            share.ticker,
            value.map_or("unpriced".into(), |v| fmt_units(v, 18)),
            fmt_units(cost, 18),
            self.opts.min_gas_multiple
        );
        match value {
            Some(v) if !math::worth_swapping(v, cost, self.opts.min_gas_multiple) => {
                info!("{}: skipped, worth ~{} {sym} < {}x gas ~{}", share.ticker, fmt_units(v, 18), self.opts.min_gas_multiple, fmt_units(cost, 18));
                return Ok(Step::default());
            }
            None => warn!("{}: can't price the underlying in {sym} (no V3 pool); redeeming anyway", share.ticker),
            _ => {}
        }
        info!(
            "{}: {shares} shares -> ~{} underlying ({}) via Aave pool {}{}",
            share.ticker,
            fmt_units(amount, dec),
            share.underlying,
            share.pool,
            if parked.is_zero() { String::new() } else { format!(" (incl. {} aTokens already held)", fmt_units(parked, dec)) }
        );

        if !s.send {
            // Wrapped native too: it's unwrapped (and its gas counted) in convert.
            *self.redeemed.entry(share.underlying).or_default() += amount;
            return Ok(Step { spent: self.worst(gas).await?, ..Step::default() });
        }

        if redeem {
            let tx = vault.redeem(shares, me, me).into_transaction_request();
            self.tx.send(tx, &format!("{} redeem", share.ticker)).await?;
        }
        let held = a_token.balanceOf(me).call().await.context("read aToken balance after redeem")?;
        debug!("    {}: {held} aTokens to withdraw", share.ticker);
        ensure!(!held.is_zero(), "no aTokens to withdraw after the redeem");
        let underlying = IERC20::new(share.underlying, provider.clone());
        let before = underlying.balanceOf(me).call().await.context("read underlying balance")?;
        let tx = IAavePool::new(share.pool, provider.clone()).withdraw(share.underlying, U256::MAX, me).into_transaction_request();
        self.tx.send(tx, &format!("{} Aave withdraw", share.ticker)).await?;
        let received = underlying.balanceOf(me).call().await?.saturating_sub(before);
        info!("    received {}  (shares left: {})", fmt_units(received, dec), vault.balanceOf(me).call().await?);
        Ok(Step::default())
    }

    /// `usd` dollars in native, at the on-chain V3 quote of the chain's USD stablecoin (a USDC
    /// first, else any `USD*` swap token). Errors when there is no stablecoin or no pool: an
    /// unpriceable cap must not turn into "no cap".
    pub(super) async fn usd_in_native(&self, usd: &str, var: &str) -> Result<U256> {
        let usd_like = |t: &&SwapToken| t.ticker.to_uppercase().starts_with("USD");
        let stable = (self.chain.swap_tokens.iter().find(|t| t.ticker.to_uppercase().starts_with("USDC")))
            .or_else(|| self.chain.swap_tokens.iter().find(usd_like))
            .with_context(|| format!("{var}: no USD stablecoin among this chain's swap tokens to price it"))?;
        let amount: U256 =
            alloy::primitives::utils::parse_units(usd, stable.decimals).with_context(|| format!("{var} {usd:?} in {} units", stable.ticker))?.into();
        let (_, native) = self
            .best_quote(stable.token, amount)
            .await?
            .with_context(|| format!("{var}: no {} pool to price {} {} in native", self.chain.dex.name, usd, stable.ticker))?;
        debug!("{var} {usd} = {usd} {} = {} native", stable.ticker, fmt_units(native, 18));
        Ok(native)
    }

    /// Best `amountIn -> wrapped native` quote across the DEX's fee tiers. A tier whose quote
    /// reverts (no pool) is skipped; an RPC failure is an error, not "no pool" (it would quietly
    /// route through a worse tier).
    async fn best_quote(&self, token: Address, amount_in: U256) -> Result<Option<(u32, U256)>> {
        let quoter = IQuoterV2::new(self.chain.dex.quoter, self.tx.provider.clone());
        let mut best: Option<(u32, U256)> = None;
        for &fee in self.chain.dex.fee_tiers {
            let params = IQuoterV2::QuoteExactInputSingleParams {
                tokenIn: token,
                tokenOut: self.chain.wrapped_native,
                amountIn: amount_in,
                fee: U24::from(fee),
                sqrtPriceLimitX96: Default::default(),
            };
            let q = match quoter.quoteExactInputSingle(params).call().await {
                Ok(q) => q,
                Err(alloy::contract::Error::TransportError(TransportError::Transport(e))) => {
                    return Err(anyhow::Error::new(e).context(format!("quote fee tier {fee}")));
                }
                Err(e) => {
                    // Reverted / undecodable: no usable pool at this tier.
                    debug!("    quote {token} fee tier {fee}: no pool ({})", redact::text(&e.to_string()));
                    continue;
                }
            };
            debug!("    quote {token} fee tier {fee}: {amount_in} -> {}", q.amountOut);
            if best.is_none_or(|(_, b)| q.amountOut > b) {
                best = Some((fee, q.amountOut));
            }
        }
        debug!("    best V3 quote for {amount_in} of {token}: {best:?}");
        Ok(best)
    }

    /// The fee wallet's native balance as the next step will see it (dry run: projected).
    async fn wallet_native(&self, s: &Settings<Self>) -> Result<U256> {
        let live = self.tx.provider.get_balance(self.from()).await?;
        Ok(if s.send { live } else { (live + self.dry.gained).saturating_sub(self.dry.spent) })
    }

    /// Where a swap's native output goes: straight to the recipient, unless the fee wallet itself
    /// is short of `keep` + the worst-case gas this run still needs (then it refills itself).
    async fn swap_destination(&self, s: &Settings<Self>, swaps_left: u64) -> Result<Address> {
        if s.recipient == self.from() {
            return Ok(self.from());
        }
        let reserve = self.worst(math::GAS_SWAP * swaps_left + math::GAS_UNWRAP + math::GAS_SEND).await?;
        let have = self.wallet_native(s).await?;
        let refill = have < s.keep + reserve;
        debug!(
            "    destination: wallet {} vs keep {} + reserve {} ({swaps_left} swaps left) -> {}",
            fmt_units(have, 18),
            fmt_units(s.keep, 18),
            fmt_units(reserve, 18),
            if refill { "fee wallet (refill)" } else { "recipient" }
        );
        Ok(if refill { self.from() } else { s.recipient })
    }

    /// LI.FI's validated offer, or why there is none (logged; the V3 path still runs).
    async fn lifi_offer(&self, token: Address, amount: U256, to: Address) -> Result<lifi::Plan> {
        let Some(client) = &self.lifi else { anyhow::bail!("disabled (SWAP_VENUE=v3 or no LI.FI on this chain)") };
        let req = lifi::Request { chain_id: self.chain_id, token, amount, from: self.from(), receiver: to, slippage_bps: self.opts.slippage_bps };
        lifi::validate(client.quote(&req).await?, &req)
    }

    /// V3 `token -> native` paid to `to` in one tx: router multicall (with deadline) of
    /// exactInputSingle (output kept by the router) + unwrapWETH9(min_out, to).
    async fn exec_v3(&mut self, ticker: &str, token: Address, amount: U256, fee: u32, min_out: U256, to: Address) -> Result<TransactionReceipt> {
        let dex = self.chain.dex;
        self.approve(token, dex.router, amount).await?;
        let swap = IV3SwapRouter::exactInputSingleCall {
            params: IV3SwapRouter::ExactInputSingleParams {
                tokenIn: token,
                tokenOut: self.chain.wrapped_native,
                fee: U24::from(fee),
                recipient: ROUTER_ADDRESS_THIS,
                amountIn: amount,
                amountOutMinimum: min_out,
                sqrtPriceLimitX96: Default::default(),
            },
        };
        let unwrap = IV3SwapRouter::unwrapWETH9Call { amountMinimum: min_out, recipient: to };
        let calls = vec![swap.abi_encode().into(), unwrap.abi_encode().into()];
        let now =
            self.tx.provider.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await?.context("latest block not found")?.header.timestamp;
        let deadline = U256::from(now + SWAP_DEADLINE_SECS);
        debug!("    V3 multicall: router {} fee {fee} amount {amount} min_out {min_out} to {to} deadline {deadline}", dex.router);
        let tx = IV3SwapRouter::new(dex.router, self.tx.provider.clone()).multicall(deadline, calls).into_transaction_request();
        self.tx.send(tx, &format!("{ticker} V3 swap -> native")).await
    }

    async fn exec_lifi(&mut self, ticker: &str, token: Address, amount: U256, plan: &lifi::Plan) -> Result<TransactionReceipt> {
        self.approve(token, lifi::DIAMOND, amount).await?;
        let tx = TransactionRequest::default().from(self.from()).to(lifi::DIAMOND).input(plan.data.clone().into());
        let estimate = self.tx.provider.estimate_gas(tx.clone()).await.context("LI.FI estimate")?;
        let gas_limit = math::call_gas_limit(estimate).max(plan.gas_limit);
        debug!("    LI.FI {}: estimate {estimate}, quote limit {} -> gas limit {gas_limit}, min_out {}", plan.tool, plan.gas_limit, plan.min_out);
        self.tx.send(tx.gas_limit(gas_limit), &format!("{ticker} LI.FI swap ({}) -> native", plan.tool)).await
    }

    /// Native paid to `to` according to the receipt's own events (not balances: the recipient is
    /// typically the busy relayer signer, whose balance moves on its own).
    fn delivered(&self, receipt: &TransactionReceipt, pick: Pick, to: Address) -> Option<U256> {
        let logs = receipt.inner.logs();
        let total: U256 = match pick {
            Pick::V3 => v3_unwrapped(logs, self.chain.wrapped_native, self.chain.dex.router),
            Pick::Lifi => logs
                .iter()
                .filter(|l| l.address() == lifi::DIAMOND)
                .filter_map(|l| ILiFiEvents::LiFiGenericSwapCompleted::decode_log(&l.inner).ok())
                .filter(|e| e.receiver == to)
                .map(|e| e.data.toAmount)
                .sum(),
        };
        (!total.is_zero()).then_some(total)
    }

    /// Sells every swap token for native. Each token is priced on V3 (on-chain quoter) and, unless
    /// SWAP_VENUE=v3, on LI.FI; `pick_venue` chooses. Output goes to `swap_destination`. A LI.FI
    /// failure at any point (quote, checks, revert) falls back to V3.
    pub(super) async fn swap_tokens(&mut self, s: &Settings<Self>) -> Result<Step<U256>> {
        let mut step = Step::default();
        let tokens = self.chain.swap_tokens.clone();
        for (i, t) in tokens.iter().enumerate() {
            match self.swap_one(s, t, (tokens.len() - i) as u64).await {
                Ok(st) => step = step + st,
                Err(e) => self.fail(&format!("swap {}", t.ticker), &e),
            }
        }
        Ok(step)
    }

    async fn swap_one(&mut self, s: &Settings<Self>, t: &SwapToken, swaps_left: u64) -> Result<Step<U256>> {
        let provider = self.tx.provider.clone();
        let dex = self.chain.dex;
        self.revoke_lifi(s, t).await?;
        let erc20 = IERC20::new(t.token, provider.clone());
        let mut amount = erc20.balanceOf(self.from()).call().await.context("read token balance")?;
        debug!("swap {}: wallet holds {amount} of {}", t.ticker, t.token);
        if !s.send {
            amount += self.redeemed.get(&t.token).copied().unwrap_or_default(); // incl. collect proceeds
        }
        if amount.is_zero() {
            info!("swap {}: 0 balance", t.ticker);
            return Ok(Step::default());
        }
        let to = self.swap_destination(s, swaps_left).await?;

        let v3 = self.best_quote(t.token, amount).await?;
        let v3_offer = match v3 {
            Some((_, quote)) => {
                Some(Offer {
                    min_out: math::min_out(quote, self.opts.slippage_bps),
                    // The approve is part of the swap's cost (as in LI.FI's offer below).
                    gas_cost: self.cost(math::GAS_SWAP_APPROVE + math::GAS_SWAP).await?,
                    quote,
                })
            }
            None => None,
        };
        let mut lifi = match self.opts.venue {
            // SWAP_VENUE=v3, or no LI.FI on this chain (`Dex::lifi`).
            _ if self.lifi.is_none() => None,
            _ => match self.lifi_offer(t.token, amount, to).await {
                Ok(plan) => Some(plan),
                Err(e) => {
                    warn!("swap {}: LI.FI unusable, {}", t.ticker, redact::error(&e));
                    None
                }
            },
        };
        // The node rejects a tx the wallet can't cover at gas_limit x maxFee; LI.FI limits run to
        // millions of gas, so check before approving anything.
        if let Some(plan) = &lifi {
            let upfront = self.worst(math::GAS_SWAP_APPROVE + plan.gas_limit).await?;
            let have = self.wallet_native(s).await?;
            if have < upfront {
                warn!(
                    "swap {}: LI.FI route needs up to {} {} upfront for gas, wallet holds {}; not using it",
                    t.ticker,
                    fmt_units(upfront, 18),
                    self.chain.native_symbol,
                    fmt_units(have, 18)
                );
                lifi = None;
            }
        }
        let lifi_offer = match &lifi {
            Some(p) => Some(Offer { min_out: p.min_out, gas_cost: self.cost(math::GAS_SWAP_APPROVE + p.gas_expected).await?, quote: p.min_out }),
            None => None,
        };
        debug!("swap {}: offers v3={v3_offer:?} lifi={lifi_offer:?}", t.ticker);
        let (pick, why) = pick_venue(self.opts.venue, v3_offer, lifi_offer);
        let Some(pick) = pick else {
            warn!("swap {}: skipped, {why} ({} fees {:?})", t.ticker, dex.name, dex.fee_tiers);
            return Ok(Step::default());
        };
        let (offer, venue) = match (pick, v3, &lifi) {
            (Pick::V3, Some((fee, _)), _) => (v3_offer.context("picked V3 without an offer")?, format!("{} fee tier {fee}", dex.name)),
            (Pick::Lifi, _, Some(plan)) => (lifi_offer.context("picked LI.FI without an offer")?, format!("LI.FI {}", plan.tool)),
            _ => anyhow::bail!("venue {pick:?} picked without its quote"),
        };
        info!(
            "swap {}: {} -> >={} {} to {} via {venue} ({why}; gas ~{})",
            t.ticker,
            fmt_units(amount, t.decimals),
            fmt_units(offer.min_out, 18),
            self.chain.native_symbol,
            if to == self.from() { "fee wallet".to_string() } else { format!("recipient {to}") },
            fmt_units(offer.gas_cost, 18)
        );
        if !math::worth_swapping(offer.min_out, offer.gas_cost, self.opts.min_gas_multiple) {
            info!("    skipped: output < {}x gas cost", self.opts.min_gas_multiple);
            return Ok(Step::default());
        }
        if !s.send {
            // Worst case: max fee; for LI.FI its whole gas limit plus a V3 fallback.
            let spent = match (pick, &lifi) {
                (Pick::Lifi, Some(p)) => self.worst(math::GAS_SWAP_APPROVE + p.gas_limit + math::GAS_SWAP).await?,
                _ => self.worst(math::GAS_SWAP_APPROVE + math::GAS_SWAP).await?,
            };
            let this = if to == self.from() {
                Step { gained: offer.min_out, spent, delivered: U256::ZERO }
            } else {
                Step { gained: U256::ZERO, spent, delivered: offer.min_out }
            };
            self.dry = self.dry + this;
            return Ok(this);
        }

        let mut done: Option<(TransactionReceipt, Pick, U256)> = None;
        if let (Pick::Lifi, Some(plan)) = (pick, &lifi) {
            match self.exec_lifi(&t.ticker, t.token, amount, plan).await {
                Ok(r) => {
                    debug!("    LI.FI swap mined in block {:?}", r.block_number);
                    done = Some((r, Pick::Lifi, plan.min_out));
                }
                Err(e) => {
                    warn!("    LI.FI swap failed ({}); falling back to {}", redact::error(&e), dex.name);
                    self.revoke_lifi(s, t).await?;
                }
            }
        }
        let (receipt, used, min) = match done {
            Some(d) => d,
            None => {
                let (fee, quote) = v3.context("LI.FI failed and no V3 pool to fall back to")?;
                let min_out = math::min_out(quote, self.opts.slippage_bps);
                (self.exec_v3(&t.ticker, t.token, amount, fee, min_out, to).await?, Pick::V3, min_out)
            }
        };
        let mut step = Step::default();
        if to != self.from() {
            let got = self.delivered(&receipt, used, to);
            debug!("    receipt {}: payout events to {to} total {got:?} (via {used:?}, min {min})", receipt.transaction_hash);
            let got = got.context("swap receipt has no payout event for the recipient")?;
            ensure!(got >= min, "receipt shows {got} paid to the recipient, below the guaranteed {min}");
            info!("    delivered {} {} to recipient", fmt_units(got, 18), self.chain.native_symbol);
            step.delivered = got;
        }
        info!("    {} left: {}", t.ticker, erc20.balanceOf(self.from()).call().await?);
        Ok(step)
    }

    pub(super) async fn unwrap_native(&mut self, s: &Settings<Self>) -> Result<Step<U256>> {
        let sym = self.chain.native_symbol.clone();
        let wrapped = IWrappedNative::new(self.chain.wrapped_native, self.tx.provider.clone());
        let mut bal = wrapped.balanceOf(self.from()).call().await.context("read wrapped native balance")?;
        debug!("W{sym}: wallet holds {bal}");
        if !s.send {
            bal += self.redeemed.get(&self.chain.wrapped_native).copied().unwrap_or_default(); // e.g. ppETH
        }
        let cost = self.cost(math::GAS_UNWRAP).await?;
        if bal.is_zero() {
            info!("W{sym}: 0, nothing to unwrap");
        } else if !math::worth_swapping(bal, cost, self.opts.min_gas_multiple) {
            // Same gate as redeems/swaps: 1 wei of WETH must not buy a daily unwrap tx.
            info!("W{sym}: {} < {}x unwrap gas ~{}, left alone", fmt_units(bal, 18), self.opts.min_gas_multiple, fmt_units(cost, 18));
        } else if !s.send {
            info!("W{sym}: {} -> {sym}", fmt_units(bal, 18));
            return Ok(Step { gained: bal, spent: self.worst(math::GAS_UNWRAP).await?, delivered: U256::ZERO });
        } else {
            info!("W{sym} -> {sym}: {}", fmt_units(bal, 18));
            self.tx.send(wrapped.withdraw(bal).into_transaction_request(), "unwrap").await?;
        }
        Ok(Step::default())
    }
}

/// What the router unwrapped in these logs; `unwrapWETH9` unwraps the router's whole WETH and
/// pays exactly that to the recipient. WETH9 / WBNB / OP-stack WETH emit `Withdrawal(router)`;
/// aeWETH (Arbitrum, Robinhood) emits only its burn, `Transfer(router, 0x0)`. The larger of the
/// two, not the sum: a WETH that emits both for one unwrap must not count it twice.
fn v3_unwrapped(logs: &[Log], wrapped_native: Address, router: Address) -> U256 {
    let ours = || logs.iter().filter(|l| l.address() == wrapped_native);
    let withdrawn: U256 =
        ours().filter_map(|l| IWrappedNative::Withdrawal::decode_log(&l.inner).ok()).filter(|e| e.src == router).map(|e| e.data.wad).sum();
    let burned: U256 = ours()
        .filter_map(|l| IWrappedNative::Transfer::decode_log(&l.inner).ok())
        .filter(|e| e.from == router && e.to.is_zero())
        .map(|e| e.data.value)
        .sum();
    withdrawn.max(burned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;

    fn offer(min_out: u64, gas_cost: u64) -> Option<Offer> {
        Some(Offer { min_out: U256::from(min_out), gas_cost: U256::from(gas_cost), quote: U256::from(min_out) })
    }

    /// A V3 offer whose raw quote is `quote` and floor `min_out`.
    fn v3(min_out: u64, quote: u64, gas_cost: u64) -> Option<Offer> {
        Some(Offer { min_out: U256::from(min_out), gas_cost: U256::from(gas_cost), quote: U256::from(quote) })
    }

    const WRAPPED: Address = address!("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1");
    const ROUTER: Address = address!("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45");
    const OTHER: Address = address!("0x00000000000000000000000000000000000000aa");

    fn log(emitter: Address, event: &impl SolEvent) -> Log {
        Log { inner: alloy::primitives::Log { address: emitter, data: event.encode_log_data() }, ..Default::default() }
    }
    fn withdrawal(emitter: Address, src: Address, wad: u64) -> Log {
        log(emitter, &IWrappedNative::Withdrawal { src, wad: U256::from(wad) })
    }
    fn transfer(emitter: Address, from: Address, to: Address, value: u64) -> Log {
        log(emitter, &IWrappedNative::Transfer { from, to, value: U256::from(value) })
    }

    #[test]
    fn v3_payout_counts_weth9_withdrawals_and_aeweth_burns() {
        let paid = |logs: &[Log]| v3_unwrapped(logs, WRAPPED, ROUTER);
        // WETH9 / WBNB / OP-stack WETH.
        assert_eq!(paid(&[withdrawal(WRAPPED, ROUTER, 70)]), U256::from(70));
        // aeWETH (Arbitrum, Robinhood): the swap's own Transfer into the router doesn't count, the burn does.
        assert_eq!(paid(&[transfer(WRAPPED, OTHER, ROUTER, 70), transfer(WRAPPED, ROUTER, Address::ZERO, 70)]), U256::from(70));
        // A WETH that emits both for one unwrap is counted once.
        assert_eq!(paid(&[withdrawal(WRAPPED, ROUTER, 70), transfer(WRAPPED, ROUTER, Address::ZERO, 70)]), U256::from(70));
        // Someone else's unwrap, another contract's burn, a router transfer elsewhere: nothing.
        assert_eq!(
            paid(&[
                withdrawal(WRAPPED, OTHER, 70),
                transfer(OTHER, ROUTER, Address::ZERO, 70),
                transfer(WRAPPED, ROUTER, OTHER, 70),
                withdrawal(OTHER, ROUTER, 70),
            ]),
            U256::ZERO
        );
    }

    #[test]
    fn venue_choice() {
        use SwapVenue::{Best, Lifi as LifiMode, V3 as V3Mode};
        let pick = |m, v3, li| pick_venue(m, v3, li).0;
        // No V3 reference: nothing, even if LI.FI quotes.
        assert_eq!(pick(Best, None, offer(100, 1)), None);
        // LI.FI missing or below V3's floor: V3, in every mode.
        assert_eq!(pick(Best, offer(100, 1), None), Some(Pick::V3));
        assert_eq!(pick(LifiMode, offer(100, 1), offer(99, 0)), Some(Pick::V3));
        // Best: net of gas decides; ties go to V3.
        assert_eq!(pick(Best, offer(100, 10), offer(105, 10)), Some(Pick::Lifi));
        assert_eq!(pick(Best, offer(100, 1), offer(105, 10)), Some(Pick::V3)); // 99 vs 95
        assert_eq!(pick(Best, offer(100, 0), offer(100, 0)), Some(Pick::V3));
        // Lifi mode takes a sane LI.FI quote even if gas makes it net less.
        assert_eq!(pick(LifiMode, offer(100, 1), offer(105, 10)), Some(Pick::Lifi));
        assert_eq!(pick(V3Mode, offer(100, 1), offer(200, 0)), Some(Pick::V3));
        // LI.FI's floor must beat V3's raw quote, not just V3's floor: 99.6 >= floor 99.5 but < quote 100.
        assert_eq!(pick(LifiMode, v3(995, 1000, 0), offer(996, 0)), Some(Pick::V3));
        assert_eq!(pick(Best, v3(995, 1000, 0), offer(1001, 0)), Some(Pick::Lifi));
    }
}
