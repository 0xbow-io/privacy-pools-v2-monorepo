# Changelog

All notable changes to `@privacy-pools-v2/dust-rescue-service` are documented in this file.

## 1.0.1 — 2026-10-20

- The image bundles the deposit circuit artifacts from `packages/circuits/build`, which now hold the trusted-setup ceremony keys. Rebuild and redeploy the image before the on-chain verifiers are rotated.

## 1.0.0 — 2026-10-19

Initial release.

- Standalone GCP Cloud Run service that detects, proves and submits cross-chain-reshield stealth dust-rescue deposits. The relayer only publishes pending jobs to Pub/Sub; this service does the proving and submission.
