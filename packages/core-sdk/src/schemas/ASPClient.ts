import { z } from "zod";

import {
    AddressSchema,
    DecimalRepresentationToHexSchema,
    DepositSecretSchema,
    HexSchema,
    NoteAddressHashSchema,
} from "./common.js";
import { PublicKeySchema } from "./CryptoService.js";

/** Validates the ASPClient constructor config. */
export const ASPClientConfigSchema = z.object({
    providers: z.array(z.any()).min(1, "At least one provider is required"),
});

/**
 * Validates the `/public-key` response from an ASP HTTP backend. Catches
 * misconfigured or malformed pubkey responses at the API boundary before
 * the value is fed into `cryptoService.ecdh(...)`, where a bad pubkey would
 * either throw deep in the crypto layer or silently produce a useless
 * shared secret. Inner key is required as 0x-prefixed hex; deeper X25519
 * length checks happen at the consumer (`PublicKey` boundary).
 */
export const ASPPublicKeyResponseSchema = z.object({
    publicKey: PublicKeySchema,
});

/**
 * Validates the structure of an ASP-ciphertext payload after AEAD decrypt.
 * The SDK both produces and (via the exported helper) potentially consumes
 * this shape — Zod-parsing here catches encode/decode version skew and any
 * decrypt-succeeded-but-bytes-are-garbage edge case with a typed error
 * instead of letting `undefined` propagate downstream.
 */
export const ASPCipherTextPayloadSchema = z.object({
    noteAddressHash: NoteAddressHashSchema,
    tokenId: AddressSchema,
    value: HexSchema,
    depositSecret: DepositSecretSchema,
    metadata: HexSchema,
});

/**
 * Validates the JSON payload pinned to IPFS by an ASP. The multihash check in
 * `IpfsASPDataProvider` already proves the bytes match what the on-chain CID
 * pinned; this schema catches structural drift (missing `leaves`, wrong type,
 * non-hex/decimal entries) before the leaves reach the Merkle root cross-check
 * with a typed `IPFSFetchFailed` instead of a downstream TypeError.
 *
 * Accepts both decimal-string and 0x-prefixed hex leaf entries (mirrors the
 * HTTP-side wire convention) and normalizes to canonical hex.
 */
export const IPFSLeavesPayloadSchema = z.object({
    leaves: z.array(DecimalRepresentationToHexSchema),
});

/**
 * Validates the HttpASPDataProvider constructor config. `entrypointAddress` is a non-empty
 * string rather than `AddressSchema` — the ASP's HTTP API treats it as an opaque per-chain
 * scoping string (see `HttpASPDataProviderConfig`'s doc comment), not an EVM-only value.
 */
export const HttpASPDataProviderConfigSchema = z.object({
    aspUrl: z
        .url("Must be a valid URL")
        .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
            message: "URL must use http or https protocol",
        }),
    chainId: z.number().int().positive("Chain ID must be a positive integer"),
    entrypointAddress: z.string().min(1, "entrypointAddress must not be empty"),
});

/**
 * Validates the per-label status object returned by the ASP. Mirrors
 * {@link LabelStatus}; consumed by `HttpASPDataProvider.getLabelStatus` to
 * verify the HTTP body before treating it as trusted SDK data.
 */
export const LabelStatusSchema = z.object({
    status: z.enum(["pending", "approved", "rejected", "poi_required", "unknown"]),
    timestamp: z.number().int().nonnegative().optional(),
});
