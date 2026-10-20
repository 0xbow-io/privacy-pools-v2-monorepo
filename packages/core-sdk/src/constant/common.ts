export const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const EMPTY_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * Opt-in behaviours this build supports.
 *
 * For consumers that vendor the SDK as a prebuilt tarball and therefore cannot
 * tell from a version range what they actually got. The public surface in
 * `src/external.ts` is hand-curated, so a schema or an optional parameter is not
 * reachable at runtime and cannot be probed for — reading `RageQuitParamsSchema`
 * from a consumer returns `undefined` no matter which build is installed.
 *
 * A consumer reads a flag and fails closed when it is absent, which is exactly
 * what an older build looks like. Add a key when a feature needs to ship ahead of
 * the code that uses it; remove it once every consumer is past that boundary.
 */
export const SDK_FEATURES = Object.freeze({
    /**
     * `prepareRageQuit` accepts `allowUnconfirmedExit`, letting a caller retry an
     * exit for a note whose `EXITED` status it could not corroborate on chain.
     * Without it, such a note cannot be exited at all and surfacing it in a UI
     * produces an action that always throws.
     */
    allowUnconfirmedExit: true,

    /**
     * Note status can be `EXIT_PENDING`: a ragequit that is mined but not settled.
     *
     * A consumer that writes this status against an older build gets
     * `InvalidStatusTransitionError`, because the transition table there has no
     * such state — so the write FAILS LOUDLY on a path where the exit already
     * succeeded on chain. Check this flag before writing it.
     */
    provisionalExitStatus: true,
} as const);

// NOTE (core-sdk split): STELLAR_EMPTY_ADDRESS (Stellar's "no address" sentinel, built via
// @stellar/stellar-sdk's StrKey) was dropped here — it belongs in stellar-sdk alongside the
// rest of the Stellar-specific constants.

/**
 * Rate headroom for a share deposit that executes on ANOTHER chain after a bridge: the 1 ppm the
 * same-chain path reserves covers seconds, a Stargate / Across leg takes minutes, and an Aave-backed
 * share appreciates about 1 ppm every 10 to 15 minutes at 3 to 5% APY. Sizing the shares from a
 * smaller principal (the cap stays the full budget, LiFi forwards exactly that) keeps the router's
 * pull under the cap on arrival; the surplus returns as dust like the 3% swap slippage already does.
 */
export const CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM = 500n;
