import { z } from "zod";

import { HexSchema } from "./common.js";
import { SecretSchema } from "./CryptoService.js";

// Deliberately just HexSchema, not the curve-specific PublicKeySchema/StellarPublicKeySchema —
// the byte length differs per curve (32B X25519 vs 33B compressed secp256k1), and
// KeystoreManager's constructor already validates the real invariant (viewingPublicKey matches
// viewingPrivateKey on `config.curve`), which implicitly rejects a wrong-length key too.
export const KeystoreManagerConfigSchema = z.object({
    privateNullifyingKey: SecretSchema,
    privateRevocableKey: SecretSchema,
    viewingPrivateKey: SecretSchema,
    viewingPublicKey: HexSchema,
    revocableKeyIndex: HexSchema,
    curve: z.enum(["x25519", "secp256k1"]).optional(),
});
