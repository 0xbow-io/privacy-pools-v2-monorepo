import type { Address, Hex } from "viem";
import type { StealthRecipientIdentifier } from "@privacy-pools-v2/dust-rescue-prover";

export type DustRescueJobState =
    | "PENDING"
    | "AWAITING_DESTINATION"
    | "BELOW_THRESHOLD"
    | "PROVING"
    | "SUBMITTING"
    | "SUBMITTED"
    | "CONFIRMED"
    | "FAILED";

export const TERMINAL_STATES: readonly DustRescueJobState[] = ["BELOW_THRESHOLD", "CONFIRMED", "FAILED"];

// The explicit complement of TERMINAL_STATES over the closed 8-value DustRescueJobState
// enum above. Firestore's `in` filter (unlike `not-in`) composes with `.orderBy()` on a
// different field — see firestore-job-store.service.ts's `listNonTerminal` (finding #10,
// Problem A).
export const NON_TERMINAL_STATES: readonly DustRescueJobState[] = [
    "PENDING",
    "AWAITING_DESTINATION",
    "PROVING",
    "SUBMITTING",
    "SUBMITTED",
];

export interface PreparedApprovalTx {
    to: Address;
    data: Hex;
    value: Hex;
}

/**
 * The dust asset's price against a reference USD stablecoin, computed once by the
 * relayer at Leg-1 registration time (dust_collection_service_detailed_design.org §4b)
 * via its own `RateProviderService` — dust-rescue-service never calls that service
 * itself, only does arithmetic against this stored rate once `sweptAmount` is known.
 *
 * `microUsdPerWholeTokenX1e18` is already fully decimals-normalized on the relayer side
 * (Curve's and CowSwap's raw `Quote.num`/`Quote.den` mean genuinely different things —
 * see rate_provider/usd_pricing.ts — so that provider-specific math happens once, in the
 * relayer, not here): the USD price of ONE WHOLE dust token, in micro-USD (1e-6 USD),
 * scaled by 1e18 for fixed-point precision. `tokenDecimals` is the dust asset's own
 * decimals, needed to convert a base-unit `sweptAmount` into whole-token terms:
 *
 *   sweptAmountUsdMicros = sweptAmount * microUsdPerWholeTokenX1e18 / (10^tokenDecimals * 1e18)
 */
export interface DustAssetUsdRate {
    source: "Curve" | "Cowswap";
    microUsdPerWholeTokenX1e18: Hex;
    tokenDecimals: number;
}

/**
 * A dust-rescue job, persisted in Firestore keyed by `sourceTxHash` (see
 * dust_collection_service_detailed_design.org §3). State advances at most once per
 * `/sweep` invocation (see sweep/sweep.service.ts).
 */
export interface DustRescueJob {
    sourceTxHash: Hex;
    fromChainId: number;
    destinationChainId: number;
    tokenId: Address;
    recipientIdentifier: StealthRecipientIdentifier;
    usdRate: DustAssetUsdRate;
    state: DustRescueJobState;
    // Set at creation (issue #222) when the relayer forwarded source-chain swap-input
    // dust ("dust #1") to this same job's destination — see
    // dust-rescue-forwarding.service.ts and dust_unification_feasibility_and_plan.org.
    // Absent when there was nothing to forward, or forwarding failed — dust #1 just
    // stays at the relayer's EOA in that case, no different from before this field
    // existed. Tracked as its own LiFi-status leg (DetectionService.check()), same
    // trust model as sourceTxHash's own leg — never balance-based.
    dust1ForwardTxHash?: Hex;
    // Ceiling on what this job may treat as dust (hex, base units of tokenId), set by the
    // relayer at registration from the reshield's own principal (minr #2). Whatever LiFi
    // reports, a swept amount above this is a stranded principal, not dust: the job fails
    // loudly instead of depositing it from the shared wallet. Optional so jobs registered
    // before the field existed still resolve.
    maxDustAmount?: Hex;
    // Populated once AWAITING_DESTINATION resolves DONE (§4a/§4b). sweptAmount is the
    // COMBINED total of both legs (dust #2 off sourceTxHash, plus dust #1 off
    // dust1ForwardTxHash when present and also DONE) — see DetectionService.check().
    sweptAmount?: Hex;
    receivingTxHash?: Hex;
    // Audit field mirroring receivingTxHash, for dust #1's own leg once it resolves.
    dust1ReceivingTxHash?: Hex;
    // Audit field: the USD value (micro-USD, 1e-6) actually used for the worth-it
    // decision, computed from sweptAmount * usdRate — not load-bearing for anything
    // downstream, kept for the same "why did this end up BELOW_THRESHOLD" visibility
    // lastError already exists for failures.
    sweptAmountUsdMicros?: Hex;
    depositCalldata?: Hex;
    depositTarget?: Address;
    depositMsgValue?: Hex;
    approvalTx?: PreparedApprovalTx | null;
    approvalTxHash?: Hex;
    // Ordered approvals recorded at PROVING (minr #28): [approve(0), approve(n)] when the shared
    // wallet holds a residual allowance on a Tether-style token, else [approve(n)] or []. Each
    // broadcast hash is appended to `approvalTxHashes` before the next send, so a crash between
    // the two can never double-send (same rule as `approvalTxHash`). Jobs from before this field
    // still carry only `approvalTx`/`approvalTxHash`.
    approvalTxs?: PreparedApprovalTx[];
    approvalTxHashes?: Hex[];
    depositTxHash?: Hex;
    attempts: number;
    lastError?: string;
    createdAt: number;
    updatedAt: number;
}

export type NewDustRescueJob = Pick<
    DustRescueJob,
    | "sourceTxHash"
    | "fromChainId"
    | "destinationChainId"
    | "tokenId"
    | "recipientIdentifier"
    | "usdRate"
    | "dust1ForwardTxHash"
    | "maxDustAmount"
>;
