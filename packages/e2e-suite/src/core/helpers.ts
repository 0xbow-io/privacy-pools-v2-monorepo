import { bigintToHex } from "@privacy-pools-v2/core-sdk";
import type { Hex, Note, PublicKey, Secret } from "@privacy-pools-v2/core-sdk";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";

import type { AssetInfo, ChainE2EDriver, ConformanceSession, ProtocolKeys } from "../internal.js";

/** `n` suite units of `asset`, as the `Hex` amount the session API takes. */
export function amountOf(asset: AssetInfo, units: number | bigint): Hex {
    return bigintToHex(asset.unit * BigInt(units));
}

/** The note the session knows by `commitment`, from its account export (`undefined` if unknown). */
export async function exportedNote(session: ConformanceSession, commitment: Hex) {
    return (await session.exportAccount()).notes.find((n) => n.commitment === commitment);
}

/**
 * Discovers notes after settling finality, retrying a few times if the result is empty. A scan run right
 * after a just-mined tx can briefly see nothing, then find everything a beat later (the node's view of
 * "current" lags `eth_getLogs`). Only retries on a fully empty result — never seen a partial one.
 */
export async function discoverNotesWithRetry(
    driver: ChainE2EDriver,
    session: ConformanceSession,
    fromBlock: Hex,
): Promise<Note<string>[]> {
    await driver.settleFinality();
    for (let attempt = 0; attempt < 5; attempt++) {
        const discovered = await session.discoverNotes({ fromBlock });
        if (discovered.length > 0) return discovered;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return session.discoverNotes({ fromBlock });
}

/** Random, chain-agnostic protocol keys (the viewing key is X25519 on every chain). */
export function randomProtocolKeys(): ProtocolKeys {
    const randomSecret = (): Secret => ("0x" + bytesToHex(randomBytes(32))) as Secret;
    const viewingPrivateKey = randomSecret();
    const pubBytes = x25519.getPublicKey(hexToBytes(viewingPrivateKey.slice(2)));
    return {
        privateNullifyingKey: randomSecret(),
        privateRevocableKey: randomSecret(),
        viewingPrivateKey,
        viewingPublicKey: ("0x" + bytesToHex(pubBytes)) as PublicKey,
        revocableKeyIndex: "0x0" as Hex,
    };
}
