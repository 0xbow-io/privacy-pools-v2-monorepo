import type { IRelayerInteractor, RelayerInfo, StellarAddress } from "../src/internal.js";
import { InvalidBuilderConfig } from "../src/internal.js";

/**
 * A relayer interactor whose `getRelayers()` resolves an empty list and every other method
 * throws. Needed even for purely self-submit sessions: `PoolSessionWithdraw.prepareWithdraw`
 * calls `relayerInteractor.getRelayers()` unconditionally before witness building, so the
 * builder's *default* unconfigured-relayer stub — which throws synchronously on every method,
 * including `getRelayers()` — would break self-submit withdrawals too, not just relayed ones.
 *
 * Ported from the retired `packages/stellar-sdk/scripts/e2e-stellar/noRelayerInteractor.ts`.
 */
// Deliberately implements only `getRelayers` — the other ~11 IRelayerInteractor methods are
// supplied by the Proxy in createNoRelayerInteractor below, not by this class, so it does not
// (and must not) declare `implements IRelayerInteractor<StellarAddress>` itself.
class NoRelayerInteractorBase {
    async getRelayers(): Promise<RelayerInfo<StellarAddress>[]> {
        return [];
    }
}

// Every other IRelayerInteractor method throws via this Proxy trap — cheaper than hand-writing
// ~11 near-identical rejected-promise methods for paths this test never exercises through this
// stub (only getRelayers() is ever actually called on a self-submit session).
export function createNoRelayerInteractor(): IRelayerInteractor<StellarAddress> {
    const base = new NoRelayerInteractorBase();
    return new Proxy(base as unknown as IRelayerInteractor<StellarAddress>, {
        get(target, prop, receiver) {
            if (prop === "getRelayers") {
                return Reflect.get(target, prop, receiver);
            }
            return (): never => {
                throw new InvalidBuilderConfig(
                    `Relaying is not configured in this e2e run — supply a real relayer to use ${String(prop)}()`,
                );
            };
        },
    });
}
