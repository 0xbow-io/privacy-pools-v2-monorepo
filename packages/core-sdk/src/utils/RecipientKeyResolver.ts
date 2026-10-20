import type {
    Address,
    Hex,
    IKeystoreInteractor,
    PreparedTransaction,
} from "../internal.js";

/** Outcome of resolving a recipient's on-chain viewing key. */
export type ResolvedRecipientKey =
    | { kind: "discoverable"; publicViewingKey: Hex }
    | { kind: "outOfBand" };

/** Options for {@link resolveRecipientViewingKey}. */
export interface ResolveRecipientViewingKeyOptions<TAddress = Address> {
    /** When true, an unregistered recipient resolves to `outOfBand` instead of throwing. */
    allowOutOfBandFallback?: boolean;
    /**
     * Builds the error to throw when the recipient has no registered viewing key and
     * `allowOutOfBandFallback` is not set. Each call site supplies its own domain error
     * (e.g. `RecipientViewingKeyUnregistered` for transfers, `DepositRecipientViewingKeyUnregistered`
     * for deposit-for) so this shared lookup does not force a single error hierarchy on every caller.
     */
    onUnregistered: (evmAddress: TAddress) => Error;
}

/**
 * Looks up `evmAddress`'s on-chain viewing key and classifies the result.
 *
 * The on-chain keystore returns the zero sentinel for an unregistered account.
 * Encrypting note data to the all-zero X25519 public key yields a constant,
 * publicly-derivable AEAD key — never safe to use for discovery — so a zero
 * result never resolves to `discoverable`; it either falls back to
 * `outOfBand` (opted in) or throws.
 *
 * RPC errors from the keystore lookup propagate — only the explicit "not
 * registered" (zero sentinel) result is handled here.
 */
export async function resolveRecipientViewingKey<TTx = PreparedTransaction, TAddress = Address>(
    evmAddress: TAddress,
    keystoreInteractor: IKeystoreInteractor<TTx, TAddress>,
    opts: ResolveRecipientViewingKeyOptions<TAddress>,
): Promise<ResolvedRecipientKey> {
    const publicViewingKey = await keystoreInteractor.getViewingKey(evmAddress);
    if (BigInt(publicViewingKey) === 0n) {
        if (!opts.allowOutOfBandFallback) throw opts.onUnregistered(evmAddress);
        return { kind: "outOfBand" };
    }
    return { kind: "discoverable", publicViewingKey };
}
