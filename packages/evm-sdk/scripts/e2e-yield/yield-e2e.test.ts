/**
 * LIVE, real-Groth16-proof END-TO-END yield test for Privacy Pools V2 (ppUSDC).
 *
 * Flow (mirrors the forge `PPUSDCYieldFork.t.sol`, but driven by the TS SDK with
 * REAL proofs and direct viem calls to the deployed `PPRouter`):
 *
 *   1. wire the SDK services against the live anvil Sepolia fork
 *   2. register the spender in the on-chain Keystore (setAuthPolicy)
 *   3. fund a depositor with faucet USDC, wrap+shield into ppUSDC via
 *      PPRouter.depositExactShares (STANDARD ppUSDC deposit proof from the SDK)
 *   4. register the deposit's label in the ASP (on-chain root + in-memory leaves)
 *   5. accrue Aave yield by warping time (the real Sepolia reserve has an open
 *      borrow, so the aUSDC index rises)
 *   6. withdraw via PPRouter.withdrawToUnderlying — a real transact proof whose
 *      processor = PPRouter and whose context binds the PayoutRouting
 *   7. ASSERT the recipient received USDC INCLUDING yield (> immediate value)
 *
 * The SDK is used ONLY for proof generation + witness/context construction; the
 * two router calls are made directly with viem (decoding the SDK-produced
 * entrypoint/poolVault calldata to lift out the proof + noteData structs).
 *
 * PREREQUISITES (NOT created here — must already be running):
 *   - anvil Sepolia fork on http://localhost:8545 with the full stack deployed
 *     (addresses read from docs/deployments.local.json)
 *   - pre-built circuit artifacts under packages/circuits/build/
 *
 * RUN:
 *   cd packages/evm-sdk
 *   YIELD_E2E=1 pnpm exec vitest run scripts/e2e-yield/yield-e2e.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
    createPublicClient,
    createWalletClient,
    decodeFunctionData,
    encodeAbiParameters,
    encodeFunctionData,
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
    Secret,
    TransactParams,
} from "../../src/internal.js";
import {
    ASPClient,
    ASPRegistryInteractor,
    CryptoService,
    EntrypointInteractor,
    ENTRYPOINT_DEPOSIT_ABI,
    Groth16Prover,
    KeystoreInteractor,
    KeystoreManager,
    LocalCircuitArtifacts,
    MerkleService,
    NoteComputationService,
    NoteManager,
    NoteStatus,
    PAYOUT_ROUTING_ABI,
    PoolSessionDeposit,
    PPRouterInteractor,
    PPYieldTokenInteractor,
    PoolSessionKeystore,
    PoolVaultInteractor,
    POOL_VAULT_TRANSACT_ABI,
    PoseidonHashService,
    ProofService,
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

const RUN = process.env.YIELD_E2E === "1";
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const DEPLOYMENTS_PATH = resolve(__dirname, "../../../../../docs/deployments.local.json");
const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../circuits/build");

// anvil acct 0 (deployer/funder)
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
// anvil acct 1 — the privacy-pool user (depositor + spender)
const USER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
// Sepolia "postman" that holds POSTMAN_ROLE on the deployed AccessRouter
const POSTMAN = "0x723a43064e73Bcf46cf7d9b8506C400Df8ac878b" as const;

const SHIELD_VALUE = 1_000_000_000_000_000_000n; // 1 ppUSDC (18 dp)
const YIELD_WARP_SECONDS = 365n * 24n * 60n * 60n; // 1 year

// ---------------------------------------------------------------------------
// Minimal on-chain ABIs (router / token / faucet / asp-registry)
// ---------------------------------------------------------------------------

const ROUTER_ABI = parseAbi([
    "function quote(uint256 value) view returns (uint256 underlyingNeeded, uint256 total)",
    "function quoteWithdraw(uint256 shares) view returns (uint256 underlyingOut)",
    "function depositExactShares((uint256[2] pA,uint256[2][2] pB,uint256[2] pC,uint256[4] pubSignals) proof,(bytes32 hint,bytes data) noteData,bytes aspCiphertext,uint256 maxUnderlyingIn) returns (uint256)",
    "function withdrawToUnderlying((uint256[2] pA,uint256[2][2] pB,uint256[2] pC,uint256[][] pubSignals) proof,(address processor,bytes data) transactParams,(bytes32 hint,bytes data)[] noteData,uint256 minUnderlyingOut) payable returns (uint256 toRecipient, uint256 fee)",
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

// ---------------------------------------------------------------------------

interface Deployments {
    minFromBlock?: number;
    core: { keystore: Address; aspRegistry: Address; poolVault: Address; entrypoint: Address };
    yield: { ppUSDC: Address; ppRouter: Address };
    aaveSepolia: { faucet: Address; usdc: Address };
}

const log = (msg: string, ...rest: unknown[]) => console.log(`[yield-e2e] ${msg}`, ...rest);

(RUN ? describe : describe.skip)("ppUSDC yield E2E (live fork, real proofs)", () => {
    let dep: Deployments;
    let publicClient: ReturnType<typeof createPublicClient>;
    let deployerWallet: ReturnType<typeof createWalletClient>;
    let userWallet: ReturnType<typeof createWalletClient>;
    let userAddress: Address;

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

    // ASP local mirror — leaves are Poseidon([label]) (matches on-chain ASP tree).
    const aspLabelLeaves: Hash[] = [];

    beforeAll(async () => {
        dep = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8")) as Deployments;

        const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
        const userAccount = privateKeyToAccount(USER_KEY);
        userAddress = userAccount.address as Address;

        publicClient = createPublicClient({ transport: http(RPC_URL) });
        deployerWallet = createWalletClient({ account: deployerAccount, transport: http(RPC_URL) });
        userWallet = createWalletClient({ account: userAccount, transport: http(RPC_URL) });

        // --- SDK services -----------------------------------------------------
        hashService = await PoseidonHashService.create();
        merkleService = new MerkleService({ hashService });
        cryptoService = new CryptoService();
        noteComputationService = new NoteComputationService({ hashService, cryptoService });

        // Derive protocol keys from a real wallet signature (production derivation path).
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

        const rpcInteractor = ViemRPCInteractor.create({ rpcUrl: RPC_URL, minFromBlock: BigInt(dep.minFromBlock ?? 0) });
        const userWalletInteractor = new ViemWalletInteractor({
            walletClient: userWallet as never,
        });

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

        // ASP: a real X25519 keypair for the in-memory provider.
        const aspPriv = x25519.utils.randomSecretKey();
        const aspPub = ("0x" + bytesToHex(x25519.getPublicKey(aspPriv))) as PublicKey;
        aspProvider = new InMemoryAspProvider(aspPub);
        aspClient = new ASPClient({
            providers: [aspProvider],
            merkleService,
            aspRegistryInteractor,
        });

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
            chainId: 11155111,
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

        log("wired SDK + viem against", RPC_URL);
        log("user (depositor+spender):", userAddress);
    }, 120_000);

    afterAll(() => {
        // nothing to tear down — the fork keeps running for the next test
    });

    it("deposits USDC->ppUSDC, accrues Aave yield, withdraws USDC+yield via PPRouter", async () => {
        const recipient = "0x000000000000000000000000000000000000bEEF" as Address;

        // === 0) Register the spender in the on-chain Keystore =================
        log("registering keystore auth policy...");
        await keystoreSession.registerKeystore();
        log("keystore registered");

        // === 1) Fund the depositor with faucet USDC =========================
        // quote how much underlying the deposit needs, give a margin.
        const [underlyingNeeded] = (await publicClient.readContract({
            address: dep.yield.ppRouter,
            abi: ROUTER_ABI,
            functionName: "quote",
            args: [SHIELD_VALUE],
        })) as [bigint, bigint];
        const maxUnderlyingIn = (underlyingNeeded * 110n) / 100n; // +10% slippage room
        const faucetAmount = maxUnderlyingIn * 2n;

        log(`router.quote(${SHIELD_VALUE}) underlyingNeeded=${underlyingNeeded}`);
        const mintHash = await deployerWallet.writeContract({
            address: dep.aaveSepolia.faucet,
            abi: FAUCET_ABI,
            functionName: "mint",
            args: [dep.aaveSepolia.usdc, userAddress, faucetAmount],
            account: deployerWallet.account!,
            chain: null,
        });
        await publicClient.waitForTransactionReceipt({ hash: mintHash });
        const usdcBal = await publicClient.readContract({
            address: dep.aaveSepolia.usdc,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [userAddress],
        });
        log(`funded user with ${usdcBal} USDC (6dp)`);
        expect(usdcBal).toBeGreaterThanOrEqual(faucetAmount);

        // === 2) DEPOSIT via PPRouter.depositExactShares =====================
        // The SDK builds a STANDARD ppUSDC deposit proof (tokenId=ppUSDC). Its
        // calldata targets the Entrypoint; we decode out (proof, noteData,
        // aspCiphertext) and feed them to the router instead — the router
        // forwards the same args to Entrypoint.deposit, so the proof context
        // (keccak(noteData)) is identical and valid.
        log("preparing deposit (real Groth16 deposit proof)...");
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

        // Approve USDC to the router for the (slippage-padded) underlying.
        log("approving USDC to router...");
        const approveHash = await userWallet.writeContract({
            address: dep.aaveSepolia.usdc,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [dep.yield.ppRouter, maxUnderlyingIn],
            account: userWallet.account!,
            chain: null,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });

        log("submitting PPRouter.depositExactShares...");
        // Pre-flight simulate so any revert surfaces its decoded reason (not an opaque receipt).
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
        log("deposit landed in block", depositReceipt.blockNumber);

        // Confirm the pool now custodies the shielded ppUSDC.
        const poolPpBal = await publicClient.readContract({
            address: dep.yield.ppUSDC,
            abi: PPUSDC_ABI,
            functionName: "balanceOf",
            args: [dep.core.poolVault],
        });
        expect(poolPpBal).toBeGreaterThanOrEqual(SHIELD_VALUE);
        log(`pool custodies ${poolPpBal} ppUSDC`);

        // === 3) Persist the deposit note locally (ACTIVE) so it is spendable.
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
        log("deposit note ACTIVE; label =", pn.label);

        // === 4) Register the deposit label in the ASP =======================
        // Mirror leaf = Poseidon([label]); compute the LeanIMT root with the SDK
        // MerkleService and submit it on-chain as POSTMAN.
        const labelLeaf = (await hashService.hash([pn.label])) as Hash;
        aspLabelLeaves.push(labelLeaf);
        const aspRoot = (await merkleService.computeRoot(aspLabelLeaves)) as Hash;
        aspProvider.setState(aspLabelLeaves, aspRoot);

        log("submitting ASP root as POSTMAN:", aspRoot);
        await impersonate(POSTMAN);
        // anvil signs for an impersonated sender on a raw eth_sendTransaction
        // (writeContract would sign with a local key instead).
        const updateRootData = encodeFunctionData({
            abi: ASP_REGISTRY_ABI,
            functionName: "updateASPRoot",
            args: [BigInt(aspRoot), ("0x" + Buffer.from("ipfs://yield-e2e").toString("hex")) as ViemHex],
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

        // === 5) Value of the shielded position BEFORE yield =================
        const immediateUSDC = (await publicClient.readContract({
            address: dep.yield.ppUSDC,
            abi: PPUSDC_ABI,
            functionName: "previewRedeem",
            args: [SHIELD_VALUE],
        })) as bigint;
        log(`previewRedeem(${SHIELD_VALUE}) BEFORE yield = ${immediateUSDC} USDC`);

        // === 6) Accrue Aave yield by warping time ===========================
        log(`warping ${YIELD_WARP_SECONDS}s to accrue Aave yield...`);
        await rpc("evm_increaseTime", [Number(YIELD_WARP_SECONDS)]);
        await rpc("evm_mine", []);
        const afterYieldUSDC = (await publicClient.readContract({
            address: dep.yield.ppUSDC,
            abi: PPUSDC_ABI,
            functionName: "previewRedeem",
            args: [SHIELD_VALUE],
        })) as bigint;
        log(`previewRedeem(${SHIELD_VALUE}) AFTER yield  = ${afterYieldUSDC} USDC`);
        expect(afterYieldUSDC).toBeGreaterThan(immediateUSDC); // position appreciated

        // === 7) WITHDRAW via PPRouter.withdrawToUnderlying ==================
        // Full withdrawal: amount=0 (no in-pool send), amountOut=SHIELD_VALUE,
        // processor=PPRouter, data=abi(PayoutRouting{recipient,...,feeAmount:0}).
        const payoutData = encodeAbiParameters(PAYOUT_ROUTING_ABI, [
            { recipient, feeRecipient: recipient, feeAmount: 0n, nativeGas: 0n },
        ]) as Hex;
        const transactParams: TransactParams = {
            processor: dep.yield.ppRouter,
            data: payoutData,
        };

        log("preparing withdraw transact (real Groth16 transact proof)...");
        // Full withdrawal: `amount` is the value released from the pool (drives the
        // change note to 0); `amountOut` == amount (no fee). No `recipient` => no
        // in-pool recipient note. Value conservation: input = change(0) + amountOut.
        const tx = await orchestrator.prepareTransact({
            inputCommitments: [pn.commitment],
            amount: ("0x" + SHIELD_VALUE.toString(16)) as Hex,
            tokenId: dep.yield.ppUSDC,
            relayAddress: dep.yield.ppRouter,
            feeAmount: "0x0" as Hex,
            processorAddress: dep.yield.ppRouter,
            amountOut: ("0x" + SHIELD_VALUE.toString(16)) as Hex, // full shares out
            recipientAddress: recipient,
            transactParams,
        });

        // Decode the SDK poolVault.transact calldata → (proof, params, noteData[]).
        const { args: transactArgs } = decodeFunctionData({
            abi: POOL_VAULT_TRANSACT_ABI,
            data: tx.callData as ViemHex,
        });
        const [tProof, tParams, tNoteData] = transactArgs as [
            unknown,
            { processor: ViemHex; data: ViemHex },
            readonly { hint: ViemHex; data: ViemHex }[],
        ];

        const expectedRecipientUSDC = (await publicClient.readContract({
            address: dep.yield.ppRouter,
            abi: ROUTER_ABI,
            functionName: "quoteWithdraw",
            args: [SHIELD_VALUE],
        })) as bigint;
        const minUnderlyingOut = (expectedRecipientUSDC * 99n) / 100n; // 1% slack

        const recipientBefore = (await publicClient.readContract({
            address: dep.aaveSepolia.usdc,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [recipient],
        })) as bigint;

        log("submitting PPRouter.withdrawToUnderlying...");
        await publicClient.simulateContract({
            address: dep.yield.ppRouter,
            abi: ROUTER_ABI,
            functionName: "withdrawToUnderlying",
            args: [tProof as never, tParams as never, tNoteData as never, minUnderlyingOut],
            account: userWallet.account!,
        });
        const withdrawHash = await userWallet.writeContract({
            address: dep.yield.ppRouter,
            abi: ROUTER_ABI,
            functionName: "withdrawToUnderlying",
            args: [tProof as never, tParams as never, tNoteData as never, minUnderlyingOut],
            account: userWallet.account!,
            chain: null,
        });
        const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
        expect(withdrawReceipt.status).toBe("success");
        log("withdraw landed in block", withdrawReceipt.blockNumber);

        // === 8) ASSERT the recipient got USDC INCLUDING yield ===============
        const recipientAfter = (await publicClient.readContract({
            address: dep.aaveSepolia.usdc,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [recipient],
        })) as bigint;
        const delivered = recipientAfter - recipientBefore;

        log("=================== RESULT ===================");
        log(`recipient USDC delta       = ${delivered}`);
        log(`previewRedeem (post-yield) = ${expectedRecipientUSDC}`);
        log(`immediate value (no yield) = ${immediateUSDC}`);
        log(`yield delivered            = ${delivered - immediateUSDC}`);
        log("=============================================");

        // recipient received ~ the post-yield previewRedeem amount
        expect(delivered).toBeGreaterThanOrEqual(minUnderlyingOut);
        // and STRICTLY MORE than an immediate (no-yield) withdrawal — yield was delivered
        expect(delivered).toBeGreaterThan(immediateUSDC);
        // pool is fully drained of the shielded shares
        const poolPpAfter = (await publicClient.readContract({
            address: dep.yield.ppUSDC,
            abi: PPUSDC_ABI,
            functionName: "balanceOf",
            args: [dep.core.poolVault],
        })) as bigint;
        expect(poolPpAfter).toBe(0n);
    }, 600_000);

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
        // fund the impersonated account for gas
        await rpc("anvil_setBalance", [addr, "0x56BC75E2D63100000"]); // 100 ETH
    }
    async function stopImpersonate(addr: string): Promise<void> {
        // Best-effort: some anvil-compatible nodes don't expose the stop method.
        try {
            await rpc("anvil_stopImpersonateAccount", [addr]);
        } catch {
            /* impersonation auto-clears or method unsupported — harmless here */
        }
    }
});
