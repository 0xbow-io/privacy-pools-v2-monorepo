import * as freighterApi from "@stellar/freighter-api";

import type { StellarWalletProvider } from "../../internal.js";

/**
 * Builds a {@link StellarWalletProvider} backed by the real, currently-published
 * `@stellar/freighter-api` package — verified directly against its shipped type definitions
 * (`v6.0.1`, the current major), not guessed. The reference implementation's freighter signer
 * module (this SDK's original porting reference) pins `^2.0.0`, whose API shape no longer matches: v2's
 * `getPublicKey`/`signTransaction`/etc. returned bare values and threw on failure; every v5+
 * call instead resolves `{...payload, error?: {code, message, ext?}}` and never throws. This
 * factory is the verified adapter from that shape to {@link StellarWalletProvider}'s
 * bare-value/throwing contract, so `FreighterWalletInteractor`'s existing `classifySignError`
 * (which expects a thrown `Error` to message-sniff) keeps working unchanged.
 *
 * `getAddress` calls `requestAccess` (not the passive `getAddress` export) — matching
 * `EIP1193WalletInteractor.getAccounts`'s use of the connection-prompting `eth_requestAccounts`
 * over the passive `eth_accounts` on the EVM side, so a first-use connection prompt fires the
 * same way on both chains.
 *
 * Freighter's actual extension-side error wording is not part of this npm package (it only
 * relays whatever the installed extension sends over `webextension-polyfill` messaging), so
 * exact message text for "user declined"/"network mismatch"/etc. could not be verified from
 * source — `classifySignError`'s substring matching remains a best-effort heuristic, unchanged.
 */
export function createFreighterProvider(): StellarWalletProvider {
    return {
        async getAddress(): Promise<string> {
            const result = await freighterApi.requestAccess();
            if (result.error) throw new Error(result.error.message);
            return result.address;
        },
        async getNetworkPassphrase(): Promise<string> {
            const result = await freighterApi.getNetworkDetails();
            if (result.error) throw new Error(result.error.message);
            return result.networkPassphrase;
        },
        async signTransaction(
            xdr: string,
            opts: { networkPassphrase: string },
        ): Promise<string> {
            const result = await freighterApi.signTransaction(xdr, {
                networkPassphrase: opts.networkPassphrase,
            });
            if (result.error) throw new Error(result.error.message);
            return result.signedTxXdr;
        },
        async signAuthEntry(
            preimageXdr: string,
            opts: { networkPassphrase: string; address: string },
        ): Promise<string> {
            const result = await freighterApi.signAuthEntry(preimageXdr, opts);
            if (result.error) throw new Error(result.error.message);
            if (!result.signedAuthEntry) throw new Error("wallet returned no auth-entry signature");
            return result.signedAuthEntry;
        },
    };
}
