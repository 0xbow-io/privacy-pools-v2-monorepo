import { bytesToHex } from "@noble/ciphers/utils.js";

import type { Address, DiscoveredNote, Hex, NoteEvent, Secret } from "../internal.js";
import { NoteDiscoveryService } from "../internal.js";
// See INoteDiscoveryService.ts's own doc for why the stealth module is imported directly rather
// than through internal.js: it's a deliberately separate, opt-in entry point (its own package
// subpath), not part of evm-sdk's main barrel surface.
import type { Hex as StealthHex, ScanCredentials } from "../stealth/index.js";
import { scanDepositNoteData } from "../stealth/index.js";

/**
 * EVM `NoteDiscoveryService` — adds `scanStealthDeposits` (ERC-5564 stealth-address deposit
 * scanning), the one discovery mode core-sdk's own `NoteDiscoveryService` deliberately omits
 * (see its own doc comment): the stealth address is *computed* via secp256k1 point addition,
 * bound to a pinned Announcer contract, so it's inherently EVM-shaped, not a generic chain
 * capability. Reuses `decryptNotePayload`/`computeNoteCommitment` from the base class rather
 * than duplicating commitment computation.
 */
export class EvmNoteDiscoveryService extends NoteDiscoveryService<Address> {
    /**
     * @inheritdoc INoteDiscoveryService.scanStealthDeposits
     */
    scanStealthDeposits(events: NoteEvent[], credentials: ScanCredentials): DiscoveredNote[] {
        if (events.length === 0) {
            return [];
        }

        const discovered: DiscoveredNote[] = [];

        for (const event of events) {
            const note = this.tryDecryptStealthDepositEvent(event, credentials);
            if (note) discovered.push(note);
        }

        return discovered;
    }

    /**
     * Attempts to match a Note event's `noteData.data` against a stealth scan (see
     * `scanStealthDeposits`). `event.ephemeralPubKey`/`event.encryptedPayload` are core-sdk's
     * own generic split of the raw on-chain `data` bytes at a fixed 32-byte offset
     * (`decodeNoteData`), reconstructed back into the original bytes here, since the stealth
     * payload's own layout (`depositPayload.ts`) is unrelated to that split and must be parsed
     * from the whole, undivided `data`.
     *
     * `match.encryptedNoteSecret` carries the same encrypted, versioned NotePayload RLP blob
     * `decryptNotePayload` already knows how to decode — reused as-is, just supplied the
     * stealth-derived shared secret and stealth address instead of a registered viewing key.
     */
    private tryDecryptStealthDepositEvent(
        event: NoteEvent,
        credentials: ScanCredentials,
    ): DiscoveredNote | null {
        try {
            // Bridge to the stealth module's own branded `Hex`/`Address` types (kept off the
            // main barrel by design, see the import comment above) — same runtime shape
            // (0x-prefixed lowercase hex), different nominal brand, so the cast is safe.
            const rawData = (event.ephemeralPubKey + event.encryptedPayload.slice(2)) as Hex;
            const match = scanDepositNoteData(rawData as unknown as StealthHex, credentials);
            if (!match) return null;

            const sharedSecretHex = `0x${bytesToHex(match.sharedSecret)}` as Secret;
            const payload = this.decryptNotePayload(
                match.encryptedNoteSecret as unknown as Hex,
                sharedSecretHex,
            );
            const ownerAddress = match.stealthAddress as unknown as Address;
            // The stealth address is always EVM-hex-shaped (secp256k1/ERC-5564) and already
            // field-sized, so it goes straight to computeNoteCommitment rather than through
            // an addressFieldConverter.
            const commitment = this.computeNoteCommitment(ownerAddress, payload);

            return {
                commitment,
                ...payload,
                contact: null,
                blockNumber: event.blockNumber,
                txHash: event.txHash,
                ownerAddress,
            };
        } catch {
            return null;
        }
    }
}
