import type { Hash, Hex, IPoolVaultInteractor, PoolSession } from "@privacy-pools-v2/evm-sdk";

/**
 * Throws unless `poolSession.isKeystoreRegistered()` returns `true`.
 * The session's `ownerAddress` is the subject of the check.
 */
export async function assertKeystoreRegistered(
    poolSession: PoolSession,
    label: string,
): Promise<void> {
    const isRegistered = await poolSession.isKeystoreRegistered();
    if (!isRegistered) {
        throw new Error(
            `Pre-condition violated: ${label}'s keystore is NOT registered.\n` +
                `→ This example requires ${label} to be registered so the SDK can fetch the on-chain viewing key.\n` +
                `  Run \`pnpm sample:registerKeystore\` first.`,
        );
    }
}

/**
 * Throws unless `poolSession.isKeystoreRegistered()` returns `false`.
 * Used by cold-start examples that demonstrate the no-keystore path.
 */
export async function assertKeystoreNotRegistered(
    poolSession: PoolSession,
    label: string,
): Promise<void> {
    const isRegistered = await poolSession.isKeystoreRegistered();
    if (isRegistered) {
        throw new Error(
            `Pre-condition violated: ${label}'s keystore IS registered.\n` +
                `→ This example demonstrates the cold-start path used when the recipient has only an ` +
                `EVM address and no on-chain keystore. If the recipient is already registered, ` +
                `EVM-publish is the right path — see \`sample:depositForEVMPublish\`.`,
        );
    }
}

/** Throws unless `poolVaultInteractor.getCommitmentTimestamp(commitment) !== 0`. */
export async function assertCommitmentOnChain(
    poolVaultInteractor: IPoolVaultInteractor,
    commitment: Hash,
): Promise<void> {
    const ts = await poolVaultInteractor.getCommitmentTimestamp(commitment);
    if (BigInt(ts) === 0n) {
        throw new Error(
            `Post-condition violated: commitment ${commitment} not found on-chain.\n` +
                `→ The deposit/transfer transaction succeeded but the commitment is not in the state tree. ` +
                `This is likely a contract bug or the wrong RPC endpoint.`,
        );
    }
}

/** Throws unless `poolVaultInteractor.getNullifierTimestamp(nullifierHash) !== 0`. */
export async function assertNullifierSpent(
    poolVaultInteractor: IPoolVaultInteractor,
    nullifierHash: Hash,
): Promise<void> {
    const ts = await poolVaultInteractor.getNullifierTimestamp(nullifierHash);
    if (BigInt(ts) === 0n) {
        throw new Error(
            `Post-condition violated: nullifier ${nullifierHash} not yet on-chain.\n` +
                `→ The withdraw/ragequit transaction confirmed but the nullifier is not in the contract — ` +
                `this would mean the input note is still spendable, which violates the protocol invariant.`,
        );
    }
}

/** Throws unless `recipientSession.discoverNotes()` returns a note with the given commitment. */
export async function assertRecipientCanDiscoverNote(
    recipientSession: PoolSession,
    expectedCommitment: Hex,
    recipientLabel: string,
): Promise<void> {
    const notes = await recipientSession.discoverNotes();
    const found = notes.some((n) => n.commitment.toLowerCase() === expectedCommitment.toLowerCase());
    if (!found) {
        throw new Error(
            `Post-condition violated: ${recipientLabel} did not discover commitment ${expectedCommitment}.\n` +
                `→ Discoverable transfers/deposits publish encrypted noteData on-chain; the recipient ` +
                `should find the note via \`poolSession.discoverNotes()\`. If this assertion fails, the ` +
                `note announcement was not emitted, the viewing key resolution failed, or the recipient ` +
                `is using the wrong viewing private key.`,
        );
    }
}

/** Throws unless `recipientSession.discoverNotes()` does NOT return the given commitment. */
export async function assertRecipientCannotDiscoverNote(
    recipientSession: PoolSession,
    unexpectedCommitment: Hex,
    recipientLabel: string,
): Promise<void> {
    const notes = await recipientSession.discoverNotes();
    const found = notes.some(
        (n) => n.commitment.toLowerCase() === unexpectedCommitment.toLowerCase(),
    );
    if (found) {
        throw new Error(
            `Post-condition violated: ${recipientLabel} unexpectedly discovered commitment ${unexpectedCommitment}.\n` +
                `→ This example demonstrates a path with no on-chain announcement (cold-start / blind transfer). ` +
                `Auto-discovery should NOT find this note — the recipient must learn \`noteSecret\` out-of-band ` +
                `and call \`importAccount\` manually. If discovery succeeded, the example was misconfigured ` +
                `(probably a discoverable variant masquerading as blind).`,
        );
    }
}

/** Throws unless `actual.toLowerCase() === expected.toLowerCase()`. */
export function assertHexEq(actual: Hex, expected: Hex, label: string): void {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(`Assertion failed (${label}): expected ${expected}, got ${actual}`);
    }
}
