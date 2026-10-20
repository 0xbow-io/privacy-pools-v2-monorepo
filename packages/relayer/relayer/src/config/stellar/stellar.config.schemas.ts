import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { zFeeBps, zQuoteExpirationTimeMs } from "../common.schemas";
import { zNonNegativeBigInt } from "../../relayer.schemas";
import { StellarChainId, StellarSecretKey } from "./stellar.types";

export const zStellarChainId = z
    .union([z.number(), z.string()])
    .pipe(z.coerce.number().positive())
    .transform((v) => v as StellarChainId);

// `@privacy-pools-v2/stellar-sdk` pins zod v4 while this package (and nestjs-zod) is on zod v3 —
// its own StellarAddressSchema is a different, incompatible ZodType at the type level, so this
// validates the same thing (StrKey.isValidEd25519PublicKey/isValidContract) with this package's
// own zod instance instead of importing that schema directly.
export const zStellarAddress = z.string().refine((val) => StrKey.isValidEd25519PublicKey(val) || StrKey.isValidContract(val), {
    message: "Must be a valid Stellar StrKey account (G...) or contract (C...) address",
});

// Keypair.fromSecret()-shaped: "S" + 55 base32 chars (StrKey alphabet).
export const zStellarSecretKey = z
    .string()
    .regex(/^S[A-Z2-7]{55}$/)
    .transform((v) => v as StellarSecretKey);

export const zStellarAssetConfig = z.object({
    address: zStellarAddress,
    ticker: z.string(),
    // Token decimals — REQUIRED, same rationale as EVM's zEvmAssetConfig: a missing/wrong
    // value silently mis-prices fees, so parse must fail loudly rather than assume a default.
    decimals: z
        .string()
        .regex(/^\d+$/)
        .or(z.number())
        .pipe(z.coerce.number().int().nonnegative().max(255)),
    fee_bps: zFeeBps.optional(),
    // Set on a yield SHARE token: the `yield-router` that unwraps it. The router is then the only
    // processor a withdrawal of this asset may name (Stellar's allowlist is per-asset, so a router
    // can never be pointed at another share), and a flat fee is quoted in shares, converted from
    // stroops at the share token's own `preview_withdraw`.
    yield_router: zStellarAddress.optional(),
    // This asset's flat fee, in its own base units — the UNDERLYING's for a yield share (converted
    // to shares like the chain default). Overrides the chain's `flat_fee_amount`, which is a raw
    // number of base units and so only fits assets worth about what XLM is: 0.02 is right for XLM
    // and USDC but far too much wBTC. There is no price oracle on Stellar to convert one value.
    flat_fee_amount: zNonNegativeBigInt.optional(),
});

export const zStellarSecretConfig = z.object({
    fee_receiver_address: zStellarAddress,
    signer_secret_key: zStellarSecretKey,
});

// Chain configuration schema without secrets
export const zStellarSafeChainConfig = z.object({
    id: zStellarChainId,
    name: z.string(),
    // Stellar has no EVM-style chainId — the network passphrase is what actually
    // distinguishes deployments (e.g. testnet vs. public), and doubles as the
    // domain-separation input for the relayer's off-chain commitment signature
    // (the role EIP-712's chainId+verifyingContract play on EVM).
    network_passphrase: z.string(),
    rpc_url: z.string().url(),
    // Unlike EVM (separate Entrypoint + PoolVault contracts), Stellar's pool contract
    // handles deposits, asset config, and the transact entrypoint directly — no
    // separate Entrypoint contract was ported. See docs/tech-design/stellar-sdk.
    pool_contract: zStellarAddress,
    relay_contract: zStellarAddress,
    keystore_contract: zStellarAddress,
    // Not derivable on-chain (no accessor exists on the pool contract) — must be
    // config-supplied, unlike EVM's contracts which the relayer never needs to know.
    asp_registry_contract: zStellarAddress,
    supported_assets: z.array(zStellarAssetConfig),
    // Stroops, not wei — Soroban resource fees are cheap and stable, so a small flat
    // fee (plus optional per-asset fee_bps) is sufficient; there is no gas-price
    // market to price against the way EVM's flat_fee_amount fallback does. The default for
    // every asset that does not set its own `flat_fee_amount`.
    flat_fee_amount: zNonNegativeBigInt.default(100),
    quote_expiration_ms: zQuoteExpirationTimeMs,
});

// Full chain configuration schema
export const zStellarChainConfig = zStellarSafeChainConfig.merge(zStellarSecretConfig);
