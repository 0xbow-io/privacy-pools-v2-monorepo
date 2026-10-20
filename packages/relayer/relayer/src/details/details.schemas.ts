import { z } from "zod";
import { zEvmAddress, zEvmChainId } from "../config/evm/evm.config.schemas";
import { zNonNegativeBigInt } from "../relayer.schemas";
import { ChainType } from "../config/enums";
import { BPS, Wei } from "../quote/evm/unit.types";

// -========- Response schemas -========-

export const zAsset = z.object({
    address: zEvmAddress,
    ticker: z.string(),
});

export const zAssetConfig = zAsset.extend({
    fixedFeeAmount: zNonNegativeBigInt.transform((v) => Wei(v)),
    feeBPS: zNonNegativeBigInt.transform((v) => BPS(v)).optional(),
});

export const zChainContracts = z.object({
    entrypoint: zEvmAddress,
    poolVault: zEvmAddress,
    relay: zEvmAddress,
    // Absent when the chain has no RelaySwaps deployment. Zero-address config
    // placeholders are normalized to absent by the details service, never echoed.
    relaySwaps: zEvmAddress.optional(),
});

// One yield wrapper a client may hold shares of (minr #30). `router` is the `transact`
// processor to bind for a relayed yield withdrawal; `zap` the loose-share exit helper.
export const zYieldWrapper = z.object({
    ppToken: zEvmAddress,
    underlying: zEvmAddress,
    router: zEvmAddress,
    zap: zEvmAddress,
    ppDecimals: z.number().int().nonnegative(),
    underlyingDecimals: z.number().int().nonnegative(),
    underlyingSymbol: z.string(),
});

export const zChainConfig = z.object({
    id: zEvmChainId,
    name: z.string(),
    type: z.nativeEnum(ChainType),
    contracts: zChainContracts,
    swapsSupported: z.boolean(),
    // Whether a cross-chain reshield may END on this chain (a bridge can run the destination
    // deposit call here). `destination_calls_supported`; clients refuse a reshield into a chain
    // reporting false before quoting.
    destinationCallsSupported: z.boolean(),
    assets: z.array(zAssetConfig),
    // The relayer's own signer address on this chain: `msg.sender` of every relay, i.e.
    // `RelayerInfo.address`. Published so clients stop hand-copying it.
    relayerAddress: zEvmAddress,
    // `allowed_processors` verbatim — every alternate `transact` processor a relay may name.
    processors: z.array(zEvmAddress),
    // Boot-derived (YieldDiscoveryService) from the routers above; `[]` without routers.
    yield: z.array(zYieldWrapper),
    // Per-chain native-wei ceiling the quote/relay paths enforce, published so clients can
    // refuse an over-cap request before proving instead of hitting the HTTP 400.
    // `max_swap_value_wei` (B2): the LayerZero fee RelaySwaps mints in-contract on a
    // Mainnet-destination reshield, in this (source) chain's native units.
    maxSwapValueWei: zNonNegativeBigInt.transform((v) => Wei(v)),
});

export const zFullConfig = z.object({
    // Relayer build version (package.json) — identifies the deployed release.
    version: z.string(),
    chains: z.array(zChainConfig),
});
