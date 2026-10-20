import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
    EVMProof,
    Hex,
    IPoolSessionDeposit,
    IPPRouterInteractor,
    IPPYieldTokenInteractor,
    PendingNote,
    Secret,
} from "../../src/internal.js";
import {
    CryptoService,
    ENTRYPOINT_DEPOSIT_ABI,
    ERC20_APPROVE_ABI,
    Groth16Prover,
    LOCAL_FORK_YIELD_DEPLOYMENT,
    LocalCircuitArtifacts,
    MerkleService,
    NoteComputationService,
    EvmPoolSessionYieldDeposit,
    PoseidonHashService,
    PP_ROUTER_DEPOSIT_ABI,
    ProofService,
    WitnessPreparationService,
} from "../../src/internal.js";

/**
 * REAL-PROOF integration test for the yield deposit re-encode.
 *
 * Generates a genuine Groth16 deposit proof from the compiled circuits, builds the real
 * `Entrypoint.deposit` calldata a standard SDK deposit would emit, and asserts that
 * `PoolSessionYieldDeposit` decodes it and re-encodes it as `PPRouter.depositExactShares` with the
 * proof, noteData, and ASP ciphertext preserved byte-for-byte. This exercises the load-bearing
 * claim on REAL 254-bit field elements (not toy values): the router call carries the identical
 * proof context, so it stays valid.
 *
 * Requires compiled circuit artifacts under packages/circuits/build/. Skipped otherwise.
 */

const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../../packages/circuits/build");
const DEPOSIT_WASM = resolve(CIRCUITS_BUILD_DIR, "deposit/deposit_js/deposit.wasm");
const hasDepositArtifacts = existsSync(DEPOSIT_WASM);

const DEP = LOCAL_FORK_YIELD_DEPLOYMENT;

// Representative encrypted note payload + ASP ciphertext (the proof is the real part).
const NOTE_DATA = { hint: `0x${"ab".repeat(32)}` as Hex, data: `0x${"cd".repeat(120)}` as Hex };
const ASP_CIPHERTEXT = `0x${"ef".repeat(80)}` as Hex;

const SHARES = 1_000_000_000_000_000_000n;
const SHARES_HEX = `0x${SHARES.toString(16)}` as Hex;

function mockRouter(): IPPRouterInteractor {
    return {
        getAddress: () => DEP.ppRouter,
        quote: vi.fn(async () => ({ underlyingNeeded: 1_000_000n, total: 1_000_000n })),
        quoteWithdraw: vi.fn(async () => 0n),
        supplyBufferUnits: vi.fn(async () => 2n),
    };
}

function mockYieldToken(): IPPYieldTokenInteractor {
    return {
        getAddress: () => DEP.ppUSDC,
        exchangeRate: vi.fn(async () => 0n),
        previewDeposit: vi.fn(async () => 0n),
        previewRedeem: vi.fn(async () => 0n),
        encodeRedeem: vi.fn(() => ({ to: DEP.ppUSDC, data: "0x" as Hex, value: "0x0" as Hex })),
    };
}

describe.skipIf(!hasDepositArtifacts)("PoolSessionYieldDeposit re-encode (real proof)", () => {
    let evmProof: EVMProof;
    let entrypointCalldata: Hex;
    let proofService: ProofService;
    let proofValid: boolean;

    beforeAll(async () => {
        const hashService = await PoseidonHashService.create();
        const merkleService = new MerkleService({ hashService });
        const cryptoService = new CryptoService();
        const noteComputationService = new NoteComputationService({ hashService, cryptoService });
        const witnessService = new WitnessPreparationService({
            noteComputationService,
            hashService,
            merkleService,
        });
        const circuitArtifacts = new LocalCircuitArtifacts({ baseDir: CIRCUITS_BUILD_DIR });
        proofService = new ProofService({ circuitArtifacts, groth16Prover: new Groth16Prover() });

        const ownerAddress = "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as Hex;
        const noteSecret =
            "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" as Secret;
        const depositSecret =
            "0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba" as Secret;
        const noteAddressHash = noteComputationService.computeNoteAddressHash(
            ownerAddress,
            noteSecret,
        );
        const witness = await witnessService.buildDepositWitness({
            noteAddressHash,
            tokenId: DEP.ppUSDC as Hex,
            value: SHARES_HEX,
            context: "0xaaaaaaaaaaaaaaaa" as Hex,
            depositSecret,
        });

        const proofResult = await proofService.proveDeposit(witness);
        proofValid = await proofService.verifyDeposit(proofResult);
        evmProof = proofService.formatForChain(proofResult);

        entrypointCalldata = encodeFunctionData({
            abi: ENTRYPOINT_DEPOSIT_ABI,
            functionName: "deposit",
            args: [
                {
                    pA: evmProof.pA,
                    pB: evmProof.pB,
                    pC: evmProof.pC,
                    pubSignals: evmProof.pubSignals,
                },
                NOTE_DATA,
                ASP_CIPHERTEXT,
            ] as never,
        });
    }, 60_000);

    it("generates a valid, verifiable deposit proof with 4 public signals", () => {
        expect(proofValid).toBe(true);
        expect(evmProof.pubSignals).toHaveLength(4);
        // Real field elements are large — not the toy values a mocked test would use.
        expect(evmProof.pA[0]).toBeGreaterThan(1_000_000n);
    });

    it("preserves the real proof, noteData, and ciphertext through the router re-encode", async () => {
        const deposit = {
            prepareDeposit: vi.fn(async () => ({
                depositTx: { to: DEP.ppUSDC, data: entrypointCalldata, value: "0x0" as Hex },
                pendingNote: { commitment: "0x01", tokenId: DEP.ppUSDC } as unknown as PendingNote,
                approvalTx: null,
            })),
        } as unknown as IPoolSessionDeposit;
        const session = new EvmPoolSessionYieldDeposit({
            deployment: DEP,
            deposit,
            router: mockRouter(),
            yieldToken: mockYieldToken(),
        });

        const result = await session.prepareYieldDeposit({ value: SHARES });

        expect(result.depositTx.to).toBe(DEP.ppRouter);
        const decoded = decodeFunctionData({
            abi: PP_ROUTER_DEPOSIT_ABI,
            data: result.depositTx.data,
        });
        expect(decoded.functionName).toBe("depositExactShares");
        const [proof, noteData, aspCiphertext, maxUnderlyingIn] = decoded.args;

        // Byte-for-byte fidelity on the real proof.
        expect(proof).toEqual({
            pA: evmProof.pA,
            pB: evmProof.pB,
            pC: evmProof.pC,
            pubSignals: evmProof.pubSignals,
        });
        expect(noteData).toEqual(NOTE_DATA);
        expect(aspCiphertext).toBe(ASP_CIPHERTEXT);
        expect(maxUnderlyingIn).toBe(result.maxUnderlyingIn);
                // Default cap: the mocked 1_000_000 quote + 1 ppm (one unit), independently of the result echo.
        expect(maxUnderlyingIn).toBe(1_000_001n);
        const approval = decodeFunctionData({
            abi: ERC20_APPROVE_ABI,
            data: result.approvalTx!.data,
        });
        expect(approval.args[1]).toBe(1_000_001n);
    });
});
