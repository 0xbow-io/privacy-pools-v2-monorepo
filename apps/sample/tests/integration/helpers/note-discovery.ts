import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import type {
  Address,
  Hash,
  Hex,
  ICryptoService,
  NoteEvent,
  NotePayload,
  PublicKey,
  Secret,
} from "@privacy-pools-v2/evm-sdk";
import { CATCH_ALL_TAG } from "@privacy-pools-v2/evm-sdk";

import type { TransferResult } from "./types.js";

/**
 * Builds a simulated NoteEvent with real encryption.
 *
 * Used in e2e tests to create events that can be fed to `discoverNotes()`.
 * The encryption uses real ECDH + XChaCha20-Poly1305 — only the event
 * construction is simulated (instead of parsing from on-chain logs).
 */
export function buildSimulatedNoteEvent(params: {
  crypto: ICryptoService;
  recipientViewingPubKey: PublicKey;
  notePayload: NotePayload;
  blockNumber: Hex;
  txHash: Hash;
  asset: Address;
}): NoteEvent {
  // Generate ephemeral key pair
  const ephemeralPrivKey = params.crypto.generateSecret();
  const ephemeralPubKeyBytes = x25519.getPublicKey(hexToBytes(ephemeralPrivKey.slice(2)));
  const ephemeralPubKey = `0x${bytesToHex(ephemeralPubKeyBytes)}` as PublicKey;

  // ECDH shared secret
  const sharedSecret = params.crypto.ecdh(
    ephemeralPrivKey,
    params.recipientViewingPubKey,
  );

  // Encrypt the JSON-encoded payload
  const payloadJson = JSON.stringify(params.notePayload);
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const encryptedPayload = params.crypto.encrypt(payloadBytes, sharedSecret);

  return {
    blockNumber: params.blockNumber,
    txHash: params.txHash,
    tag: CATCH_ALL_TAG,
    ephemeralPubKey,
    encryptedPayload,
  };
}

/**
 * Builds simulated NoteEvents from a transfer result.
 *
 * Convenience wrapper that extracts the note payload from the transfer result
 * and encrypts it for the recipient. Returns a single-element array.
 */
export function buildEventsFromTransferResult(params: {
  crypto: ICryptoService;
  recipientViewingPubKey: PublicKey;
  transferResult: TransferResult;
  blockNumber: Hex;
  txHash: Hash;
  asset: Address;
}): NoteEvent[] {
  const { recipientNoteData } = params.transferResult;

  const notePayload: NotePayload = {
    noteSecret: recipientNoteData.noteSecret as Secret,
    value: recipientNoteData.value,
    tokenId: recipientNoteData.tokenId as Address,
    label: recipientNoteData.label,
  };

  return [
    buildSimulatedNoteEvent({
      crypto: params.crypto,
      recipientViewingPubKey: params.recipientViewingPubKey,
      notePayload,
      blockNumber: params.blockNumber,
      txHash: params.txHash,
      asset: params.asset,
    }),
  ];
}
