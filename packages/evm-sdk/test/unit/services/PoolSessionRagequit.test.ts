import { encodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    IKeystoreInteractor,
    IKeystoreManager,
    INoteManager,
    IPoolVaultInteractor,
    IProofService,
    IRPCInteractor,
    IWitnessPreparationService,
    Note,
    PrepareRageQuitResult,
} from "../../../src/internal.js";
import {
    AddressSchema,
    EMPTY_ADDRESS,
    EvmAddressFieldConverter,
    EvmPreparedTxVerifier,
    KeystoreNotRegistered,
    RegistrationCheckFailed,
    NoteStatus,
    POOL_VAULT_RAGEQUIT_ABI,
    PoolSessionRagequit,
    RagequitAddresslessNoteError,
    RagequitNoteAlreadyExitedError,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const ATTACKER = "0x9999999999999999999999999999999999999999" as Address;
const VALID_TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;

const RAGEQUIT_PROOF = {
    pA: [0n, 0n],
    pB: [
        [0n, 0n],
        [0n, 0n],
    ],
    pC: [0n, 0n],
    pubSignals: [0n, 0n, 0n, 0n, 0n, 0n, 0n],
} as const;

function ragequitCalldata(): Hex {
    return encodeFunctionData({
        abi: POOL_VAULT_RAGEQUIT_ABI,
        functionName: "ragequit",
        args: [RAGEQUIT_PROOF],
    });
}

function createMockPoolVaultInteractor(): IPoolVaultInteractor {
    return {
        getAddress: vi.fn(() => VALID_POOL),
        submitTransaction: vi.fn().mockResolvedValue("0x1" as Hex),
    } as unknown as IPoolVaultInteractor;
}

function createMockRPCInteractor(): IRPCInteractor {
    return {
        waitForTransactionReceipt: vi.fn().mockResolvedValue({
            status: true,
            blockNumber: "0x1" as Hex,
            txHash: "0x1" as Hex,
            logs: [],
        }),
    } as unknown as IRPCInteractor;
}

function buildResult(overrides?: Partial<PrepareRageQuitResult>): PrepareRageQuitResult {
    return {
        commitment: ("0x" + "aa".repeat(32)) as Hash,
        value: "0x64" as Hex,
        tokenId: VALID_TOKEN,
        nullifierHash: ("0x" + "11".repeat(32)) as Hash,
        recipientAddress: VALID_OWNER,
        ragequitTx: { data: ragequitCalldata(), to: VALID_POOL, value: "0x0" as Hex },
        ...overrides,
    };
}

describe("PoolSessionRagequit", () => {
    let poolVaultInteractor: IPoolVaultInteractor;
    let rpcInteractor: IRPCInteractor;
    let service: PoolSessionRagequit;

    beforeEach(() => {
        vi.clearAllMocks();
        poolVaultInteractor = createMockPoolVaultInteractor();
        rpcInteractor = createMockRPCInteractor();
        service = new PoolSessionRagequit({
            ownerAddress: VALID_OWNER,
            poolVaultInteractor,
            noteManager: {
                updateNoteStatus: vi.fn(),
            } as unknown as INoteManager,
            keystoreManager: {} as IKeystoreManager,
            witnessPreparationService: {} as IWitnessPreparationService,
            proofService: {} as IProofService,
            keystoreInteractor: {} as IKeystoreInteractor,
            rpcInteractor,
            preparedTxVerifier: new EvmPreparedTxVerifier(),
            addressFieldConverter: new EvmAddressFieldConverter(),
            addressSchema: AddressSchema,
        });
    });

    describe("executeRageQuit", () => {
        it("submit when target is the pool vault and calldata is a ragequit call", async () => {
            const receipt = await service.executeRageQuit(buildResult());

            expect(receipt.status).toBe(true);
            expect(poolVaultInteractor.submitTransaction).toHaveBeenCalledOnce();
        });

        it("reject a result whose target is not the pool vault", async () => {
            await expect(
                service.executeRageQuit(
                    buildResult({
                        ragequitTx: { data: ragequitCalldata(), to: ATTACKER, value: "0x0" as Hex },
                    }),
                ),
            ).rejects.toThrow(UnexpectedTransactionTarget);
            expect(poolVaultInteractor.submitTransaction).not.toHaveBeenCalled();
        });

        it("reject a result whose calldata is not a ragequit call", async () => {
            // Arbitrary non-ragequit calldata (e.g. an ERC-20 approve selector).
            const tampered = buildResult({
                ragequitTx: { data: "0x095ea7b3" as Hex, to: VALID_POOL, value: "0x0" as Hex },
            });
            await expect(service.executeRageQuit(tampered)).rejects.toThrow(
                UnexpectedTransactionTarget,
            );
            expect(poolVaultInteractor.submitTransaction).not.toHaveBeenCalled();
        });
    });

    describe("prepareRageQuit", () => {
        function serviceWithNote(
            note: Note,
            overrides: {
                keystoreInteractor?: IKeystoreInteractor;
                keystoreManager?: IKeystoreManager;
                witnessPreparationService?: IWitnessPreparationService;
            } = {},
        ): PoolSessionRagequit {
            return new PoolSessionRagequit({
                ownerAddress: VALID_OWNER,
                poolVaultInteractor,
                noteManager: {
                    getNote: vi.fn(() => note),
                } as unknown as INoteManager,
                keystoreManager: overrides.keystoreManager ?? ({} as IKeystoreManager),
                witnessPreparationService:
                    overrides.witnessPreparationService ?? ({} as IWitnessPreparationService),
                proofService: {} as IProofService,
                keystoreInteractor: overrides.keystoreInteractor ?? ({} as IKeystoreInteractor),
                rpcInteractor,
                preparedTxVerifier: new EvmPreparedTxVerifier(),
                addressFieldConverter: new EvmAddressFieldConverter(),
                addressSchema: AddressSchema,
            });
        }

        function addresslessNote(): Note {
            return {
                noteAddressHash: ("0x" + "cc".repeat(32)) as Hash,
                commitment: ("0x" + "aa".repeat(32)) as Hash,
                value: "0x64" as Hex,
                tokenId: VALID_TOKEN,
                label: ("0x" + "dd".repeat(32)) as Hash,
                status: NoteStatus.PENDING,
                ownerAddress: EMPTY_ADDRESS,
                noteSecret: ("0x" + "ee".repeat(32)) as Hex,
                isOwned: true,
                createdAtBlock: "0x1" as Hex,
                spentAtBlock: null,
                txHash: ("0x" + "ff".repeat(32)) as Hash,
            } as Note;
        }

        // Guard against an addressless (payment-key) note: its on-chain commitment binds 0x0, so
        // proof generation would otherwise fail deep inside witness building with an opaque error.
        it("reject a note whose owner address is the zero address", async () => {
            const service = serviceWithNote(addresslessNote());

            await expect(
                service.prepareRageQuit({ commitment: ("0x" + "aa".repeat(32)) as Hash }),
            ).rejects.toThrow(RagequitAddresslessNoteError);
        });

        function exitedNote(): Note {
            return { ...addresslessNote(), ownerAddress: VALID_OWNER, status: NoteStatus.EXITED };
        }

        it("still refuse an EXITED note by default", async () => {
            // The ordinary guard keeps protecting everyone from spending gas on an
            // exit that already happened.
            const service = serviceWithNote(exitedNote());

            await expect(
                service.prepareRageQuit({ commitment: ("0x" + "aa".repeat(32)) as Hash }),
            ).rejects.toThrow(RagequitNoteAlreadyExitedError);
        });

        it("get past the EXITED status when the caller could not corroborate the exit", async () => {
            // An `EXITED` status can come from an unauthenticated ASP snapshot row, and
            // `EXITED` is terminal — so refusing on it locks the owner out of the only
            // path that recovers a note still spendable on chain. The status check is a
            // convenience: a nullifier publishes once, so a real exit reverts on
            // submission anyway. Getting PAST the check is what this asserts; the call
            // then fails further in on this test's stub collaborators, which is proof
            // enough that the status gate is no longer what stops it.
            const service = serviceWithNote(exitedNote());

            await expect(
                service.prepareRageQuit({
                    commitment: ("0x" + "aa".repeat(32)) as Hash,
                    allowUnconfirmedExit: true,
                }),
            ).rejects.not.toThrow(RagequitNoteAlreadyExitedError);
        });

        describe("keystore registration", () => {
            const COMMITMENT = ("0x" + "aa".repeat(32)) as Hash;
            const ownedNote = (): Note => ({ ...addresslessNote(), ownerAddress: VALID_OWNER });

            function keystoreHarness(nullifyingKeyHash: () => Promise<Hash>) {
                const getNullifyingKeyHash = vi.fn(nullifyingKeyHash);
                const getKeystoreLeaves = vi.fn().mockResolvedValue([]);
                const buildRagequitWitness = vi.fn().mockRejectedValue(new Error("reached witness stage"));
                return { getNullifyingKeyHash, getKeystoreLeaves, buildRagequitWitness };
            }

            const build = (note: Note, h: ReturnType<typeof keystoreHarness>) =>
                serviceWithNote(note, {
                    keystoreInteractor: {
                        getNullifyingKeyHash: h.getNullifyingKeyHash,
                        getKeystoreLeaves: h.getKeystoreLeaves,
                    } as unknown as IKeystoreInteractor,
                    keystoreManager: {
                        getPrivateNullifyingKey: () => ("0x" + "11".repeat(32)) as Hex,
                        getPrivateRevocableKey: () => ("0x" + "22".repeat(32)) as Hex,
                    } as unknown as IKeystoreManager,
                    witnessPreparationService: {
                        buildRagequitWitness: h.buildRagequitWitness,
                    } as unknown as IWitnessPreparationService,
                });

            it("throw KeystoreNotRegistered before building any witness when the owner never registered", async () => {
                const h = keystoreHarness(() => Promise.resolve("0x0" as Hash));

                await expect(build(ownedNote(), h).prepareRageQuit({ commitment: COMMITMENT })).rejects.toThrow(
                    KeystoreNotRegistered,
                );
                expect(h.getKeystoreLeaves).not.toHaveBeenCalled();
                expect(h.buildRagequitWitness).not.toHaveBeenCalled();
            });

            it("check the registration of the note's owner, whose keystore leaf the witness proves", async () => {
                const h = keystoreHarness(() => Promise.resolve("0x0" as Hash));
                const note = { ...ownedNote(), ownerAddress: ATTACKER };

                await build(note, h)
                    .prepareRageQuit({ commitment: COMMITMENT })
                    .catch(() => undefined);

                expect(h.getNullifyingKeyHash).toHaveBeenCalledWith(ATTACKER);
            });

            it("proceed to witness building when the owner is registered", async () => {
                const h = keystoreHarness(() => Promise.resolve(("0x" + "ab".repeat(32)) as Hash));

                await expect(build(ownedNote(), h).prepareRageQuit({ commitment: COMMITMENT })).rejects.toThrow(
                    "reached witness stage",
                );
                expect(h.buildRagequitWitness).toHaveBeenCalledOnce();
            });

            it("wrap a failed registration read in RegistrationCheckFailed", async () => {
                const h = keystoreHarness(() => Promise.reject(new Error("rpc down")));

                await expect(build(ownedNote(), h).prepareRageQuit({ commitment: COMMITMENT })).rejects.toThrow(
                    RegistrationCheckFailed,
                );
            });
        });
    });
});
