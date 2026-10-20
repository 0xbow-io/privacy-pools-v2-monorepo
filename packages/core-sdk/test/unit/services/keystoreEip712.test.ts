import { concat, encodeAbiParameters, hashTypedData, keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";

import type { Address, Hex } from "../../../src/internal.js";
import {
    buildSetAuthPolicyTypedData,
    KEYSTORE_EIP712_DOMAIN_NAME,
    KEYSTORE_EIP712_DOMAIN_VERSION,
} from "../../../src/internal.js";

const KEYSTORE = "0x1111111111111111111111111111111111111111" as Address;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const AUTH_DIGEST = "0x0000000000000000000000000000000000000000000000000000000000000abc" as Hex;
const NULLIFYING_KEY_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000def" as Hex;
const DEADLINE = "0x1234" as Hex;

describe("buildSetAuthPolicyTypedData", () => {
    it("build the PrivacyPoolsKeystore/1 domain bound to the keystore address and chain", () => {
        const typedData = buildSetAuthPolicyTypedData({
            keystoreAddress: KEYSTORE,
            chainId: 8453,
            account: ACCOUNT,
            authDigest: AUTH_DIGEST,
            nullifyingKeyHash: NULLIFYING_KEY_HASH,
            deadline: DEADLINE,
        });

        expect(typedData.domain).toEqual({
            name: KEYSTORE_EIP712_DOMAIN_NAME,
            version: KEYSTORE_EIP712_DOMAIN_VERSION,
            chainId: 8453,
            verifyingContract: KEYSTORE,
        });
        expect(typedData.domain.name).toBe("PrivacyPoolsKeystore");
        expect(typedData.domain.version).toBe("1");
    });

    it("emit the SetAuthPolicy struct type in the exact contract field order", () => {
        const typedData = buildSetAuthPolicyTypedData({
            keystoreAddress: KEYSTORE,
            chainId: 1,
            account: ACCOUNT,
            authDigest: AUTH_DIGEST,
            nullifyingKeyHash: NULLIFYING_KEY_HASH,
            deadline: DEADLINE,
        });

        expect(typedData.primaryType).toBe("SetAuthPolicy");
        // Order matches SET_AUTH_POLICY_TYPEHASH's abi.encode order in Keystore.sol.
        expect(typedData.types.SetAuthPolicy).toEqual([
            { name: "account", type: "address" },
            { name: "authDigest", type: "uint256" },
            { name: "nullifyingKeyHash", type: "uint256" },
            { name: "deadline", type: "uint256" },
        ]);
    });

    it("convert the hex uint256 fields to bigint so the signature matches abi.encode", () => {
        const typedData = buildSetAuthPolicyTypedData({
            keystoreAddress: KEYSTORE,
            chainId: 1,
            account: ACCOUNT,
            authDigest: AUTH_DIGEST,
            nullifyingKeyHash: NULLIFYING_KEY_HASH,
            deadline: DEADLINE,
        });

        expect(typedData.message).toEqual({
            account: ACCOUNT,
            authDigest: 0xabcn,
            nullifyingKeyHash: 0xdefn,
            deadline: 0x1234n,
        });
        expect(typeof typedData.message.authDigest).toBe("bigint");
        expect(typeof typedData.message.deadline).toBe("bigint");
    });

    it("hash to the same EIP-712 digest the contract reconstructs on-chain", () => {
        const CHAIN_ID = 8453;
        const typedData = buildSetAuthPolicyTypedData({
            keystoreAddress: KEYSTORE,
            chainId: CHAIN_ID,
            account: ACCOUNT,
            authDigest: AUTH_DIGEST,
            nullifyingKeyHash: NULLIFYING_KEY_HASH,
            deadline: DEADLINE,
        });

        // Independently reconstruct keccak256(0x1901 ‖ domainSeparator ‖ structHash) the way
        // Keystore.sol does, from the raw type strings — a mismatch means the SDK drifted from
        // the contract's SET_AUTH_POLICY_TYPEHASH or field order and signatures would not verify.
        const domainTypeHash = keccak256(
            stringToHex(
                "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
            ),
        );
        const domainSeparator = keccak256(
            encodeAbiParameters(
                [
                    { type: "bytes32" },
                    { type: "bytes32" },
                    { type: "bytes32" },
                    { type: "uint256" },
                    { type: "address" },
                ],
                [
                    domainTypeHash,
                    keccak256(stringToHex(KEYSTORE_EIP712_DOMAIN_NAME)),
                    keccak256(stringToHex(KEYSTORE_EIP712_DOMAIN_VERSION)),
                    BigInt(CHAIN_ID),
                    KEYSTORE,
                ],
            ),
        );
        const structTypeHash = keccak256(
            stringToHex(
                "SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)",
            ),
        );
        const structHash = keccak256(
            encodeAbiParameters(
                [
                    { type: "bytes32" },
                    { type: "address" },
                    { type: "uint256" },
                    { type: "uint256" },
                    { type: "uint256" },
                ],
                [
                    structTypeHash,
                    ACCOUNT,
                    BigInt(AUTH_DIGEST),
                    BigInt(NULLIFYING_KEY_HASH),
                    BigInt(DEADLINE),
                ],
            ),
        );
        const expectedDigest = keccak256(concat(["0x1901", domainSeparator, structHash]));

        expect(hashTypedData(typedData)).toBe(expectedDigest);
    });

    it("bind the digest to the chain id and keystore address", () => {
        const base = {
            keystoreAddress: KEYSTORE,
            chainId: 1,
            account: ACCOUNT,
            authDigest: AUTH_DIGEST,
            nullifyingKeyHash: NULLIFYING_KEY_HASH,
            deadline: DEADLINE,
        };
        const baseDigest = hashTypedData(buildSetAuthPolicyTypedData(base));

        // A different chain id must produce a different digest (domain-separated).
        const otherChain = hashTypedData(buildSetAuthPolicyTypedData({ ...base, chainId: 8453 }));
        expect(otherChain).not.toBe(baseDigest);

        // A different keystore (verifyingContract) must produce a different digest.
        const otherKeystore = hashTypedData(
            buildSetAuthPolicyTypedData({
                ...base,
                keystoreAddress: "0x3333333333333333333333333333333333333333" as Address,
            }),
        );
        expect(otherKeystore).not.toBe(baseDigest);
    });
});
