# Alert Dispatcher

Operator alerting for the relayer: `turbo`-level faults (and explicitly marked degraded-but-up
conditions) are published to Pub/Sub and delivered to Telegram by a standalone Cloud Run
service. See [dust-rescue-service.md](dust-rescue-service.md) for the sibling service whose
patterns this one reuses, and `packages/relayer/CLAUDE.md` §4 / §4b for the logging
conventions that feed it.

## Overview

The relayer already logs its worst faults at `turbo` (GCP `CRITICAL`), but a log line nobody is
watching pages nobody. `alert-dispatcher` (`packages/relayer/alert-dispatcher`) turns those
records into a Telegram message to the on-call chat, with per-fault rate limiting so an ongoing
outage does not produce a message storm.

**What it is NOT.** It does not watch the chain. There is no on-chain event subscription, no
balance polling, no RPC access and no signer key. It only forwards what the relayer already
decided to log. Anything the relayer does not log as `turbo` (or mark with `alert: true`) cannot
page. Email is not built in v1 (the channel seam exists, see "Telegram delivery and the channel
seam"). This boundary still holds for the on-demand reports feature
([relayer-reports.md](relayer-reports.md)): that feature's dispatcher-side piece
(`ReportsController`, `POST /pubsub/reports`) only formats and sends already-gathered text — all
chain access lives on the relayer, and the dispatcher's ingress gains no new public route at all.

```mermaid
sequenceDiagram
    participant Code as Relayer code / boot validators
    participant Log as FATLogger (Winston)
    participant Tr as AlertTransport
    participant Topic as Pub/Sub: relayer-alerts
    participant Svc as alert-dispatcher (Cloud Run)
    participant FS as Firestore (cooldowns)
    participant TG as Telegram Bot API

    Code->>Log: logger.turbo(...) / logger.error(..., { alert: true, dedupKey })
    Log->>Tr: record
    Tr->>Tr: classify (turbo -> "turbo"; alert:true -> "warn"), redact
    Tr-->>Topic: publishAlert() (fire-and-forget)
    Topic->>Svc: POST /pubsub/alerts (push)
    Svc->>FS: transaction: claim cooldown for sha256(dedupKey)
    alt inside cooldown window
        Svc-->>Topic: 204 (suppressed)
    else claimed
        Svc->>TG: sendMessage
        alt delivered
            Svc-->>Topic: 204
        else Telegram failed
            Svc->>FS: release claim
            Svc-->>Topic: 5xx (Pub/Sub redelivers)
        end
    end
```

## Package Layout

```
packages/relayer/alert-dispatcher/
  src/main.ts                         Nest bootstrap (PORT, default 8080)
  src/app.module.ts                   wires config, cooldown store, CHANNELS array
  src/pubsub/pubsub.controller.ts     POST /pubsub/alerts
  src/pubsub/reports.controller.ts    POST /pubsub/reports (relayer-reports.md)
  src/pubsub/pubsub.schemas.ts        zAlertEvent, zReportEvent, zPubSubPushEnvelope
  src/cooldown/                       IAlertCooldownStore + FirestoreAlertCooldownStore
  src/channel/                        IAlertChannel + TelegramChannel
  src/config/                         env-var-only config (zod-validated at boot)
  Dockerfile, README.md
packages/relayer/alert-fixtures/alert-events.json     shared wire-format fixture
packages/relayer/relayer/src/logger/alert-publisher.ts   publishAlert / flushAlerts / AlertEvent
packages/relayer/relayer/src/logger/alert-transport.ts   Winston AlertTransport
```

The dispatcher has no workspace dependencies (it does not import the relayer, SDKs or contracts),
so its CI steps and Docker build need none of the heavy packages. The root `package.json` script
`build:relayer-deps` builds the relayer's TypeScript dependency chain while skipping circuits and
contracts; it is a build convenience, unrelated to runtime behaviour.

## Alert Event Schema

The wire format is `AlertEvent` (relayer, `alert-publisher.ts`), mirrored by hand as `zAlertEvent`
in the dispatcher (`pubsub.schemas.ts`):

| Field | Type | Notes |
| --- | --- | --- |
| `severity` | `"turbo"` \| `"warn"` | `turbo` = operator-page class; `warn` = degraded but not down |
| `message` | string | redacted, truncated to 1000 chars by the publisher |
| `context` | string | emitting class/module (FATLogger `context`), `"unknown"` if absent |
| `dedupKey` | string, min 1 | stable per fault class; truncated to 200 chars by the publisher |
| `timestamp` | ISO 8601 string | stamped at publish time |
| `requestId` | string, optional | |
| `meta` | record, optional | redacted, depth-limited (4), bigint stringified |

The Pub/Sub message `data` is the JSON of this object (base64 in the push envelope).

**Drift guard.** The two packages share no dependency, so the schema is duplicated. The only
protection is a shared fixture, `packages/relayer/alert-fixtures/alert-events.json`, checked by
the relayer's `alert-publisher.spec.ts` (events built by the publisher match it) and the
dispatcher's `pubsub.schemas.spec.ts` (every fixture parses with `zAlertEvent`). Changing the
wire format means changing the fixture, which forces both sides' tests to be updated together.

## Relayer-Side Changes

All in `packages/relayer/relayer/src/`; `FATLogger` / `FATLoggerService` method signatures are
unchanged.

**AlertTransport (`logger/alert-transport.ts`)**, registered in `winstonConfig.transports`
(`logger/fat.logger.ts`) so every logger instance is covered without call-site changes. Rule:

1. record level `turbo` -> severity `turbo`;
2. else any record whose meta has `alert: true` -> severity `warn`;
3. else ignored. `error`/`warn` volume is too high to alert on by level alone, so non-turbo
   alerts are strictly opt-in.

`dedupKey` is taken from the record's meta, falling back to the `context`. The marker keys
`alert` and `dedupKey` are consumed by the transport and stripped from Console output
(`stripAlertMarkers` format). Publishing is fire-and-forget: a slow or failing Pub/Sub never
blocks logging. The base class is `winston.Transport` at runtime although winston's typings only
declare `winston.transport`; the code casts accordingly (extending the lowercase name evaluates
to `undefined` and throws at load).

**Implicit path.** A `turbo` log pages without anything at the call site saying so. This is a
known trade-off, documented in `packages/relayer/CLAUDE.md` §4b.

**Dust-rescue call site.** The swallowed-failure `logger.error` in
`relay/evm/evm.relay.service.ts` (see [dust-rescue-service.md](dust-rescue-service.md), "Failure
handling") now carries `{ alert: true, dedupKey: "dustRescue.<chainId>" }`. It is deliberately
not `turbo`: the relayer keeps operating. Response and `dustRescueWarning` behaviour are
unchanged.

**Low-balance call site.** After every broadcast, `EVMChainService.broadcast()`
(`chain.service/evm.chain.service.ts`) fires a never-awaited `checkSignerBalance()` next to
`recordBroadcastLog`: it reads the signer's native balance and, if below
`LOW_BALANCE_ALERT_WEI_EVM_<id>`, logs `logger.warn("RELAYER WALLET LOW on chain ...", { alert:
true, dedupKey: "relayer.lowBalance.<chainId>", chainId, signer, balanceWei, thresholdWei })`
(severity `warn`). The threshold is per chain only (no global fallback; unset = no check) and in
native wei, not USD: USD pricing in the relayer needs Curve/CowSwap API calls, too heavy per relay.
The reading can be up to one tx's gas high (gas leaves the balance only once mined). A failed
balance read logs a plain, non-alert `warn`; the check never throws or delays the relay. Refilling
the signer is the funder job's concern (`packages/relayer/funder`), not this alert's.

**Quote operator-fault call sites.** Operator-side quote failures page at severity `warn`, not
`turbo`, so the quote keeps answering. Each call site passes `{ alert: true, dedupKey }`:
- `QuoteDeadlineInterceptor` (`quote/quote-deadline.interceptor.ts`): the 503 "Quote deadline
  exceeded" path (upstream RPC unresponsive) uses `dedupKey` `quote.deadline.<chainType>.<chainId>`,
  built from the route params, never from free text. The chain id is normalized with `Number()`, as
  routing does, so `8453`, `08453` and `0x2105` share one cooldown key.
- `RateProviderService.quote` (`rate_provider/rate_provider.service.ts`): when a rate provider fails
  to quote (CowSwap outage or rate limit, Curve oracle fault, unpriced asset), the `BadRequest` is
  preceded by `{ alert: true, dedupKey: "quote.rateProvider.<provider>.<chainId>" }`. Keyed per
  provider and chain, never per token or message.
- `calculateFlatFee` / `calculateBpsFee` / `calculateExactBpsFee` (`quote/evm/fee.calculations.ts`)
  take a `FeeAlertContext` (logger + chainId). The "Asset not relayable" throw (maxRelayFee below
  relay cost) logs `quote.notRelayable.<chainId>` before the `BadRequest`.
- `EvmQuoteService` (`quote/evm/evm.quote.service.ts`), before the `BadRequest` throw, for three
  operator-config faults: `quote.underlyingMisconfigured.<chainId>` (quoter `Underlying` with no
  underlying configured, or an underlying that is itself a share token), `quote.previewRedeemZero.<chainId>`
  (`previewRedeem(1 share)` returned 0), and `quote.nativeAssetMissing.<chainId>` (no native asset
  configured).

Client-input 4xx errors (amount too small, fee over `maxRelayFee`, recipient missing) deliberately
do not page. They are the caller's fault, not the operator's.

**Publisher (`logger/alert-publisher.ts`).** A plain module, not a Nest provider (it runs with
no DI container, e.g. in boot validators). Topic from `RELAYER_ALERTS_PUBSUB_TOPIC`, default
`relayer-alerts`. All errors are swallowed and reported with plain `console.error`, never through
Winston, which would re-enter the transport and loop if Pub/Sub itself is failing.

**Redaction.** Message and meta pass through the same redaction used for logs and HTTP errors
(`errors/redact.ts`: `redactText`, `clientSafeErrorMessage`) before leaving the process. The
dispatcher trusts this and does not re-scrub.

**Kill switches.** `NODE_ENV=test` and `RELAYER_ALERTS_DISABLED=true` make `publishAlert` a no-op
(the latter needs no redeploy-of-code, only an env change). Logging itself is unaffected.

**Boot-time flush (`main.ts`).** Boot validators log `turbo` and then throw. `bootstrap()`'s
rejection handler rethrows inside an async `.catch`, which becomes an unhandled rejection that
terminates the process, so a fire-and-forget publish would be killed before reaching Pub/Sub,
losing exactly the boot-time alerts that matter most. The handler therefore does
`await flushAlerts()` (bounded, default 3000 ms, never rejects) before rethrowing.

## HTTP Route Contract

`POST /pubsub/alerts` with the standard Pub/Sub push envelope
`{ "message": { "data": "<base64 AlertEvent JSON>" } }`. Auth is Cloud Run IAM only
(`--no-allow-unauthenticated`; the push subscription's service account holds `roles/run.invoker`),
no app-level JWT check, same as dust-rescue-service.

| Status | Meaning |
| --- | --- |
| 204 | Handled: paged, or suppressed by the cooldown. A suppressed message must not be retried. |
| 400 | Malformed envelope, bad base64/JSON, or invalid `AlertEvent`. Permanently undeliverable. |
| 5xx | A channel failed. The cooldown claim is rolled back and Pub/Sub redelivers. |

A sibling route, `POST /pubsub/reports`, delivers on-demand report results (the reverse direction,
triggered by a Telegram command on the relayer rather than a relayer log line) — same envelope
handling, no cooldown involved. See [relayer-reports.md](relayer-reports.md).

## Cooldown Design

One Firestore document per `dedupKey` in collection `relayerAlertCooldowns` (configurable), id =
`sha256(dedupKey)` (keys are free-form and Firestore ids cannot contain `/`). Fields: `dedupKey`,
`lastSentAt` (epoch ms), `lastSeverity`, `lastMessage`, `occurrenceCount`.

`tryAcquire` runs in a Firestore transaction: if a document exists and `now - lastSentAt` is
inside the window (default 900 s), it increments `occurrenceCount` and returns no claim
(suppressed); otherwise it writes a new `lastSentAt` and returns a claim. The transaction makes
two Cloud Run instances racing on the same key unable to both page. If sending fails, `release`
restores the previous `lastSentAt` only if the stored value still equals this attempt's claim, so
the redelivery is not suppressed by the failed attempt and a newer claim is not clobbered. With
several channels a redelivery re-sends to those that already succeeded (accepted for paging).
Lookups are by document id, so no composite index is required.

**Divergence from the sibling.** dust-rescue-service dedups permanently and one-shot: its job
store treats a redelivered message for an existing job as a no-op, because a job is a unique unit
of work. Alerts are different: an ongoing outage should keep paging, once per window, and a
fault that recurs next week must page again. The windowed, time-based cooldown is therefore an
intentional difference, not an oversight.

## Telegram Delivery and the Channel Seam

`TelegramChannel` calls the Bot API `sendMessage` via global `fetch` (no extra dependency), HTML
parse mode, 10 s timeout, previews disabled. Content: severity prefix (CRITICAL / WARN), context,
escaped message, then `dedupKey`, timestamp and request id. Text is HTML-escaped (`& < >`) and, if
over Telegram's 4096-char limit, the free-text message is shortened (never cut mid-tag). Errors
include only the HTTP status and Telegram's `description`, never the request URL, which contains
the bot token.

`IAlertChannel` (`send(event)`, must throw on failure) is the seam for further channels. `app.module.ts`
provides a `CHANNELS` array containing only Telegram in v1; adding email means implementing the
interface and adding it to that array behind its own enable flag. The route, cooldown and event
schema do not change.

`TelegramChannel.send()`'s Bot API call is factored into a private `sendText(text)`; `sendReport()`
(used by `ReportsController`, [relayer-reports.md](relayer-reports.md)) calls the same `sendText`
with `formatReport()`'s output instead of `formatAlert()`'s — same HTML-escape-and-truncate shape,
a status prefix instead of a severity badge, no cooldown involved.

## Language Decision Record

Rust was considered for the dispatcher and rejected. The service is a thin HTTP handler plus two
network calls; the deciding factor was reusing the proven `dust-rescue-service` patterns (NestJS,
zod, Pub/Sub push handling, Firestore, Dockerfile and deploy workflow, CI wiring) and keeping one
toolchain for the relayer package. TypeScript/NestJS was approved.

## Configuration

Environment variables only; validated at boot, errors name the variable and never its value.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | - | Secret Manager secret mounted as env var |
| `TELEGRAM_CHAT_ID` | yes | - | plain env var |
| `ALERT_COOLDOWN_SECONDS` | no | `900` | non-negative integer |
| `ALERT_COOLDOWN_COLLECTION` | no | `relayerAlertCooldowns` | |
| `PORT` | no | `8080` | set by Cloud Run |

Relayer-side (set on the relayer): `RELAYER_ALERTS_PUBSUB_TOPIC` (default `relayer-alerts`),
`RELAYER_ALERTS_DISABLED` (`true` disables publishing), `LOW_BALANCE_ALERT_WEI_EVM_<id>`
(per-chain signer low-balance threshold in wei; unset = no check).

## Deploy and Infrastructure

- Pub/Sub topic `relayer-alerts` and a push subscription to `https://<dispatcher>/pubsub/alerts`
  with a push-auth service account.
- That service account needs `roles/run.invoker` on the dispatcher service.
- Dispatcher runtime service account: `roles/datastore.user` (cooldown collection) and
  `roles/secretmanager.secretAccessor` on the `TELEGRAM_BOT_TOKEN` secret.
- Relayer runtime service account: `roles/pubsub.publisher` on the topic (easy to miss).
- Optional dead-letter topic on the push subscription for poison (400) messages; not configured by
  default.
- Workflow `.github/workflows/alert-dispatcher-gcp-deploy.yml` (`workflow_call`; takes the usual
  GCP secrets plus `TELEGRAM_CHAT_ID`; mounts the bot token via `--set-secrets`, deploys with
  `--no-allow-unauthenticated`). It is not yet wired into `relayer-prod-deploy.yml`.
  `relayer-ci.yml` lints, builds and tests the package.

**Cost.** No GCP product beyond those dust-rescue-service already uses (Cloud Run, Pub/Sub,
Firestore, Secret Manager). Alert volume is expected to be free-tier scale; this is an
expectation, not a measurement.

## Status and Known Gaps

- Never deployed or verified live yet; all behaviour above is from code and unit tests.
- Email channel not built.
- Cooldown window (900 s) is untuned against real on-call experience.
- Event schema is hand-mirrored; guarded only by the shared fixture test.
- Alerting path is implicit via the transport (a `turbo` log pages without a call-site marker).
- Quote alerts cover only the EVM paths listed above. Not covered: all Stellar quote-service
  `BadRequest` throws. Those stay log-only (or silent) until added.
- Poison messages (400) are not dead-lettered unless the subscription is configured to do so.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.5.1 | 2026-10-23 - Deadline alert key normalizes the route chain id with `Number()` (as routing does), so equivalent spellings share one cooldown key. |
| 1.5.0 | 2026-10-23 - Rate-provider quote failures (`quote.rateProvider.<provider>.<chainId>`) now page at `warn`, so CowSwap outages and rate limits are visible to operators. |
| 1.4.0 | 2026-10-23 - `capFee` "Asset not relayable" (`quote.notRelayable.<chainId>`) now pages at `warn`: the fee helpers in `quote/evm/fee.calculations.ts` take a `FeeAlertContext` (logger + chainId). Stellar throws still do not page. |
| 1.3.0 | 2026-10-23 - Quote operator-fault call sites: `QuoteDeadlineInterceptor` 503 path (`quote.deadline.<chainType>.<chainId>`) and three `EvmQuoteService` config faults (`quote.underlyingMisconfigured`, `quote.previewRedeemZero`, `quote.nativeAssetMissing`) page at `warn`; client-input 4xx and `capFee` / Stellar throws do not. |
| 1.2.0 | 2026-10-22 - On-demand reports (reverse direction): `ReportsController` (`POST /pubsub/reports`), `zReportEvent`, `TelegramChannel.sendReport()`/`formatReport()`. Full design in [relayer-reports.md](relayer-reports.md); this service's own ingress and threat model are unchanged. |
| 1.1.0 | 2026-10-18 - Low-balance call site: `EVMChainService.broadcast()` fire-and-forget `checkSignerBalance()` pages (`warn`, `dedupKey` `relayer.lowBalance.<chainId>`) when the signer's native balance is below `LOW_BALANCE_ALERT_WEI_EVM_<id>` (per chain only, wei, unset = off). |
| 1.0.0 | 2026-10-16 - Initial design and implementation: relayer AlertTransport + publisher, `alert-dispatcher` Cloud Run service (Pub/Sub push, Firestore cooldown, Telegram channel), shared wire-format fixture, deploy workflow. |
