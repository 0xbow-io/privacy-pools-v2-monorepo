import type { Capability, CapabilityMembers, ChainE2EDriver, UnsupportedMap } from "../internal.js";

type UnionToIntersection<U> = (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void
    ? I
    : never;

/**
 * The extra driver members a chain must supply given what it opted out of: every capability NOT in `U`
 * contributes its {@link CapabilityMembers}. So a chain cannot both claim support for a capability and
 * omit the members that capability's suites use — that is a compile error.
 */
export type RequiredMembers<U extends UnsupportedMap> = UnionToIntersection<
    CapabilityMembers[Exclude<Capability, keyof U>]
>;

export interface ChainE2EConfig<U extends UnsupportedMap> {
    /** Shown in reports and error messages (`"evm"`, `"stellar"`). */
    name: string;
    /** The chain's opt-in switch (e.g. `process.env.EVM_E2E === "1"`); a bare `vitest run` stays inert. */
    enabled: boolean;
    /** Capabilities this chain cannot support, each with the reason. Empty = the chain supports everything. */
    unsupported: U;
    /**
     * Builds the driver. Called from `beforeAll` (never at collection), so it may `inject()` the
     * handle the chain's `globalSetup` provided. Memoised per test file.
     */
    createDriver: () => (ChainE2EDriver & RequiredMembers<U>) | Promise<ChainE2EDriver & RequiredMembers<U>>;
}

/** What suites receive: static facts (known at collection) plus a lazy driver. */
export interface ChainE2E {
    readonly name: string;
    readonly enabled: boolean;
    /** The reason `capability` is opted out, or `undefined` when the chain supports it. */
    unsupportedReason(capability: Capability): string | undefined;
    /** The driver, created on first use. Only call from hooks / tests, not at collection time. */
    driver(): Promise<ChainE2EDriver>;
}

/**
 * Declares a chain to the suite. `unsupported` is captured as a const type so {@link RequiredExtras}
 * can check the driver against it.
 */
export function defineChainE2E<const U extends UnsupportedMap>(config: ChainE2EConfig<U>): ChainE2E {
    let driver: Promise<ChainE2EDriver> | undefined;
    return {
        name: config.name,
        enabled: config.enabled,
        unsupportedReason: (capability) => config.unsupported[capability],
        driver: () => (driver ??= Promise.resolve(config.createDriver())),
    };
}
