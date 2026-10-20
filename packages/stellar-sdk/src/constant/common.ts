import { StrKey } from "@stellar/stellar-sdk";

/**
 * Stellar's equivalent "no address" sentinel. Unlike EVM's `address(0)` — a syntactically valid
 * 20-byte value that ABI-encodes fine even though `PoolVault.transact` rejects it as processor —
 * Stellar has no such natural zero address: a StrKey is a checksummed encoding of a real
 * ed25519/contract ID, and `EMPTY_ADDRESS`'s literal `0x00...0` string isn't parseable as one at
 * all (`Address` construction throws immediately, before any on-chain call). This is the
 * all-zero ed25519 public key ("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"),
 * encoded via `StrKey.encodeEd25519PublicKey` — syntactically valid (so it encodes/simulates
 * without error), but not a key anyone holds, matching `EMPTY_ADDRESS`'s role as an
 * intentionally-invalid processor placeholder.
 */
export const STELLAR_EMPTY_ADDRESS = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));
