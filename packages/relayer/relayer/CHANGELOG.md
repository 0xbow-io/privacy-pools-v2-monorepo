# Changelog

All notable changes to `@privacy-pools-v2/relayer` are documented in this file.

## 1.0.1 — 2026-10-20

- Version bump only; no changes.

## 1.0.0 — 2026-10-19

Initial release.

- NestJS relayer that quotes and relays Privacy Pools V2 transactions for EVM and Stellar chains (`/v1/quote`, `/v1/relay` and `/v1/details` routes).
- Publishes operational alerts to the `relayer-alerts` Pub/Sub topic: `turbo`-level log records and records marked `alert: true`, including a heartbeat on every boot. `@privacy-pools-v2/alert-dispatcher` delivers them to Telegram. `RELAYER_ALERTS_DISABLED=true` turns publishing off.
- Pages operators when the signer's balance drops below `LOW_BALANCE_ALERT_WEI_EVM_<id>` after a broadcast. The `funder` job (`packages/relayer/funder`) sweeps the fee-receiver wallet into native gas and refills the signer.
- The package version was already `1.0.0` before this release; the `/v1/details` endpoints report it.
