# Timestamps in Note Scheme

## Background

There has been a request to include timestamps in the note scheme, primarily motivated by future yield generation and incentivizing users to keep funds in the pool.

This document clarifies what is required **now**, what can be safely deferred, and how this decision impacts the project.

---

## Key Points

### 1. We are not structurally blocked today

The current note scheme already includes an **opaque `metadata` field**, explicitly designed for future extensibility.

- A timestamp can be introduced later via `metadata`
- This does **not** require changing the commitment structure or migrating existing notes
- Therefore, adding timestamps now is **not technically required** to preserve future options

---

### 2. The discussion should focus on lending protocol support, not timestamps

The core question is **how the protocol intends to support lending / yield-generating mechanisms**, rather than whether timestamps should exist in the note scheme.

Once the lending approach is clearly defined, it becomes possible to evaluate whether time-based data is required at the note level, and whether the existing opaque `metadata` field is sufficient or needs to be extended.

Potential approaches include:

- Supporting yield-bearing assets (e.g. stETH, aTokens) as deposit assets
- Handling yield mechanics at the asset or integration layer
- Preserving explicit user opt-in and well-defined risk boundaries

Framing the problem this way ensures that any decision around timestamps is a consequence of a well-defined lending model, rather than a premature structural change to the protocol.

---

### 3. Adding timestamps requires a clear end-to-end design

While feasible, embedding timestamps is a **non-trivial protocol decision**:

- It increases circuit complexity and the public signal surface
- It introduces UX and privacy considerations
- It expands implementation and audit scope

Because timestamps directly affect note lifecycle semantics, this decision should only be made with a **clear end-to-end flow**.

In particular, we would need clarity on:

- How timestamps are assigned at deposit time
- How timestamps behave on partial spends and transfers
    - e.g. when a note is split, which timestamp does the remaining balance carry?
- Whether timestamps are preserved, reset, or aggregated across note transitions
- How these semantics interact with yield accounting and claims

Before committing to timestamps, we ask for a concrete E2E proposal describing the full note lifecycle and timestamp behavior across deposits, transfers, partial spends, and withdrawals. This will allow us to properly evaluate feasibility, risks, and whether the existing `metadata` field is sufficient.

---

## Recommendation

- Do not add timestamps to the core note scheme at this stage
- Proceed with the current design, leveraging `metadata` for future extensions
- Revisit timestamps later as a dedicated initiative

This approach keeps development unblocked, minimizes risk, and preserves full flexibility for future protocol evolution.