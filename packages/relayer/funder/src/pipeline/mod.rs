//! Chain-neutral sweep pipeline. A chain family (EVM, later Stellar...) implements [`Family`];
//! [`sweep`] runs the same four steps on any of them:
//!
//!   1. collect: turn fee-side positions (e.g. PP yield shares) into something convertible
//!   2. convert: turn every fee asset into the native coin (swap, unwrap, path payment...)
//!   3. measure: native balance now (send mode) or projected (dry run)
//!   4. forward: send everything above `keep` + the transfer's own cost to the recipient
//!
//! Families keep their own address/amount types, so an EVM address can never reach a Stellar
//! transfer. Every step reads live state, so re-running finishes a run that died midway.

#[cfg(test)]
mod mock;

use std::{
    fmt::{Debug, Display},
    ops::Add,
    path::Path,
};

use anyhow::{Result, bail};
use tracing::{debug, info, warn};

use crate::config::RelayerConfig;

/// Native amount of a family (`U256` wei on EVM; stroops on Stellar).
pub trait Amount: Copy + Ord + Default + Debug + Display + Add<Output = Self> {
    fn saturating_sub(self, rhs: Self) -> Self;
}

impl Amount for u128 {
    fn saturating_sub(self, rhs: Self) -> Self {
        u128::saturating_sub(self, rhs)
    }
}

#[cfg(feature = "evm")]
impl Amount for alloy::primitives::U256 {
    fn saturating_sub(self, rhs: Self) -> Self {
        alloy::primitives::U256::saturating_sub(self, rhs)
    }
}

/// Run inputs shared by every chain, as the CLI received them. Families resolve the per-chain
/// overrides (`<NAME>_<FAMILY>_<id>`) on top.
pub struct Common<'a> {
    pub config: &'a RelayerConfig,
    pub config_path: &'a Path,
    /// `RECIPIENT`, the fallback for `RECIPIENT_<FAMILY>_<id>`.
    pub recipient: Option<&'a str>,
    pub send: bool,
    pub only: Option<&'a [String]>,
}

/// What every run needs, whatever the chain.
pub struct Settings<F: Family> {
    pub recipient: F::Address,
    /// Native left in the fee wallet for the next run's fees.
    pub keep: F::Amount,
    /// Broadcast; otherwise a dry run that only reads and projects.
    pub send: bool,
    /// Share tickers to collect; `None` = all.
    pub only: Option<Vec<String>>,
}

impl<F: Family> Settings<F> {
    pub fn selected(&self, ticker: &str) -> bool {
        self.only.as_ref().is_none_or(|only| only.iter().any(|t| t == ticker))
    }
}

/// Effect of a step. `gained`/`spent` are the dry-run effect on the fee wallet's native balance
/// (zero in send mode, where the pipeline reads the real balance instead); `delivered` is native
/// the step paid straight to the recipient (e.g. a swap whose output goes there), in both modes.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Step<A> {
    /// Native the step would add to the fee wallet (swap output, unwrapped balance...).
    pub gained: A,
    /// Worst-case fees the step would burn.
    pub spent: A,
    /// Native paid directly to the recipient (dry run: guaranteed minimum).
    pub delivered: A,
}

impl<A: Amount> Add for Step<A> {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Step { gained: self.gained + o.gained, spent: self.spent + o.spent, delivered: self.delivered + o.delivered }
    }
}

/// What a run did (or, in dry-run mode, would do) for the recipient.
#[derive(Debug, Default, PartialEq)]
pub struct Outcome<A> {
    /// Total native to the recipient: `delivered` + `sent` (dry run: projected lower bound).
    pub forwarded: A,
    /// Paid directly by steps (swaps to the recipient).
    pub delivered: A,
    /// The final transfer of the fee wallet's balance above the reserve.
    pub sent: A,
}

/// One chain family. Methods take `&Settings` so families see `send`/`only` without the
/// pipeline knowing what a share or a swap is.
#[allow(async_fn_in_trait)] // single-threaded use; no Send bound needed
pub trait Family: Sized {
    type Address: Copy + PartialEq + Display;
    type Amount: Amount;
    /// A prepared native transfer (e.g. the EVM gas limit), from [`Family::prepare_transfer`].
    type Transfer;

    fn native_symbol(&self) -> &str;
    fn fmt_native(&self, v: Self::Amount) -> String;
    fn fee_wallet(&self) -> Self::Address;

    /// Checked first: `Some(reason)` means the recipient needs no top-up (e.g. its balance is above
    /// a configured floor), so the chain is done for this run with nothing swept. Not a skip: on a
    /// frequent schedule this is the normal outcome.
    async fn recipient_funded(&self, _to: Self::Address) -> Result<Option<String>> {
        Ok(None)
    }

    /// Checked before any step: `Some(reason)` skips this chain for this run without failing it
    /// (e.g. gas above the configured ceiling).
    async fn skip_reason(&self) -> Result<Option<String>> {
        Ok(None)
    }

    /// Balance the wallet must keep whatever `keep` says (Stellar account reserves); 0 on EVM.
    fn min_reserve(&self) -> Self::Amount {
        Self::Amount::default()
    }

    async fn native_balance(&self, who: Self::Address) -> Result<Self::Amount>;

    /// Step 1.
    async fn collect(&mut self, s: &Settings<Self>) -> Result<Step<Self::Amount>>;

    /// Step 2.
    async fn convert(&mut self, s: &Settings<Self>) -> Result<Step<Self::Amount>>;

    /// Plans a native transfer to `to`; returns it with the native to hold back for its fee.
    async fn prepare_transfer(&self, to: Self::Address) -> Result<(Self::Transfer, Self::Amount)>;

    /// Most native the final transfer may send, with a label for the logs; `None` = no cap. An error (e.g.
    /// the cap can't be priced) fails the chain instead of sending uncapped.
    async fn transfer_cap(&self) -> Result<Option<(Self::Amount, String)>> {
        Ok(None)
    }

    /// `Some(reason)`: `amount` is too small to be worth the transfer's own fee; it stays in the
    /// wallet for a later run.
    async fn transfer_skip_reason(&self, _plan: &Self::Transfer, _amount: Self::Amount) -> Result<Option<String>> {
        Ok(None)
    }

    async fn transfer(&mut self, plan: Self::Transfer, to: Self::Address, amount: Self::Amount) -> Result<()>;

    /// Failures of single items (one share, one token) that didn't stop the rest of the sweep.
    /// A non-empty list fails the chain after everything else ran.
    fn take_failures(&mut self) -> Vec<String> {
        Vec::new()
    }

    /// Extra state for the final log line (e.g. nonces).
    async fn summary(&self) -> Result<String>;
}

pub async fn sweep<F: Family>(f: &mut F, s: &Settings<F>) -> Result<Outcome<F::Amount>> {
    let start = f.native_balance(f.fee_wallet()).await?;
    debug!("fee wallet {} starts with {} {}", f.fee_wallet(), f.fmt_native(start), f.native_symbol());
    let collected = f.collect(s).await?;
    debug!("collect: {collected:?}");
    let converted = f.convert(s).await?;
    debug!("convert: {converted:?}");
    let steps = collected + converted;
    let sent = forward(f, s, (start + steps.gained).saturating_sub(steps.spent)).await?;
    Ok(Outcome { forwarded: steps.delivered + sent, delivered: steps.delivered, sent })
}

/// Step 4; returns the amount sent (or that would be).
async fn forward<F: Family>(f: &mut F, s: &Settings<F>, projected: F::Amount) -> Result<F::Amount> {
    let sym = f.native_symbol().to_string();
    let (from, to) = (f.fee_wallet(), s.recipient);
    if to == from {
        info!("send: recipient is the fee wallet, keeping {} {sym}", f.fmt_native(f.native_balance(from).await?));
        return Ok(F::Amount::default());
    }
    let balance = if s.send { f.native_balance(from).await? } else { projected };
    let keep = s.keep.max(f.min_reserve());
    // Nothing above keep: done, before planning the transfer (its estimate needs a funded wallet,
    // so an empty wallet with nothing to send would otherwise fail the chain).
    if balance <= keep {
        info!("send: nothing above keep (balance {} {sym}, keep {})", f.fmt_native(balance), f.fmt_native(keep));
        return Ok(F::Amount::default());
    }
    let (plan, fee_reserve) = f.prepare_transfer(to).await?;
    let mut amount = balance.saturating_sub(keep).saturating_sub(fee_reserve);
    debug!(
        "send: balance {} - keep {} - transfer reserve {} = {} {sym}{}",
        f.fmt_native(balance),
        f.fmt_native(keep),
        f.fmt_native(fee_reserve),
        f.fmt_native(amount),
        if s.send { "" } else { " (projected)" }
    );
    if let Some((cap, label)) = f.transfer_cap().await?
        && amount > cap
    {
        info!("send: capped by {label} at {} {sym}; {} {sym} stays in the fee wallet", f.fmt_native(cap), f.fmt_native(amount.saturating_sub(cap)));
        amount = cap;
    }

    if amount == F::Amount::default() {
        info!("send: nothing above keep + gas (balance {} {sym})", f.fmt_native(balance));
        return Ok(F::Amount::default());
    }
    if let Some(why) = f.transfer_skip_reason(&plan, amount).await? {
        info!("send: skipped, {why}");
        return Ok(F::Amount::default());
    }
    if !s.send {
        info!("send: >=~{} {sym} -> {to} (projected after steps 1-3 at worst-case gas; keeps {})", f.fmt_native(amount), f.fmt_native(keep));
        return Ok(amount);
    }

    info!("send: {} {sym} -> {to}", f.fmt_native(amount));
    let before = f.native_balance(to).await?;
    f.transfer(plan, to, amount).await?;
    let rose = f.native_balance(to).await?.saturating_sub(before);
    if rose < amount {
        // Informational only: the transfer itself succeeded. A busy recipient (the relayer signer
        // paying gas between the two reads) or delegated code forwarding the funds both look like
        // this; failing here would only hide the run's result.
        warn!("recipient balance rose by {rose} < sent {amount} (recipient spent in between, or its code forwarded it)");
    }
    info!("    fee wallet left with {} {sym}", f.fmt_native(f.native_balance(from).await?));
    Ok(amount)
}

/// One chain's result for the run's summary (failures are the `Err` of [`run`]).
#[derive(Debug, PartialEq)]
pub enum Report {
    Done(String),
    Skipped(String),
}

/// Runs one chain's sweep and prints its closing line.
pub async fn run<F: Family>(mut f: F, s: Settings<F>) -> Result<Report> {
    if let Some(why) = f.recipient_funded(s.recipient).await? {
        info!("done; nothing to do: {why}");
        return Ok(Report::Done(why));
    }
    if let Some(why) = f.skip_reason().await? {
        info!("skipped: {why}");
        return Ok(Report::Skipped(why));
    }
    let o = sweep(&mut f, &s).await?;
    let (amount, sym) = (f.fmt_native(o.forwarded), f.native_symbol().to_string());
    let split = format!("{} by swaps + {} by send", f.fmt_native(o.delivered), f.fmt_native(o.sent));
    info!(
        "done; {} {amount} {sym} {} ({split}); {}",
        if s.send { "sent" } else { "would send >=~" },
        if s.send { "to recipient" } else { "(dry run)" },
        f.summary().await?
    );
    let failures = f.take_failures();
    if !failures.is_empty() {
        bail!("{} step(s) failed (the rest of the sweep completed): {}", failures.len(), failures.join("; "));
    }
    Ok(Report::Done(match (s.send, o.forwarded == F::Amount::default()) {
        (_, true) => "nothing to send".into(),
        (true, false) => format!("sent {amount} {sym} ({split})"),
        (false, false) => format!("would send >=~{amount} {sym} ({split}, dry run)"),
    }))
}
