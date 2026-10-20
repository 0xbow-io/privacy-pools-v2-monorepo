import {
    ASPCipherTextPayload,
    ASPCipherTextPayloadSchema,
    DecodingKeys,
    EncodingKeys,
    Hex,
    InvalidASPCipherText,
    UtilsDependencies,
} from "../internal.js";

/**
 * Encrypts the deposit payload for the ASP using a freshly-generated
 * ephemeral X25519 keypair (ECDH with the ASP's public key). The resulting
 * ciphertext is prefixed with the **ephemeral** public key, never the
 * depositor's long-term registered viewing key — this mirrors the note-
 * discovery pattern and prevents anyone joining `ASPRegistry.LabelRegistered`
 * events with on-chain `Keystore.setViewingKey` registrations from
 * deanonymizing the depositor by exact-matching the ciphertext prefix.
 *
 * The ASP decoder is unchanged: it still treats the prefix as an opaque
 * X25519 counterparty pubkey and ECDH-decrypts with its private key, so
 * existing ASP infrastructure is wire-compatible.
 */
export const encodeASPCipherText = (
    payload: ASPCipherTextPayload,
    keys: EncodingKeys,
    dependencies: UtilsDependencies,
): Hex => {
    const { aspPublicKey } = keys;
    const { cryptoService } = dependencies;
    const textEncoder = new TextEncoder();

    dependencies.logger?.info("Encoding ASP ciphertext");
    dependencies.logger?.debug("ASPCipherText payload and keys", {
        noteAddresHash: payload.noteAddressHash,
        tokenId: payload.tokenId,
        value: payload.value,
        aspPublicKey,
    });

    const ephemeralKey = cryptoService.generateEphemeralKeyPair();
    const sharedSecret = cryptoService.ecdh(ephemeralKey.privateKey, aspPublicKey);
    const plaintext = textEncoder.encode(JSON.stringify(payload));
    const encrypted = cryptoService.encrypt(plaintext, sharedSecret);

    return ("0x" + ephemeralKey.publicKey.slice(2) + encrypted.slice(2)) as Hex;
};

export const decodeASPCipherText = (
    aspCipherText: Hex,
    keys: DecodingKeys,
    dependencies: UtilsDependencies,
): ASPCipherTextPayload => {
    const { aspPrivateKey } = keys;
    const { cryptoService } = dependencies;
    const textEncoder = new TextDecoder();

    dependencies.logger?.info("Decoding ASP ciphertext");

    const ciphertextHex = aspCipherText.slice(2);
    const senderPubKey = ("0x" + ciphertextHex.slice(0, 64)) as Hex;
    const encrypted = ("0x" + ciphertextHex.slice(64)) as Hex;

    dependencies.logger?.debug(`Sender viewing pubkey: ${senderPubKey}`);

    const sharedSecret = cryptoService.ecdh(aspPrivateKey, senderPubKey);
    const decryptedBytes = cryptoService.decrypt(encrypted, sharedSecret);

    const jsonString = textEncoder.decode(decryptedBytes);
    try {
        const result = ASPCipherTextPayloadSchema.safeParse(JSON.parse(jsonString));
        if (!result.success) {
            throw new InvalidASPCipherText(result.error.issues[0]!.message);
        }

        return result.data;
    } catch (error) {
        if (error instanceof InvalidASPCipherText) {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new InvalidASPCipherText(`Failed to parse JSON: ${message}`);
    }
};
