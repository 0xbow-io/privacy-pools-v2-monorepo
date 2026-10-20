import { encodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Eip712TypedData,
    FinalizedBlockResult,
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    IKeystoreInteractor,
    IKeystoreManager,
    IMerkleService,
    INoteComputationService,
    IRPCInteractor,
    PoolSessionKeystoreConfig,
    PublicKey,
    RotateRevocableKeyResult,
    Secret,
    ViewingKeyPair,
} from "../../../src/internal.js";
import {
    AlreadyRegistered,
    AddressSchema,
    buildSetAuthPolicyTypedData,
    ContractCallError,
    EvmAddressFieldConverter,
    EvmPreparedTxVerifier,
    InvalidPoolSessionKeystoreConfig,
    KEYSTORE_WRITE_ABI,
    KeystoreAlreadyRegistered,
    PoolSessionKeystore,
    RegistrationCheckFailed,
    RegistrationDeadlineInPast,
    RotationKeyMismatch,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_KEYSTORE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const VALID_CHAIN_ID = 1;

const MOCK_PRIVATE_NULLIFYING_KEY =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
const MOCK_PRIVATE_REVOCABLE_KEY =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Secret;
const MOCK_VIEWING_PUBLIC_KEY =
    "0x033333333333333333333333333333333333333333333333333333333333333333" as PublicKey;
const MOCK_VIEWING_PRIVATE_KEY =
    "0x4444444444444444444444444444444444444444444444444444444444444444" as Secret;

const ZERO_HASH = "0x0" as Hash;
const MOCK_NULLIFYING_KEY_HASH =
    "0xaaaa000000000000000000000000000000000000000000000000000000000000" as Hash;
const MOCK_AUTH_DIGEST =
    "0xcccc000000000000000000000000000000000000000000000000000000000000" as Hash;

const MOCK_VIEWING_KEY_PAIR: ViewingKeyPair = {
    privateKey: MOCK_VIEWING_PRIVATE_KEY,
    publicKey: MOCK_VIEWING_PUBLIC_KEY,
};

function buildConfig(overrides?: Partial<PoolSessionKeystoreConfig>): PoolSessionKeystoreConfig {
    const keystoreManager: IKeystoreManager = {
        getPrivateNullifyingKey: vi.fn().mockReturnValue(MOCK_PRIVATE_NULLIFYING_KEY),
        getPrivateRevocableKey: vi.fn().mockReturnValue(MOCK_PRIVATE_REVOCABLE_KEY),
        getViewingKeyPair: vi.fn().mockReturnValue(MOCK_VIEWING_KEY_PAIR),
        applyRotation: vi.fn(),
        getRevocableKeyIndex: vi.fn().mockReturnValue("0x0" as Hex),
        isRegistered: vi.fn().mockReturnValue(false),
        markRegistered: vi.fn(),
    };

    const keystoreInteractor: IKeystoreInteractor = {
        getAddress: vi.fn().mockReturnValue(VALID_KEYSTORE),
        getNullifyingKeyHash: vi.fn().mockResolvedValue(ZERO_HASH),
        getViewingKey: vi.fn().mockResolvedValue(ZERO_HASH),
        isKnownRoot: vi.fn().mockResolvedValue(false),
        getKeystoreLeaves: vi.fn().mockResolvedValue([]),
        exportLeafCache: vi.fn().mockReturnValue(undefined),
        getCurrentAuthorizerDigest: vi.fn().mockResolvedValue(null),
        encodeSetAuthPolicy: vi.fn().mockReturnValue({
            to: VALID_KEYSTORE,
            data: encodeFunctionData({
                abi: KEYSTORE_WRITE_ABI,
                functionName: "setAuthPolicy",
                args: [1n, 2n],
            }),
            value: "0x0" as Hex,
        }),
        encodeSetViewingKey: vi.fn().mockReturnValue({
            to: VALID_KEYSTORE,
            data: encodeFunctionData({
                abi: KEYSTORE_WRITE_ABI,
                functionName: "setViewingKey",
                args: [("0x" + "ab".repeat(32)) as Hex],
            }),
            value: "0x0" as Hex,
        }),
        // Encodes its real arguments (instead of a canned blob) because executeRotateRevocableKey
        // decodes the digests back out of this calldata.
        encodeUpdateAuthPolicy: vi
            .fn()
            .mockImplementation((oldDigest: Hash, newDigest: Hash, siblings: Hash[]) => ({
                to: VALID_KEYSTORE,
                data: encodeFunctionData({
                    abi: KEYSTORE_WRITE_ABI,
                    functionName: "updateAuthPolicy",
                    args: [BigInt(oldDigest), BigInt(newDigest), siblings.map((s) => BigInt(s))],
                }),
                value: "0x0" as Hex,
            })),
        submitTransaction: vi.fn().mockResolvedValue("0x1234" as Hex),
        signTypedData: vi.fn().mockResolvedValue("0xsig" as Hex),
        // The EVM adapter's real authorization builder (EIP-712 over this keystore + chain), signed
        // through the same mocked signTypedData — what KeystoreInteractor delegates to.
        buildRegistrationAuthorization: vi.fn(async (args: { account: Address; nullifyingKeyHash: Hex; authDigest: Hex; deadline: Hex; chainId: number }) =>
            buildSetAuthPolicyTypedData({ keystoreAddress: VALID_KEYSTORE, ...args }),
        ),
        signRegistrationAuthorization: vi.fn(async (t: unknown) => keystoreInteractor.signTypedData(t as Eip712TypedData)),
    };

    const noteComputationService: INoteComputationService = {
        computeAuthDigest: vi.fn().mockReturnValue(MOCK_AUTH_DIGEST),
        computeNoteAddressHash: vi.fn().mockReturnValue("0xdeadbeef" as Hash),
        computePrecommitment: vi.fn().mockReturnValue("0xdeadbeef" as Hash),
        computeLabel: vi.fn().mockReturnValue("0xdeadbeef" as Hash),
        computeFullCommitment: vi.fn().mockReturnValue("0xdeadbeef" as Hash),
        computeNullifier: vi.fn().mockReturnValue("0xdeadbeef" as Hash),
        computeLabelHash: vi.fn().mockReturnValue("0xdeadbeef" as Hash),
        encodeNotePayload: vi.fn().mockReturnValue(new Uint8Array(117)),
        decodeNotePayload: vi.fn().mockReturnValue({
            noteSecret: "0x0" as Secret,
            value: "0x0" as Hash,
            tokenId: "0x0" as Address,
            label: "0x0" as Hash,
        }),
        generateNoteData: vi.fn().mockReturnValue({ hint: "0x0" as Hash, data: "0x0" as Hash }),
        encodePaymentRequestNotePayload: vi.fn().mockReturnValue(new Uint8Array()),
        decodePaymentRequestNotePayload: vi.fn(),
        generatePaymentRequestNoteData: vi
            .fn()
            .mockReturnValue({ hint: "0x0" as Hash, data: "0x0" as Hash }),
    };

    const hashService: IHashService = {
        hash: vi.fn().mockReturnValue(MOCK_NULLIFYING_KEY_HASH),
    };

    const rpcInteractor: IRPCInteractor = {
        readContract: vi.fn(),
        getBlockNumber: vi.fn(),
        getFinalizedBlockNumber: vi.fn(
            async () => ({ status: "unsupported" }) as FinalizedBlockResult,
        ),
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
            status: true,
            blockNumber: ("0x" + "00".repeat(31) + "01") as Hex,
            txHash: ("0x" + "00".repeat(31) + "01") as Hex,
            logs: [],
        }),
        getLogs: vi.fn(),
        getLogsPaginated: vi.fn(),
    };

    const merkleService: IMerkleService = {
        generateMerkleProof: vi.fn().mockResolvedValue({
            leaf: "0x0" as Hex,
            root: "0x0" as Hex,
            siblings: [] as Hex[],
            index: 0,
        }),
        verifyMerkleProof: vi.fn().mockResolvedValue(true),
        padSiblings: vi.fn().mockReturnValue([]),
        computeRoot: vi.fn().mockResolvedValue("0x0" as Hex),
    };

    const cryptoService: ICryptoService = {
        deriveKeysFromSignature: vi.fn(),
        derivePaymentRequestKeyPair: vi.fn(),
        generateSecret: vi.fn(),
        generateEphemeralKeyPair: vi.fn(),
        ecdh: vi.fn(),
        encrypt: vi.fn(),
        decrypt: vi.fn(),
    };

    return {
        ownerAddress: VALID_OWNER,
        chainId: VALID_CHAIN_ID,
        keystoreManager,
        keystoreInteractor,
        noteComputationService,
        hashService,
        merkleService,
        cryptoService,
        rpcInteractor,
        preparedTxVerifier: new EvmPreparedTxVerifier(),
        addressFieldConverter: new EvmAddressFieldConverter(),
        addressSchema: AddressSchema,
        ...overrides,
    };
}

describe("PoolSessionKeystore", () => {
    describe("constructor", () => {
        it("constructs successfully with valid config", () => {
            expect(() => new PoolSessionKeystore(buildConfig())).not.toThrow();
        });

        it("throws InvalidPoolSessionKeystoreConfig for invalid ownerAddress", () => {
            expect(
                () =>
                    new PoolSessionKeystore(
                        buildConfig({ ownerAddress: "not-an-address" as Address }),
                    ),
            ).toThrow(InvalidPoolSessionKeystoreConfig);
        });

        it("throws InvalidPoolSessionKeystoreConfig for non-positive chainId", () => {
            expect(() => new PoolSessionKeystore(buildConfig({ chainId: 0 }))).toThrow(
                InvalidPoolSessionKeystoreConfig,
            );
        });
    });

    describe("isKeystoreRegistered", () => {
        it("returns false when account is not registered on-chain", async () => {
            const session = new PoolSessionKeystore(buildConfig());
            await expect(session.isKeystoreRegistered()).resolves.toBe(false);
        });

        it("returns true when nullifyingKeyHash is non-zero on-chain", async () => {
            const config = buildConfig();
            (
                config.keystoreInteractor.getNullifyingKeyHash as ReturnType<typeof vi.fn>
            ).mockResolvedValue(MOCK_NULLIFYING_KEY_HASH);

            const session = new PoolSessionKeystore(config);
            await expect(session.isKeystoreRegistered()).resolves.toBe(true);
        });

        it("throws RegistrationCheckFailed when the RPC call fails", async () => {
            const config = buildConfig();
            (
                config.keystoreInteractor.getNullifyingKeyHash as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new ContractCallError("RPC error"));

            const session = new PoolSessionKeystore(config);
            await expect(session.isKeystoreRegistered()).rejects.toThrow(RegistrationCheckFailed);
        });
    });

    describe("prepareRegisterKeystore", () => {
        let session: PoolSessionKeystore;
        let config: PoolSessionKeystoreConfig;

        beforeEach(() => {
            config = buildConfig();
            session = new PoolSessionKeystore(config);
        });

        it("returns keystoreCalldata and viewingKeyCalldata when not registered", async () => {
            const result = await session.prepareRegisterKeystore();

            expect(result.alreadyRegistered).toBe(false);
            expect(result.keystoreCalldata).not.toBeNull();
            expect(result.keystoreCalldata!.to).toBe(VALID_KEYSTORE);
            expect(result.keystoreCalldata!.value).toBe("0x0");
            expect(result.viewingKeyCalldata).not.toBeNull();
            expect(result.viewingKeyCalldata!.to).toBe(VALID_KEYSTORE);
        });

        it("returns null viewingKeyCalldata when includeViewingKey is false", async () => {
            const result = await session.prepareRegisterKeystore({ includeViewingKey: false });

            expect(result.alreadyRegistered).toBe(false);
            expect(result.keystoreCalldata).not.toBeNull();
            expect(result.viewingKeyCalldata).toBeNull();
        });

        it("returns correct nullifyingKeyHash and authDigest", async () => {
            const result = await session.prepareRegisterKeystore();

            expect(result.nullifyingKeyHash).toBe(MOCK_NULLIFYING_KEY_HASH);
            expect(result.authDigest).toBe(MOCK_AUTH_DIGEST);
        });

        it("computes hashes using privateNullifyingKey and privateRevocableKey", async () => {
            await session.prepareRegisterKeystore();

            expect(config.hashService.hash).toHaveBeenCalledWith([MOCK_PRIVATE_NULLIFYING_KEY]);
            expect(config.noteComputationService.computeAuthDigest).toHaveBeenCalledWith(
                MOCK_PRIVATE_REVOCABLE_KEY,
            );
        });

        it("returns alreadyRegistered true with null calldata when already registered", async () => {
            (
                config.keystoreInteractor.getNullifyingKeyHash as ReturnType<typeof vi.fn>
            ).mockResolvedValue(MOCK_NULLIFYING_KEY_HASH);
            (config.keystoreInteractor.getViewingKey as ReturnType<typeof vi.fn>).mockResolvedValue(
                MOCK_VIEWING_PUBLIC_KEY,
            );

            const result = await session.prepareRegisterKeystore();

            expect(result.alreadyRegistered).toBe(true);
            expect(result.keystoreCalldata).toBeNull();
            expect(result.viewingKeyCalldata).toBeNull();
            expect(result.nullifyingKeyHash).toBe(MOCK_NULLIFYING_KEY_HASH);
            expect(result.authDigest).toBe(MOCK_AUTH_DIGEST);
        });

        it("returns viewing-key calldata only when auth policy is on-chain but viewing key missing", async () => {
            (
                config.keystoreInteractor.getNullifyingKeyHash as ReturnType<typeof vi.fn>
            ).mockResolvedValue(MOCK_NULLIFYING_KEY_HASH);
            (config.keystoreInteractor.getViewingKey as ReturnType<typeof vi.fn>).mockResolvedValue(
                ZERO_HASH,
            );

            const result = await session.prepareRegisterKeystore();

            expect(result.alreadyRegistered).toBe(false);
            expect(result.keystoreCalldata).toBeNull();
            expect(result.viewingKeyCalldata).not.toBeNull();
        });

        it("delegate calldata encoding to keystoreInteractor", async () => {
            await session.prepareRegisterKeystore();

            expect(config.keystoreInteractor.encodeSetAuthPolicy).toHaveBeenCalled();
            expect(config.keystoreInteractor.encodeSetViewingKey).toHaveBeenCalled();
        });

        it("does not call markRegistered on the keystoreManager", async () => {
            await session.prepareRegisterKeystore();
            expect(config.keystoreManager.markRegistered).not.toHaveBeenCalled();
        });
    });

    describe("prepareRelayedRegistration", () => {
        // Far-future so the courtesy deadline guard always passes regardless of the wall clock.
        const FUTURE_DEADLINE = "0xffffffffff" as Hex;
        let session: PoolSessionKeystore;
        let config: PoolSessionKeystoreConfig;

        beforeEach(() => {
            config = buildConfig();
            session = new PoolSessionKeystore(config);
        });

        it("compute the registration values and sign by default", async () => {
            const result = await session.prepareRelayedRegistration({ deadline: FUTURE_DEADLINE });

            expect(result.account).toBe(VALID_OWNER);
            expect(result.nullifyingKeyHash).toBe(MOCK_NULLIFYING_KEY_HASH);
            expect(result.authDigest).toBe(MOCK_AUTH_DIGEST);
            expect(result.deadline).toBe(FUTURE_DEADLINE);
            expect(result.signature).toBe("0xsig");
        });

        it("build the EIP-712 payload bound to the keystore contract and chain", async () => {
            const result = await session.prepareRelayedRegistration({ deadline: FUTURE_DEADLINE });

            if ("kind" in result.typedData) throw new Error("expected EIP-712 typed data on EVM");
            expect(result.typedData.domain).toEqual({
                name: "PrivacyPoolsKeystore",
                version: "1",
                chainId: VALID_CHAIN_ID,
                verifyingContract: VALID_KEYSTORE,
            });
            expect(result.typedData.primaryType).toBe("SetAuthPolicy");
            expect(result.typedData.message).toEqual({
                account: VALID_OWNER,
                authDigest: BigInt(MOCK_AUTH_DIGEST),
                nullifyingKeyHash: BigInt(MOCK_NULLIFYING_KEY_HASH),
                deadline: BigInt(FUTURE_DEADLINE),
            });
        });

        it("delegate signing to the keystoreInteractor with the built payload", async () => {
            const result = await session.prepareRelayedRegistration({ deadline: FUTURE_DEADLINE });

            expect(config.keystoreInteractor.signTypedData).toHaveBeenCalledWith(result.typedData);
        });

        it("return a null signature and skip signing when sign is false", async () => {
            const result = await session.prepareRelayedRegistration({
                deadline: FUTURE_DEADLINE,
                sign: false,
            });

            expect(result.signature).toBeNull();
            expect(result.typedData).toBeDefined();
            expect(config.keystoreInteractor.signTypedData).not.toHaveBeenCalled();
        });

        it("throw RegistrationDeadlineInPast for a deadline that is not in the future", async () => {
            await expect(
                session.prepareRelayedRegistration({ deadline: "0x1" as Hex }),
            ).rejects.toThrow(RegistrationDeadlineInPast);
            expect(config.keystoreInteractor.signTypedData).not.toHaveBeenCalled();
        });

        it("throw KeystoreAlreadyRegistered when the account is already registered on-chain", async () => {
            (
                config.keystoreInteractor.getNullifyingKeyHash as ReturnType<typeof vi.fn>
            ).mockResolvedValue(MOCK_NULLIFYING_KEY_HASH);

            await expect(
                session.prepareRelayedRegistration({ deadline: FUTURE_DEADLINE }),
            ).rejects.toThrow(KeystoreAlreadyRegistered);
            expect(config.keystoreInteractor.signTypedData).not.toHaveBeenCalled();
        });

        it("propagate RegistrationCheckFailed when the on-chain registration check errors", async () => {
            (
                config.keystoreInteractor.getNullifyingKeyHash as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("rpc unavailable"));

            await expect(
                session.prepareRelayedRegistration({ deadline: FUTURE_DEADLINE }),
            ).rejects.toThrow(RegistrationCheckFailed);
            expect(config.keystoreInteractor.signTypedData).not.toHaveBeenCalled();
        });

        it("reject an already-registered account before checking the deadline", async () => {
            // The registration guard runs before the deadline guard, so an already-registered
            // account with a past deadline surfaces KeystoreAlreadyRegistered, not
            // RegistrationDeadlineInPast.
            (
                config.keystoreInteractor.getNullifyingKeyHash as ReturnType<typeof vi.fn>
            ).mockResolvedValue(MOCK_NULLIFYING_KEY_HASH);

            await expect(
                session.prepareRelayedRegistration({ deadline: "0x1" as Hex }),
            ).rejects.toThrow(KeystoreAlreadyRegistered);
        });
    });

    describe("rotateRevocableKey", () => {
        const NEW_REVOCABLE_KEY =
            "0x9999999999999999999999999999999999999999999999999999999999999999" as Secret;
        const OLD_AUTH_DIGEST =
            "0xaaaa000000000000000000000000000000000000000000000000000000000000" as Hash;
        const NEW_AUTH_DIGEST =
            "0xbbbb000000000000000000000000000000000000000000000000000000000000" as Hash;
        const CURRENT_LEAF =
            "0xcafe000000000000000000000000000000000000000000000000000000000000" as Hash;
        const OTHER_LEAF =
            "0xfeed000000000000000000000000000000000000000000000000000000000000" as Hash;

        const ROTATION_CONFIG = {
            signature: ("0x" + "ab".repeat(65)) as Hex,
            signerAddress: VALID_OWNER,
            addressHash: ("0x" + "00".repeat(32)) as Hex,
        };

        function configWithRotationStubs(): PoolSessionKeystoreConfig {
            const cfg = buildConfig();
            (
                cfg.keystoreInteractor.getNullifyingKeyHash as ReturnType<typeof vi.fn>
            ).mockResolvedValue(MOCK_NULLIFYING_KEY_HASH);
            (
                cfg.keystoreInteractor.getKeystoreLeaves as ReturnType<typeof vi.fn>
            ).mockResolvedValue([OTHER_LEAF, CURRENT_LEAF]);
            // rotateRevocableKey runs prepare then execute, and each rebuilds the path against the
            // latest tree (audit #47). Both passes hash the nullifying key then the leaf, so the
            // chain needs the pair twice.
            (cfg.hashService.hash as ReturnType<typeof vi.fn>)
                .mockReturnValueOnce(MOCK_NULLIFYING_KEY_HASH)
                .mockReturnValueOnce(CURRENT_LEAF)
                .mockReturnValueOnce(MOCK_NULLIFYING_KEY_HASH)
                .mockReturnValueOnce(CURRENT_LEAF);
            // Prepare computes old then new digest; execute recomputes the new digest from
            // newRevocableKey to check it matches the calldata before submitting.
            (cfg.noteComputationService.computeAuthDigest as ReturnType<typeof vi.fn>)
                .mockReturnValueOnce(OLD_AUTH_DIGEST)
                .mockReturnValueOnce(NEW_AUTH_DIGEST)
                .mockReturnValueOnce(NEW_AUTH_DIGEST);
            (cfg.cryptoService.deriveKeysFromSignature as ReturnType<typeof vi.fn>).mockReturnValue(
                {
                    privateNullifyingKey: MOCK_PRIVATE_NULLIFYING_KEY,
                    privateRevocableKey: NEW_REVOCABLE_KEY,
                    viewingPrivateKey: MOCK_VIEWING_PRIVATE_KEY,
                    viewingPublicKey: MOCK_VIEWING_PUBLIC_KEY,
                },
            );
            (cfg.merkleService.generateMerkleProof as ReturnType<typeof vi.fn>).mockResolvedValue({
                leaf: CURRENT_LEAF,
                root: "0xrooot" as Hex,
                siblings: [OTHER_LEAF],
                index: 1,
            });
            (cfg.merkleService.padSiblings as ReturnType<typeof vi.fn>).mockReturnValue([
                OTHER_LEAF,
            ]);
            return cfg;
        }

        it("throw KeystoreNotRegistered when nullifyingKeyHash is zero on-chain", async () => {
            const config = buildConfig();
            const session = new PoolSessionKeystore(config);
            await expect(session.rotateRevocableKey(ROTATION_CONFIG)).rejects.toThrow(
                /Keystore not registered/,
            );
        });

        it("throw CurrentLeafNotFound when current leaf is not in the keystore tree", async () => {
            const config = configWithRotationStubs();
            (
                config.keystoreInteractor.getKeystoreLeaves as ReturnType<typeof vi.fn>
            ).mockResolvedValue([OTHER_LEAF]);

            const session = new PoolSessionKeystore(config);
            await expect(session.rotateRevocableKey(ROTATION_CONFIG)).rejects.toThrow(
                /Current keystore leaf/,
            );
        });

        it("encode updateAuthPolicy with old/new digests and the keystore inclusion proof", async () => {
            const config = configWithRotationStubs();
            const session = new PoolSessionKeystore(config);

            await session.rotateRevocableKey(ROTATION_CONFIG);

            expect(config.keystoreInteractor.encodeUpdateAuthPolicy).toHaveBeenCalledWith(
                OLD_AUTH_DIGEST,
                NEW_AUTH_DIGEST,
                [OTHER_LEAF],
            );
        });

        it("rebuild the merkle path from the latest tree at execute time", async () => {
            const FRESH_LEAF =
                "0xface000000000000000000000000000000000000000000000000000000000000" as Hash;
            const config = configWithRotationStubs();
            // A leaf is inserted between prepare and execute; the submitted calldata must carry
            // the proof from the second (latest) tree, not the one baked at prepare time.
            (config.keystoreInteractor.getKeystoreLeaves as ReturnType<typeof vi.fn>)
                .mockResolvedValueOnce([OTHER_LEAF, CURRENT_LEAF])
                .mockResolvedValueOnce([OTHER_LEAF, CURRENT_LEAF, FRESH_LEAF]);
            (config.merkleService.padSiblings as ReturnType<typeof vi.fn>)
                .mockReturnValueOnce([OTHER_LEAF])
                .mockReturnValueOnce([OTHER_LEAF, FRESH_LEAF]);

            const session = new PoolSessionKeystore(config);
            await session.rotateRevocableKey(ROTATION_CONFIG);

            expect(config.keystoreInteractor.encodeUpdateAuthPolicy).toHaveBeenNthCalledWith(
                2,
                OLD_AUTH_DIGEST,
                NEW_AUTH_DIGEST,
                [OTHER_LEAF, FRESH_LEAF],
            );
        });

        it("apply rotation in the keystoreManager on a successful receipt", async () => {
            const config = configWithRotationStubs();
            const session = new PoolSessionKeystore(config);

            const outcome = await session.rotateRevocableKey(ROTATION_CONFIG);

            expect(outcome.receipt.status).toBe(true);
            expect(outcome.oldAuthorizerDigest).toBe(OLD_AUTH_DIGEST);
            expect(outcome.newAuthorizerDigest).toBe(NEW_AUTH_DIGEST);
            expect(config.keystoreManager.applyRotation).toHaveBeenCalledWith(
                "0x" + "00".repeat(31) + "01",
                NEW_REVOCABLE_KEY,
            );
        });

        it("surface newRevocableKeyIndex equal to currentIndex + 1", async () => {
            const config = configWithRotationStubs();
            const session = new PoolSessionKeystore(config);

            const outcome = await session.rotateRevocableKey(ROTATION_CONFIG);

            expect(outcome.newRevocableKeyIndex).toBe("0x" + "00".repeat(31) + "01");
        });

        it("throw when the receipt status is false and not apply the rotation", async () => {
            const config = configWithRotationStubs();
            (
                config.rpcInteractor.waitForTransactionReceipt as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                status: false,
                blockNumber: ("0x" + "00".repeat(31) + "01") as Hex,
                txHash: ("0x" + "00".repeat(31) + "01") as Hex,
                logs: [],
            });

            const session = new PoolSessionKeystore(config);

            await expect(session.rotateRevocableKey(ROTATION_CONFIG)).rejects.toThrow(
                /updateAuthPolicy transaction reverted/,
            );
            expect(config.keystoreManager.applyRotation).not.toHaveBeenCalled();
        });
    });

    describe("discoverRevocableKeyIndex", () => {
        const DISCOVER_CONFIG = {
            signature: ("0x" + "ab".repeat(65)) as Hex,
            signerAddress: VALID_OWNER,
            addressHash: ("0x" + "00".repeat(32)) as Hex,
        };
        const TARGET_DIGEST =
            "0xbeef000000000000000000000000000000000000000000000000000000000000" as Hash;
        const OTHER_DIGEST =
            "0xdead000000000000000000000000000000000000000000000000000000000000" as Hash;

        it("returns the matching index when on-chain digest matches a candidate", async () => {
            const config = buildConfig();
            (
                config.keystoreInteractor.getCurrentAuthorizerDigest as ReturnType<typeof vi.fn>
            ).mockResolvedValue(TARGET_DIGEST);
            // Index 2 produces the on-chain digest; 0 and 1 produce different digests.
            (config.cryptoService.deriveKeysFromSignature as ReturnType<typeof vi.fn>)
                .mockReturnValueOnce({ privateRevocableKey: "0xa1" })
                .mockReturnValueOnce({ privateRevocableKey: "0xa2" })
                .mockReturnValueOnce({ privateRevocableKey: "0xa3" });
            (config.noteComputationService.computeAuthDigest as ReturnType<typeof vi.fn>)
                .mockReturnValueOnce(OTHER_DIGEST)
                .mockReturnValueOnce(OTHER_DIGEST)
                .mockReturnValueOnce(TARGET_DIGEST);

            const session = new PoolSessionKeystore(config);
            const index = await session.discoverRevocableKeyIndex(DISCOVER_CONFIG);

            expect(BigInt(index)).toBe(2n);
            expect(config.cryptoService.deriveKeysFromSignature).toHaveBeenCalledTimes(3);
        });

        it("throws KeystoreNotRegistered when there is no on-chain digest for the account", async () => {
            const config = buildConfig();
            (
                config.keystoreInteractor.getCurrentAuthorizerDigest as ReturnType<typeof vi.fn>
            ).mockResolvedValue(null);

            const session = new PoolSessionKeystore(config);
            await expect(session.discoverRevocableKeyIndex(DISCOVER_CONFIG)).rejects.toThrow(
                /Keystore not registered/,
            );
        });

        it("throws RevocableKeyIndexNotFound after exhausting gapLimit", async () => {
            const config = buildConfig();
            (
                config.keystoreInteractor.getCurrentAuthorizerDigest as ReturnType<typeof vi.fn>
            ).mockResolvedValue(TARGET_DIGEST);
            (
                config.cryptoService.deriveKeysFromSignature as ReturnType<typeof vi.fn>
            ).mockReturnValue({ privateRevocableKey: "0xff" });
            (
                config.noteComputationService.computeAuthDigest as ReturnType<typeof vi.fn>
            ).mockReturnValue(OTHER_DIGEST);

            const session = new PoolSessionKeystore(config);
            await expect(session.discoverRevocableKeyIndex(DISCOVER_CONFIG, 3)).rejects.toThrow(
                /No matching revocable-key index/,
            );
        });

        // Regression: a Stellar-shaped derive config (signature + appIdentifier, no
        // signerAddress/addressHash) previously reached `config.signerAddress` here as
        // `undefined` — TypeScript's method-parameter bivariance let it compile, but
        // `getCurrentAuthorizerDigest(undefined)` broke at runtime. The session's own
        // `ownerAddress` is used now regardless of what fields `config` carries.
        it("look up the on-chain digest by the session's own ownerAddress, not config.signerAddress", async () => {
            const config = buildConfig({ ownerAddress: VALID_OWNER });
            (
                config.keystoreInteractor.getCurrentAuthorizerDigest as ReturnType<typeof vi.fn>
            ).mockResolvedValue(TARGET_DIGEST);
            (config.cryptoService.deriveKeysFromSignature as ReturnType<typeof vi.fn>).mockReturnValue({
                privateRevocableKey: "0xa1",
            });
            (config.noteComputationService.computeAuthDigest as ReturnType<typeof vi.fn>).mockReturnValue(
                TARGET_DIGEST,
            );
            // No `signerAddress` field at all — the shape a Stellar-typed derive config has.
            const stellarShapedConfig = { signature: DISCOVER_CONFIG.signature, appIdentifier: "app" };

            const session = new PoolSessionKeystore(config);
            const index = await session.discoverRevocableKeyIndex(
                stellarShapedConfig as unknown as typeof DISCOVER_CONFIG,
            );

            expect(BigInt(index)).toBe(0n);
            expect(config.keystoreInteractor.getCurrentAuthorizerDigest).toHaveBeenCalledWith(VALID_OWNER);
        });
    });

    describe("executeRegisterKeystore tampering guard", () => {
        const OTHER_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
        const APPROVE_CALLDATA = encodeFunctionData({
            abi: [
                {
                    type: "function",
                    name: "approve",
                    inputs: [
                        { name: "spender", type: "address" },
                        { name: "amount", type: "uint256" },
                    ],
                    outputs: [{ type: "bool" }],
                    stateMutability: "nonpayable",
                },
            ],
            functionName: "approve",
            args: [OTHER_CONTRACT, 1n],
        });

        it("reject keystoreCalldata pointed at a non-Keystore address", async () => {
            const config = buildConfig();
            (
                config.keystoreInteractor.encodeSetAuthPolicy as ReturnType<typeof vi.fn>
            ).mockReturnValue({
                to: OTHER_CONTRACT,
                data: encodeFunctionData({
                    abi: KEYSTORE_WRITE_ABI,
                    functionName: "setAuthPolicy",
                    args: [1n, 2n],
                }),
                value: "0x0" as Hex,
            });
            const session = new PoolSessionKeystore(config);
            const prepared = await session.prepareRegisterKeystore();

            await expect(session.executeRegisterKeystore(prepared)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(config.keystoreInteractor.submitTransaction).not.toHaveBeenCalled();
        });

        it("reject keystoreCalldata carrying a non-setAuthPolicy selector", async () => {
            const config = buildConfig();
            (
                config.keystoreInteractor.encodeSetAuthPolicy as ReturnType<typeof vi.fn>
            ).mockReturnValue({
                to: VALID_KEYSTORE,
                data: APPROVE_CALLDATA,
                value: "0x0" as Hex,
            });
            const session = new PoolSessionKeystore(config);
            const prepared = await session.prepareRegisterKeystore();

            await expect(session.executeRegisterKeystore(prepared)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(config.keystoreInteractor.submitTransaction).not.toHaveBeenCalled();
        });

        it("reject viewingKeyCalldata carrying the wrong selector before submitting setAuthPolicy", async () => {
            const config = buildConfig();
            (
                config.keystoreInteractor.encodeSetViewingKey as ReturnType<typeof vi.fn>
            ).mockReturnValue({
                to: VALID_KEYSTORE,
                data: encodeFunctionData({
                    abi: KEYSTORE_WRITE_ABI,
                    functionName: "updateAuthPolicy",
                    args: [1n, 2n, [3n]],
                }),
                value: "0x0" as Hex,
            });
            const session = new PoolSessionKeystore(config);
            const prepared = await session.prepareRegisterKeystore();

            await expect(session.executeRegisterKeystore(prepared)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            // Both calldatas are verified before anything is signed, so a tampered second
            // transaction cannot leave the first (setAuthPolicy) on-chain as a partial registration.
            expect(config.keystoreInteractor.submitTransaction).not.toHaveBeenCalled();
            expect(config.keystoreManager.markRegistered).not.toHaveBeenCalled();
        });

        it("submit both txs on the happy path", async () => {
            const config = buildConfig();
            const session = new PoolSessionKeystore(config);
            const prepared = await session.prepareRegisterKeystore();

            await expect(session.executeRegisterKeystore(prepared)).resolves.toHaveLength(2);
            expect(config.keystoreInteractor.submitTransaction).toHaveBeenCalledTimes(2);
            expect(config.keystoreManager.markRegistered).toHaveBeenCalledWith(VALID_CHAIN_ID);
        });
    });

    describe("executeRegisterKeystore resuming a partial registration", () => {
        it("not re-mark a session that already marked itself registered, and still return the receipts", async () => {
            // First run registered the auth policy only (marking the manager); the resume submits the
            // missing viewing-key tx. The real KeystoreManager throws AlreadyRegistered on a second mark.
            const config = buildConfig();
            (config.keystoreManager.isRegistered as ReturnType<typeof vi.fn>).mockReturnValue(true);
            (config.keystoreManager.markRegistered as ReturnType<typeof vi.fn>).mockImplementation(() => {
                throw new AlreadyRegistered(VALID_CHAIN_ID);
            });
            (config.keystoreInteractor.getNullifyingKeyHash as ReturnType<typeof vi.fn>).mockResolvedValue(
                MOCK_NULLIFYING_KEY_HASH,
            );
            const session = new PoolSessionKeystore(config);
            const prepared = await session.prepareRegisterKeystore();
            expect(prepared.keystoreCalldata).toBeNull();
            expect(prepared.viewingKeyCalldata).not.toBeNull();

            await expect(session.executeRegisterKeystore(prepared)).resolves.toHaveLength(1);
            expect(config.keystoreManager.markRegistered).not.toHaveBeenCalled();
        });

        it("still mark a session that has not registered before", async () => {
            const config = buildConfig();
            const session = new PoolSessionKeystore(config);
            const prepared = await session.prepareRegisterKeystore();

            await session.executeRegisterKeystore(prepared);

            expect(config.keystoreManager.markRegistered).toHaveBeenCalledOnce();
        });
    });

    describe("executeRotateRevocableKey tampering guard", () => {
        const OTHER_CONTRACT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
        const NEW_REVOCABLE_KEY =
            "0x9999999999999999999999999999999999999999999999999999999999999999" as Secret;

        function buildRotationResult(
            overrides?: Partial<{ to: Address; data: Hex }>,
        ): RotateRevocableKeyResult {
            return {
                keystoreCalldata: {
                    to: overrides?.to ?? VALID_KEYSTORE,
                    data:
                        overrides?.data ??
                        encodeFunctionData({
                            abi: KEYSTORE_WRITE_ABI,
                            functionName: "updateAuthPolicy",
                            args: [1n, 2n, [3n]],
                        }),
                    value: "0x0" as Hex,
                },
                newIndex: "0x1" as Hex,
                newRevocableKey: NEW_REVOCABLE_KEY,
            };
        }

        it("reject keystoreCalldata pointed at a non-Keystore address", async () => {
            const config = buildConfig();
            const session = new PoolSessionKeystore(config);

            await expect(
                session.executeRotateRevocableKey(buildRotationResult({ to: OTHER_CONTRACT })),
            ).rejects.toThrow(UnexpectedTransactionTarget);
            expect(config.keystoreInteractor.submitTransaction).not.toHaveBeenCalled();
            expect(config.keystoreManager.applyRotation).not.toHaveBeenCalled();
        });

        it("reject keystoreCalldata carrying a non-updateAuthPolicy selector", async () => {
            const config = buildConfig();
            const session = new PoolSessionKeystore(config);

            const tampered = encodeFunctionData({
                abi: KEYSTORE_WRITE_ABI,
                functionName: "setAuthPolicy",
                args: [1n, 2n],
            });
            await expect(
                session.executeRotateRevocableKey(buildRotationResult({ data: tampered })),
            ).rejects.toThrow(UnexpectedTransactionTarget);
            expect(config.keystoreInteractor.submitTransaction).not.toHaveBeenCalled();
            expect(config.keystoreManager.applyRotation).not.toHaveBeenCalled();
        });

        it("reject a newRevocableKey that does not hash to the calldata's new digest", async () => {
            const config = buildConfig();
            const session = new PoolSessionKeystore(config);

            // Calldata installs digest 2n, but computeAuthDigest(newRevocableKey) returns the
            // default MOCK_AUTH_DIGEST — submitting would brick the locally stored key.
            await expect(session.executeRotateRevocableKey(buildRotationResult())).rejects.toThrow(
                RotationKeyMismatch,
            );
            expect(config.keystoreInteractor.submitTransaction).not.toHaveBeenCalled();
            expect(config.keystoreManager.applyRotation).not.toHaveBeenCalled();
        });
    });
});
