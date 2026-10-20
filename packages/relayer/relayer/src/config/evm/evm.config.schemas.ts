import { z } from "zod";
import { zFeeBps, zQuoteExpirationTimeMs } from "../common.schemas";
import { Address, getAddress } from "viem";
import { EvmChainId, EvmPrivateKey } from "./evm.types";
import { RateProvider } from "../../rate_provider/rate_types";
import { zNonNegativeBigInt } from "../../relayer.schemas";
import { BPS, Wei } from "../../quote/evm/unit.types";

export const zEvmChainId = z
    .union([z.number(), z.string()])
    .pipe(z.coerce.number().positive())
    .transform((v) => v as EvmChainId);

export const zEvmAddress = z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .length(42)
    .transform((v): Address => getAddress(v));

export const zEvmPrivateKey = z
    .string()
    .regex(/^0x[0-9a-fA-F]+$/)
    .length(66)
    .transform((v) => v as EvmPrivateKey);

export const zEvmAssetConfig = z.object({
    address: zEvmAddress,
    ticker: z.string(),
    quoter: z.nativeEnum(RateProvider),
    // Only with quoter "Underlying": address of the configured asset this ERC-4626 share
    // token redeems into (ppUSDC -> USDC). Must be another entry of the same chain's
    // supported_assets with a real quoter; enforced by RateProviderBootValidator.
    underlying: zEvmAddress.optional(),
    // Only with quoter "Underlying": the wrapper's PPYieldTokenZap. OPTIONAL cross-check —
    // the authoritative zap is derived on-chain at boot from RelaySwaps.approvedZapList()
    // (see YieldZapRegistry), which fails boot if a relay_swaps chain's Underlying asset has
    // no allowlisted zap, or if this value disagrees with the on-chain one.
    zap: zEvmAddress.optional(),
    fee_bps: zFeeBps.transform((v) => BPS(v)).optional(),
    // Token decimals — REQUIRED (no default). The fee conversion scales the native
    // gas cost by 10^decimals to reach this token's base units; a missing/wrong
    // value silently mis-prices fees, so parse must fail loudly rather than assume 18.
    // String input is restricted to decimal digits so an unset template value ("") does
    // NOT coerce to 0 (Number("") === 0); the result is capped at the ERC-20 uint8 range.
    decimals: z
        .string()
        .regex(/^\d+$/)
        .or(z.number())
        .pipe(z.coerce.number().int().nonnegative().max(255)),
});

// Native currency configuration schema
export const zEvmNativeCurrency = z.object({
    name: z.string().default("Ether"),
    symbol: z.string().default("ETH"),
    decimals: z.string().or(z.number()).pipe(z.coerce.number().nonnegative()).default(18),
});

export const zEvmSecretConfig = z.object({
    fee_receiver_address: zEvmAddress,
    signer_private_key: zEvmPrivateKey,
});

// Chain configuration schema without secrets
export const zEvmSafeChainConfig = z.object({
    id: zEvmChainId,
    name: z.string(),
    rpc_url: z.string().url(),
    entrypoint_contract: zEvmAddress,
    relay_contract: zEvmAddress,
    pool_vault_contract: zEvmAddress,
    // Allowlist of alternate transact processors (e.g. PPRouter) the relayer may
    // route a withdrawal through. A request's processorAddress MUST appear here.
    allowed_processors: z.array(zEvmAddress).default([]),
    relay_swaps_contract: zEvmAddress.optional(),
    native_currency: zEvmNativeCurrency.default({}),
    supported_assets: z.array(zEvmAssetConfig),
    flat_fee_amount: zNonNegativeBigInt.default(21_000).transform((v) => Wei(v)),
    // B2 — absolute per-request ceiling (wei) on the client-supplied `swapValue`: the
    // native LayerZero fee that RelaySwaps mints in-contract (from a slice of the
    // withdrawal) and forwards as msg.value on a Mainnet-destination reshield. The relayer
    // does NOT front this — it comes from the user's
    // reshielded principal — but an oversized value on a stale/subverted commitment still
    // burns disproportionate principal on the gas swap, so cap it. The value is in THIS
    // (source) chain's native unit, so one default means different USD on each chain.
    // Default 0.08 native (~$50 on BSC, where B2 is actually funded: a BSC->ETH Stargate fee
    // ran ~0.006 BNB + 1.2x headroom and tripped the old 0.005 default in prod, 2026-10-08).
    // On an ETH-native chain that is ~$200+; tighten per chain with max_swap_value_wei or
    // MAX_SWAP_VALUE_WEI_EVM_<id> (prod sets 0.02 on Mainnet). Enforced in quoteSwap
    // (quote time) and relaySwap (relay time).
    max_swap_value_wei: zNonNegativeBigInt.default("80000000000000000").transform((v) => Wei(v)),
    // Whether a cross-chain bridge can run a destination contract call ON this chain (the
    // deposit into the pool / yield router that ends a cross-chain reshield). Needs LI.FI's
    // receiver contracts (ReceiverAcrossV3 / ReceiverStargateV2 / ...) deployed here; Robinhood
    // and Citrea have none. Fails closed: a chain is refused as a reshield destination until
    // its receivers are confirmed and this is set. Source-side flows (withdraw-and-swap, a
    // reshield FROM this chain) do not read it. Published on /details as
    // `destinationCallsSupported`; the SDK refuses a reshield into a chain reporting false.
    // Env override `DESTINATION_CALLS_SUPPORTED_EVM_<id>` ("true" / "false").
    destination_calls_supported: z.boolean().default(false),
    quote_expiration_ms: zQuoteExpirationTimeMs,
    // Broadcast gas ceiling, as a multiple of the gas each action is priced at
    // (relay_gas_budget.ts: 650k relay, 900k swap, ...). Before signing, the relayer
    // estimates the transaction and refuses it (HTTP 400, no gas spent) when the estimate
    // exceeds `budget × multiplier`, otherwise sends it with the estimate as the gas
    // limit. Stops a recipient whose receive() burns gas from making the relayer pay the
    // block limit for a fixed fee. Env override `RELAY_GAS_CAP_MULTIPLIER_EVM_<chainId>`.
    relay_gas_cap_multiplier: z.coerce.number().int().min(1).max(100).default(3),
    // Cross-chain-reshield dust rescue: the public address (Child 0, see
    // dust_collection_service_detailed_design.org §6) a caller should pass as
    // `dustRecipient` when opting into dustRescue on this destination chain. Optional —
    // a chain without this configured simply can't be a rescue destination. Proving and
    // submission (formerly dust_rescue_asp_url / dust_rescue_circuit_artifacts_dir here)
    // now live entirely in the standalone `dust-rescue-service` package's own config —
    // this relayer no longer proves or submits rescue deposits itself.
    dust_rescue_recipient_address: zEvmAddress.optional(),
});

// Full chain configuration schema
export const zEvmChainConfig = zEvmSafeChainConfig.merge(zEvmSecretConfig);
