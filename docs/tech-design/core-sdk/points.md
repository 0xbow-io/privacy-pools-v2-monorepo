# Points

The points module computes each note's Points v1 accrual on the client. The ASP publishes the accrual parameters (rate tree, rate scale, cliff, cohort schedule) with every epoch; the SDK fetches them through `IPointsDataProvider` and evaluates the formula locally with `computePoints`. Nothing per-user is sent to the ASP: no request carries a commitment, nullifier, label or address.

The module is standalone. It is not wired into `PoolSession`; an integrator combines its own notes (from `NoteManager`) with the provider's epoch data. Code lives in `packages/core-sdk/src/services/points/`, with types in `types/Points.ts`, schemas in `schemas/Points.ts`, constants in `constant/Points.ts` and errors in `errors/Points.ts`.

Public exports (package root): `computePoints`, `notePointsForEpoch`, `cliffOverlap`, `cohortBpsAt`, `assertPointsEpochParams`, `epochParamsFromRateLeaves`, `liveEpochParams`, `HttpPointsDataProvider`, `IPointsDataProvider`, `POINTS_DECIMALS`, `POINTS_COHORT_EDGE_SENTINEL`, and the error classes. `rateTreeRoot` / `spentNoteTreeRoot` (`pointsTrees.ts`) are internal.

### Accrual formula

Per note, per epoch, integer-only, floored once:

```
pointsWei    = floor(value × rate[tokenId] × cohortBps(createdAt) × cliffOverlap / (S × 10_000))
cliffOverlap = max(0, min(end, snapshotTime) − max(createdAt + cliffSeconds, windowStart))
end          = spentAt if spent, else snapshotTime
cohortBps(t) = cohortWeightsBps[k], k = number of cohortEdges ≤ t
```

- **Units.** `value` is in token base units; `rate` is points-wei per base-unit-second scaled by `S`; all times are unix seconds. Point amounts are points-wei, `POINTS_DECIMALS = 18`.
- **`S` (`rateScale`)** is read from the epoch's rate-leaves payload. It is never defaulted: a payload without one fails (`InvalidPointsEpochParams`).
- **Missing rate.** A tokenId absent from the epoch's rates earns `0` for that epoch. Rates are looked up by the lowercased tokenId.
- **Cohort tiers.** There are 3 edges and 4 weights. `k` counts edges at or before `createdAt`, so a note created exactly at an edge falls in the next (lower) tier.
- **Unreached milestones.** A milestone not yet reached is published as the sentinel edge `2^47 + tier` (`POINTS_COHORT_EDGE_SENTINEL + tier`). The sentinels are ordinary edges to the formula: they lie far beyond any plausible `createdAt`, so they put no note into a lower tier.
- **Flooring.** Each epoch is a separate claim, so each `(note, epoch)` amount is floored on its own and the floored amounts are summed. Nothing else is rounded.

`cohortBpsAt`, `cliffOverlap` and `notePointsForEpoch` implement these three lines and nothing else: eligibility and timestamp plausibility are applied by `computePoints`.

### Epoch parameters and tiling

`PointsEpochParams` is everything one accrual window pays under: `epochNumber` (`null` for the live window), `windowStart`, `snapshotTime`, `rateScale`, `rates` (a `Map` keyed by lowercased tokenId), `cliffSeconds`, `cohortEdges` and `cohortWeightsBps`.

`assertPointsEpochParams` rejects a window when any of these holds:

- `rateScale ≤ 0`;
- `windowStart < 0`, or `snapshotTime < windowStart`. This applies to every window, the live one included;
- epoch `0` does not start at `windowStart = 0`;
- `cliffSeconds < 0`, or any rate `< 0`;
- there are not exactly 3 edges, or the edges are not positive and strictly increasing;
- there are not exactly 4 weights, or the weights are not non-increasing integers in `(0, 60000]`.

`computePoints` also checks that the windows tile the timeline:

- every published epoch carries an epoch number, and no number appears twice;
- sorted by epoch number, each epoch's `windowStart` equals the previous epoch's `snapshotTime`;
- the live window has `epochNumber = null`, and its `windowStart` equals the latest published epoch's `snapshotTime`.

Epoch numbers need not be consecutive; only the times must meet. The earliest published epoch passed in is not required to be epoch `0`. A violation throws `InvalidPointsEpochParams`.

### Building epoch params from rate leaves

**`epochParamsFromRateLeaves(epoch, rateLeaves, previousSnapshotTime, hashService) → PointsEpochParams`**

This function maps an epoch row plus its rate-leaves response into `PointsEpochParams`. It accepts both what `IPointsDataProvider` returns and the raw ASP DTO (`[tokenId, rate]` tuples).

1. **Re-validation.** Both inputs are re-parsed with the same Zod schemas the provider uses (`PointsEpochSchema`, `RateLeavesResponseSchema`). Hex values must be 32-byte `0x` values, roots and tokenIds must be BN254 field elements, and parsing is idempotent.
2. **Epoch match.** `rateLeaves.epochNumber` must equal `epoch.epochNumber`.
3. **Rate root integrity.** The epoch row must have a `rateRoot`; an epoch published before the rate tree has none and fails with "no rate tree published". The served `rateLeaves.rateRoot` must equal the epoch row's `rateRoot`, and the leaves must recompute to it:
   - leaf = `Poseidon(tokenId, rate)`;
   - tree = LeanIMT with `Poseidon(a, b)` internal nodes, built over the leaves in served order.

   The ASP sorts the leaves and pads them with `(p − 1, 0)` leaves; the SDK neither re-sorts nor re-pads.
4. **Parameters.**
   - `rateScale` comes from the rate-leaves payload and is required.
   - `cliffSeconds` is the rate-leaves value, falling back to the epoch row's; one of the two must be present.
   - Cohort edges and weights are the rate-leaves arrays when non-empty, else the epoch row's. There must be exactly 3 edges and 4 weights.

   No value is defaulted.
5. **TokenId mapping.**
   - A rate-leaf tokenId is `uint256(uint160(asset))`. It becomes a lowercased `0x` + 40-hex-digit address so it matches note tokenIds.
   - Leaves with tokenId `≥ 2^160` (`POINTS_MAX_TOKEN_ID`) are padding and are dropped.
   - A tokenId that appears twice with different rates fails.
6. **Window.** `windowStart = previousSnapshotTime ?? 0`, and `snapshotTime` is the epoch row's. The result is passed through `assertPointsEpochParams`.

Every failure throws `InvalidPointsEpochParams`, labelled with the epoch number.

**`liveEpochParams(latest, nowSeconds) → PointsEpochParams`**

This function builds the live estimate window from the latest published epoch. It reuses that epoch's rates, rate scale, cliff and cohort schedule, with:

- `epochNumber = null`;
- `windowStart = latest.snapshotTime`;
- `snapshotTime = max(nowSeconds, latest.snapshotTime)`.

The function is pure; the caller supplies the clock.

### computePoints

**`computePoints(notes, published, live) → PointsSummary`**

This function is pure: no I/O and no clock. `published` is the list of published epochs' params. `live` is the live window, or `null`. With no published epoch and no live window, every amount is `0`.

**Note input (`PointsNoteInput`):**

| Field | Type | Description |
| --- | --- | --- |
| `commitment` | `Hash` | Echoed back on the result only; never used in the computation or in errors. |
| `tokenId` | `string` | The note's token (on EVM, the token address); matched against rates lowercased. |
| `value` | `bigint` | Base units. A negative value throws `InvalidPointsInput`. |
| `createdAt` | `bigint` | Unix seconds: the commitment leaf's block timestamp. |
| `spentAt` | `bigint \| null \| "unknown"` | Spend time; `null` if unspent; `"unknown"` if spent but the time is not yet known. |
| `aspStatus` | `"approved" \| "pending" \| "declined"` | The note's current ASP status. |

**Per-note rules:**

| Condition | Result |
| --- | --- |
| `spentAt === "unknown"`, or `createdAt` / a set `spentAt` below `MIN_PLAUSIBLE_POINTS_TIMESTAMP` (`1_000_000_000`, 2001-09-09; e.g. a legacy export carrying a block number) | Status `unknown-time`. Every amount is `0` and `perEpoch` is empty. The note is never counted as held. |
| `aspStatus = "declined"` | Status `ineligible`; every amount is `0` (per-epoch rows are still listed, at `0`). |
| `aspStatus = "approved"` | The sum over published epochs is `claimable`. |
| `aspStatus = "pending"` | The same sum is reported as `pending`, not `claimable`. |
| Live window present and note eligible | The live-window amount is `estimated`. |

**Per-note result (`NotePoints`):**

- **Amounts.** `claimable`, `pending` and `estimated`.
- **`perEpoch`.** One entry per published epoch, plus one with `epochNumber: null` for the live window.
- **Current-window fields.**
  - The current window is the live window if one is given, else the latest published epoch.
  - `activatesAt = createdAt + current.cliffSeconds`.
  - `cohortBps` is the note's tier weight under the current window's edges.
  - With no current window, `activatesAt` is `null` and `cohortBps` is `0`.
- **`status`.** One of:
  - `ineligible`: declined;
  - `closed`: spent;
  - `activating`: no current window, or the current window's `snapshotTime` is before `activatesAt`;
  - `accruing`: otherwise;
  - `unknown-time`: as in the table above.
- **`pointsPerDay`.** The note's daily rate, `floor(value × liveRate × cohortBps × 86400 / (S × 10_000))`, computed from the live window's rate, scale and edges. It is non-zero only when a live window exists, the status is `accruing`, and the live window has a rate for the token.

**Summary (`PointsSummary`):**

- totals of `claimable`, `pending`, `estimated` and `pointsPerDay` across all notes;
- `total = claimable + pending + estimated`;
- `byTokenId`, keyed by lowercased tokenId, with the same fields plus `total` and `noteCount`;
- `notes`, the per-note results in input order.

**Errors.**

- `InvalidPointsEpochParams` on malformed or non-tiling windows.
- `InvalidPointsInput` on a negative value. The note is identified by its index (`note at index N`), never by its commitment.

# Dependencies

| Dependency | Why |
| --- | --- |
| **IHashService** | Poseidon, used to recompute rate-tree and spent-note-tree roots before served leaves are trusted. Required by `HttpPointsDataProvider` (config) and by `epochParamsFromRateLeaves` (argument). |
| **IHTTPClient** | Injected HTTP client used by `HttpPointsDataProvider`. Every request is made with `cache: "no-store"`. |
| **ILogger** | Optional (`HttpPointsDataProviderDependencies.logger`). Logs only the base URL at construction. |
| **`@zk-kit/lean-imt`** | LeanIMT root computation for both trees. |

# IPointsDataProvider / HttpPointsDataProvider

`IPointsDataProvider` reads the ASP's public points API. `HttpPointsDataProvider` is the HTTP implementation.

**Config (`HttpPointsDataProviderConfig`)**, validated by `HttpPointsDataProviderConfigSchema`; any failure throws `InvalidPointsDataProviderConfig`:

| Field | Type | Description |
| --- | --- | --- |
| `aspUrl` | `string` | Base URL of the ASP API; must be `http://` or `https://`. A trailing slash is stripped. |
| `chainId` | `number` | Positive integer. |
| `entrypointAddress` | `string` | Required, non-empty. Sent as `entrypoint=<address>` on every request (pool scoping, as in [ASPClient](asp-client.md)). |
| `httpClient` | `IHTTPClient` | Validated to implement `get()`. |
| `hashService` | `IHashService` | Required, validated to implement `hash()`. |

**Endpoints.** All are under `{aspUrl}/{chainId}/public/points`:

| Method | Endpoint |
| --- | --- |
| `getEpochs()` | `GET /epochs[?sinceId=<cursor>]` |
| `getLatestEpoch()` | `GET /epochs/latest` |
| `getSpentNoteLeaves(epochNumber)` | `GET /epochs/{n}/spent-note-leaves` |
| `getRateLeaves(epochNumber)` | `GET /epochs/{n}/rate-leaves` |
| `getCohorts()` | `GET /cohorts[?since=<cursor>]` |
| `getStats()` | `GET /stats` |

### Wire format

Following `packages/core-sdk/CLAUDE.md` §5, values that cross the boundary are `Hex`. The API serves the same encoding.

| Kind | Encoding | Fields |
| --- | --- | --- |
| Field elements, roots, leaf preimages | `Hex`: `0x` + 64 hex digits, lowercased on parse. Roots, leaves and tokenIds must be `< BN254` modulus. | `aspRoot`, `eligibilityRoot`, `spentNoteRoot`, `rateRoot`; leaves `[nullifierHash, spentAt]`, `[tokenId, rate]` |
| Large integers, epoch and block numbers, unix timestamps | `Hex` (32-byte) | `epochNumber`, `snapshotBlock`, `snapshotTime`, `createdAt`, `correctedAt`, `tvlSeriesLastSample`, `cohortEdges[]`, `rateScale`; cohorts `thresholdsUsd8[]`, `publishedEdges[]`, `publishedInEpoch`, `seriesStartUnix`, `seriesLastSample`, `tiers[].{thresholdUsd8, edgeUnix, sealedInEpoch, sealedAt, runFirstAt, runLastAt}`, `series[].{at, totalUsd8}`; stats `latestEpochNumber`, `latestSnapshotTime` |
| Small bounded integers | JSON `number` | `*LeafCount`, `epochCount`, `cliffSeconds`, bps weights (`cohortWeights`, `weightsBps`, `publishedWeights`, `weightBps`, `baseWeightBps`), `tier`, `sampleIntervalSeconds`, `sustainSamples`, `tierCleared` (`-1` = none) |
| Opaque strings | `string`, unchanged | row ids and cursors (`id`, `lastSyncedId`, `seriesNextSince`), IPFS CIDs, tx hashes, `campaignKey`, `priceRule`, `unpricedReason`, `includedPools`, `seriesDigest` / `tvlSeriesDigest`, `eligibilityMerkleTreeId` |

Notes on parsing:

- Epoch-row fields added in newer ASP versions (`rateRoot`, `rateIpfsCid`, `rateLeafCount`, `cliffSeconds`, the `cohort*` fields, `tvlSeries*`, `correctedAt`, `correctionTxHash`) and the stats field `latestRateLeafCount` may be absent; an absent value is normalized to `null`.
- Leaves are parsed from served tuples into objects (`{ nullifierHash, spentAt }`, `{ tokenId, rate }`). Already-parsed objects are also accepted, so the result of one parse can be parsed again.
- The rate-leaves `table` (the audit table behind the leaves) is passed through verbatim.
- The `{n}` path segment is passed in as `Hex` (any `0x`-prefixed hex), converted, and sent as a decimal number.

---

**`getEpochs() → Promise<PointsEpoch[]>`**

Retrieves every published epoch, ascending by feed id.

- The first page is requested with no cursor, and each following page with `sinceId = lastSyncedId` of the previous page.
- The drain stops at the first **empty** page, never at a short one, so a smaller server page size cannot truncate the feed silently.
- The drain fails if `lastSyncedId` does not strictly advance, or if it reaches `POINTS_FEED_MAX_PAGES` (100) non-empty pages.

A correction rewrites an epoch row in place, under the same feed id. A cached copy must therefore be refreshed by a full drain from the start, never by resuming from a saved cursor.

---

**`getLatestEpoch() → Promise<PointsEpoch | null>`**

Returns the most recent epoch row. A 404 means no epoch has been published yet and returns `null`; any other failure throws.

---

**`getSpentNoteLeaves(epochNumber: Hex) → Promise<SpentNoteLeaves>`**

Returns the complete sorted spent-note leaf set of one epoch, the two boundary sentinels and the padding included.

- The response's `epochNumber` must equal the one requested.
- The leaves must recompute to the served `spentNoteRoot`. Each leaf is `Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, spentAt)` (`POINTS_NULLIFIER_LEAF_TAG`, the contracts' `Constants.NULLIFIER_LEAF_TAG`), and the tree is a LeanIMT over the leaves in served order.

The method does not compare `spentNoteRoot` with the epoch row's `spentNoteRoot`; that comparison is left to the caller.

---

**`getRateLeaves(epochNumber: Hex) → Promise<PointsRateLeaves>`**

Returns the complete rate tree of one epoch, with `rateScale`, `cliffSeconds`, the cohort edges and weights, and the audit `table`.

- The response's `epochNumber` must equal the one requested.
- The leaves must recompute to the served `rateRoot`.
- A 404 means the epoch does not exist or predates the rate tree; it throws.

The comparison with the epoch row's `rateRoot` happens in `epochParamsFromRateLeaves`.

---

**`getCohorts() → Promise<PointsCohorts>`**

Returns the campaign's TVL-milestone cohort schedule: thresholds, weights, tiers, the published edges, `pinnedOnChain`, and the TVL sample `series`.

- The series is paged. While a page has `seriesHasMore = true`, the next page is requested with `since = seriesNextSince`. A page with `seriesHasMore = true` must carry a non-null `seriesNextSince`, or it fails validation.
- The drain fails if the cursor does not change between pages, or after 100 pages.
- The returned object is the last page's envelope with every page's `series` concatenated; the paging fields are removed.
- `pinnedOnChain = false` means the schedule is a derivation the operator can still redo, so it should be presented as an estimate.

---

**`getStats() → Promise<PointsStats>`**

Returns display-only aggregates: `epochCount`, the latest epoch number and snapshot time, and the latest leaf counts.

---

**Errors**

| Error | When |
| --- | --- |
| `InvalidPointsDataProviderConfig` | Constructor config fails validation. |
| `PointsDataUnavailable` | A request fails (other than the `getLatestEpoch` 404); a response fails schema validation; leaves are served for another epoch or do not recompute to their root; a feed cursor does not advance; a drain hits its page cap; an `epochNumber` argument is not `0x` hex. |
| `InvalidPointsEpochParams` | `epochParamsFromRateLeaves` / `computePoints` validation (see above). |
| `InvalidPointsInput` | `computePoints` note input (negative value). |

All of them extend `PointsBaseError`.

# Privacy

- **No note-identifying request.** No provider method takes a commitment, nullifier, label or address. Leaf sets (spent-note, rate) are always fetched whole, and membership or gap witnesses are assembled locally from the full set. The computation itself runs entirely client-side.
- **The epoch number is in the path.** `getSpentNoteLeaves` / `getRateLeaves` put the epoch number in the URL. A caller that fetches only the epochs its own notes touch reveals that selection. To keep the request stream independent of the notes held, callers fetch every published epoch, or none, and never a note-driven subset.
- **Errors carry no note data.** `computePoints` errors identify a note by its index in the input array, never by its commitment, because error messages travel wherever the integrator ships them. Provider errors carry no note data, since requests carry none.

# Trust boundary and known limitations

- **Roots are checked against the ASP, not the chain.**
  - Each served leaf set is checked against the root served with it.
  - `epochParamsFromRateLeaves` also checks the rate root against the ASP's own epoch row.
  - All of these roots come from the same server. A compromised ASP that serves a self-consistent epoch row and leaf set is not detected.
  - Verification against the on-chain `PointsRegistry` comes once the registry is live. The registry lives on the unmerged branch `feat/points-registry`.
- **Eligibility is the current ASP status.**
  - `computePoints` applies the note's current `aspStatus` to every epoch. On chain, eligibility is membership in each epoch's eligibility snapshot.
  - A note approved late can therefore show `claimable` points for epochs it cannot claim.
  - Per-epoch eligibility needs the ASP to serve each epoch's eligibility leaf set (PR #474, open question 1).
- **The live estimate uses the latest epoch's schedule.** The live window reuses the latest published epoch's rates and cohort edges. A milestone crossed during the live window appears only once the next epoch publishes it.
- **The claim circuit does not match yet.** `Claim.circom` on `feat/points-registry` still uses a single public `rate`, `RATE_SCALE = 1e27` and no cliff or cohort terms, so it does not match this formula. Aligning it is out of scope for this module.

# Test vectors

`packages/core-sdk/test/fixtures/points-vectors.json` holds 18 language-neutral vectors, each one note in one epoch (that is, one claim):

- All integers are decimal strings, and times are unix seconds.
- Each vector gives the expected `cliffOverlap`, `cohortBps` and `pointsWei`. The file also states the formula, including the ASP's `tokenRate` / `shareRate` / `roundHalfUp` rate derivation and the `2^47 + tier` sentinel.
- `test/unit/services/pointsVectors.test.ts` validates the file with a Zod schema at load and asserts the count (18).
- The test checks each expected value against `cliffOverlap`, `cohortBpsAt` and `notePointsForEpoch`.
- For the 16 vectors that carry a `rateDerivation`, the test also checks the rate against a verbatim copy of the ASP's rate-table functions.

The file is meant for reuse by the circuit tests when `Claim.circom` is updated.

# **Version History**

| Version | Date | Description |
| --- | --- | --- |
| 1.0 | 2026-10-07 | Initial version (PR #474, `feat/points-sdk`). Documents client-side Points v1 accrual (`computePoints`, `notePointsForEpoch`, `cliffOverlap`, `cohortBpsAt`, `assertPointsEpochParams`), epoch params from rate leaves with rate-root verification (`epochParamsFromRateLeaves`, `liveEpochParams`), `IPointsDataProvider` / `HttpPointsDataProvider` with the Hex wire format, feed draining and leaf-set root checks, the privacy rules, trust boundary, and the shared test vectors. |
