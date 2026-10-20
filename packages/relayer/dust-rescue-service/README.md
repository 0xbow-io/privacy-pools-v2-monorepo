# @privacy-pools-v2/dust-rescue-service

Detects, proves, and submits cross-chain reshield's stealth "dust rescue" deposits. See
`docs/tech-design/relayer/dust-rescue-service.md` for the full design (architecture, job
state machine, key custody) — this doc is operational: how to configure, run, and deploy it.

## Configuration

Reads a JSON config file. By default it looks for `dust-rescue-service.config.json` in
the package root. Override with `CONFIG_PATH`:

```
CONFIG_PATH=/path/to/dust-rescue-service.config.json pnpm start
```

See `dust-rescue-service.config.example.json` for a filled-in template. **This example
file is baked into the deployed image as the default config** (`Dockerfile`'s last `COPY`)
— it's fine as the local-dev default, but it must never carry real values: it's checked
into git, and real `rpcUrl`s from providers like Alchemy embed an API key in the URL. On
Cloud Run, the real config overrides it entirely via a mounted Secret Manager secret — see
Deploy below.

### Config format

```json
{
    "chains": [
        {
            "chainId": 42161,
            "rpcUrl": "https://arb1.arbitrum.io/rpc",
            "aspUrl": "https://asp.example.com",
            "circuitArtifactsDir": "/app/circuit-artifacts",
            "minWorthUsdMicros": "2000000"
        }
    ],
    "pubsubTopic": "dust-rescue.pending",
    "firestoreCollection": "dustRescueJobs",
    "sweepMaxAttempts": 5
}
```

### Field reference

| Field | Required | Description |
|---|---|---|
| `chains[].chainId` | yes | Destination chain this service can rescue into. |
| `chains[].rpcUrl` | yes | JSON-RPC endpoint for that chain. |
| `chains[].aspUrl` | yes | ASP endpoint `dust-rescue-prover` needs for compliance ciphertext. |
| `chains[].circuitArtifactsDir` | yes | Filesystem path to the deposit circuit's artifacts. Baked into the deployed image (see Deploy below) — must match wherever `Dockerfile` `COPY`s them to. |
| `chains[].deployment` | no | Explicit `{poolAddress, entrypointAddress, keystoreAddress, aspRegistryAddress}` override. Omit to fall back to `@privacy-pools-v2/evm-sdk`'s `DEPLOYMENTS[chainId]`. |
| `chains[].minWorthUsdMicros` | yes | Worth-it floor in micro-USD (1e-6 USD) — chain-level, not per-token. Below this, a job terminates at `BELOW_THRESHOLD` instead of proving/submitting. Static, manually refreshed. **Set to a flat `2000000` ($2) on every chain as a deliberate v1 placeholder** (decided 2026-08-18) — real per-chain/per-asset numbers from `packages/swaps/scripts/dust-rescue-cost-matrix.ts` are deferred until after a first successful deploy, so the service can be demonstrated working before the threshold gets tuned. |
| `pubsubTopic` | no | Defaults to `"dust-rescue.pending"`. Must match the topic the relayer's `DustRescueOrchestratorService` publishes to (its own `DUST_RESCUE_PUBSUB_TOPIC` env var). |
| `firestoreCollection` | no | Defaults to `"dustRescueJobs"`. |
| `sweepMaxAttempts` | no | Defaults to `5`. Bounded retries per job before it's marked `FAILED`. |
| `sweepBatchSize` | no | Defaults to `30`. Caps how many non-terminal jobs one `/sweep` pass examines, oldest-`updatedAt`-first — a timed-out pass now drops the *newest*-touched jobs, not always the same ones (finding #10, Problem A). Requires the Firestore composite index below. |
| `notFoundAgeOutHours` | no | Defaults to `6`. How long a leg may sit at genuine LiFi `NOT_FOUND` (indexing lag) before the job gives up and retires `FAILED` (finding #10, Problem C) — hours, not minutes, so normal indexing delay is never mistaken for a dead transfer. Does not apply to LiFi's `INVALID`, which is terminal immediately. |

Note: the *rescue recipient's* address isn't this service's own config — worth-it pricing
and detection don't read it. It's still needed as the relayer's own
`dust_rescue_recipient_address` config (the address a caller passes as `dustRecipient` on
opt-in, and where issue #222's dust #1 forwarding also targets) — since the key-custody
unification below, it's simply this service's own signer address, printed by
`derive-keys.ts`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DUST_RESCUE_SIGNER_PRIVATE_KEY` | **yes** | This service's signer private key (see Key custody below). Never put this in the config file. Missing it is a startup-time fatal error. |
| `CONFIG_PATH` | no | Overrides the default config file path. |
| `PORT` | no | HTTP port. Defaults to `8080` (Cloud Run's convention). |
| `LIFI_API_KEY` | no | LiFi API key for authenticated (higher rate limit) status polling. Public rate limits apply without it. |

Firestore and Pub/Sub clients use ambient GCP credentials (the Cloud Run service's default
service account in production; `gcloud auth application-default login` / a service-account
key via `GOOGLE_APPLICATION_CREDENTIALS` for local runs against a real project). No
explicit project ID or key file is configured in this package.

## Key custody

**One signer, not two** (unified 2026-08-18, issue #222 — see the tech-design doc's Key
custody section for why an earlier two-key split turned out unworkable). Derived once via
`scripts/derive-keys.ts` (not part of the deployed image — run manually, offline):

```
pnpm --filter @privacy-pools-v2/dust-rescue-service exec tsx scripts/derive-keys.ts <0x-prefixed-hex-seed>
```

Prints:
- **Address** → the relayer's `dust_rescue_recipient_address` config per destination
  chain (public) — this is where both dust sources land (destination-chain leftover
  directly, source-chain dust via the relayer's forwarding swap) and what signs the
  eventual deposit.
- **Private key** → this service's `DUST_RESCUE_SIGNER_PRIVATE_KEY`, Secret Manager only
  — never commit it, never log it.

The seed used to derive it is never needed again after this — store it in Secret Manager
with access restricted to whoever needs to derive a replacement later, not to either
running service.

## Running locally

```
pnpm build
DUST_RESCUE_SIGNER_PRIVATE_KEY=0x... CONFIG_PATH=./dust-rescue-service.config.json pnpm start
```

or `pnpm start:dev` for watch mode. Requires a real (or emulated) Firestore project and
Pub/Sub topic to do anything useful — there's no in-memory/offline mode.

To exercise the two routes directly without waiting for Pub/Sub or Cloud Scheduler:

```
curl -X POST localhost:8080/sweep
curl -X POST localhost:8080/pubsub/pending -H 'content-type: application/json' \
  -d '{"message":{"data":"<base64-encoded-json-job>"}}'
```

## Deploy (GCP Cloud Run)

`Dockerfile` builds `sdk` → `dust-rescue-prover` → this package, bakes circuit artifacts
in at `circuitArtifactsDir`, and is deployed `--no-allow-unauthenticated` via the root
`.github/workflows/dust-rescue-service-gcp-deploy.yml` reusable workflow (same shape as
`relayer-gcp-deploy.yml`). Neither HTTP route checks a token itself — auth is entirely
Cloud Run's IAM invoker check, wired in Step 4.

**Two blockers, not yet cleared (2026-08-18), independent of each other:** no real ASP HTTP
endpoint exists for the it-002 stack yet (`chains[].aspUrl` is required — `dust-rescue-prover`
calls it for compliance ciphertext on every proof), and the CI workflow needs a
`workflow_dispatch` wrapper added in `fatlabsxyz/pp-relayer-v2` before Step 2 can even run.
**Never actually deployed as of 2026-08-18** — the steps below are the documented
procedure, not a verified one.

### Step 1 — create both secrets

The CI deploy step references these by name; if either is missing, the first
`gcloud run deploy` fails outright.

```sh
# This service's signer key — see Key custody above
gcloud secrets create DUST_RESCUE_SIGNER_PRIVATE_KEY --data-file=/path/to/signer.key

# Real per-environment config — same shape as dust-rescue-service.config.example.json,
# with real rpcUrl/aspUrl/minWorthUsdMicros. Never commit this file.
gcloud secrets create DUST_RESCUE_CONFIG --data-file=/path/to/real-dust-rescue-service.config.json
```

### Step 2 — grant the runtime service account access

The **runtime** SA (what the container itself runs as — `--service-account` on `gcloud run
deploy`, or the project default compute SA; **not** the WIF identity GitHub Actions
deploys with) needs `secretmanager.secretAccessor` on both secrets. Find it once the
service exists via `gcloud run services describe dust-rescue-service --region=<region>
--format='value(spec.template.spec.serviceAccountName)'`:

```sh
gcloud secrets add-iam-policy-binding DUST_RESCUE_SIGNER_PRIVATE_KEY \
  --member="serviceAccount:<runtime-sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding DUST_RESCUE_CONFIG \
  --member="serviceAccount:<runtime-sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

Skip this if the runtime SA already has `secretmanager.secretAccessor` project-wide.

### Step 2b — create the sweep's Firestore composite index

`SweepService.run()` queries `where("state", "in", NON_TERMINAL_STATES).orderBy("updatedAt", "asc")`
(finding #10, Problem A) — Firestore requires a composite index for an `in` filter
combined with `.orderBy()` on a different field, and there's none by default. Without it,
the **first** `/sweep` call after deploy throws `FAILED_PRECONDITION`, not something caught
by tests. This repo has no Firebase CLI project (no `firebase.json`), so create it directly
against the Firestore database instead of via `firestore.indexes.json`:

```sh
gcloud firestore indexes composite create \
  --collection-group=dustRescueJobs \
  --field-config field-path=state,order=ascending \
  --field-config field-path=updatedAt,order=ascending
```

Use the configured `firestoreCollection` value instead of `dustRescueJobs` if it's been
changed from the default. Composite indexes take a few minutes to build after creation —
do this before Step 3's first deploy, not after the first `/sweep` call fails.

### Step 3 — first deploy

Dispatch the ops-repo workflow (or run `gcloud run deploy` from
`dust-rescue-service-gcp-deploy.yml` directly). It mounts `DUST_RESCUE_SIGNER_PRIVATE_KEY`
as an env var and `DUST_RESCUE_CONFIG` as a file at
`/secrets/dust-rescue-service.config.json`, with `CONFIG_PATH` pointed at it — overriding
the placeholder example baked into the image. Note the resulting Cloud Run URL; Step 4
needs it.

### Step 4 — wire the triggers

```sh
# Topic the relayer publishes pending jobs to, and the push subscription that wakes this service
gcloud pubsub topics create dust-rescue.pending
gcloud pubsub subscriptions create dust-rescue-pending-push \
  --topic=dust-rescue.pending \
  --push-endpoint="https://<dust-rescue-service-url>/pubsub/pending" \
  --push-auth-service-account="<pubsub-invoker-sa>@<project>.iam.gserviceaccount.com"

# Cloud Scheduler drives the state-machine sweep — 5 min is the current default
gcloud scheduler jobs create http dust-rescue-sweep \
  --schedule="*/5 * * * *" \
  --uri="https://<dust-rescue-service-url>/sweep" \
  --http-method=POST \
  --oidc-service-account-email="<scheduler-invoker-sa>@<project>.iam.gserviceaccount.com"

# Grant both callers permission to invoke the (unauthenticated-disabled) service
gcloud run services add-iam-policy-binding dust-rescue-service \
  --member="serviceAccount:<pubsub-invoker-sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
gcloud run services add-iam-policy-binding dust-rescue-service \
  --member="serviceAccount:<scheduler-invoker-sa>@<project>.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

Still open beyond the two blockers above: real, cost-matrix-computed `minWorthUsdMicros`
per chain/asset (ships as a flat $2 placeholder today, see the field reference above) and
reference-stablecoin coverage beyond Arbitrum/Base if a third destination chain is ever
added. See the tech-design doc's "Status / known gaps".

## Updating configuration after deploy

None of this touches the container image, CI, or `gcloud run deploy` — it's a secret edit
plus a restart, both doable straight from the `gcloud` CLI (or the Cloud Console) in
seconds. Cheap enough to use for iterating on test values like `minWorthUsdMicros`.

`DustRescueConfigService` reads `CONFIG_PATH` and `DUST_RESCUE_SIGNER_PRIVATE_KEY` exactly
**once, in its constructor** (`src/config/dust-rescue-config.service.ts`) — there is no
file-watching or live reload. Combined with Cloud Run scale-to-zero, this means a config or
key change only takes effect for *new* container instances. A warm instance keeps serving
requests against the config it started with, potentially for a long time if traffic keeps
it alive. **Always force a restart after updating a secret** — don't assume the next cold
start will happen soon enough on its own:

```sh
gcloud run services update dust-rescue-service --region=<region>
```

This does **not** rebuild or repush the image — it's the same already-built revision's
image, redeployed as a fresh revision purely to restart every instance, which re-pulls
`:latest` on both mounted secrets in the process. No CI run required.

**Changing chain config (`rpcUrl`, `aspUrl`, `minWorthUsdMicros`, `circuitArtifactsDir`,
`deployment` override) or adding/removing a chain:**

```sh
gcloud secrets versions add DUST_RESCUE_CONFIG --data-file=/path/to/updated-config.json
gcloud run services update dust-rescue-service --region=<region>
```

**Temporarily lowering `minWorthUsdMicros` for testing:** same two commands, always paired
with the reinstate step so a test value never lingers in production.

```sh
gcloud secrets versions access latest --secret=DUST_RESCUE_CONFIG > /tmp/prod-config.json  # back up first
gcloud secrets versions add DUST_RESCUE_CONFIG --data-file=/path/to/lowered-threshold-config.json
gcloud run services update dust-rescue-service --region=<region>

# ...test...

gcloud secrets versions add DUST_RESCUE_CONFIG --data-file=/tmp/prod-config.json  # reinstate
gcloud run services update dust-rescue-service --region=<region>
```

Adding a *new* destination chain is a cross-package change, not just this file: the
relayer needs a matching `dust_rescue_recipient_address` (this service's own signer
address, per chain — see Key custody above) and a `REFERENCE_STABLECOIN_BY_CHAIN_ID` entry
(re-verified on-chain, not copy-pasted — see `reference_stablecoin.ts`), and the relayer's
own config needs the chain listed as a valid cross-chain-reshield destination in the first
place. This service, Pub/Sub, and Cloud Scheduler don't need any new infra for it — one
service already covers every chain.

**Rotating the signer key:** since key-custody unification (issue #222), this is one
address doing both jobs — there's no longer a cheap "signer-only" rotation path separate
from changing where dust lands. Run `derive-keys.ts` again (or generate a standalone key
any other way), then update **both** sides together:

```sh
gcloud secrets versions add DUST_RESCUE_SIGNER_PRIVATE_KEY --data-file=/path/to/new-signer.key
gcloud run services update dust-rescue-service --region=<region>
```

...and update the relayer's `dust_rescue_recipient_address` to the new address, redeploying
the relayer too. Since this changes where LiFi routes future dust, any in-flight job still
awaiting a bridge quoted against the old address should finish (or be abandoned) before the
switch — and fund the **new** address with native gas on every destination chain
beforehand, or in-flight `PROVING`/`SUBMITTING` jobs will start failing with
insufficient-funds on the next sweep. `ChainWriteService` derives the signing account fresh
on every call (never cached), so there's no in-process key to invalidate on this service's
side once the new revision is live.

## Testing

```
pnpm test
```

Colocated `*.spec.ts` per unit, `jest` + `jest-mock-extended`. No emulator/live-GCP
dependency — Firestore and `@google-cloud/pubsub` are mocked at the module boundary in
every spec.
