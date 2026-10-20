/**
 * LIVE, real-Groth16-proof END-TO-END test for the RELAYED KEYSTORE REGISTRATION
 * flow (a.k.a. cold-start onboarding — `docs/tech-design/user-flows.md`, Flow 3),
 * driven through the SDK and a locally running relayer service.
 *
 * The scenario, split into two logical phases (see the two `it(...)` blocks):
 *
 *   PHASE 1 — Alice funds the pool
 *     1. Alice registers her keystore on-chain (setAuthPolicy + viewing key).
 *     2. Alice deposits native ETH into the pool (Entrypoint.deposit) — a real
 *        deposit proof from `PoolSessionDeposit`.
 *     3. The deposit's label is registered in the ASP (on-chain `updateASPRoot`
 *        + in-memory leaves). This is the "wait for ASP approval" boundary — in a
 *        real deployment an operator approves the label out-of-band; here we
 *        impersonate the postman and set the root inline, then STOP.
 *
 *   PHASE 2 — Alice pays Bob, Bob withdraws WITHOUT ever funding his address
 *     4. Bob's client exists only as keys derived from a wallet signature — his
 *        address is UNREGISTERED and UNFUNDED.
 *     5. Alice transfers a note to Bob's `ownerAddress` via
 *        `prepareColdStartTransfer` (out-of-band: no encrypted recipient noteData
 *        is published; Alice submits the transact herself and hands Bob the note
 *        secrets). Bob's note inherits Alice's already-approved ASP label.
 *     6. Bob signs the EIP-712 `SetAuthPolicy` typed data off-chain (no gas).
 *     7. Bob asks the relayer for a withdrawal quote, then calls
 *        `PoolSessionWithdraw.registerAndWithdraw`, which:
 *          - builds a transact proof anchored to the PREDICTED post-registration
 *            keystore root (`predictKeystoreRegistration: true`), and
 *          - POSTs `/v1/relay/evm/:chainId/register-and-withdrawal` so the
 *            relayer atomically registers Bob's auth policy AND withdraws his note.
 *     8. ASSERT on-chain:
 *          - Bob's keystore is now registered,
 *          - the withdrawal recipient received ETH (amount − fee),
 *          - the submitting `tx.from` is the relayer's signer, not Bob.
 *
 * The whole run is wrapped in an `evm_snapshot` / `evm_revert` so it leaves the
 * shared fork clean.
 *
 * PREREQUISITES (NOT created here — must already be running):
 *   - anvil Sepolia fork on http://localhost:8545 with the full stack deployed
 *     (addresses read from docs/deployments.local.json)
 *   - the relayer service on http://localhost:3000 (routes under /v1) configured
 *     for the LOCAL FORK addresses with native ETH supported —
 *     see `packages/relayer/relayer/relayer.config.local.json` and start it with
 *     `CONFIG_PATH=$PWD/relayer.config.local.json`. The default relayer.config.json
 *     points at remote Sepolia and will NOT work here.
 *   - pre-built circuit artifacts under packages/circuits/build/
 *
 * RUN:
 *   cd packages/evm-sdk
 *   REGISTRATION_E2E=1 pnpm exec vitest run --config scripts/e2e-registration/vitest.config.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    getAddress,
    http,
    keccak256,
    toBytes,
    parseAbi,
    type Hex as ViemHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    PendingNote,
    PublicKey,
    RelayerInfo,
} from "../../src/internal.js";
import {
    ASPClient,
    ASPRegistryInteractor,
    CryptoService,
    EntrypointInteractor,
    Groth16Prover,
    HTTPClient,
    InMemoryStorageService,
    KeystoreInteractor,
    KeystoreManager,
    LocalCircuitArtifacts,
    MerkleService,
    NATIVE_ASSET_ADDRESS,
    NoteComputationService,
    NoteManager,
    NoteStatus,
    PaymentRequestService,
    PaymentRequestStorageAdapter,
    PoolSessionDeposit,
    PoolSessionKeystore,
    PoolSessionTransfer,
    PoolSessionWithdraw,
    PoolVaultInteractor,
    PoseidonHashService,
    ProofService,
    RelayerInteractor,
    resolveCommitmentTimestamp,
    TransactOrchestrator,
    ViemRPCInteractor,
    ViemWalletInteractor,
    WitnessPreparationService,
} from "../../src/internal.js";
import { InMemoryAspProvider } from "../e2e-yield/InMemoryAspProvider.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RUN = process.env.REGISTRATION_E2E === "1";
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";
const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:3000";
const CHAIN_ID = 11155111;
// When set, skip the evm_snapshot/evm_revert so every tx the run mines PERSISTS
// on the anvil node for inspection (default reverts to keep the fork clean).
const KEEP_STATE = process["env"].KEEP_STATE === "1";
// Collected (label, txHash) of every on-chain tx the run mines, printed at the end.
const MINED_TXS: { label: string; hash: string }[] = [];
const DEPLOYMENTS_PATH = resolve(__dirname, "../../../../docs/deployments.local.json");
const CIRCUITS_BUILD_DIR = resolve(__dirname, "../../../circuits/build");

// anvil default accounts (well-known dev keys — local only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const; // acct 0
const ALICE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // acct 1
// Bob is a FRESH random key (generated per run), not a known anvil dev account.
// The canonical anvil accounts have EIP-7702 delegation code on the real Sepolia
// state we fork; SignatureChecker would then take the ERC-1271 path and reject
// Bob's ECDSA SetAuthPolicy signature. A random address has no code on the fork.
const BOB_KEY = generatePrivateKey();

// The address holding POSTMAN_ROLE on THIS deployment's AccessRouter (authorized
// to push ASP roots). Discovered from RoleGranted events on the access router;
// it also holds admin here. We impersonate it to approve the deposit label.
const POSTMAN = "0xfe2a20530514A3E478dDb558B6dceD3F833c167E" as const;

// The relayer's signer address (anvil acct #3 — matches relayer.config.local.json
// signer_private_key). Funded here so it can submit the relay transaction.
const RELAYER_SIGNER_ADDRESS = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;

const DEPOSIT_VALUE = 1_000_000_000_000_000_000n; // 1 ETH shielded by Alice
const TRANSFER_VALUE = 500_000_000_000_000_000n; // 0.5 ETH Alice sends to Bob
// Bob withdraws less than his note so the note covers withdrawal + relayer fee;
// the remainder returns to Bob as a shielded change note.
const WITHDRAW_VALUE = 400_000_000_000_000_000n; // 0.4 ETH net to Bob's recipient

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const ASP_REGISTRY_ABI = parseAbi([
    "function updateASPRoot(uint256 aspRoot, bytes ipfsCID)",
    "function latestASPRoot() view returns (uint256)",
]);

// ---------------------------------------------------------------------------

interface Deployments {
    chainId: number;
    core: {
        keystore: Address;
        aspRegistry: Address;
        poolVault: Address;
        entrypoint: Address;
        privacyPoolRelay: Address;
    };
}

// Mirrors the relayer.config.local.json fee_receiver_address; the relayer signs
// its PayoutRouting fee commitment with `feeRecipient = fee_receiver_address`.
const RELAYER_FEE_RECEIVER =
    (process.env.RELAYER_FEE_RECEIVER as Address | undefined) ??
    ("0x4Ba5fF376865b370790A56276C63e7984DCFf1f7" as Address);

const log = (msg: string, ...rest: unknown[]) => console.log(`[registration-e2e] ${msg}`, ...rest);

(RUN ? describe : describe.skip)("Relayed keystore registration E2E (live fork, real proofs)", () => {
    let dep: Deployments;
    let publicClient: ReturnType<typeof createPublicClient>;
    let deployerWallet: ReturnType<typeof createWalletClient>;
    let snapshotId: ViemHex;

    // Shared services (chain-agnostic, reused by both accounts).
    let hashService: PoseidonHashService;
    let merkleService: MerkleService;
    let noteComputationService: NoteComputationService;
    let cryptoService: CryptoService;
    let proofService: ProofService;
    let witnessPreparationService: WitnessPreparationService;
    let aspProvider: InMemoryAspProvider;
    let aspClient: ASPClient;
    let rpcInteractor: ViemRPCInteractor;
    let aspRegistryInteractor: ASPRegistryInteractor;
    let poolVaultInteractor: PoolVaultInteractor;

    // Alice.
    let aliceAddress: Address;
    let aliceNoteManager: NoteManager;
    let aliceDeposit: PoolSessionDeposit;
    let aliceKeystore: PoolSessionKeystore;
    let aliceTransfer: PoolSessionTransfer;

    // Bob (unregistered, unfunded — client-side keys only).
    let bobAddress: Address;
    let bobNoteManager: NoteManager;
    let bobKeystore: PoolSessionKeystore;
    let bobWithdraw: PoolSessionWithdraw;
    let bobWallet: ReturnType<typeof createWalletClient>;
    let bobSignerAccount: ReturnType<typeof privateKeyToAccount>;
    let relayerInteractor: RelayerInteractor;

    // Cross-phase state.
    const aspLabelLeaves: Hash[] = [];
    let aliceDepositNote: PendingNote;
    let bobNote: PendingNote;

    beforeAll(async () => {
        dep = JSON.parse(readFileSync(DEPLOYMENTS_PATH, "utf8")) as Deployments;
        expect(dep.chainId).toBe(CHAIN_ID);

        const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
        const aliceAccount = privateKeyToAccount(ALICE_KEY);
        bobSignerAccount = privateKeyToAccount(BOB_KEY);
        aliceAddress = aliceAccount.address as Address;
        bobAddress = bobSignerAccount.address as Address;

        publicClient = createPublicClient({ transport: http(RPC_URL) });
        deployerWallet = createWalletClient({ account: deployerAccount, transport: http(RPC_URL) });
        const aliceWallet = createWalletClient({ account: aliceAccount, transport: http(RPC_URL) });
        bobWallet = createWalletClient({ account: bobSignerAccount, transport: http(RPC_URL) });

        // Snapshot the live fork so the run leaves no residue (unless KEEP_STATE).
        if (!KEEP_STATE) {
            snapshotId = (await rpc("evm_snapshot", [])) as ViemHex;
            log("evm_snapshot:", snapshotId);
        } else {
            log("KEEP_STATE=1 — skipping snapshot; mined txs will persist on anvil");
        }

        // Fund the actors that pay gas on the fork (real Sepolia balances are 0 for
        // these dev keys). Alice deposits/transfers; the relayer signer submits the
        // register-and-withdrawal. BOB IS DELIBERATELY LEFT UNFUNDED — the whole
        // point of relayed registration is that he never funds his address.
        const ONE_THOUSAND_ETH = "0x3635C9ADC5DEA00000";
        await rpc("anvil_setBalance", [aliceAddress, ONE_THOUSAND_ETH]);
        await rpc("anvil_setBalance", [RELAYER_SIGNER_ADDRESS, ONE_THOUSAND_ETH]);

        // --- shared services ---
        hashService = await PoseidonHashService.create();
        merkleService = new MerkleService({ hashService });
        cryptoService = new CryptoService();
        noteComputationService = new NoteComputationService({ hashService, cryptoService });
        rpcInteractor = ViemRPCInteractor.create({ rpcUrl: RPC_URL });

        const circuitArtifacts = new LocalCircuitArtifacts({ baseDir: CIRCUITS_BUILD_DIR });
        proofService = new ProofService({ circuitArtifacts, groth16Prover: new Groth16Prover() });
        witnessPreparationService = new WitnessPreparationService({
            noteComputationService,
            hashService,
            merkleService,
        });

        aspRegistryInteractor = new ASPRegistryInteractor({
            rpcInteractor,
            contractAddress: dep.core.aspRegistry,
        });
        poolVaultInteractor = new PoolVaultInteractor(
            { rpcInteractor, contractAddress: dep.core.poolVault },
            { walletInteractor: new ViemWalletInteractor({ walletClient: deployerWallet as never }) },
        );

        const aspPriv = x25519.utils.randomSecretKey();
        const aspPub = ("0x" + bytesToHex(x25519.getPublicKey(aspPriv))) as PublicKey;
        aspProvider = new InMemoryAspProvider(aspPub);
        aspClient = new ASPClient({ providers: [aspProvider], merkleService, aspRegistryInteractor });

        // A single relayer pointed at the local fork (see relayer.config.local.json).
        relayerInteractor = new RelayerInteractor({
            relayers: [
                {
                    url: RELAYER_URL,
                    name: "local",
                    chainId: CHAIN_ID,
                    chainType: "evm",
                    status: "active",
                    address: RELAYER_FEE_RECEIVER,
                    processorAddress: dep.core.privacyPoolRelay,
                },
            ],
            httpClient: new HTTPClient(),
        });

        // --- Alice's SDK stack ---
        aliceNoteManager = new NoteManager({});
        const aliceKm = await keystoreManagerFor(aliceWallet, aliceAccount, aliceAddress);
        const aliceWalletInteractor = new ViemWalletInteractor({ walletClient: aliceWallet as never });
        const aliceEntrypoint = new EntrypointInteractor(
            { rpcInteractor, contractAddress: dep.core.entrypoint },
            { walletInteractor: aliceWalletInteractor },
        );
        const aliceKeystoreInteractor = new KeystoreInteractor(
            { rpcInteractor, contractAddress: dep.core.keystore },
            { walletInteractor: aliceWalletInteractor },
        );
        const alicePoolVault = new PoolVaultInteractor(
            { rpcInteractor, contractAddress: dep.core.poolVault },
            { walletInteractor: aliceWalletInteractor },
        );
        aliceDeposit = new PoolSessionDeposit({
            ownerAddress: aliceAddress,
            cryptoService,
            witnessPreparationService,
            proofService,
            entrypointInteractor: aliceEntrypoint,
            noteManager: aliceNoteManager,
            aspClient,
            keystoreManager: aliceKm,
            noteComputationService,
            keystoreInteractor: aliceKeystoreInteractor,
            poolVaultInteractor: alicePoolVault,
            rpcInteractor,
        });
        aliceKeystore = new PoolSessionKeystore({
            ownerAddress: aliceAddress,
            chainId: CHAIN_ID,
            keystoreManager: aliceKm,
            keystoreInteractor: aliceKeystoreInteractor,
            noteComputationService,
            hashService,
            merkleService,
            cryptoService,
            rpcInteractor,
        });
        const aliceCore = new TransactOrchestrator({
            ownerAddress: aliceAddress,
            noteManager: aliceNoteManager,
            keystoreManager: aliceKm,
            witnessPreparationService,
            proofService,
            keystoreInteractor: aliceKeystoreInteractor,
            poolVaultInteractor: alicePoolVault,
            aspClient,
            cryptoService,
            noteComputationService,
            rpcInteractor,
        });
        aliceTransfer = new PoolSessionTransfer({
            ownerAddress: aliceAddress,
            core: aliceCore,
            relayerInteractor,
            rpcInteractor,
            cryptoService,
            noteComputationService,
            keystoreInteractor: aliceKeystoreInteractor,
            paymentRequestService: new PaymentRequestService({
                ownerAddress: aliceAddress,
                cryptoService,
                hashService,
                noteComputationService,
                keystoreManager: aliceKm,
                storageAdapter: new PaymentRequestStorageAdapter(
                    CHAIN_ID,
                    new InMemoryStorageService(),
                    aliceAddress,
                ),
            }),
        });

        // --- Bob's SDK stack (no wallet funding; signs typed data only) ---
        bobNoteManager = new NoteManager({});
        const bobKm = await keystoreManagerFor(bobWallet, bobSignerAccount, bobAddress);
        const bobWalletInteractor = new ViemWalletInteractor({ walletClient: bobWallet as never });
        const bobKeystoreInteractor = new KeystoreInteractor(
            { rpcInteractor, contractAddress: dep.core.keystore },
            { walletInteractor: bobWalletInteractor },
        );
        const bobPoolVault = new PoolVaultInteractor(
            { rpcInteractor, contractAddress: dep.core.poolVault },
            { walletInteractor: bobWalletInteractor },
        );
        bobKeystore = new PoolSessionKeystore({
            ownerAddress: bobAddress,
            chainId: CHAIN_ID,
            keystoreManager: bobKm,
            keystoreInteractor: bobKeystoreInteractor,
            noteComputationService,
            hashService,
            merkleService,
            cryptoService,
            rpcInteractor,
        });
        const bobCore = new TransactOrchestrator({
            ownerAddress: bobAddress,
            noteManager: bobNoteManager,
            keystoreManager: bobKm,
            witnessPreparationService,
            proofService,
            keystoreInteractor: bobKeystoreInteractor,
            poolVaultInteractor: bobPoolVault,
            aspClient,
            cryptoService,
            noteComputationService,
            rpcInteractor,
        });
        bobWithdraw = new PoolSessionWithdraw({
            core: bobCore,
            relayerInteractor,
            rpcInteractor,
            keystore: bobKeystore,
        });

        // Sanity: relayer is up.
        const ping = await (await fetch(`${RELAYER_URL}/v1/ping`)).text();
        if (ping.trim() !== "pong") throw new Error(`relayer /v1/ping returned "${ping}"`);

        log("wired Alice + Bob SDK stacks + relayer", { aliceAddress, bobAddress, RELAYER_URL });
    }, 120_000);

    afterAll(async () => {
        if (MINED_TXS.length > 0) {
            log("=================== MINED TXS (on anvil) ===================");
            for (const t of MINED_TXS) log(`  ${t.label.padEnd(26)} ${t.hash}`);
            log(KEEP_STATE
                ? "KEEP_STATE=1 — these persist on anvil; query them with eth_getTransactionReceipt"
                : "NOTE: reverting below — these hashes will NOT resolve on anvil afterward");
            log("===========================================================");
        }
        if (!KEEP_STATE && snapshotId) {
            const reverted = await rpc("evm_revert", [snapshotId]);
            log("evm_revert:", reverted);
        }
    });

    // =====================================================================
    // PHASE 1 — Alice registers, deposits, and the ASP approves the label.
    // =====================================================================
    it("registers Alice, deposits native ETH, and approves the deposit label in the ASP", async () => {
        // 1) Register Alice's keystore on-chain.
        const aliceRegReceipts = await aliceKeystore.registerKeystore();
        expect(await aliceKeystore.isKeystoreRegistered()).toBe(true);
        aliceRegReceipts.forEach((r, i) =>
            MINED_TXS.push({ label: `alice registerKeystore[${i}]`, hash: r.txHash }),
        );
        log("Alice keystore registered");

        // 2) Deposit native ETH (real deposit proof, Entrypoint.deposit{value}).
        const prep = await aliceDeposit.prepareDeposit({
            tokenId: NATIVE_ASSET_ADDRESS,
            value: ("0x" + DEPOSIT_VALUE.toString(16)) as Hex,
        });
        const receipt = await aliceDeposit.executeDeposit(prep);
        expect(receipt.status).toBe(true);
        MINED_TXS.push({ label: "alice deposit", hash: receipt.txHash });
        aliceDepositNote = prep.pendingNote;

        const createdAt = await resolveCommitmentTimestamp(
            poolVaultInteractor,
            aliceDepositNote.commitment,
        );
        if (createdAt === null) throw new Error("could not resolve deposit commitment timestamp");
        // executeDeposit already registered the note locally as PENDING. Replace it
        // with an ACTIVE copy carrying the resolved createdAtBlock so it is spendable.
        try {
            aliceNoteManager.deleteNote(aliceDepositNote.commitment);
        } catch {
            /* not auto-added (e.g. not isOwned) — fall through to add */
        }
        aliceNoteManager.addNote({
            ...aliceDepositNote,
            noteSecret: aliceDepositNote.noteSecret!,
            status: NoteStatus.ACTIVE,
            createdAtBlock: createdAt,
            spentAtBlock: null,
            txHash: receipt.txHash,
        });
        log("Alice deposit landed", { commitment: aliceDepositNote.commitment });

        // 3) Register the deposit label in the ASP (the "approval" boundary).
        const labelLeaf = hashService.hash([aliceDepositNote.label]) as Hash;
        aspLabelLeaves.push(labelLeaf);
        const aspRoot = (await merkleService.computeRoot(aspLabelLeaves)) as Hash;
        aspProvider.setState(aspLabelLeaves, aspRoot);

        await impersonate(POSTMAN);
        const updateRootData = encodeFunctionData({
            abi: ASP_REGISTRY_ABI,
            functionName: "updateASPRoot",
            args: [
                BigInt(aspRoot),
                ("0x" + Buffer.from("ipfs://registration-e2e").toString("hex")) as ViemHex,
            ],
        });
        const updateRootHash = (await rpc("eth_sendTransaction", [
            { from: POSTMAN, to: dep.core.aspRegistry, data: updateRootData },
        ])) as ViemHex;
        MINED_TXS.push({ label: "asp updateASPRoot", hash: updateRootHash });
        await publicClient.waitForTransactionReceipt({ hash: updateRootHash });
        await stopImpersonate(POSTMAN);

        const onchainRoot = await publicClient.readContract({
            address: dep.core.aspRegistry,
            abi: ASP_REGISTRY_ABI,
            functionName: "latestASPRoot",
        });
        expect(BigInt(onchainRoot)).toBe(BigInt(aspRoot));
        log("ASP root approved on-chain — Phase 1 complete");
    }, 600_000);

    // =====================================================================
    // PHASE 2 — Alice pays Bob; Bob registers + withdraws via the relayer.
    // =====================================================================
    it("transfers to Bob and lets Bob register-and-withdraw through the relayer without funding his address", async () => {
        // Precondition: Bob has never touched the protocol.
        expect(await bobKeystore.isKeystoreRegistered()).toBe(false);

        // 5) Alice cold-start transfers a note to Bob's ownerAddress. No encrypted
        //    recipient noteData is published; Alice submits the transact herself and
        //    receives the recipient note secrets to hand to Bob out-of-band.
        const prepared = await aliceTransfer.prepareColdStartTransfer({
            inputCommitments: [aliceDepositNote.commitment],
            amount: ("0x" + TRANSFER_VALUE.toString(16)) as Hex,
            tokenId: NATIVE_ASSET_ADDRESS,
            recipientEvmAddress: bobAddress,
        });
        const transferResult = await aliceTransfer.executeTransfer(prepared.executeOptions);
        expect(transferResult.txReceipt.status).toBe(true);
        MINED_TXS.push({ label: "alice→bob transfer", hash: transferResult.txReceipt.txHash });

        const recipientNotes = prepared.executeOptions.recipientPendingNotes;
        expect(recipientNotes.length).toBe(1);
        bobNote = recipientNotes[0];
        expect(getAddress(bobNote.ownerAddress as Address)).toBe(getAddress(bobAddress));
        log("Alice transferred to Bob (out-of-band)", { commitment: bobNote.commitment });

        // Deliver the note to Bob's client (the out-of-band hand-off).
        const bobCreatedAt = await resolveCommitmentTimestamp(poolVaultInteractor, bobNote.commitment);
        if (bobCreatedAt === null) throw new Error("could not resolve Bob's note commitment timestamp");
        bobNoteManager.addNote({
            ...bobNote,
            noteSecret: bobNote.noteSecret!,
            status: NoteStatus.ACTIVE,
            createdAtBlock: bobCreatedAt,
            spentAtBlock: null,
            txHash: transferResult.txReceipt.txHash,
        });

        // 6) Bob signs the EIP-712 SetAuthPolicy off-chain (no gas, no on-chain tx).
        // C-8: the authorization is bound to a signature `deadline` (uint256), which the relayer
        // forwards to `registerAndRelay` as its 4th arg. The signed typed data and the deadline
        // handed to `registerAndWithdraw` MUST match, or the on-chain signature check fails.
        const deadline = ("0x" + (Math.floor(Date.now() / 1000) + 3600).toString(16)) as Hex;
        const typedData = bobKeystore.buildSetAuthPolicyTypedData(deadline);
        const signature = (await bobSignerAccount.signTypedData({
            domain: typedData.domain,
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
        } as never)) as Hex;
        log("Bob signed SetAuthPolicy authorization");

        // 7a) Bob requests a withdrawal quote from the relayer for the full note value.
        const bobRecipient = bobAddress; // where the withdrawn ETH lands
        const [relayerInfo] = await relayerInteractor.getRelayers();
        const quote = await relayerInteractor.getWithdrawalQuote(relayerInfo as RelayerInfo, {
            asset: NATIVE_ASSET_ADDRESS,
            commit: true,
            recipient: bobRecipient,
            extraGas: false,
            amount: WITHDRAW_VALUE.toString(),
        });
        log("relayer withdrawal quote", {
            feeAmount: quote.feeAmount,
            amountSent: quote.amountSent,
            amountReceived: quote.amountReceived,
        });

        const recipientBefore = await publicClient.getBalance({ address: bobRecipient });

        // 7b) Bob registers-and-withdraws atomically THROUGH THE RELAYER.
        const txReceipt = await bobWithdraw.registerAndWithdraw({
            inputCommitments: [bobNote.commitment],
            amount: ("0x" + WITHDRAW_VALUE.toString(16)) as Hex,
            tokenId: NATIVE_ASSET_ADDRESS,
            recipientAddress: bobRecipient,
            signature,
            deadline,
            selectedQuote: { relayerInfo: relayerInfo as RelayerInfo, quote },
        });
        expect(txReceipt.status).toBe(true);
        MINED_TXS.push({ label: "bob register-and-withdraw", hash: txReceipt.txHash });
        log("relayer submitted register-and-withdrawal", { txHash: txReceipt.txHash });

        const withdrawReceipt = await publicClient.waitForTransactionReceipt({
            hash: txReceipt.txHash as ViemHex,
        });

        // Dump the actual on-chain receipt so success is observable, not inferred.
        log("withdraw receipt", {
            status: withdrawReceipt.status,
            from: withdrawReceipt.from,
            to: withdrawReceipt.to,
            gasUsed: withdrawReceipt.gasUsed.toString(),
            logs: withdrawReceipt.logs.length,
            logAddresses: [...new Set(withdrawReceipt.logs.map((l) => getAddress(l.address as Address)))],
        });

        // 8) Assertions.
        // 8a) The relayed tx actually succeeded on-chain and went to the relay contract.
        expect(withdrawReceipt.status).toBe("success");
        expect(getAddress(withdrawReceipt.to as Address)).toBe(getAddress(dep.core.privacyPoolRelay));

        // 8b) Bob's keystore is now registered on-chain (the relayer registered it).
        expect(await bobKeystore.isKeystoreRegistered()).toBe(true);

        // 8c) The submitter is the relayer's signer, NOT Bob — Bob never funded his address.
        expect(getAddress(withdrawReceipt.from as Address)).toBe(getAddress(RELAYER_SIGNER_ADDRESS));
        expect(getAddress(withdrawReceipt.from as Address)).not.toBe(getAddress(bobAddress));

        // 8d) Bob received the net withdrawal (value − relayer fee).
        const recipientAfter = await publicClient.getBalance({ address: bobRecipient });
        const delivered = recipientAfter - recipientBefore;
        const expectedNet = BigInt(quote.amountReceived);
        log("=================== RESULT (RELAYED REGISTRATION) ===================");
        log(`txHash                   = ${txReceipt.txHash}`);
        log(`tx.from (relayer signer) = ${withdrawReceipt.from}`);
        log(`Bob recipient ETH delta  = ${delivered}`);
        log(`quote.amountReceived     = ${expectedNet}`);
        log("====================================================================");
        expect(delivered).toBe(expectedNet);
    }, 600_000);

    // --- helpers ------------------------------------------------------------
    async function keystoreManagerFor(
        wallet: ReturnType<typeof createWalletClient>,
        account: ReturnType<typeof privateKeyToAccount>,
        address: Address,
    ): Promise<KeystoreManager> {
        // Deterministic key derivation from a wallet signature. The message text is
        // irrelevant to the protocol; it only seeds the account's keys.
        const sig = (await wallet.signMessage({
            account,
            message: "privacy-pools-v2 registration e2e key derivation",
        })) as Hex;
        return KeystoreManager.fromSignature(
            {
                signature: sig,
                signerAddress: address,
                revocableKeyIndex: "0x0" as Hex,
                addressHash: keccak256(toBytes(address)) as Hex,
            },
            { cryptoService },
        );
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
