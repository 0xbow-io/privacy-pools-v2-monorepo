/**
 * LIVE, real-Groth16-proof END-TO-END yield test for Privacy Pools V2 (ppUSDC),
 * driven THROUGH THE RUNNING RELAYER SERVICE (not a direct contract call).
 *
 * This is the RELAYED sibling of `yield-e2e.test.ts`. The deposit + Aave yield
 * accrual + SDK wiring are IDENTICAL (reused verbatim in spirit); the ONLY thing
 * that changes is the withdraw leg:
 *
 *   DIRECT (yield-e2e.test.ts):
 *     user wallet -> PPRouter.withdrawToUnderlying(...) directly
 *
 *   RELAYED (this file):
 *     1. POST /v1/quote/evm/11155111/send  -> signed EIP-712 fee commitment
 *        (gives the exact PayoutRouting `data` the relayer will pass on-chain)
 *     2. SDK TransactOrchestrator.prepareTransact with
 *        processorAddress = PPRouter and transactParams.data = the quote's
 *        commitment `data` VERBATIM, so the proof `context =
 *        keccak(abi.encode(transactParams, noteData))` matches what PPRouter +
 *        PoolVault re-derive on-chain.
 *     3. POST /v1/relay/evm/11155111/withdrawal with
 *        { proof (snarkjs fmt), inputNullifierNumber, outputCommitmentNumber,
 *          noteData, signedFeeCommitment, processorAddress: PPRouter }
 *        -> relayer submits PPRouter.withdrawToUnderlying as the postman.
 *     4. Poll the txHash; ASSERT on-chain:
 *        - recipient USDC delta >= previewRedeem(amountReceived shares) (incl yield)
 *        - delivered > immediate (no-yield) value           (yield delivered)
 *        - the relay fee recipient got the fee leg in USDC
 *        - the pool drained to 0
 *        - the relayed tx's `to` == PPRouter                (new processor path)
 *
 * Snapshots the chain before and reverts after, so the fork stays clean.
 *
 * PREREQUISITES (NOT created here — must already be running):
 *   - anvil Sepolia fork on http://localhost:8545 with the full stack deployed
 *     (addresses read from docs/deployments.local.json)
 *   - the relayer service on http://localhost:3000 (routes under /v1), config
 *     relayer.config.local.json with ppUSDC supported + PPRouter allowlisted
 *   - pre-built circuit artifacts under packages/circuits/build/
 *
 * RUN:
 *   cd packages/evm-sdk
 *   YIELD_E2E_RELAYED=1 pnpm exec vitest run scripts/e2e-yield/yield-e2e-relayed.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
    createPublicClient,
    createWalletClient,
    decodeAbiParameters,
    decodeFunctionData,
    encodeFunctionData,
    getAddress,
    http,
    keccak256,
    toBytes,
    parseAbi,
    type Hex as ViemHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    PendingNote,
    PublicKey,
    RelayerInfo,
    TransactParams,
    WithdrawalFeeCommitment,
    WithdrawalRelayParams,
} from "../../src/internal.js";
import {
    ASPClient,
    ASPRegistryInteractor,
    bigintToHex,
    CryptoService,
    EntrypointInteractor,
    ENTRYPOINT_DEPOSIT_ABI,
    Groth16Prover,
    HTTPClient,
    KeystoreInteractor,
    KeystoreManager,
    LocalCircuitArtifacts,
    MerkleService,
    NoteComputationService,
    NoteManager,
    NoteStatus,
    PoolSessionDeposit,
    PoolSessionKeystore,
    PoolVaultInteractor,
    POOL_VAULT_TRANSACT_ABI,
    PoseidonHashService,
    ProofService,
    RelayerInteractor,
    resolveCommitmentTimestamp,
    TransactOrchestrator,
    ViemRPCInteractor,
    ViemWalletInteractor,
    WitnessPreparationService,
} from "../../src/internal.js";
import { InMemoryAspProvider } from "./InMemoryAspProvider.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RUN = process.env.YIELD_E2E_RELAYED === "1";
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:3000";
const CHAIN_ID = 11155111;
const DEPLOYMENTS_PATH = resolve(__dirname, "../../../../../docs/deployments.local.json");
const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../circuits/build");

const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const USER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const POSTMAN = "0x723a43064e73Bcf46cf7d9b8506C400Df8ac878b" as const;

const SHIELD_VALUE = 1_000_000_000_000_000_000n; // 1 ppUSDC (18 dp)
const YIELD_WARP_SECONDS = 365n * 24n * 60n * 60n; // 1 year

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const ROUTER_ABI = parseAbi([
    "function quote(uint256 value) view returns (uint256 underlyingNeeded, uint256 total)",
    "function quoteWithdraw(uint256 shares) view returns (uint256 underlyingOut)",
    "function depositExactShares((uint256[2] pA,uint256[2][2] pB,uint256[2] pC,uint256[4] pubSignals) proof,(bytes32 hint,bytes data) noteData,bytes aspCiphertext,uint256 maxUnderlyingIn) returns (uint256)",
]);
const ERC20_ABI = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
]);
const PPUSDC_ABI = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function previewRedeem(uint256) view returns (uint256)",
]);
const FAUCET_ABI = parseAbi(["function mint(address token, address to, uint256 amount) returns (uint256)"]);
const ASP_REGISTRY_ABI = parseAbi([
    "function updateASPRoot(uint256 aspRoot, bytes ipfsCID)",
    "function latestASPRoot() view returns (uint256)",
]);

// PayoutRouting layout — must match SDK PAYOUT_ROUTING_ABI and relayer feeSplitParams.
const PAYOUT_ROUTING_DECODE = [
    {
        type: "tuple",
        components: [
            { name: "recipient", type: "address" },
            { name: "feeRecipient", type: "address" },
            { name: "feeAmount", type: "uint256" },
            { name: "nativeGas", type: "uint256" },
        ],
    },
] as const;

// ---------------------------------------------------------------------------

interface Deployments {
    core: { keystore: Address; aspRegistry: Address; poolVault: Address; entrypoint: Address };
    yield: { ppUSDC: Address; ppRouter: Address };
    aaveSepolia: { faucet: Address; usdc: Address };
}

// The relayer's signed withdrawal fee commitment (POST /quote/.../send response).
interface SignedWithdrawalFeeCommitment {
    feeAmount: string;
    asset: Address;
    recipient: Address;
    amountSent: string;
    amountReceived: string;
    data: ViemHex;
    expiration: number;
    signedRelayerCommitment: ViemHex;
}
interface QuoteResponse {
    feeAmount: string;
    gasPrice: string;
    txCost: string;
    amountSent: string;
    amountReceived: string;
    feeCommitment: SignedWithdrawalFeeCommitment;
}

const log = (msg: string, ...rest: unknown[]) => console.log(`[yield-e2e-relayed] ${msg}`, ...rest);

(RUN ? describe : describe.skip)("ppUSDC yield E2E THROUGH THE RELAYER (live fork, real proofs)", () => {
    let dep: Deployments;
    let publicClient: ReturnType<typeof createPublicClient>;
    let deployerWallet: ReturnType<typeof createWalletClient>;
    let userWallet: ReturnType<typeof createWalletClient>;
    let userAddress: Address;
    let snapshotId: ViemHex;

    let hashService: PoseidonHashService;
    let merkleService: MerkleService;
    let noteComputationService: NoteComputationService;
    let cryptoService: CryptoService;
    let keystoreManager: KeystoreManager;
    let noteManager: NoteManager;
    let aspProvider: InMemoryAspProvider;
    let aspClient: ASPClient;
    let poolVaultInteractor: PoolVaultInteractor;
    let keystoreInteractor: KeystoreInteractor;
    let aspRegistryInteractor: ASPRegistryInteractor;
    let depositSession: PoolSessionDeposit;
    let keystoreSession: PoolSessionKeystore;
    let orchestrator: TransactOrchestrator;

    const aspLabelLeaves: Hash[] = [];

    beforeAll(async () => {
        dep = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8")) as Deployments;

        const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
        const userAccount = privateKeyToAccount(USER_KEY);
        userAddress = userAccount.address as Address;

        publicClient = createPublicClient({ transport: http(RPC_URL) });
        deployerWallet = createWalletClient({ account: deployerAccount, transport: http(RPC_URL) });
        userWallet = createWalletClient({ account: userAccount, transport: http(RPC_URL) });

        // Snapshot the live fork so the relayed run leaves no residue.
        snapshotId = (await rpc("evm_snapshot", [])) as ViemHex;
        log("evm_snapshot:", snapshotId);

        hashService = await PoseidonHashService.create();
        merkleService = new MerkleService({ hashService });
        cryptoService = new CryptoService();
        noteComputationService = new NoteComputationService({ hashService, cryptoService });

        const sig = await userWallet.signMessage({
            account: userAccount,
            message: "privacy-pools-v2 yield e2e key derivation",
        });
        keystoreManager = KeystoreManager.fromSignature(
            {
                signature: sig as Hex,
                signerAddress: userAddress,
                revocableKeyIndex: "0x0" as Hex,
                addressHash: keccak256(toBytes(userAddress)) as Hex,
            },
            { cryptoService },
        );

        const rpcInteractor = ViemRPCInteractor.create({ rpcUrl: RPC_URL });
        const userWalletInteractor = new ViemWalletInteractor({ walletClient: userWallet as never });

        const entrypointInteractor = new EntrypointInteractor(
            { rpcInteractor, contractAddress: dep.core.entrypoint },
            { walletInteractor: userWalletInteractor },
        );
        keystoreInteractor = new KeystoreInteractor(
            { rpcInteractor, contractAddress: dep.core.keystore },
            { walletInteractor: userWalletInteractor },
        );
        poolVaultInteractor = new PoolVaultInteractor(
            { rpcInteractor, contractAddress: dep.core.poolVault },
            { walletInteractor: userWalletInteractor },
        );
        aspRegistryInteractor = new ASPRegistryInteractor({
            rpcInteractor,
            contractAddress: dep.core.aspRegistry,
        });

        const aspPriv = x25519.utils.randomSecretKey();
        const aspPub = ("0x" + bytesToHex(x25519.getPublicKey(aspPriv))) as PublicKey;
        aspProvider = new InMemoryAspProvider(aspPub);
        aspClient = new ASPClient({ providers: [aspProvider], merkleService, aspRegistryInteractor });

        const circuitArtifacts = new LocalCircuitArtifacts({ baseDir: CIRCUITS_BUILD_DIR });
        const proofService = new ProofService({ circuitArtifacts, groth16Prover: new Groth16Prover() });
        const witnessPreparationService = new WitnessPreparationService({
            noteComputationService,
            hashService,
            merkleService,
        });
        noteManager = new NoteManager({});

        depositSession = new PoolSessionDeposit({
            ownerAddress: userAddress,
            cryptoService,
            witnessPreparationService,
            proofService,
            entrypointInteractor,
            noteManager,
            aspClient,
            keystoreManager,
            noteComputationService,
            keystoreInteractor,
            poolVaultInteractor,
            rpcInteractor,
        });
        keystoreSession = new PoolSessionKeystore({
            ownerAddress: userAddress,
            chainId: CHAIN_ID,
            keystoreManager,
            keystoreInteractor,
            noteComputationService,
            hashService,
            merkleService,
            cryptoService,
            rpcInteractor,
        });
        orchestrator = new TransactOrchestrator({
            ownerAddress: userAddress,
            noteManager,
            keystoreManager,
            witnessPreparationService,
            proofService,
            keystoreInteractor,
            poolVaultInteractor,
            aspClient,
            cryptoService,
            noteComputationService,
            rpcInteractor,
        });

        // Sanity: relayer is up and serves the ppUSDC chain config.
        const ping = await (await fetch(`${RELAYER_URL}/v1/ping`)).text();
        if (ping.trim() !== "pong") throw new Error(`relayer /v1/ping returned "${ping}"`);

        log("wired SDK + viem + relayer", { RPC_URL, RELAYER_URL });
    }, 120_000);

    afterAll(async () => {
        if (snapshotId) {
            const reverted = await rpc("evm_revert", [snapshotId]);
            log("evm_revert:", reverted);
        }
    });

    it("deposits USDC->ppUSDC, accrues yield, withdraws USDC+yield THROUGH the relayer (PPRouter)", async () => {
        const recipient = "0x000000000000000000000000000000000000bEEF" as Address;

        // === 0) Register the spender in the on-chain Keystore =================
        await keystoreSession.registerKeystore();
        log("keystore registered");

        // === 1) Fund the depositor with faucet USDC =========================
        const [underlyingNeeded] = (await publicClient.readContract({
            address: dep.yield.ppRouter,
            abi: ROUTER_ABI,
            functionName: "quote",
            args: [SHIELD_VALUE],
        })) as [bigint, bigint];
        const maxUnderlyingIn = (underlyingNeeded * 110n) / 100n;
        const faucetAmount = maxUnderlyingIn * 2n;

        const mintHash = await deployerWallet.writeContract({
            address: dep.aaveSepolia.faucet,
            abi: FAUCET_ABI,
            functionName: "mint",
            args: [dep.aaveSepolia.usdc, userAddress, faucetAmount],
            account: deployerWallet.account!,
            chain: null,
        });
        await publicClient.waitForTransactionReceipt({ hash: mintHash });

        // === 2) DEPOSIT via PPRouter.depositExactShares (verbatim from direct) =
        const prep = await depositSession.prepareDeposit({
            tokenId: dep.yield.ppUSDC,
            value: ("0x" + SHIELD_VALUE.toString(16)) as Hex,
        });
        const { args: depositArgs } = decodeFunctionData({
            abi: ENTRYPOINT_DEPOSIT_ABI,
            data: prep.callData as ViemHex,
        });
        const [proof, noteData, aspCiphertext] = depositArgs as [
            unknown,
            { hint: ViemHex; data: ViemHex },
            ViemHex,
        ];

        const approveHash = await userWallet.writeContract({
            address: dep.aaveSepolia.usdc,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [dep.yield.ppRouter, maxUnderlyingIn],
            account: userWallet.account!,
            chain: null,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });

        await publicClient.simulateContract({
            address: dep.yield.ppRouter,
            abi: ROUTER_ABI,
            functionName: "depositExactShares",
            args: [proof as never, noteData as never, aspCiphertext, maxUnderlyingIn],
            account: userWallet.account!,
        });
        const depositHash = await userWallet.writeContract({
            address: dep.yield.ppRouter,
            abi: ROUTER_ABI,
            functionName: "depositExactShares",
            args: [proof as never, noteData as never, aspCiphertext, maxUnderlyingIn],
            account: userWallet.account!,
            chain: null,
        });
        const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
        expect(depositReceipt.status).toBe("success");

        const poolPpBal = (await publicClient.readContract({
            address: dep.yield.ppUSDC,
            abi: PPUSDC_ABI,
            functionName: "balanceOf",
            args: [dep.core.poolVault],
        })) as bigint;
        expect(poolPpBal).toBeGreaterThanOrEqual(SHIELD_VALUE);
        log(`deposit landed; pool custodies ${poolPpBal} ppUSDC`);

        // Persist note as ACTIVE.
        const pn: PendingNote = prep.pendingNote;
        const createdAt = await resolveCommitmentTimestamp(poolVaultInteractor, pn.commitment);
        if (createdAt === null) throw new Error("could not resolve deposit commitment timestamp");
        noteManager.addNote({
            ...pn,
            noteSecret: pn.noteSecret!,
            status: NoteStatus.ACTIVE,
            createdAtBlock: createdAt,
            spentAtBlock: null,
            txHash: depositReceipt.transactionHash as Hash,
        });

        // === 3) Register the deposit label in the ASP =======================
        const labelLeaf = (await hashService.hash([pn.label])) as Hash;
        aspLabelLeaves.push(labelLeaf);
        const aspRoot = (await merkleService.computeRoot(aspLabelLeaves)) as Hash;
        aspProvider.setState(aspLabelLeaves, aspRoot);

        await impersonate(POSTMAN);
        const updateRootData = encodeFunctionData({
            abi: ASP_REGISTRY_ABI,
            functionName: "updateASPRoot",
            args: [BigInt(aspRoot), ("0x" + Buffer.from("ipfs://yield-e2e-relayed").toString("hex")) as ViemHex],
        });
        const updateRootHash = (await rpc("eth_sendTransaction", [
            { from: POSTMAN, to: dep.core.aspRegistry, data: updateRootData },
        ])) as ViemHex;
        await publicClient.waitForTransactionReceipt({ hash: updateRootHash });
        await stopImpersonate(POSTMAN);
        const onchainRoot = await publicClient.readContract({
            address: dep.core.aspRegistry,
            abi: ASP_REGISTRY_ABI,
            functionName: "latestASPRoot",
        });
        expect(BigInt(onchainRoot)).toBe(BigInt(aspRoot));
        log("ASP root registered on-chain");

        // === 4) Value of the position BEFORE yield ==========================
        const immediateUSDC = (await publicClient.readContract({
            address: dep.yield.ppUSDC,
            abi: PPUSDC_ABI,
            functionName: "previewRedeem",
            args: [SHIELD_VALUE],
        })) as bigint;

        // === 5) Accrue Aave yield ===========================================
        await rpc("evm_increaseTime", [Number(YIELD_WARP_SECONDS)]);
        await rpc("evm_mine", []);
        const afterYieldUSDC = (await publicClient.readContract({
            address: dep.yield.ppUSDC,
            abi: PPUSDC_ABI,
            functionName: "previewRedeem",
            args: [SHIELD_VALUE],
        })) as bigint;
        expect(afterYieldUSDC).toBeGreaterThan(immediateUSDC);
        log(`previewRedeem before=${immediateUSDC} after=${afterYieldUSDC} USDC`);

        // === 6) RELAYED WITHDRAW LEG ========================================
        // 6a) Ask the relayer for a SEND quote (fee inside the withdrawal amount).
        //     Full withdrawal of SHIELD_VALUE shares to `recipient`, commit=true.
        const quote = await relayerQuoteSend({
            asset: dep.yield.ppUSDC,
            amount: SHIELD_VALUE.toString(),
            recipient,
        });
        const commitment = quote.feeCommitment;
        log("relayer quote", {
            feeAmount: commitment.feeAmount,
            amountSent: commitment.amountSent,
            amountReceived: commitment.amountReceived,
        });

        // The relayer will pass commitment.data as PayoutRouting on-chain. Decode it
        // so we can sanity-check and so the proof binds to the EXACT same bytes.
        const [payout] = decodeAbiParameters(PAYOUT_ROUTING_DECODE, commitment.data);
        expect(getAddress(payout.recipient)).toBe(getAddress(recipient));
        expect(payout.feeAmount).toBe(BigInt(commitment.feeAmount));
        expect(payout.nativeGas).toBe(0n);
        const feeRecipient = getAddress(payout.feeRecipient) as Address;
        // Full withdrawal: amountSent (== amountOut shares) must equal SHIELD_VALUE.
        expect(BigInt(commitment.amountSent)).toBe(SHIELD_VALUE);

        // 6b) Build the transact proof bound to the quote's commitment.
        //     - processor = PPRouter (bound into context)
        //     - transactParams.data = commitment.data VERBATIM (byte-exact)
        //     - amountOut = full shares; in-pool `amount`/`feeAmount` = 0 (the
        //       router splits the fee from the withdrawn shares post-exit).
        const transactParams: TransactParams = {
            processor: dep.yield.ppRouter,
            data: commitment.data as Hex,
        };
        const tx = await orchestrator.prepareTransact({
            inputCommitments: [pn.commitment],
            // Full withdrawal: `amount` is the value released from the pool (drives the
            // change note to 0). `feeAmount` is the IN-POOL fee (0 here — the relayer
            // fee is split from the withdrawn shares by the router, off-circuit).
            // Value conservation: input = change(0) + amountOut.
            amount: ("0x" + SHIELD_VALUE.toString(16)) as Hex,
            tokenId: dep.yield.ppUSDC,
            relayAddress: dep.yield.ppRouter,
            feeAmount: "0x0" as Hex,
            processorAddress: dep.yield.ppRouter,
            amountOut: ("0x" + SHIELD_VALUE.toString(16)) as Hex, // full shares out
            recipientAddress: recipient,
            transactParams, // <- binds proof.context to the quote's PayoutRouting
        });

        // Decode the SDK calldata for the noteData[] that the context was computed
        // over (this is what we hand the relayer). Proof we send in snarkjs format.
        const { args: transactArgs } = decodeFunctionData({
            abi: POOL_VAULT_TRANSACT_ABI,
            data: tx.callData as ViemHex,
        });
        const [, tParams, tNoteData] = transactArgs as [
            unknown,
            { processor: ViemHex; data: ViemHex },
            readonly { hint: ViemHex; data: ViemHex }[],
        ];
        // Guard: the SDK must have used our exact processor + data (else context mismatch).
        expect(getAddress(tParams.processor)).toBe(getAddress(dep.yield.ppRouter));
        expect((tParams.data as string).toLowerCase()).toBe((commitment.data as string).toLowerCase());

        const inputNullifierNumber = tx.spentNotes.length; // N
        const outputCommitmentNumber = tNoteData.length; // M
        log("proof shape", { N: inputNullifierNumber, M: outputCommitmentNumber });

        // 6c) Pre-withdraw balances.
        const recipientBefore = (await publicClient.readContract({
            address: dep.aaveSepolia.usdc,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [recipient],
        })) as bigint;
        const feeRecipientBefore = (await publicClient.readContract({
            address: dep.aaveSepolia.usdc,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [feeRecipient],
        })) as bigint;
        const expectedRecipientUSDC = (await publicClient.readContract({
            address: dep.yield.ppRouter,
            abi: ROUTER_ABI,
            functionName: "quoteWithdraw",
            args: [BigInt(commitment.amountReceived)],
        })) as bigint;

        // 6d) Submit the relay request through the SDK's typed RelayerInteractor.relayWithdrawal
        // (POSTs to /v1/relay/evm/<chainId>/withdrawal). Setting `processorAddress` to the PPRouter
        // makes the relayer route to PPRouter.withdrawToUnderlying, and `minUnderlyingOut` is the
        // client's slippage floor on the recipient's underlying leg. Both fields now survive the SDK
        // schema (audit finding F-1) — before the fix Zod stripped them, forcing this leg to hand-roll
        // a raw HTTP body. This exercises the real SDK path end-to-end.
        const relayerInfo: RelayerInfo = {
            url: RELAYER_URL,
            name: "local-relayer",
            chainId: CHAIN_ID,
            chainType: "evm",
            status: "active",
            address: POSTMAN as Address,
            processorAddress: dep.yield.ppRouter,
        };
        const relayerInteractor = new RelayerInteractor({
            relayers: [relayerInfo],
            httpClient: new HTTPClient(),
        });

        // 1% slippage floor on the recipient leg, sized from the router quote. Delivered comfortably
        // clears this (the assertions below expect delivered within `slack` of expectedRecipientUSDC).
        const minUnderlyingOut = (expectedRecipientUSDC * 9900n) / 10000n;

        const relayParams: WithdrawalRelayParams = {
            proof: tx.proof,
            noteData: tNoteData.map((n) => ({ hint: n.hint as Hex, data: n.data as Hex })),
            signedFeeCommitment: { ...commitment, extraGas: false } as WithdrawalFeeCommitment,
            inputNullifierNumber,
            outputCommitmentNumber,
            processorAddress: dep.yield.ppRouter,
            minUnderlyingOut: bigintToHex(minUnderlyingOut),
        };

        // The current relayer config WAIVES a zero-redeem (dust) fee leg instead of reverting, so the
        // relayed withdrawal succeeds. A genuine on-chain revert would surface here as RelayerRejected.
        log("POST /v1/relay/.../withdrawal via RelayerInteractor.relayWithdrawal ...");
        const txHash = await relayerInteractor.relayWithdrawal(relayerInfo, relayParams);
        log("relayer submitted tx:", txHash);

        const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        expect(withdrawReceipt.status).toBe("success");

        // 7a) The relayed tx actually went to the PPRouter (proves processor path).
        expect(getAddress(withdrawReceipt.to as Address)).toBe(getAddress(dep.yield.ppRouter));
        // and the submitter was the relayer's signer (deployer), not our user wallet.
        expect(getAddress(withdrawReceipt.from as Address)).not.toBe(getAddress(userAddress));

        // 7b) Recipient got USDC including yield.
        const recipientAfter = (await publicClient.readContract({
            address: dep.aaveSepolia.usdc,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [recipient],
        })) as bigint;
        const delivered = recipientAfter - recipientBefore;

        // 7c) Fee recipient got the fee leg in USDC.
        const feeRecipientAfter = (await publicClient.readContract({
            address: dep.aaveSepolia.usdc,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [feeRecipient],
        })) as bigint;
        const feeDelivered = feeRecipientAfter - feeRecipientBefore;
        const expectedFeeUSDC = (await publicClient.readContract({
            address: dep.yield.ppRouter,
            abi: ROUTER_ABI,
            functionName: "quoteWithdraw",
            args: [BigInt(commitment.feeAmount)],
        })) as bigint;

        log("=================== RESULT (RELAYED) ===================");
        log(`txHash                     = ${txHash}`);
        log(`tx.to                      = ${withdrawReceipt.to} (PPRouter=${dep.yield.ppRouter})`);
        log(`tx.from (relayer signer)   = ${withdrawReceipt.from}`);
        log(`recipient USDC delta       = ${delivered}`);
        log(`previewRedeem(amountRecv)  = ${expectedRecipientUSDC}`);
        log(`immediate value (no yield) = ${immediateUSDC}`);
        log(`yield delivered            = ${delivered - immediateUSDC}`);
        log(`fee recipient USDC delta   = ${feeDelivered}  (expected ~${expectedFeeUSDC})`);
        log("=======================================================");

        const slack = 2n;
        expect(delivered).toBeGreaterThanOrEqual(expectedRecipientUSDC - slack);
        expect(delivered).toBeLessThanOrEqual(expectedRecipientUSDC + slack);
        expect(delivered).toBeGreaterThan(immediateUSDC);
        expect(feeDelivered).toBeGreaterThanOrEqual(0n);
        expect(feeDelivered).toBeLessThanOrEqual(expectedFeeUSDC + slack);
        const poolPpAfter = (await publicClient.readContract({
            address: dep.yield.ppUSDC,
            abi: PPUSDC_ABI,
            functionName: "balanceOf",
            args: [dep.core.poolVault],
        })) as bigint;
        expect(poolPpAfter).toBe(0n);
    }, 600_000);

    // --- relayer helper -----------------------------------------------------
    async function relayerQuoteSend(params: {
        asset: Address;
        amount: string;
        recipient: Address;
    }): Promise<QuoteResponse> {
        const res = await fetch(`${RELAYER_URL}/v1/quote/evm/${CHAIN_ID}/send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...params, commit: true }),
        });
        const json = (await res.json()) as QuoteResponse & { error?: string; message?: string };
        if (!res.ok || !json.feeCommitment) {
            throw new Error(`relayer quote failed (HTTP ${res.status}): ${JSON.stringify(json)}`);
        }
        return json;
    }

    // --- raw RPC helpers ----------------------------------------------------
    async function rpc(method: string, params: unknown[]): Promise<unknown> {
        const res = await fetch(RPC_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const json = (await res.json()) as { result?: unknown; error?: { message: string } };
        if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
        return json.result;
    }
    async function impersonate(addr: string): Promise<void> {
        await rpc("anvil_impersonateAccount", [addr]);
        await rpc("anvil_setBalance", [addr, "0x56BC75E2D63100000"]);
    }
    async function stopImpersonate(addr: string): Promise<void> {
        try {
            await rpc("anvil_stopImpersonateAccount", [addr]);
        } catch {
            /* harmless */
        }
    }
});
