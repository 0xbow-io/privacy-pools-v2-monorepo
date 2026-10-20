# Mock ASP - Tech Design

> **Package scope.** `packages/mock-asp` (`@privacy-pools-v2/mock-asp`) — a **dev/test tool, not shipped SDK code**: an Association Set Provider (ASP) you can run locally, with an admin API and fault injection. It exists so SDK end-to-end tests (and browser integrations) exercise the *real* HTTP path — `HttpASPDataProvider` → `HTTPClient` → an HTTP server — instead of an in-memory `IASPDataProvider`. The wire contract it implements is owned by core-sdk (`HttpASPDataProvider`, `schemas/ASPClient.ts`, `schemas/NoteEvents.ts`, `schemas/EventSnapshot.ts`); this doc covers the server, its ports, and its admin surface.

## Layout

| Path | Chain-agnostic? | Contents |
| --- | --- | --- |
| `src/core/` | yes — depends only on `core-sdk` | `AspState` (association set, published root, label-status overrides), `MockAspHttpServer` (routes, CORS, scoping, faults, admin API), `AspAdminClient` (typed `fetch` client over the admin API, for e2e suites), `ports.ts`, `faults.ts` |
| `src/evm/` | EVM adapter (viem) | `EvmAspRootPublisher`, `EvmDeploymentSnapshotSource`, `startEvmMockAsp` |
| `src/cli/evm.ts` | — | standalone EVM server for browser/dev use (`pnpm --filter @privacy-pools-v2/mock-asp start:evm`) |

Package exports: `.` (core) and `./evm`. `mock-asp/evm` deliberately does **not** depend on `evm-sdk` (evm-sdk's e2e depends on mock-asp; the reverse edge would be a cycle), so the few ABI fragments it needs are re-declared locally.

Leaf and root computation uses core-sdk's own `PoseidonHashService` / `MerkleService`, so the association-set format is byte-identical to what `WitnessPreparationService` expects.

## Ports (where chains plug in)

| Port | Role | EVM implementation |
| --- | --- | --- |
| `AspRootPublisher` | Publish a root to the chain's ASP registry; must resolve only once confirmed. Optional `readLatestRoot()` to seed the served root. | `EvmAspRootPublisher` — `ASPRegistry.updateASPRoot(uint256,bytes)`; signer is a local `postman` key or an anvil-impersonated `postman`; `forkMode` adds retries for flaky public-RPC forks. |
| `AspChainEventSource` | Serve `note-events` and/or `event-snapshot`. Every method optional; an unimplemented endpoint answers `501` so the SDK's on-chain fallback stays testable. | `EvmDeploymentSnapshotSource` — an honestly empty snapshot through the deployment block (a fork cannot serve `eth_getLogs` from genesis). Full chain-indexing source is planned. |
| `ChainScope` | `{ chainId, entrypoint? }`; requests naming another chain/entrypoint are rejected. | — |

A Stellar adapter is expected to implement the same two ports (root publication via the registry contract's `update_asp_root`; events from Soroban) with no change to `src/core/`.

## HTTP surface

All JSON. CORS headers (`Access-Control-Allow-Origin`, configurable) are sent on every response, including errors and `501`s, and `OPTIONS` is answered `204`.

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness |
| `GET /association-set/root` / `leaves` | decimal-string root / leaves; `?chainId=&entrypoint=` checked when present (`400` on mismatch) |
| `GET /labels/{decimalLeaf}/status` | `pending` / `approved`, or an admin-set `rejected` / `poi_required` / `unknown` |
| `GET /public-key` | X25519 ASP public key |
| `GET /{chainId}/public/note-events?entrypoint&since&until` | via `AspChainEventSource`, else `501`; path `chainId` mismatch → `404` |
| `GET /{chainId}/public/event-snapshot/payload?entrypoint` | via `AspChainEventSource`, else `501` |

The root served is the **published** root (what the registry holds), not the root of the served leaves; the two differ between an approval and its publication, which is exactly the "approved but root not pushed" state the SDK must handle.

## Admin API (never faulted, never scope-checked)

| Route | Effect |
| --- | --- |
| `POST /admin/approve-label {label, pushRoot?}` | add the label's leaf and (default) publish the new root; `pushRoot:false` approves without publishing. Response keeps the legacy `txHash` field. |
| `POST /admin/revoke-label {label}` | remove the leaf, publish the shrunken root, mark the label `rejected`; `404` if never approved |
| `POST /admin/label-status {label\|leaf, status, timestamp?}` | force the served status |
| `POST /admin/faults {endpoint?, mode, count?}` / `DELETE /admin/faults` | inject / clear faults |
| `POST /admin/reset` | clear faults and status overrides (leaves stay: the set is append-only relative to the chain) |
| `GET /admin/state` | leaves, published root, active faults, overrides, request count |

Admin mutations are serialized, and state is committed only after publication succeeds, so a failed publish leaves the ASP unchanged.

`AspAdminClient` (exported from the package root) is a thin, chain-agnostic `fetch` wrapper over these routes (`approveLabel`, `revokeLabel`, `setLabelStatus`, `setFault` / `clearFaults`, `state`). Chain e2e suites drive the ASP through it (`@privacy-pools-v2/e2e-suite`'s driver exposes it as `driver.asp`); it speaks only HTTP to a running server, so it works against any chain's adapter.

### Fault modes

Generic (any endpoint): `down` (socket destroyed), `http500`, `timeout` (hangs until the client gives up), `malformed-json`, `not-implemented` (`501`). Data-shaping: `stale-root` (`root`), `bad-leaves` (`leaves`), `drop-rows` (`note-events`, `event-snapshot` — corrupts the load-bearing field of the first row), `empty-payload-events` (`note-events`). `endpoint` is one of `health | root | leaves | label-status | public-key | note-events | event-snapshot | *`; `count` limits how many requests a fault applies to.

## Testing

Unit tests run the real `HttpASPDataProvider` + `HTTPClient` against the in-process server with a fake publisher (no chain needed): every endpoint, every fault mode, scoping, CORS, and root/leaf consistency against an independent Poseidon/LeanIMT computation. The EVM adapter is exercised by the evm-sdk e2e suite through the shared `@privacy-pools-v2/e2e-suite` (its `aspHttp` suite pins that a chain's adapter publishes roots on-chain and serves what the SDK's sessions read).

---

**Version History**

| Version | Change |
| --- | --- |
| 1.0 | 2026-09-24 — Initial doc for the new `packages/mock-asp` package: chain-agnostic HTTP server + admin/fault API, EVM adapter, ports for future Stellar support. Consolidates the previously separate `evm-sdk/e2e/mockAspServer.ts` (in-memory) and `evm-sdk/scripts/local-mock-asp/server.ts` (HTTP) mocks. |
| 1.1 | 2026-09-25 — `AspAdminClient` moved from `evm-sdk/e2e/harness/asp.ts` into `src/core` (chain-agnostic admin client, exported from the package root) so every chain's e2e suite can share it; no server behaviour change. |
