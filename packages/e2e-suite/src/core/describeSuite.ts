import { describe, it } from "vitest";

import type { Capability, CapabilityMembers, ChainE2E, ChainE2EDriver } from "../internal.js";
import { CAPABILITY_MEMBERS } from "../internal.js";

/** The lazy driver a suite body receives; await it in `beforeAll`, never at collection time. */
export type DriverAccessor = () => Promise<ChainE2EDriver>;

/**
 * The driver narrowed to the members `capability` owns. The chain must have provided them because it did
 * not opt out (a compile-time guarantee); this fails loudly if a driver cast its way past that.
 */
export function need<K extends Capability>(driver: ChainE2EDriver, capability: K): ChainE2EDriver & CapabilityMembers[K] {
    for (const member of CAPABILITY_MEMBERS[capability]) {
        if (!(member in driver)) {
            throw new Error(
                `The ${driver.chainName} driver does not provide '${String(member)}', which capability ` +
                    `'${capability}' needs. Implement it or list '${capability}' in 'unsupported'.`,
            );
        }
    }
    return driver as ChainE2EDriver & CapabilityMembers[K];
}

/**
 * Registers one operation's suite. Top-level `describe` of a shared suite file:
 * - inert unless the chain's opt-in is on (`describe.skipIf`, same as the original per-chain files),
 * - shown as an explained skip when the chain opted out of a capability the suite requires.
 */
export function describeSuite(
    chain: ChainE2E,
    name: string,
    requires: readonly Capability[],
    body: (driver: DriverAccessor) => void,
): void {
    const opted = firstUnsupported(chain, requires);
    if (opted !== undefined) {
        describe.skipIf(!chain.enabled)(`${name} (unsupported on ${chain.name}: ${opted})`, () => {
            it.skip("declared unsupported by the chain", () => undefined);
        });
        return;
    }
    describe.skipIf(!chain.enabled)(name, () => body(() => chain.driver()));
}

/** A nested group that needs a capability the rest of the suite does not (e.g. relayed spends). */
export function describeWith(
    chain: ChainE2E,
    capability: Capability | readonly Capability[],
    name: string,
    body: () => void,
): void {
    const reason = firstUnsupported(chain, capability);
    if (reason !== undefined) {
        describe(`${name} (unsupported on ${chain.name}: ${reason})`, () => {
            it.skip("declared unsupported by the chain", () => undefined);
        });
        return;
    }
    describe(name, body);
}

/** A single rung that needs a capability the rest of its suite does not (e.g. a second asset). */
export function itWith(
    chain: ChainE2E,
    capability: Capability | readonly Capability[],
    name: string,
    body: () => Promise<void> | void,
): void {
    const reason = firstUnsupported(chain, capability);
    if (reason !== undefined) {
        it.skip(`${name} (unsupported on ${chain.name}: ${reason})`, () => undefined);
        return;
    }
    it(name, body);
}

function firstUnsupported(chain: ChainE2E, capability: Capability | readonly Capability[]): string | undefined {
    const list: readonly Capability[] = typeof capability === "string" ? [capability] : capability;
    return list.map((c) => chain.unsupportedReason(c)).find((r) => r !== undefined);
}
