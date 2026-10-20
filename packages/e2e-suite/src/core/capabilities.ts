import type { CapabilityMembers } from "./driver.js";

/**
 * Everything a chain may legitimately be unable to do. The suite is **opt-out**: every suite runs on
 * every chain unless the chain lists the capability it lacks in `unsupported` (with a reason), so a
 * ladder added later reaches every chain automatically.
 *
 * Keep this list to real product/architecture gaps. A behavioural difference that is not a missing
 * feature (a different error class, say) is a driver hook or a chain-specific file, not a capability.
 * Each capability owns the driver members its suites use — see {@link CapabilityMembers}.
 */
export const CAPABILITIES = {
    /** Spends can be relayed through a live relayer (relayed withdraw / batch). */
    relayer: "relayed spends through a live relayer",
    /** Gasless `registerAndWithdraw` for an account with no keystore and no gas (implies `relayer`). */
    registerAndWithdraw: "gasless register-and-withdraw",
    /** Signature-derived keys with revocable-key rotation and index discovery. */
    keyRotation: "revocable-key rotation and discovery",
    /** A second, non-native test asset the driver can mint (ERC-20 / SAC token). */
    token: "a mintable non-native asset",
    /** Payment requests. */
    paymentRequests: "payment requests",
    /** Multiple withdrawals batched into one transaction — self-submitted or relayed alike. */
    batchRelay: "batched withdrawal of multiple notes in one transaction",
    /** A yield deployment: underlying wrapped into a shielded share by a router, and unwrapped on exit. */
    yield: "yield-bearing share deposits and withdrawals",
    /** A yield deployment over the chain's native coin. */
    yieldNative: "yield over the native coin",
    /** A yield deployment over a non-native token. */
    yieldToken: "yield over a non-native token",
} as const satisfies Record<keyof CapabilityMembers, string>;

export type Capability = keyof typeof CAPABILITIES;

/** The runtime list of members each capability owns; `need` uses it to fail loudly on a missing one. */
export const CAPABILITY_MEMBERS: { [K in Capability]: readonly (keyof CapabilityMembers[K])[] } = {
    relayer: ["relayerUrl", "relayedSession", "withdrawalQuote", "rerouteFeeCommitment", "sendUnrelatedTransaction"],
    registerAndWithdraw: ["verifyRelayedRegistration", "drainedNativeBalance"],
    keyRotation: ["keysAtIndex"],
    token: ["tokenAsset", "mint"],
    paymentRequests: [],
    batchRelay: [],
    yield: ["sessionWithoutYield", "emptyAddress"],
    yieldNative: ["nativeYield"],
    yieldToken: ["tokenYield"],
};

/** `capability -> reason it is unsupported`. A reason is mandatory so a skip is always explained. */
export type UnsupportedMap = Partial<Record<Capability, string>>;
