import { LeanIMT } from "@zk-kit/lean-imt";

import type { Hex, IHashService, RateLeaf, SpentNoteLeaf } from "../../internal.js";
import { POINTS_NULLIFIER_LEAF_TAG, bigintToHex } from "../../internal.js";

/**
 * Root of an epoch's rate tree over its served leaves, in served order (sorted and padded by the
 * ASP): a LeanIMT of `Poseidon(tokenId, rate)`.
 */
export function rateTreeRoot(leaves: readonly RateLeaf[], hashService: IHashService): bigint {
    return leanImtRoot(
        leaves.map(({ tokenId, rate }) => hashService.hash([tokenId, rate])),
        hashService,
    );
}

/**
 * Root of an epoch's sorted spent-note tree over its served leaves, in served order (sentinels and
 * padding included): a LeanIMT of `Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, spentAt)`.
 */
export function spentNoteTreeRoot(
    leaves: readonly SpentNoteLeaf[],
    hashService: IHashService,
): bigint {
    const tag = bigintToHex(POINTS_NULLIFIER_LEAF_TAG);
    return leanImtRoot(
        leaves.map(({ nullifierHash, spentAt }) => hashService.hash([tag, nullifierHash, spentAt])),
        hashService,
    );
}

function leanImtRoot(leafHashes: Hex[], hashService: IHashService): bigint {
    if (leafHashes.length === 0) return 0n;
    const tree = new LeanIMT<Hex>((a, b) => hashService.hash([a, b]));
    tree.insertMany(leafHashes);
    return BigInt(tree.root);
}
