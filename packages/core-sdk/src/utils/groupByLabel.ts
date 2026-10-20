import { Label } from "../internal.js";

/**
 * Groups items by their `label`, preserving first-occurrence order of labels.
 *
 * Uses a `Map`, not a plain object. Labels come from discovered on-chain notes, so a label
 * could be any string — including "__proto__" or "constructor". On a plain-object accumulator
 * those names collide with inherited prototype members: the bucket lookup returns a truthy
 * non-array and the later `.push` throws, blocking the victim from spending. A `Map` keys on
 * the raw value with no prototype chain, so reserved names are ordinary keys.
 */
export function groupByLabel<T extends { label: Label }>(items: T[]): Map<Label, T[]> {
    const groups = new Map<Label, T[]>();
    for (const item of items) {
        const bucket = groups.get(item.label);
        if (bucket) {
            bucket.push(item);
        } else {
            groups.set(item.label, [item]);
        }
    }
    return groups;
}
