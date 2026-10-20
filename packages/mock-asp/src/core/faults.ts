/** Endpoints a fault can target. `"*"` matches every ASP route (the admin API is never faulted). */
export const ASP_ENDPOINTS = [
    "health",
    "root",
    "leaves",
    "label-status",
    "public-key",
    "note-events",
    "event-snapshot",
] as const;

export type AspEndpoint = (typeof ASP_ENDPOINTS)[number];

/**
 * Failure modes the server can be told to exhibit.
 *
 * Generic (any endpoint):
 * - `down` — destroys the socket without a response (network-level failure).
 * - `http500` — answers `500`.
 * - `timeout` — never answers; the connection hangs until the client gives up.
 * - `malformed-json` — answers `200` with an unparseable body.
 * - `not-implemented` — answers `501`.
 *
 * Data-shaping (specific endpoints):
 * - `stale-root` (`root`) — serves the root before the latest approval.
 * - `bad-leaves` (`leaves`) — serves a leaf set whose root cannot match the served root.
 * - `drop-rows` (`note-events`, `event-snapshot`) — corrupts the load-bearing field of the first row of the
 *   first non-empty array, so tolerant clients drop that row (and strict ones reject the payload).
 * - `empty-payload-events` (`note-events`) — appends an event with an empty `encryptedPayload`.
 */
export const FAULT_MODES = [
    "down",
    "http500",
    "timeout",
    "malformed-json",
    "not-implemented",
    "stale-root",
    "bad-leaves",
    "drop-rows",
    "empty-payload-events",
] as const;

export type FaultMode = (typeof FAULT_MODES)[number];

/** Modes that only make sense on specific endpoints. */
export const SHAPING_MODE_ENDPOINTS: Partial<Record<FaultMode, readonly AspEndpoint[]>> = {
    "stale-root": ["root"],
    "bad-leaves": ["leaves"],
    "drop-rows": ["note-events", "event-snapshot"],
    "empty-payload-events": ["note-events"],
};

export interface FaultSpec {
    /** Target endpoint; defaults to `"*"`. */
    endpoint?: AspEndpoint | "*";
    mode: FaultMode;
    /** Number of requests the fault applies to; omitted means until cleared. */
    count?: number;
}

export interface ActiveFault {
    endpoint: AspEndpoint | "*";
    mode: FaultMode;
    /** Remaining applications; `null` means unlimited. */
    remaining: number | null;
}

/**
 * Validates a fault spec.
 *
 * @returns An error message, or `null` when the spec is valid.
 */
export function validateFaultSpec(spec: unknown): string | null {
    if (typeof spec !== "object" || spec === null) return "fault spec must be an object";
    const { endpoint = "*", mode, count } = spec as Record<string, unknown>;
    if (typeof mode !== "string" || !(FAULT_MODES as readonly string[]).includes(mode)) {
        return `mode must be one of ${FAULT_MODES.join(", ")}`;
    }
    if (endpoint !== "*" && !(ASP_ENDPOINTS as readonly string[]).includes(endpoint as string)) {
        return `endpoint must be "*" or one of ${ASP_ENDPOINTS.join(", ")}`;
    }
    if (count !== undefined && (!Number.isInteger(count) || (count as number) < 1)) {
        return "count must be a positive integer";
    }
    const allowed = SHAPING_MODE_ENDPOINTS[mode as FaultMode];
    if (allowed && !allowed.includes(endpoint as AspEndpoint)) {
        return `mode "${mode}" only applies to endpoint(s): ${allowed.join(", ")}`;
    }
    return null;
}
