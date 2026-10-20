import type { IKeystoreInteractor } from "../internal.js";
import {
    ContractInteractorBaseError,
    KeystoreNotRegistered,
    RegistrationCheckFailed,
} from "../internal.js";

/**
 * Reads whether `ownerAddress` has an auth policy registered on-chain.
 *
 * Unset `nullifyingKeys` slots read as 0, and `Poseidon(privateNullifyingKey)` is never 0 for any
 * preimage, so a 0 result unambiguously means "not registered".
 *
 * @param keystoreInteractor - The keystore to read the nullifying-key hash from.
 * @param ownerAddress - The account to check.
 * @throws {RegistrationCheckFailed} When the on-chain read fails.
 */
export async function isKeystoreRegisteredOnChain<TTx, TAddress>(
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>,
    ownerAddress: TAddress,
): Promise<boolean> {
    try {
        const nullifyingKeyHash = await keystoreInteractor.getNullifyingKeyHash(ownerAddress);
        return BigInt(nullifyingKeyHash) !== 0n;
    } catch (error) {
        if (error instanceof ContractInteractorBaseError) {
            throw new RegistrationCheckFailed(error.message);
        }
        throw new RegistrationCheckFailed(error instanceof Error ? error.message : String(error));
    }
}

/**
 * Fails fast, before any witness is built, when an account tries to spend without ever having
 * registered: a transact/ragequit witness proves membership of the owner's keystore leaf, so the
 * only alternative is a generic witness failure wrapping a Merkle `LeafNotFound`.
 *
 * Deliberately checks registration only. An account that IS registered but whose session keys
 * produce a leaf missing from the tree (wrong or rotated keys) still fails later, as
 * `WitnessPreparationFailed`, so it is never misreported as "not registered".
 *
 * @param keystoreInteractor - The keystore to read.
 * @param ownerAddress - The spending account.
 * @throws {KeystoreNotRegistered} When the account has no registered auth policy.
 * @throws {RegistrationCheckFailed} When the on-chain read fails.
 */
export async function assertKeystoreRegistered<TTx, TAddress>(
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>,
    ownerAddress: TAddress,
): Promise<void> {
    if (!(await isKeystoreRegisteredOnChain(keystoreInteractor, ownerAddress))) {
        throw new KeystoreNotRegistered(`${ownerAddress}`);
    }
}
