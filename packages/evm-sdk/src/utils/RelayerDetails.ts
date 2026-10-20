import type { Address, RelayerChainDetails, RelayerInfo, YieldDeployment } from "../internal.js";
import { InvalidRelayerConfig } from "../internal.js";

/**
 * Builds a {@link RelayerInfo} from what the relayer itself publishes on `/v1/details`, so
 * neither `address` (its signer) nor `processorAddress` (PrivacyPoolRelay — the processor
 * plain relayed withdrawals/transfers bind into their proof) is hand-copied (minr #30).
 *
 * @throws {InvalidRelayerConfig} If the relayer predates discovery and publishes no `relayerAddress`.
 */
export function relayerInfoFromDetails(
    relayer: { url: string; name: string; status?: RelayerInfo["status"] },
    details: RelayerChainDetails,
): RelayerInfo {
    if (!details.relayerAddress) {
        throw new InvalidRelayerConfig(
            `Relayer ${relayer.url} publishes no relayerAddress on /v1/details (predates discovery); pass RelayerInfo explicitly`,
        );
    }
    return {
        url: relayer.url,
        name: relayer.name,
        status: relayer.status ?? "active",
        chainId: details.id,
        chainType: details.type,
        address: details.relayerAddress,
        processorAddress: details.contracts.relay,
    };
}

/**
 * Maps the relayer's published `yield[]` wrappers onto {@link YieldDeployment}s, one per
 * share, so `PoolSessionBuilder.withRelayerDetails()` can enable every wrapper the relayer
 * actually relays (router = the processor bound into yield withdrawal proofs).
 */
export function yieldDeploymentsFromDetails(details: RelayerChainDetails): YieldDeployment[] {
    return (details.yield ?? []).map((w) => ({
        ppRouter: w.router,
        nativeMode: undefined,
        zap: w.zap,
        ppUSDC: w.ppToken,
        ppUSDCDecimals: w.ppDecimals,
        underlying: w.underlying,
        underlyingDecimals: w.underlyingDecimals,
        underlyingSymbol: w.underlyingSymbol,
    }));
}

/** The RelaySwaps address the relayer relays swaps through, or undefined when it supports none. */
export function relaySwapsAddressFromDetails(details: RelayerChainDetails): Address | undefined {
    return details.swapsSupported ? details.contracts.relaySwaps : undefined;
}
