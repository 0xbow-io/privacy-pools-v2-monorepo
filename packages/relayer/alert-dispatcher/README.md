# @privacy-pools-v2/alert-dispatcher

Standalone GCP Cloud Run service that turns relayer operational alerts into Telegram pages.

```
relayer (Winston AlertTransport) -> Pub/Sub topic relayer-alerts -> POST /pubsub/alerts (this service)
                                      -> Firestore cooldown (per dedupKey) -> Telegram Bot API
```

The relayer publishes an alert for every `turbo`-level log record, and for any record logged with
`{ alert: true }` (e.g. the swallowed dust-rescue failure, severity `warn`). This service decodes it,
suppresses repeats of the same `dedupKey` within a cooldown window, and sends the rest to Telegram.
It does **not** watch the chain — it only forwards what the relayer already logged.

Design: `docs/tech-design/relayer/alert-dispatcher.md`. Wire format: `AlertEvent` in
`packages/relayer/relayer/src/logger/alert-publisher.ts`, hand-mirrored here as `zAlertEvent`
(`src/pubsub/pubsub.schemas.ts`) and kept in sync by the shared fixture
`packages/relayer/alert-fixtures/alert-events.json`, which both packages' specs check.

## Configuration

Environment variables only (there is no config file).

| Variable                    | Required | Default                 | Notes                                                        |
| --------------------------- | -------- | ----------------------- | ------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`        | yes      | —                       | Secret Manager secret, mounted as an env var                 |
| `TELEGRAM_CHAT_ID`          | yes      | —                       | Plain env var; the chat/channel the bot posts to             |
| `ALERT_COOLDOWN_SECONDS`    | no       | `900`                   | Minimum time between two pages for the same `dedupKey`       |
| `ALERT_COOLDOWN_COLLECTION` | no       | `relayerAlertCooldowns` | Firestore collection holding one document per `dedupKey`     |
| `PORT`                      | no       | `8080`                  | Set by Cloud Run                                             |

A missing or invalid variable fails the service at boot, naming the variable (never its value).

Relayer-side variables (set on the **relayer**, not here): `RELAYER_ALERTS_PUBSUB_TOPIC` (default
`relayer-alerts`) and `RELAYER_ALERTS_DISABLED=true` (kill switch, no redeploy needed).

## Key custody

None. Unlike `dust-rescue-service`, this service holds no signer key and sends no transactions. The
only secret is the Telegram bot token (Secret Manager), which can post to one chat and nothing else.

## Route

`POST /pubsub/alerts` — standard Pub/Sub push envelope (`{ "message": { "data": "<base64 AlertEvent JSON>" } }`).

| Status | Meaning                                                                                       |
| ------ | --------------------------------------------------------------------------------------------- |
| 204    | Handled: paged, **or** suppressed by the cooldown (Pub/Sub must not retry a suppressed alert) |
| 400    | Malformed envelope, base64/JSON, or `AlertEvent` (permanently undeliverable)                  |
| 5xx    | Telegram (or Firestore) failed: the cooldown claim is rolled back and Pub/Sub redelivers       |

Auth is Cloud Run IAM (`--no-allow-unauthenticated`; the push subscription's service account holds
`roles/run.invoker`). The service trusts the relayer's redaction and does not re-scrub alert text.

### Cooldown

One Firestore document per `dedupKey` (id = SHA-256 of the key): `{ dedupKey, lastSentAt, lastSeverity,
lastMessage, occurrenceCount }`. The read-check-write runs in a transaction, so two Cloud Run instances
racing on the same key cannot both page. A failed send restores the previous `lastSentAt`, so the
redelivery is not suppressed by the failed attempt. This deliberately differs from `dust-rescue-service`'s
permanent one-shot dedup: an ongoing outage keeps paging, once per window.

## Running locally

```sh
pnpm install            # from the repo root
cd packages/relayer/alert-dispatcher
export TELEGRAM_BOT_TOKEN=<test bot token> TELEGRAM_CHAT_ID=<test chat id>
# Firestore: either `gcloud auth application-default login` against a scratch project, or the emulator:
#   export FIRESTORE_EMULATOR_HOST=localhost:8080   (use another PORT for this service then)
pnpm start:dev
```

Send an alert by hand (the payload is the `AlertEvent`, base64-encoded):

```sh
DATA=$(printf '%s' '{"severity":"turbo","message":"manual test","context":"curl","dedupKey":"curl.test","timestamp":"2026-10-16T12:00:00.000Z"}' | base64 -w0)
curl -i -X POST localhost:8080/pubsub/alerts -H 'content-type: application/json' \
  -d "{\"message\":{\"data\":\"$DATA\"}}"
```

Expected: first call -> `204` and a Telegram message; repeating it within the cooldown -> `204`, no message;
a different `dedupKey` -> a message again.

## Deploy (GCP Cloud Run)

The workflow `.github/workflows/alert-dispatcher-gcp-deploy.yml` is a `workflow_call` workflow dispatched
from the external ops repo (like `dust-rescue-service-gcp-deploy.yml`); it is intentionally not wired into
`relayer-prod-deploy.yml`. It needs one secret beyond the sibling's: `TELEGRAM_CHAT_ID`.

### Step 1 — create the topic and the bot token secret

```sh
gcloud pubsub topics create relayer-alerts
gcloud secrets create TELEGRAM_BOT_TOKEN --data-file=/path/to/bot-token.txt
```

### Step 2 — grant the runtime service account access

```sh
gcloud secrets add-iam-policy-binding TELEGRAM_BOT_TOKEN \
  --member="serviceAccount:<alert-dispatcher-runtime-sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Firestore access for the cooldown collection (lookups are by document id: no composite index needed).
gcloud projects add-iam-policy-binding <project> \
  --member="serviceAccount:<alert-dispatcher-runtime-sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/datastore.user"
```

### Step 3 — first deploy

Run the deploy workflow from the ops repo. Equivalent manual command:

```sh
gcloud run deploy alert-dispatcher --image=<image> --region=<region> --no-allow-unauthenticated \
  --set-secrets=TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest \
  --update-env-vars=TELEGRAM_CHAT_ID=<chat-id>
```

### Step 4 — wire the trigger and the relayer

```sh
gcloud pubsub subscriptions create relayer-alerts-push \
  --topic=relayer-alerts \
  --push-endpoint="https://<alert-dispatcher-url>/pubsub/alerts" \
  --push-auth-service-account="<pubsub-invoker-sa>@<project>.iam.gserviceaccount.com"
  # recommended: --dead-letter-topic=<dlq-topic> --max-delivery-attempts=10
  # (malformed messages return 400 forever otherwise)

gcloud run services add-iam-policy-binding alert-dispatcher \
  --member="serviceAccount:<pubsub-invoker-sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

# The RELAYER's runtime SA needs publish rights on the topic — easy to miss.
gcloud pubsub topics add-iam-policy-binding relayer-alerts \
  --member="serviceAccount:<relayer-runtime-sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

If Telegram delivery itself misbehaves, set `RELAYER_ALERTS_DISABLED=true` on the relayer — logging at
`turbo`/`error` continues either way.

## Testing

```sh
pnpm --filter @privacy-pools-v2/alert-dispatcher test
pnpm --filter @privacy-pools-v2/alert-dispatcher lint
pnpm --filter @privacy-pools-v2/alert-dispatcher build
```

Specs use `jest-mock-extended` fakes for the cooldown store and channel, a stateful fake of the Firestore
transaction API, and a stubbed global `fetch` for Telegram. Nothing needs GCP or network access.
