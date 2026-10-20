/**
 * E2E Proof Service
 *
 * Wraps @privacy-pools-v2/evm-sdk proof generation primitives to provide a high-level API
 * for e2e relay tests. Handles the full lifecycle:
 *   1. Account setup on anvil (keystore registration, ASP set, /deposit)
 *   2. ZK proof generation (witness building, Groth16 proving)
 *   3. Relay payload formatting (snarkjs format with signed fee commitment)
 */

import { randomBytes } from "crypto";
import {
    createPublicClient,
    createTestClient,
    createWalletClient,
    encodeAbiParameters,
    keccak256,
    parseAbi,
    http,
    type Address,
    type Hex,
    type PublicClient,
    type TestClient,
    type WalletClient,
} from "viem";
import { hardhat } from "viem/chains";
import { LeanIMT } from "@zk-kit/lean-imt";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: SDK installed from tarball, not always present in node_modules
// prettier-ignore
import { PoseidonHashService, WitnessPreparationService, ProofService, Groth16Prover, MerkleService, LocalCircuitArtifacts, CryptoService, NoteComputationService, NoteStatus, NoteManager, KeystoreManager, ASPClient, ASPRegistryInteractor, PoolVaultInteractor, KeystoreInteractor, ViemRPCInteractor, TransactOrchestrator, type Hex as SDKHex, type Proof, type TransactCircuitInputs, type Note, type IASPDataProvider, type LabelStatus, type PublicKey, type EventSnapshot, type NoteEvent } from "@privacy-pools-v2/evm-sdk";

// Not exported from SDK bundle despite being in .d.ts — hardcode the value
const AUTH_TYPE_DIRECT_KEY: SDKHex = "0x0";

import { SEPOLIA_CONTRACTS, SNARK_SCALAR_FIELD, MAX_DEPTHS, NATIVE_ASSET_ID, POSTMAN_ADDRESS } from "./config.js";

// ============================================================================
// Types
// ============================================================================

export interface E2EProofServiceConfig {
    circuitArtifactsDir: string;
    rpcUrl: string;
}

/** The relay payload shape accepted by POST /v1/relay/evm/:chainId/withdrawal */
export interface RelayPayload {
    proof: Proof & { publicSignals: string[] };
    inputNullifierNumber: number;
    outputCommitmentNumber: number;
    processor: Address;
    noteData: { hint: Hex; data: Hex }[];
    signedFeeCommitment: Record<string, unknown>;
}

export interface WithdrawalPayloadResult {
    relayPayload: RelayPayload;
    depositTxHash: Hex;
    nullifiers: Hex[];
    outputCommitments: Hex[];
    /** Account state needed to chain subsequent operations */
    accountState: AccountState;
}

/** A single relayer-signed PayoutRouting (== IPrivacyPoolRelay.PayoutRouting). */
export interface PayoutRouting {
    recipient: Address;
    feeRecipient: Address;
    feeAmount: bigint;
    nativeGas: bigint;
}

export interface TransferPayloadResult {
    relayPayload: RelayPayload;
    depositTxHash: Hex;
    nullifiers: Hex[];
    outputCommitments: Hex[];
    accountState: AccountState;
    /** The recipient's note data (for recipient to spend later) */
    recipientNote: {
        noteAddressHash: Hex;
        value: string;
        label: Hex;
        tokenId: Hex;
    };
}

/** Internal account state from setup */
export interface AccountState {
    ownerAddress: Address;
    privateNullifyingKey: SDKHex;
    privateRevocableKey: SDKHex;
    noteSecret: SDKHex;
    depositSecret: SDKHex;
    tokenId: Hex;
    value: string;
    label: SDKHex;
    labelHash: SDKHex;
    /** Block timestamp (used as createdAtBlock in SDK) */
    createdAtBlock: Hex;
    depositTxHash: Hex;
}

/** Pre-computed account data (CPU-only, no chain interaction) */
export interface PreparedAccount {
    ownerAddress: Address;
    tokenId: Hex;
    value: string;
    privateNullifyingKey: SDKHex;
    privateRevocableKey: SDKHex;
    noteSecret: SDKHex;
    depositSecret: SDKHex;
    label: SDKHex;
    labelHash: SDKHex;
    depositProof: ReturnType<typeof proofToDepositCalldata>;
}

/** Result of fetching state tree data */
interface StateTreeResult {
    leaves: SDKHex[];
}

// ============================================================================
// ABIs (subset needed for setup)
// ============================================================================

const KEYSTORE_ABI = parseAbi([
    "function setAuthPolicy(uint256 _authDigest, uint256 _nullifyingKeyHash) external",
    "function nullifyingKeys(address _account) external view returns (uint256)",
    "function currentRootIndex() external view returns (uint32)",
    "function roots(uint256 _index) external view returns (uint256)",
]);

const ASP_REGISTRY_ABI = parseAbi([
    "function updateASPRoot(uint256 _aspRoot, bytes memory _ipfsCID) external",
    "function latestASPRoot() external view returns (uint256)",
]);

const ENTRYPOINT_ABI = parseAbi([
    "function deposit((uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[4] pubSignals) _proof, (bytes32 hint, bytes data) _noteData, bytes _aspCiphertext) external payable",
]);

const ERC20_ABI = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
]);

// ============================================================================
// Helpers
// ============================================================================

function randomFieldElement(): SDKHex {
    // 31 random bytes keeps the value < BN254 field; zero-pad to 32 bytes (64 hex
    // chars) so it satisfies the SDK's DepositSecretSchema/SecretSchema length check.
    return `0x${randomBytes(31).toString("hex").padStart(64, "0")}`;
}

function toHex(value: string | number | bigint): SDKHex {
    // SDK's PoseidonHashService pads all hex to 64 chars — we must match
    if (typeof value === "string" && value.startsWith("0x")) {
        const raw = value.slice(2);
        return `0x${raw.padStart(64, "0")}` as SDKHex;
    }
    return `0x${BigInt(value).toString(16).padStart(64, "0")}` as SDKHex;
}

const ZERO_HINT = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const ZERO_DATA = "0x00" as Hex;

/**
 * Convert SDK Proof + publicSignals into the Solidity calldata tuple format
 * expected by the Entrypoint.deposit() ABI: { pA, pB, pC, pubSignals }.
 */
function proofToDepositCalldata(proof: Proof, publicSignals: SDKHex[]) {
    return {
        pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
        // pi_b coordinates must be swapped for the Solidity Groth16 verifier
        pB: [
            [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
            [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
        ] as [[bigint, bigint], [bigint, bigint]],
        pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
        pubSignals: publicSignals.map((s) => BigInt(s)) as [bigint, bigint, bigint, bigint],
    };
}

/**
 * Compute the actual (unpadded) depth of a sibling array by stripping trailing "0x0" padding.
 * The SDK pads siblings with "0x0" to a fixed max depth — this recovers the real proof depth.
 */
function actualDepth(paddedSiblings: SDKHex[]): number {
    let depth = paddedSiblings.length;
    while (depth > 0 && paddedSiblings[depth - 1] === "0x0") {
        depth--;
    }
    return depth;
}

/**
 * Pad witness siblings to circuit-required fixed depths and fix per-input tree depths.
 *
 * The SDK's WitnessPreparationService has a bug for multi-input circuits: it sets
 * stateTreeDepth and associationSetTreeDepth as scalars from the FIRST proof only.
 * In a LeanIMT, different leaves can have different proof depths (siblings are skipped
 * at levels where the sibling node doesn't exist). This function computes per-input
 * depths from the actual sibling arrays.
 */
function padWitnessSiblings(
    witness: TransactCircuitInputs,
    merkleService: MerkleService,
    maxDepths: { state: number; keystore: number; asp: number },
    nInputs: number
): TransactCircuitInputs {
    const patched = { ...witness };
    if (nInputs > 1) {
        // Compute per-input depths from sibling arrays (SDK only provides first proof's depth)
        const stateDepths = witness.stateSiblings.map((s: SDKHex[]) => `0x${actualDepth(s).toString(16)}` as SDKHex);
        const aspDepths = witness.associationSetSiblings.map(
            (s: SDKHex[]) => `0x${actualDepth(s).toString(16)}` as SDKHex
        );
        (patched as Record<string, unknown>).stateTreeDepth = stateDepths;
        (patched as Record<string, unknown>).associationSetTreeDepth = aspDepths;
    }
    return {
        ...patched,
        keystoreSiblings: merkleService.padSiblings(witness.keystoreSiblings, maxDepths.keystore),
        stateSiblings: witness.stateSiblings.map((s: SDKHex[]) => merkleService.padSiblings(s, maxDepths.state)),
        associationSetSiblings: witness.associationSetSiblings.map((s: SDKHex[]) =>
            merkleService.padSiblings(s, maxDepths.asp)
        ),
    };
}

/**
 * Serves a fixed association-set leaf list to the SDK's {@link ASPClient}.
 *
 * The e2e pushes the LeanIMT root of these exact leaves on-chain via
 * `updateASPRoot` (see `pushASPTree`), so `ASPClient.getAssociationSetLeaves`
 * verifies the returned leaves against `latestASPRoot` and accepts them. Only
 * `getLeaves` is exercised by the withdraw path; the other provider methods are
 * unused here and reject if called.
 */
class InMemoryASPDataProvider implements IASPDataProvider {
    constructor(private readonly leaves: SDKHex[]) {}
    async getRoot(): Promise<SDKHex> {
        throw new Error("InMemoryASPDataProvider.getRoot not used by the e2e withdraw path");
    }
    async getLeaves(): Promise<SDKHex[]> {
        return this.leaves;
    }
    async getLabelStatus(): Promise<LabelStatus> {
        throw new Error("InMemoryASPDataProvider.getLabelStatus not implemented");
    }
    async getASPPublicKey(): Promise<PublicKey> {
        throw new Error("InMemoryASPDataProvider.getASPPublicKey not implemented");
    }
    async getEventSnapshot(): Promise<EventSnapshot> {
        throw new Error("InMemoryASPDataProvider.getEventSnapshot not implemented");
    }
    async getNoteEvents(): Promise<{ events: NoteEvent[]; lastSyncedBlock: SDKHex }> {
        throw new Error("InMemoryASPDataProvider.getNoteEvents not implemented");
    }
}

// ============================================================================
// E2EProofService
// ============================================================================

export class E2EProofService {
    private constructor(
        private readonly hashService: PoseidonHashService,
        private readonly merkleService: MerkleService,
        private readonly witnessService: WitnessPreparationService,
        private readonly proofService: ProofService,
        private readonly cryptoService: CryptoService,
        private readonly noteComputationService: NoteComputationService,
        private readonly rpcUrl: string,
        private readonly publicClient: PublicClient,
        private readonly testClient: TestClient,
        private readonly walletClientFactory: (account: Address) => WalletClient
    ) {}

    static async create(config: E2EProofServiceConfig): Promise<E2EProofService> {
        const hashService = await PoseidonHashService.create();
        const merkleService = new MerkleService({ hashService });
        const cryptoService = new CryptoService();
        const noteComputationService = new NoteComputationService({ hashService, cryptoService });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const witnessService = new WitnessPreparationService({ hashService, merkleService, noteComputationService } as any);
        const artifacts = new LocalCircuitArtifacts({ baseDir: config.circuitArtifactsDir } as any);
        const proofService = new ProofService({
            circuitArtifacts: artifacts,
            groth16Prover: new Groth16Prover(),
        });

        const transport = http(config.rpcUrl);
        const publicClientRaw = createPublicClient({ transport });
        const chainId = await publicClientRaw.getChainId();
        const chain = { ...hardhat, id: chainId };

        const publicClient = createPublicClient({ chain, transport });
        const testClient = createTestClient({ chain, transport, mode: "hardhat" });
        const walletClientFactory = (account: Address) => createWalletClient({ chain, transport, account });

        return new E2EProofService(
            hashService,
            merkleService,
            witnessService,
            proofService,
            cryptoService,
            noteComputationService,
            config.rpcUrl,
            publicClient,
            testClient,
            walletClientFactory
        );
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Full lifecycle: setup account on anvil -> deposit -> generate withdrawal proof -> format relay payload.
     * Requires anvil running with impersonation available.
     */
    async generateWithdrawalPayload(params: {
        amountOut: string;
        recipient: Address;
        asset: Address;
        relayerUrl: string;
        chainId: string;
        ownerAddress: Address;
    }): Promise<WithdrawalPayloadResult> {
        const ownerAddress = params.ownerAddress;
        const tokenId = params.asset;
        const value = params.amountOut; // deposit at least amountOut (will be adjusted below)

        // Step 1: Setup account (register + ASP + deposit)
        const accountState = await this.setupAccount({
            ownerAddress,
            tokenId,
            value,
        });

        // Step 2: Generate withdrawal proof
        return this.generateWithdrawalProof({
            accountStates: [accountState],
            amountOut: params.amountOut,
            recipient: params.recipient,
            relayerUrl: params.relayerUrl,
            chainId: params.chainId,
        });
    }

    /**
     * Full lifecycle: setup account on anvil -> deposit -> generate transfer proof -> format relay payload.
     * Requires anvil running with impersonation available.
     */
    async generateTransferPayload(params: {
        recipientNoteAddressHash: Hex;
        transferAmount: string;
        asset: Address;
        relayerUrl: string;
        chainId: string;
        ownerAddress: Address;
    }): Promise<TransferPayloadResult> {
        const ownerAddress = params.ownerAddress;
        const tokenId = params.asset;
        // Deposit enough for the transfer (transfer amount + room for fee)
        const depositValue = (BigInt(params.transferAmount) * 2n).toString();

        const accountState = await this.setupAccount({
            ownerAddress,
            tokenId,
            value: depositValue,
        });

        return this.generateTransferProof({
            accountStates: [accountState],
            recipientNoteAddressHash: params.recipientNoteAddressHash,
            transferAmount: params.transferAmount,
            relayerUrl: params.relayerUrl,
            chainId: params.chainId,
        });
    }

    /**
     * CPU-only phase: generate secrets, compute hashes, build deposit proof.
     * No chain interaction — safe to run in parallel via Promise.all.
     */
    async prepareAccount(params: {
        ownerAddress: Address;
        tokenId: Address;
        value: string;
        privateNullifyingKey?: SDKHex;
        privateRevocableKey?: SDKHex;
        noteSecret?: SDKHex;
        depositSecret?: SDKHex;
    }): Promise<PreparedAccount> {
        const privateNullifyingKey = params.privateNullifyingKey ?? randomFieldElement();
        const privateRevocableKey = params.privateRevocableKey ?? randomFieldElement();
        const noteSecret = params.noteSecret ?? randomFieldElement();
        const depositSecret = params.depositSecret ?? randomFieldElement();
        const value = toHex(params.value);
        console.log("TOKEN_ID: ", params.tokenId);
        console.log("OWNER_ADDRESS: ", params.ownerAddress);
        const tokenId = toHex(params.tokenId);
        const ownerAddress = params.ownerAddress;
        const ownerAddressHex = toHex(params.ownerAddress);


        // 1. Compute label hashes
        const noteAddressHash = this.hashService.hash([ownerAddressHex, noteSecret]);
        const precommitment = this.hashService.hash([noteAddressHash, tokenId, value, "0x0"]);
        const label = this.hashService.hash([precommitment, depositSecret]);
        const labelHash = this.hashService.hash([label]);

        // 2. Generate deposit proof (CPU-heavy, no chain interaction)
        const depositNoteData = { hint: ZERO_HINT, data: ZERO_DATA };
        const depositContextHash = keccak256(
            encodeAbiParameters(
                [
                    {
                        type: "tuple",
                        components: [
                            { name: "hint", type: "bytes32" },
                            { name: "data", type: "bytes" },
                        ],
                    },
                ],
                [depositNoteData]
            )
        );
        const depositContext = toHex(BigInt(depositContextHash) % SNARK_SCALAR_FIELD);

        // Source SDK uses noteAddressHash; built d.ts expects ownerAddress+noteSecret.
        // Docker runs from source, so use noteAddressHash.
        const depositWitness = await this.witnessService.buildDepositWitness({
            noteAddressHash,
            tokenId,
            value,
            depositSecret,
            context: depositContext,
        } as any);

        // Source SDK returns DepositCircuitInputs directly; built d.ts wraps it in DepositWitness.
        // Handle both shapes for Docker (source) vs local (built) compatibility.
        const witnessInput = 'witness' in depositWitness ? (depositWitness as any).witness : depositWitness;
        const depositResult = await this.proofService.proveDeposit(witnessInput);
        const depositProof = proofToDepositCalldata(depositResult.proof, depositResult.publicSignals);

        return {
            ownerAddress,
            tokenId,
            value,
            privateNullifyingKey,
            privateRevocableKey,
            noteSecret,
            depositSecret,
            label,
            labelHash,
            depositProof,
        };
    }

    /**
     * Anvil-bound phase: register keystore, submit deposit on-chain.
     * Must run sequentially against anvil (impersonation is not concurrent-safe).
     */
    async submitAccount(prepared: PreparedAccount, options?: { skipASP?: boolean }): Promise<AccountState> {
        // 1. Register keystore account
        await this.registerKeystoreAccount(
            prepared.ownerAddress,
            prepared.privateNullifyingKey,
            prepared.privateRevocableKey
        );

        // 2. Add ASP set (skip if caller will batch all labels later)
        if (!options?.skipASP) {
            await this.addASPSet([prepared.labelHash]);
        }

        // 3. Submit deposit on-chain using pre-generated proof
        const isNative = BigInt(prepared.tokenId) === NATIVE_ASSET_ID;
        await this.impersonateAndFund(prepared.ownerAddress);
        const walletClient = this.walletClientFactory(prepared.ownerAddress);

        if (!isNative) {
            const approveTx = await walletClient.writeContract({
                chain: null,
                account: prepared.ownerAddress,
                address: `0x${prepared.tokenId.slice(-40)}` as Address,
                abi: ERC20_ABI,
                functionName: "approve",
                args: [SEPOLIA_CONTRACTS.entrypoint, BigInt(prepared.value)],
            });
            await this.publicClient.waitForTransactionReceipt({ hash: approveTx });
        }

        console.log("DEBUG deposit proof:", JSON.stringify({
            pA: prepared.depositProof.pA.map(String),
            pB: prepared.depositProof.pB.map((r: [bigint, bigint]) => r.map(String)),
            pC: prepared.depositProof.pC.map(String),
            pubSignals: prepared.depositProof.pubSignals.map(String),
            noteData: { hint: ZERO_HINT, data: ZERO_DATA },
            value: isNative ? prepared.value : "0",
            entrypoint: SEPOLIA_CONTRACTS.entrypoint,
            owner: prepared.ownerAddress,
        }, null, 2));

        // Simulate first to get detailed revert reason before spending gas
        try {
            await this.publicClient.simulateContract({
                address: SEPOLIA_CONTRACTS.entrypoint,
                abi: ENTRYPOINT_ABI,
                functionName: "deposit",
                args: [prepared.depositProof, { hint: ZERO_HINT, data: ZERO_DATA }, "0x"],
                value: isNative ? BigInt(prepared.value) : 0n,
                account: prepared.ownerAddress,
            });
        } catch (simErr: any) {
            // Extract revert reason details
            const details = simErr?.cause?.data ?? simErr?.data ?? simErr?.shortMessage ?? simErr?.message ?? String(simErr);
            throw new Error(`Deposit simulation reverted: ${JSON.stringify(details)}`);
        }

        const txHash = await walletClient.writeContract({
            chain: null,
            account: prepared.ownerAddress,
            address: SEPOLIA_CONTRACTS.entrypoint,
            abi: ENTRYPOINT_ABI,
            functionName: "deposit",
            args: [prepared.depositProof, { hint: ZERO_HINT, data: ZERO_DATA }, "0x"],
            value: isNative ? BigInt(prepared.value) : 0n,
        });

        const depositReceipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
        if (depositReceipt.status !== "success") {
            throw new Error(`Deposit transaction reverted: ${txHash}`);
        }
        await this.testClient.stopImpersonatingAccount({ address: prepared.ownerAddress });

        // 4. Get the deposit timestamp from the block
        const block = await this.publicClient.getBlock({
            blockNumber: depositReceipt.blockNumber,
        });
        const createdAtBlock = toHex(block.timestamp) as Hex;

        return {
            ownerAddress: prepared.ownerAddress,
            privateNullifyingKey: prepared.privateNullifyingKey,
            privateRevocableKey: prepared.privateRevocableKey,
            noteSecret: prepared.noteSecret,
            depositSecret: prepared.depositSecret,
            tokenId: prepared.tokenId,
            value: prepared.value,
            label: prepared.label,
            labelHash: prepared.labelHash,
            createdAtBlock,
            depositTxHash: txHash,
        };
    }

    /**
     * Setup-only: prepare + submit in one call (backward-compatible).
     */
    async setupAccount(params: {
        ownerAddress: Address;
        tokenId: Address;
        value: string;
        privateNullifyingKey?: SDKHex;
        privateRevocableKey?: SDKHex;
        noteSecret?: SDKHex;
        depositSecret?: SDKHex;
        skipASP?: boolean;
    }): Promise<AccountState> {
        const prepared = await this.prepareAccount(params);
        return this.submitAccount(prepared, { skipASP: params.skipASP });
    }

    /**
     * Generate a withdrawal proof from an existing account state.
     * Does not touch the chain -- only reads state and generates proof.
     */
    async generateWithdrawalProof(params: {
        accountStates: AccountState[];
        amountOut: string;
        recipient: Address;
        relayerUrl: string;
        chainId: string;
        aspLeaves?: SDKHex[];
        mOutputs?: number;
    }): Promise<WithdrawalPayloadResult> {
        const { accountStates } = params;
        const nInputs = accountStates.length;
        const mOutputs = params.mOutputs ?? 1;
        const primaryAccount = accountStates[0];

        // 1. Fetch on-chain state
        const stateLeaves = await this.getStateTreeLeaves();
        const keystoreLeaves = await this.getKeystoreLeaves();

        // 2. ASP leaves (use provided leaves or fall back to input accounts)
        const aspLeaves = params.aspLeaves ?? accountStates.map((a) => a.labelHash);

        // 3. Quote the relayer
        const quoteUrl = `${params.relayerUrl}/v1/quote/evm/${params.chainId}/send`;
        const quoteBody = {
            asset: `0x${primaryAccount.tokenId.slice(-40)}`,
            amount: params.amountOut,
            commit: true,
            recipient: params.recipient,
        };

        const quoteRes = await fetch(quoteUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(quoteBody),
        });
        if (!quoteRes.ok) {
            const errText = await quoteRes.text();
            throw new Error(`Quote failed (${quoteRes.status}): ${errText}`);
        }

        const quoteData = (await quoteRes.json()) as {
            feeCommitment?: Record<string, unknown>;
            feeAmount: string;
        };
        if (!quoteData.feeCommitment) {
            throw new Error("Quote response missing feeCommitment -- was commit: true sent?");
        }

        const signedFeeCommitment = quoteData.feeCommitment;
        const feeSplitData = (signedFeeCommitment as { data: Hex }).data;

        // 4. Compute context
        const context = this.computeContext(SEPOLIA_CONTRACTS.relayContract, feeSplitData, mOutputs);

        // 5. Build output notes (change notes, split evenly across mOutputs)
        const amountOut = BigInt(params.amountOut);
        const totalValue = accountStates.reduce((sum, a) => sum + BigInt(a.value), 0n);
        const changeValue = totalValue - amountOut;

        const changePerNote = changeValue / BigInt(mOutputs);
        const changeRemainder = changeValue % BigInt(mOutputs);

        const tokenIdAddr = (`0x${primaryAccount.tokenId.slice(-40)}`) as SDKHex;
        const outputNotes = Array.from({ length: mOutputs }, (_, i) => {
            const nonce = `0x${i.toString(16)}` as SDKHex;
            const derivationKey = this.hashService.hash([
                primaryAccount.privateNullifyingKey,
                primaryAccount.noteSecret,
                nonce,
            ]);
            const outNoteSecret = this.hashService.hash([derivationKey, "0x0", "0x0"]);
            const outNoteAddressHash = this.hashService.hash([
                primaryAccount.ownerAddress as unknown as SDKHex,
                outNoteSecret,
            ]);
            // Give any remainder to the last note
            const value = i === mOutputs - 1 ? changePerNote + changeRemainder : changePerNote;
            const hexValue = toHex(value);
            const precommitment = this.hashService.hash([outNoteAddressHash, primaryAccount.tokenId as SDKHex, hexValue, "0x0"]);
            const commitment = this.hashService.hash([precommitment, primaryAccount.label]);
            return {
                noteAddressHash: outNoteAddressHash,
                commitment,
                value: hexValue,
                tokenId: tokenIdAddr,
                label: primaryAccount.label,
                status: "PENDING" as const,
                isOwned: true as const,
                noteSecret: outNoteSecret,
                ownerAddress: primaryAccount.ownerAddress as unknown as SDKHex,
            };
        });

        // 6. Build witness then generate proof
        const inputNotes = accountStates.map((a) => this.buildNoteFromAccountState(a));

        const witnessInputs = {
            inputNotes,
            changeNotes: outputNotes,
            ownerAddress: primaryAccount.ownerAddress as unknown as SDKHex,
            privateNullifyingKey: primaryAccount.privateNullifyingKey,
            privateRevocableKey: primaryAccount.privateRevocableKey,
            tokenId: primaryAccount.tokenId as SDKHex,
            amountOut: toHex(amountOut),
            tokenIdOut: primaryAccount.tokenId as SDKHex,
            context: context as SDKHex,
            stateLeaves: stateLeaves.leaves,
            keystoreLeaves,
            aspLeaves,
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const witness = await this.witnessService.buildTransactWitness(witnessInputs as any) as any as TransactCircuitInputs;
        const paddedWitness = padWitnessSiblings(witness, this.merkleService, MAX_DEPTHS, nInputs);

        const proofResult = await this.proofService.proveTransact(paddedWitness, nInputs, mOutputs);

        // Compute nullifiers and output commitments from witness data
        const nullifiers = inputNotes.map((n) =>
            this.hashService.hash([n.noteSecret, primaryAccount.privateNullifyingKey]),
        );
        const outputCommitments = outputNotes.map((n) => n.commitment);

        // 7. Format relay payload
        const noteData: { hint: Hex; data: Hex }[] = Array.from({ length: mOutputs }, () => ({
            hint: ZERO_HINT,
            data: ZERO_DATA,
        }));

        const relayPayload: RelayPayload = {
            proof: {
                ...proofResult.proof,
                publicSignals: proofResult.publicSignals,
            },
            inputNullifierNumber: nInputs,
            outputCommitmentNumber: mOutputs,
            processor: SEPOLIA_CONTRACTS.relayContract,
            noteData,
            signedFeeCommitment,
        };

        return {
            relayPayload,
            depositTxHash: primaryAccount.depositTxHash as Hex,
            nullifiers: nullifiers as Hex[],
            outputCommitments: outputCommitments as Hex[],
            accountState: primaryAccount,
        };
    }

    /**
     * Wire a real SDK {@link TransactOrchestrator} ("core") plus a {@link NoteManager}
     * populated with the batch's active input notes, exactly as the PoolSession factory
     * does (see `PoolSessionFactory`). The caller constructs a
     * {@link BatchWithdrawOrchestrator} from `{ core, noteManager }` and drives its
     * `prepareBatchWithdraw` — so all per-note-group work (1x1 full withdrawal, zero-value
     * change note, per-item PayoutRouting bound into the proof context) lives in the SDK,
     * not reproduced here.
     *
     * ASP leaves are served by an in-memory provider whose LeanIMT root the e2e has already
     * pushed on-chain via `pushASPTree`, so `ASPClient.getAssociationSetLeaves` verifies the
     * returned leaves against `latestASPRoot` and accepts them. State and keystore leaves are
     * read from anvil through the real interactors. Every account in a batch shares one
     * keystore identity (same nullifying/revocable keys), so a single KeystoreManager covers all.
     */
    async createBatchWithdrawCore(params: {
        ownerAddress: Address;
        accounts: AccountState[];
        aspLeaves: SDKHex[];
    }): Promise<{ core: TransactOrchestrator; noteManager: NoteManager; notes: Note[] }> {
        const { ownerAddress, accounts, aspLeaves } = params;
        const primary = accounts[0];

        // Build the RPC interactor with the SDK's own viem (via rpcUrl) rather than
        // passing the harness's viem PublicClient — the two viem versions drift, and the
        // interactor only needs read access (getLogs / readContract) to the anvil fork.
        const rpcInteractor = ViemRPCInteractor.create({ rpcUrl: this.rpcUrl });
        const poolVaultInteractor = new PoolVaultInteractor({
            rpcInteractor,
            contractAddress: SEPOLIA_CONTRACTS.poolVault,
        });
        const keystoreInteractor = new KeystoreInteractor({
            rpcInteractor,
            contractAddress: SEPOLIA_CONTRACTS.keystore,
        });
        const aspRegistryInteractor = new ASPRegistryInteractor({
            rpcInteractor,
            contractAddress: SEPOLIA_CONTRACTS.aspRegistry,
        });
        const aspClient = new ASPClient({
            providers: [new InMemoryASPDataProvider(aspLeaves)],
            merkleService: this.merkleService,
            aspRegistryInteractor,
        });

        // Direct-key keystore identity shared by every note in the batch. The withdraw
        // path only reads the nullifying/revocable keys; the viewing keypair is a valid
        // X25519 pair the config schema requires but this flow never uses.
        const viewing = this.cryptoService.generateEphemeralKeyPair();
        const keystoreManager = new KeystoreManager({
            privateNullifyingKey: primary.privateNullifyingKey,
            privateRevocableKey: primary.privateRevocableKey,
            viewingPrivateKey: viewing.privateKey,
            viewingPublicKey: viewing.publicKey,
            revocableKeyIndex: "0x0",
        });

        const noteManager = new NoteManager({});
        const notes = accounts.map((a) => this.buildActiveNote(a));
        for (const note of notes) {
            noteManager.addNote(note);
        }

        const core = new TransactOrchestrator({
            ownerAddress,
            noteManager,
            keystoreManager,
            witnessPreparationService: this.witnessService,
            proofService: this.proofService,
            keystoreInteractor,
            poolVaultInteractor,
            aspClient,
            cryptoService: this.cryptoService,
            noteComputationService: this.noteComputationService,
            rpcInteractor,
        });

        return { core, noteManager, notes };
    }

    /** Build a spendable ACTIVE {@link Note} from an AccountState (a batch input note). */
    private buildActiveNote(a: AccountState): Note {
        const noteAddressHash = this.hashService.hash([toHex(a.ownerAddress), a.noteSecret]);
        const precommitment = this.hashService.hash([noteAddressHash, toHex(a.tokenId), toHex(a.value), "0x0"]);
        const commitment = this.hashService.hash([precommitment, a.label]);
        return {
            noteAddressHash,
            commitment,
            value: toHex(a.value),
            tokenId: (`0x${a.tokenId.slice(-40)}`) as Address,
            label: a.label,
            status: NoteStatus.ACTIVE,
            ownerAddress: a.ownerAddress,
            noteSecret: a.noteSecret,
            isOwned: true,
            depositSecret: a.depositSecret,
            createdAtBlock: a.createdAtBlock as SDKHex,
            spentAtBlock: null,
            txHash: a.depositTxHash as SDKHex,
        };
    }

    /**
     * Generate a transfer proof from an existing account state.
     */
    async generateTransferProof(params: {
        accountStates: AccountState[];
        recipientNoteAddressHash?: Hex;
        transferAmount?: string;
        recipients?: Array<{ noteAddressHash: Hex; amount: string }>;
        relayerUrl: string;
        chainId: string;
        aspLeaves?: SDKHex[];
        mOutputs?: number;
        processor?: Address;
    }): Promise<TransferPayloadResult> {
        const { accountStates } = params;
        const primaryAccount = accountStates[0];
        const nInputs = accountStates.length;
        // For N inputs use N outputs (1 recipient + N-1 change notes), minimum 2.
        // This ensures per-label conservation: each change note gets a distinct
        // input's label so no single label's output exceeds its input value.
        const mOutputs = params.mOutputs ?? Math.max(2, nInputs);

        // 1. Fetch on-chain state
        const stateLeaves = await this.getStateTreeLeaves();
        const keystoreLeaves = await this.getKeystoreLeaves();
        const aspLeaves = params.aspLeaves ?? accountStates.map((a) => a.labelHash);

        // 2. Quote the relayer for a transfer
        const quoteUrl = `${params.relayerUrl}/v1/quote/evm/${params.chainId}/transfer`;
        const quoteBody = {
            asset: `0x${primaryAccount.tokenId.slice(-40)}`,
            commit: true,
        };

        const quoteRes = await fetch(quoteUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(quoteBody),
        });
        if (!quoteRes.ok) {
            const errText = await quoteRes.text();
            throw new Error(`Transfer quote failed (${quoteRes.status}): ${errText}`);
        }

        const quoteData = (await quoteRes.json()) as {
            feeCommitment?: Record<string, unknown>;
            feeAmount: string;
        };
        if (!quoteData.feeCommitment) {
            throw new Error("Quote response missing feeCommitment -- was commit: true sent?");
        }

        const signedFeeCommitment = quoteData.feeCommitment;
        const feeSplitData = (signedFeeCommitment as { data: Hex }).data;
        const feeAmount = BigInt(quoteData.feeAmount);

        // For transfers: amountOut = feeAmount (the only value leaving the pool is the relayer fee)
        const amountOut = feeAmount;

        // Normalize single-recipient to array form
        const recipientOutputs = params.recipients ?? [{
            noteAddressHash: params.recipientNoteAddressHash!,
            amount: params.transferAmount!,
        }];
        const numRecipients = recipientOutputs.length;

        const totalValue = accountStates.reduce((sum, a) => sum + BigInt(a.value), 0n);
        const totalTransfer = recipientOutputs.reduce((sum, r) => sum + BigInt(r.amount), 0n);

        if (totalTransfer + feeAmount > totalValue) {
            throw new Error(
                `totalTransfer (${totalTransfer}) + feeAmount (${feeAmount}) exceeds deposit value (${totalValue})`
            );
        }
        if (numRecipients > mOutputs) {
            throw new Error(
                `Too many recipients (${numRecipients}) for ${mOutputs} outputs`
            );
        }

        // 3. Compute context (use provided processor or default to relay contract)
        const processor = params.processor ?? SEPOLIA_CONTRACTS.relayContract;
        const context = this.computeContext(processor, feeSplitData);

        // 4. Build output notes: [0..numRecipients-1] = recipient notes, rest = change notes
        // Per-label conservation: for each label L,
        //   sum(inputs with label L) >= sum(outputs with label L).
        const changeValue = totalValue - totalTransfer - feeAmount;
        const numChangeNotes = mOutputs - numRecipients;

        if (numChangeNotes === 0 && changeValue !== 0n) {
            throw new Error(
                `No change note slots but ${changeValue} wei unaccounted for. ` +
                `Either add more outputs or adjust recipient amounts.`
            );
        }

        const derivationKey = this.hashService.hash([
            primaryAccount.privateNullifyingKey,
            primaryAccount.noteSecret,
            "0x0", // nonce = 0
        ]);

        // Outputs [0..numRecipients-1]: recipient notes (label from primary account)
        const tokenIdAddr = (`0x${primaryAccount.tokenId.slice(-40)}`) as SDKHex;
        const recipientNotes = recipientOutputs.map((r) => {
            const hexValue = toHex(r.amount);
            const nah = r.noteAddressHash as SDKHex;
            const precommitment = this.hashService.hash([nah, primaryAccount.tokenId as SDKHex, hexValue, "0x0"]);
            const commitment = this.hashService.hash([precommitment, primaryAccount.label]);
            return {
                noteAddressHash: nah,
                commitment,
                value: hexValue,
                tokenId: tokenIdAddr,
                label: primaryAccount.label,
                status: "PENDING" as const,
                isOwned: false as const,
            };
        });
        const changeNotes: any[] = [];

        // Assign labels to change note positions:
        //   i < nInputs  → 1:1 with that input's label
        //   i >= nInputs → cycle through all input labels
        const changeLabels: SDKHex[] = [];
        for (let i = numRecipients; i < mOutputs; i++) {
            changeLabels.push(accountStates[i < nInputs ? i : i % nInputs].label);
        }

        // Compute per-label budgets after the recipient note and fee
        const labelBudget = new Map<SDKHex, bigint>();
        for (const a of accountStates) {
            labelBudget.set(a.label, (labelBudget.get(a.label) ?? 0n) + BigInt(a.value));
        }
        labelBudget.set(
            primaryAccount.label,
            labelBudget.get(primaryAccount.label)! - totalTransfer - feeAmount,
        );

        // Distribute change proportionally to each change-label's budget
        const uniqueChangeLabels = [...new Set(changeLabels)];
        const totalChangeBudget = uniqueChangeLabels.reduce(
            (sum, l) => sum + (labelBudget.get(l) ?? 0n),
            0n,
        );
        const labelChange = new Map<SDKHex, bigint>();
        let allocated = 0n;
        for (let i = 0; i < uniqueChangeLabels.length; i++) {
            const label = uniqueChangeLabels[i];
            if (i === uniqueChangeLabels.length - 1) {
                labelChange.set(label, changeValue - allocated);
            } else {
                const budget = labelBudget.get(label) ?? 0n;
                const share = totalChangeBudget > 0n ? (changeValue * budget) / totalChangeBudget : 0n;
                labelChange.set(label, share);
                allocated += share;
            }
        }

        // Split each label's share evenly across its notes
        const notesPerLabel = new Map<SDKHex, number>();
        for (const l of changeLabels) notesPerLabel.set(l, (notesPerLabel.get(l) ?? 0) + 1);
        const labelCounter = new Map<SDKHex, number>();

        for (let i = 0; i < numChangeNotes; i++) {
            const label = changeLabels[i];
            const idx = labelCounter.get(label) ?? 0;
            labelCounter.set(label, idx + 1);

            const count = notesPerLabel.get(label)!;
            const total = labelChange.get(label)!;
            const perNote = total / BigInt(count);
            const remainder = total % BigInt(count);
            const noteValue = idx === count - 1 ? perNote + remainder : perNote;

            const nonce = `0x${(i + 1).toString(16)}` as SDKHex;
            const changeNoteSecret = this.hashService.hash([derivationKey, "0x0", nonce]);
            const changeNoteAddressHash = this.hashService.hash([
                primaryAccount.ownerAddress as unknown as SDKHex,
                changeNoteSecret,
            ]);
            const hexValue = toHex(noteValue);
            const precommitment = this.hashService.hash([changeNoteAddressHash, primaryAccount.tokenId as SDKHex, hexValue, "0x0"]);
            const commitment = this.hashService.hash([precommitment, label]);
            changeNotes.push({
                noteAddressHash: changeNoteAddressHash,
                commitment,
                value: hexValue,
                tokenId: tokenIdAddr,
                label,
                status: "PENDING" as const,
                isOwned: true as const,
                noteSecret: changeNoteSecret,
                ownerAddress: primaryAccount.ownerAddress as unknown as SDKHex,
            });
        }

        // 5. Build witness then generate proof
        const inputNotes = accountStates.map((a) => this.buildNoteFromAccountState(a));

        const witnessInputs = {
            inputNotes,
            changeNotes,
            recipientNotes,
            ownerAddress: primaryAccount.ownerAddress as unknown as SDKHex,
            privateNullifyingKey: primaryAccount.privateNullifyingKey,
            privateRevocableKey: primaryAccount.privateRevocableKey,
            tokenId: primaryAccount.tokenId as SDKHex,
            amountOut: toHex(amountOut),
            tokenIdOut: primaryAccount.tokenId as SDKHex,
            context: context as SDKHex,
            stateLeaves: stateLeaves.leaves,
            keystoreLeaves,
            aspLeaves,
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const witness = await this.witnessService.buildTransactWitness(witnessInputs as any) as any as TransactCircuitInputs;
        const paddedWitness = padWitnessSiblings(witness, this.merkleService, MAX_DEPTHS, nInputs);
        const proofResult = await this.proofService.proveTransact(paddedWitness, nInputs, mOutputs);

        // Compute nullifiers and output commitments from witness data
        const nullifiers = inputNotes.map((n) =>
            this.hashService.hash([n.noteSecret, primaryAccount.privateNullifyingKey]),
        );
        const allOutputNotes = [...recipientNotes, ...changeNotes];
        const outputCommitments = allOutputNotes.map((n) => n.commitment);

        // 6. Format relay payload
        const noteData: { hint: Hex; data: Hex }[] = [{ hint: ZERO_HINT, data: ZERO_DATA }];

        const relayPayload: RelayPayload = {
            proof: {
                ...proofResult.proof,
                publicSignals: proofResult.publicSignals,
            },
            inputNullifierNumber: nInputs,
            outputCommitmentNumber: mOutputs,
            processor,
            noteData,
            signedFeeCommitment,
        };

        return {
            relayPayload,
            depositTxHash: primaryAccount.depositTxHash as Hex,
            nullifiers: nullifiers as Hex[],
            outputCommitments: outputCommitments as Hex[],
            accountState: primaryAccount,
            recipientNote: {
                noteAddressHash: recipientOutputs[0].noteAddressHash,
                value: recipientOutputs[0].amount,
                label: primaryAccount.label as Hex,
                tokenId: primaryAccount.tokenId as Hex,
            },
        };
    }

    // ========================================================================
    // On-chain state fetching
    // ========================================================================

    /**
     * Fetch all state tree leaves from PoolVault via LeavesInserted events.
     * Also fetches Transacted events for change note timestamp lookup.
     */
    private async getStateTreeLeaves(): Promise<StateTreeResult> {
        // const TRANSACTED_TOPIC = "0x10763cc44bf9290f53ec1afd9f70684d93fe62b7d1956d9a18410ae38da9d048" as Hex;

        // interface RawLog {
        //     blockNumber: Hex;
        //     logIndex: Hex;
        //     data: Hex;
        //     topics: Hex[];
        // }

        const leavesInsertedLogs = await this.publicClient.getLogs({
            address: SEPOLIA_CONTRACTS.poolVault,
            event: {
                type: "event",
                name: "LeavesInserted",
                inputs: [
                    { name: "_newLeaves", type: "uint256[]", indexed: false },
                    { name: "_root", type: "uint256", indexed: false },
                    { name: "_startIndex", type: "uint256", indexed: false },
                ],
            },
            fromBlock: 0n,
            toBlock: "latest",
        });

        // Build leaf entries with sort keys
        interface LeafEntry {
            blockNumber: bigint;
            logIndex: number;
            leaves: SDKHex[];
        }
        const entries: LeafEntry[] = [];

        for (const log of leavesInsertedLogs) {
            entries.push({
                blockNumber: log.blockNumber,
                logIndex: log.logIndex,
                leaves: (log.args._newLeaves ?? []).map((v) => toHex(v)),
            });
        }

        // Sort by (blockNumber, logIndex) for correct insertion order
        entries.sort((a, b) => {
            if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
            return a.logIndex - b.logIndex;
        });

        const allLeaves = entries.flatMap((e) => e.leaves);
        return { leaves: allLeaves };
    }

    /**
     * Fetch all keystore tree leaves from Keystore via LeafInserted events.
     */
    private async getKeystoreLeaves(): Promise<SDKHex[]> {
        const logs = await this.publicClient.getLogs({
            address: SEPOLIA_CONTRACTS.keystore,
            event: {
                type: "event",
                name: "LeafInserted",
                inputs: [
                    { name: "_newLeaf", type: "uint256", indexed: false },
                    { name: "_root", type: "uint256", indexed: false },
                    { name: "_leafIndex", type: "uint256", indexed: false },
                ],
            },
            fromBlock: 0n,
            toBlock: "latest",
        });

        const sorted = logs.sort((a, b) => {
            const idxA = Number(a.args._leafIndex ?? 0n);
            const idxB = Number(b.args._leafIndex ?? 0n);
            return idxA - idxB;
        });

        return sorted.map((log) => toHex(log.args._newLeaf!));
    }

    // ========================================================================
    // Account setup (anvil impersonation)
    // ========================================================================

    private async impersonateAndFund(address: Address): Promise<void> {
        await this.testClient.impersonateAccount({ address });
        const balance = await this.publicClient.getBalance({ address });
        if (balance < 10n ** 18n) {
            await this.testClient.setBalance({
                address,
                value: 10_000n * 10n ** 18n,
            });
        }
    }

    /**
     * Register a keystore account via Keystore.setAuthPolicy().
     * Uses anvil impersonation.
     */
    private async registerKeystoreAccount(
        ownerAddress: Address,
        privateNullifyingKey: SDKHex,
        privateRevocableKey: SDKHex
    ): Promise<void> {
        const authDigest = this.hashService.hash([AUTH_TYPE_DIRECT_KEY, privateRevocableKey]);
        const nullifyingKeyHash = this.hashService.hash([privateNullifyingKey]);

        // Check if already registered
        const existingNullKey = await this.publicClient.readContract({
            address: SEPOLIA_CONTRACTS.keystore,
            abi: KEYSTORE_ABI,
            functionName: "nullifyingKeys",
            args: [ownerAddress],
        });

        if (existingNullKey !== 0n) {
            return; // Already registered
        }

        await this.impersonateAndFund(ownerAddress);
        const walletClient = this.walletClientFactory(ownerAddress);

        const txHash = await walletClient.writeContract({
            chain: null,
            account: ownerAddress,
            address: SEPOLIA_CONTRACTS.keystore,
            abi: KEYSTORE_ABI,
            functionName: "setAuthPolicy",
            args: [BigInt(authDigest), BigInt(nullifyingKeyHash)],
        });

        const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") {
            throw new Error(`registerKeystoreAccount reverted for ${ownerAddress}: ${txHash}`);
        }
        await this.testClient.stopImpersonatingAccount({ address: ownerAddress });
    }

    /**
     * Push a shared ASP tree containing all the given label hashes.
     * Use with setupAccount({ skipASP: true }) to batch all labels into one tree.
     */
    async pushASPTree(accountStates: AccountState[]): Promise<void> {
        const labelHashes = accountStates.map((s) => s.labelHash);
        await this.addASPSet(labelHashes);
    }

    /**
     * Add an ASP set with the given label hashes.
     */
    private async addASPSet(labelHashes: SDKHex[]): Promise<void> {
        const tree = new LeanIMT<SDKHex>((a, b) => this.hashService.hash([a, b]));
        tree.insertMany(labelHashes);
        const aspRoot = tree.root;

        // Impersonate an address that already has POSTMAN_ROLE on the Sepolia fork
        const callerAddress = POSTMAN_ADDRESS;

        await this.impersonateAndFund(callerAddress);
        const walletClient = this.walletClientFactory(callerAddress);

        const txHash = await walletClient.writeContract({
            chain: null,
            account: callerAddress,
            address: SEPOLIA_CONTRACTS.aspRegistry,
            abi: ASP_REGISTRY_ABI,
            functionName: "updateASPRoot",
            args: [BigInt(aspRoot!), "0xfa7fa7fa7fa7fa7fa7fa7"],
        });

        const aspReceipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
        if (aspReceipt.status !== "success") {
            throw new Error(`updateASPRoot transaction reverted: ${txHash}`);
        }
        await this.testClient.stopImpersonatingAccount({ address: callerAddress });
    }

    // ========================================================================
    // Context computation
    // ========================================================================

    /**
     * Build a full NoteSchema-compatible object from AccountState.
     * Computes commitment and noteAddressHash from the account's crypto material.
     */
    private buildNoteFromAccountState(a: AccountState) {
        const noteAddressHash = this.hashService.hash([
            toHex(a.ownerAddress),
            a.noteSecret,
        ]);
        const precommitment = this.hashService.hash([
            noteAddressHash,
            toHex(a.tokenId),
            toHex(a.value),
            "0x0",
        ]);
        const commitment = this.hashService.hash([precommitment, a.label]);
        return {
            commitment,
            noteAddressHash,
            value: toHex(a.value),
            tokenId: (`0x${a.tokenId.slice(-40)}`) as SDKHex,
            label: a.label,
            status: "ACTIVE" as const,
            ownerAddress: a.ownerAddress as unknown as SDKHex,
            noteSecret: a.noteSecret,
            isOwned: true,
            createdAtBlock: a.createdAtBlock as SDKHex,
            spentAtBlock: null,
            txHash: a.depositTxHash as SDKHex,
        };
    }

    /**
     * Compute the context hash for a transact proof.
     * context = keccak256(abi.encode(TransactParams{processor, data}, NoteData[])) % SNARK_SCALAR_FIELD
     */
    private computeContext(processor: Address, feeSplitData: Hex, mOutputs = 1): SDKHex {
        const noteData = Array.from({ length: mOutputs }, () => ({ hint: ZERO_HINT, data: ZERO_DATA }));

        const encoded = encodeAbiParameters(
            [
                {
                    type: "tuple",
                    components: [
                        { name: "processor", type: "address" },
                        { name: "data", type: "bytes" },
                    ],
                },
                {
                    type: "tuple[]",
                    components: [
                        { name: "hint", type: "bytes32" },
                        { name: "data", type: "bytes" },
                    ],
                },
            ],
            [{ processor, data: feeSplitData }, noteData]
        );

        const contextHash = keccak256(encoded);
        return toHex(BigInt(contextHash) % SNARK_SCALAR_FIELD);
    }

    // ========================================================================
    // Anvil snapshot helpers
    // ========================================================================

    async snapshot(): Promise<Hex> {
        const id = await this.testClient.request({ method: "evm_snapshot" });
        return id as Hex;
    }

    async revert(snapshotId: Hex): Promise<void> {
        await this.testClient.request({ method: "evm_revert", params: [snapshotId] });
    }
}
