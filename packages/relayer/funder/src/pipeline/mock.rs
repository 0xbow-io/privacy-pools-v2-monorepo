//! In-memory family: tests the pipeline's ordering, projection and reserve math with no chain.

use std::collections::HashMap;

use anyhow::{Result, ensure};

use super::{Family, Outcome, Report, Settings, Step, run, sweep};

const WALLET: u8 = 1;
const ALICE: u8 = 2;

#[derive(Default)]
struct Mock {
    balances: HashMap<u8, u128>,
    /// What collect/convert would add, and their worst-case fees.
    collect: Step<u128>,
    convert: Step<u128>,
    /// Fees the real steps actually burn (<= the worst case).
    actual_fee: u128,
    transfer_reserve: u128,
    min_reserve: u128,
    skip: Option<&'static str>,
    /// Recipient balance at or above this needs no top-up.
    funded_at: Option<u128>,
    /// Transfers smaller than this are not worth their fee.
    min_transfer: u128,
    /// The transfer estimate fails (as a node's does for an unfunded sender).
    prepare_fails: bool,
    /// `Some(Ok(cap))`: transfer cap; `Some(Err(()))`: the cap can't be priced.
    cap: Option<Result<u128, ()>>,
    failures: Vec<String>,
    /// Fraction of a transfer the recipient actually keeps, in percent (a leaky 7702 recipient < 100).
    recipient_keeps_pct: u128,
    calls: Vec<String>,
}

impl Mock {
    fn new(wallet: u128) -> Self {
        Mock { balances: HashMap::from([(WALLET, wallet)]), transfer_reserve: 10, recipient_keeps_pct: 100, ..Default::default() }
    }

    fn bal(&self, who: u8) -> u128 {
        self.balances.get(&who).copied().unwrap_or_default()
    }

    fn step(&mut self, name: &str, step: Step<u128>, send: bool) -> Step<u128> {
        self.calls.push(name.into());
        if !send {
            return step;
        }
        *self.balances.entry(WALLET).or_default() += step.gained - self.actual_fee;
        *self.balances.entry(ALICE).or_default() += step.delivered;
        Step { delivered: step.delivered, ..Step::default() }
    }
}

impl Family for Mock {
    type Address = u8;
    type Amount = u128;
    type Transfer = &'static str;

    fn native_symbol(&self) -> &str {
        "MOCK"
    }
    fn fmt_native(&self, v: u128) -> String {
        v.to_string()
    }
    fn fee_wallet(&self) -> u8 {
        WALLET
    }
    fn min_reserve(&self) -> u128 {
        self.min_reserve
    }
    async fn recipient_funded(&self, to: u8) -> Result<Option<String>> {
        Ok(self.funded_at.filter(|&floor| self.bal(to) >= floor).map(|floor| format!("recipient holds {} >= {floor}", self.bal(to))))
    }
    async fn skip_reason(&self) -> Result<Option<String>> {
        Ok(self.skip.map(String::from))
    }
    async fn native_balance(&self, who: u8) -> Result<u128> {
        Ok(self.bal(who))
    }
    async fn collect(&mut self, s: &Settings<Self>) -> Result<Step<u128>> {
        Ok(self.step("collect", self.collect, s.send))
    }
    async fn convert(&mut self, s: &Settings<Self>) -> Result<Step<u128>> {
        Ok(self.step("convert", self.convert, s.send))
    }
    async fn prepare_transfer(&self, _to: u8) -> Result<(&'static str, u128)> {
        ensure!(!self.prepare_fails, "estimate failed: insufficient funds");
        Ok(("plan", self.transfer_reserve))
    }
    async fn transfer_cap(&self) -> Result<Option<(u128, String)>> {
        match self.cap {
            None => Ok(None),
            Some(Ok(c)) => Ok(Some((c, "cap".into()))),
            Some(Err(())) => anyhow::bail!("cap can't be priced"),
        }
    }
    async fn transfer_skip_reason(&self, _plan: &&'static str, amount: u128) -> Result<Option<String>> {
        Ok((amount < self.min_transfer).then(|| format!("{amount} < {}", self.min_transfer)))
    }
    async fn transfer(&mut self, plan: &'static str, to: u8, amount: u128) -> Result<()> {
        ensure!(plan == "plan");
        self.calls.push(format!("transfer {amount}"));
        *self.balances.get_mut(&WALLET).unwrap() -= amount + 1; // + a 1-unit fee
        *self.balances.entry(to).or_default() += amount * self.recipient_keeps_pct / 100;
        Ok(())
    }
    async fn summary(&self) -> Result<String> {
        Ok(String::new())
    }
    fn take_failures(&mut self) -> Vec<String> {
        std::mem::take(&mut self.failures)
    }
}

fn settings(send: bool) -> Settings<Mock> {
    Settings { recipient: ALICE, keep: 100, send, only: None }
}

fn gains(m: &mut Mock) {
    m.collect = Step { gained: 500, spent: 20, delivered: 0 };
    m.convert = Step { gained: 300, spent: 30, delivered: 0 };
    m.actual_fee = 5;
}

#[tokio::test]
async fn dry_run_projects_and_sends_nothing() {
    let mut m = Mock::new(1_000);
    gains(&mut m);
    let out = sweep(&mut m, &settings(false)).await.unwrap();
    // 1000 + 800 gained - 50 worst-case fees - 100 keep - 10 transfer reserve
    assert_eq!(out, Outcome { forwarded: 1_640, delivered: 0, sent: 1_640 });
    assert_eq!(m.calls, ["collect", "convert"]);
    assert_eq!((m.bal(WALLET), m.bal(ALICE)), (1_000, 0));
}

#[tokio::test]
async fn send_uses_live_balance_and_projection_is_a_lower_bound() {
    let mut m = Mock::new(1_000);
    gains(&mut m);
    let projected = sweep(&mut m, &settings(false)).await.unwrap().forwarded;
    m.calls.clear();
    let out = sweep(&mut m, &settings(true)).await.unwrap();
    // 1000 + 800 - 2x5 actual fees - 100 keep - 10 reserve
    assert_eq!(out.forwarded, 1_680);
    assert!(out.forwarded >= projected);
    assert_eq!(m.calls, ["collect", "convert", "transfer 1680"]);
    assert_eq!(m.bal(ALICE), 1_680);
    assert_eq!(m.bal(WALLET), 109); // keep + unspent reserve - 1 fee
}

#[tokio::test]
async fn rerun_after_sweep_is_noop() {
    let mut m = Mock::new(1_000);
    sweep(&mut m, &settings(true)).await.unwrap();
    m.calls.clear();
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap(), Outcome::default());
    assert_eq!(m.calls, ["collect", "convert"]);
}

#[tokio::test]
async fn recipient_is_wallet_keeps_everything() {
    let mut m = Mock::new(1_000);
    gains(&mut m);
    let s = Settings { recipient: WALLET, ..settings(true) };
    assert_eq!(sweep(&mut m, &s).await.unwrap(), Outcome::default());
    assert_eq!(m.calls, ["collect", "convert"]); // still converts
    assert_eq!(m.bal(WALLET), 1_790);
}

#[tokio::test]
async fn nothing_above_keep_and_reserve() {
    let mut m = Mock::new(110); // exactly keep + reserve
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap(), Outcome::default());
    let mut m = Mock::new(5); // below keep: no underflow
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap(), Outcome::default());
}

#[tokio::test]
async fn transfer_not_worth_its_fee_is_skipped() {
    // 50 above keep + reserve, but the family says a transfer needs >= 60: nothing moves.
    let mut m = Mock::new(160);
    m.min_transfer = 60;
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap(), Outcome::default());
    assert_eq!((m.bal(WALLET), m.bal(ALICE)), (160, 0));
    assert!(!m.calls.iter().any(|c| c.starts_with("transfer")), "{:?}", m.calls);
    // Dry run reports nothing to send either.
    let mut m = Mock::new(160);
    m.min_transfer = 60;
    assert_eq!(sweep(&mut m, &settings(false)).await.unwrap().sent, 0);
    // At the threshold it goes.
    let mut m = Mock::new(170);
    m.min_transfer = 60;
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap().sent, 60);
}

#[tokio::test]
async fn empty_wallet_with_nothing_to_do_is_not_a_failure() {
    // Nothing to collect or convert, 0 native, and the transfer estimate would fail: the send is
    // skipped before it is planned, so the chain is ok, not failed.
    for (bal, send) in [(0, true), (0, false), (100, true)] {
        let mut m = Mock::new(bal);
        m.prepare_fails = true;
        assert_eq!(sweep(&mut m, &settings(send)).await.unwrap(), Outcome::default(), "balance {bal} send {send}");
    }
}

#[tokio::test]
async fn transfer_cap_limits_only_the_send() {
    // 1000 - keep 100 - reserve 10 = 890 above; cap 300 sends 300, the rest stays.
    let mut m = Mock::new(1_000);
    m.cap = Some(Ok(300));
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap().sent, 300);
    assert_eq!(m.bal(ALICE), 300);
    // Swap output delivered straight to the recipient is not capped.
    let mut m = Mock::new(1_000);
    m.cap = Some(Ok(300));
    m.convert = Step { delivered: 500, ..Step::default() };
    let out = sweep(&mut m, &settings(true)).await.unwrap();
    assert_eq!((out.delivered, out.sent, out.forwarded), (500, 300, 800));
    // A cap above the amount changes nothing; dry run is capped too.
    let mut m = Mock::new(1_000);
    m.cap = Some(Ok(5_000));
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap().sent, 890);
    let mut m = Mock::new(1_000);
    m.cap = Some(Ok(300));
    assert_eq!(sweep(&mut m, &settings(false)).await.unwrap().sent, 300);
    // An unpriceable cap fails instead of sending uncapped.
    let mut m = Mock::new(1_000);
    m.cap = Some(Err(()));
    assert!(sweep(&mut m, &settings(true)).await.is_err());
    assert_eq!(m.bal(ALICE), 0);
}

#[tokio::test]
async fn family_min_reserve_beats_lower_keep() {
    let mut m = Mock::new(1_000);
    m.min_reserve = 300;
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap().forwarded, 690);
    let mut m = Mock::new(1_000);
    m.min_reserve = 50; // keep (100) is higher
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap().forwarded, 890);
}

#[tokio::test]
async fn short_recipient_delta_only_warns() {
    // The transfer succeeded; a busy recipient or forwarding code must not fail the run.
    let mut m = Mock::new(1_000);
    m.recipient_keeps_pct = 99;
    assert_eq!(sweep(&mut m, &settings(true)).await.unwrap().sent, 890);
}

#[tokio::test]
async fn item_failures_fail_the_chain_after_the_sweep() {
    let mut m = Mock::new(1_000);
    m.failures = vec!["ppUSDT: Aave withdraw reverted".into()];
    let err = format!("{:#}", run(m, settings(true)).await.unwrap_err());
    assert!(err.contains("1 step(s) failed") && err.contains("ppUSDT"), "{err}");
}

#[tokio::test]
async fn delivered_by_steps_counts_toward_the_total() {
    // convert pays 300 straight to the recipient (e.g. swap to recipient); the wallet only adds 500.
    let mut m = Mock::new(1_000);
    m.collect = Step { gained: 500, spent: 20, delivered: 0 };
    m.convert = Step { gained: 0, spent: 30, delivered: 300 };
    let dry = sweep(&mut m, &settings(false)).await.unwrap();
    // send = 1000 + 500 - 50 - 100 keep - 10 reserve = 1340; total = 300 + 1340
    assert_eq!(dry, Outcome { forwarded: 1_640, delivered: 300, sent: 1_340 });
    let real = sweep(&mut m, &settings(true)).await.unwrap();
    assert_eq!((real.delivered, real.sent), (300, 1_390)); // actual fees 0 here
    assert_eq!(m.bal(ALICE), 1_690);
    assert_eq!(real.forwarded, m.bal(ALICE));
}

#[tokio::test]
async fn run_reports_and_honours_skip() {
    let mut m = Mock::new(1_000);
    m.skip = Some("gas too high");
    assert_eq!(run(m, settings(true)).await.unwrap(), Report::Skipped("gas too high".into()));

    let m = Mock::new(1_000);
    assert_eq!(run(m, settings(true)).await.unwrap(), Report::Done("sent 890 MOCK (0 by swaps + 890 by send)".into()));
    let m = Mock::new(1_000);
    assert_eq!(run(m, settings(false)).await.unwrap(), Report::Done("would send >=~890 MOCK (0 by swaps + 890 by send, dry run)".into()));
    let m = Mock::new(50);
    assert_eq!(run(m, settings(true)).await.unwrap(), Report::Done("nothing to send".into()));
}

#[tokio::test]
async fn funded_recipient_ends_the_run_before_any_step() {
    let mut m = Mock::new(1_000);
    m.balances.insert(ALICE, 500);
    m.funded_at = Some(500);
    m.skip = Some("gas too high"); // a funded recipient is not reported as a skip
    assert_eq!(run(m, settings(true)).await.unwrap(), Report::Done("recipient holds 500 >= 500".into()));

    // Below the floor: the normal sweep.
    let mut m = Mock::new(1_000);
    m.balances.insert(ALICE, 499);
    m.funded_at = Some(500);
    assert_eq!(run(m, settings(true)).await.unwrap(), Report::Done("sent 890 MOCK (0 by swaps + 890 by send)".into()));
}

#[test]
fn only_filter() {
    assert!(settings(true).selected("ppUSDC"));
    let s = Settings { only: Some(vec!["ppUSDT".into()]), ..settings(true) };
    assert!(s.selected("ppUSDT") && !s.selected("ppUSDC"));
}
