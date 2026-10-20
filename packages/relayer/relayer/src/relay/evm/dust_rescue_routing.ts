import type { Address } from "viem";
import type { EvmDustRescue } from "../../quote/evm/types";
import type { RoutingDustRescue } from "./swap_routing_abi";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const EMPTY_ROUTING_DUST_RESCUE: RoutingDustRescue = {
    chainId: 0n,
    tokenId: ZERO_ADDRESS,
    isCanonical: false,
    spendingPubKey: "0x",
    viewingPubKey: "0x",
};

/**
 * Flattens a quote-time dustRescue opt-in into the on-chain `SwapRouting.dustRescue`
 * shape (RC-10) — encoded into the routing the relayer signs, so it inherits the
 * struct's existing proof-context binding. `undefined` maps to the all-zero sentinel
 * (chainId 0n), which {@link fromRoutingDustRescue} maps back to `undefined`.
 */
export function toRoutingDustRescue(dustRescue: EvmDustRescue | undefined): RoutingDustRescue {
    if (!dustRescue) return EMPTY_ROUTING_DUST_RESCUE;
    const { recipientIdentifier } = dustRescue;
    const isCanonical = recipientIdentifier.kind === "canonical";
    return {
        chainId: BigInt(dustRescue.destinationChainId),
        tokenId: dustRescue.tokenId,
        isCanonical,
        spendingPubKey: recipientIdentifier.spendingPubKey,
        viewingPubKey: isCanonical ? recipientIdentifier.viewingPubKey : "0x",
    };
}

/**
 * Inverse of {@link toRoutingDustRescue} — recovers the dustRescue opt-in from an
 * already-decoded, proof-executed `SwapRouting.dustRescue`. Safe to trust directly at
 * relay time: by the point `EvmRelayService.relaySwap` reaches this, the on-chain
 * transaction has already succeeded, which means the proof's context hash already
 * matched this exact routing — nothing between quote and relay could have altered it.
 *
 * `destinationChainType` is omitted from the result: it's resolved off-chain at
 * quote time and, per {@link toRoutingDustRescue}'s comment, never threaded into
 * `RoutingDustRescue` — so there's nothing here to recover it from.
 */
export function fromRoutingDustRescue(
    routing: RoutingDustRescue,
): Omit<EvmDustRescue, "destinationChainType"> | undefined {
    if (routing.chainId === 0n) return undefined;
    return {
        destinationChainId: Number(routing.chainId),
        tokenId: routing.tokenId,
        recipientIdentifier: routing.isCanonical
            ? { kind: "canonical", spendingPubKey: routing.spendingPubKey, viewingPubKey: routing.viewingPubKey }
            : { kind: "raw", spendingPubKey: routing.spendingPubKey },
    };
}
