import { Account, BASE_FEE, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

import {
    STELLAR_KEY_DERIVATION_DATA_KEY,
    STELLAR_KEY_DERIVATION_SEQUENCE,
} from "../internal.js";

/**
 * Builds the fixed, never-submitted transaction a Stellar wallet signs to produce the raw
 * ed25519 signature `StellarCryptoService.deriveKeysFromSignature` derives keys from.
 *
 * Every field is a constant (fixed sequence number, no time bounds, a single versioned
 * `manage_data` operation with no value) so the exact same bytes get signed every time — EdDSA
 * signing is deterministic (RFC 8032, no per-signature random nonce like ECDSA), so signing this
 * identical transaction twice with the same key always reproduces the identical signature, and
 * therefore the identical derived keys. Using the account's REAL sequence number here would
 * silently change the signed bytes — and therefore the derived keys — every time the account
 * transacts, stranding access to previously-derived notes; that's why it's fixed instead.
 *
 * Never submit this transaction — it exists only to be signed. The signed envelope is,
 * unavoidably on Stellar (unlike EVM's EIP-712, which can never be mistaken for a real
 * transaction), a technically-valid low-stakes transaction: broadcasting it would only set/clear
 * one harmless `manage_data` entry on the signer's own account, never move funds or grant
 * authority.
 *
 * @param ownerAddress - The signer's StrKey account address (source of the built transaction).
 * @param networkPassphrase - The network this signature should be scoped to — baked into the
 *   signed hash (`sha256(networkId ‖ envelope)`), so a signature produced for one network cannot
 *   be reused to derive "the same" keys on another.
 * @returns The unsigned transaction, ready for a wallet's `sign`/`signTransaction` call.
 */
export function buildKeyDerivationTransaction(
    ownerAddress: string,
    networkPassphrase: string,
): Transaction {
    const account = new Account(ownerAddress, STELLAR_KEY_DERIVATION_SEQUENCE);
    return new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
        timebounds: { minTime: 0, maxTime: 0 },
    })
        .addOperation(Operation.manageData({ name: STELLAR_KEY_DERIVATION_DATA_KEY, value: null }))
        .build();
}
