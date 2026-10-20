import { createWalletClient, createPublicClient, custom, http, parseEther } from "viem";
import { sepolia } from "viem/chains";

import type { Hex, PoolSession } from "@privacy-pools-v2/evm-sdk";
import {
    ASPClient,
    CryptoService,
    EIP1193WalletInteractor,
    EntrypointInteractor,
    Groth16Prover,
    HttpASPDataProvider,
    HTTPClient,
    KeystoreInteractor,
    KeystoreManager,
    MerkleService,
    NoteComputationService,
    NoteManager,
    PoolSessionFactory,
    PoolVaultInteractor,
    PoseidonHashService,
    ProofService,
    RelayerInteractor,
    ViemRPCInteractor,
    ViemWalletInteractor,
    WitnessPreparationService,
} from "@privacy-pools-v2/evm-sdk";
import { FetchCircuitArtifacts } from "./FetchCircuitArtifacts.js";

// ── Config ───────────────────────────────────────────────────────────────────
// In production, load these from environment or a config service.
const CONFIG = {
    rpcUrl: import.meta.env.VITE_RPC_URL ?? "https://rpc.sepolia.org",
    entrypointAddress: import.meta.env.VITE_ENTRYPOINT_ADDRESS as Hex,
    keystoreAddress: import.meta.env.VITE_KEYSTORE_ADDRESS as Hex,
    poolAddress: import.meta.env.VITE_POOL_ADDRESS as Hex,
    tokenId: (import.meta.env.VITE_TOKEN_ID ??
        "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE") as Hex,
    chainId: Number(import.meta.env.VITE_CHAIN_ID ?? 11155111),
    aspUrl: import.meta.env.VITE_ASP_URL as string,
    relayerUrl: import.meta.env.VITE_RELAYER_URL as string,
    relayerAddress: import.meta.env.VITE_RELAYER_ADDRESS as Hex,
    relayerProcessorAddress: import.meta.env.VITE_RELAYER_PROCESSOR_ADDRESS as Hex,
    circuitArtifactsUrl: import.meta.env.VITE_CIRCUIT_ARTIFACTS_URL ?? "/circuits",
    // Key material — in production, derive from a secure source (e.g., BIP-32).
    privateNullifyingKey: import.meta.env.VITE_PRIVATE_NULLIFYING_KEY as Hex,
    privateRevocableKey: import.meta.env.VITE_PRIVATE_REVOCABLE_KEY as Hex,
    viewingPrivateKey: import.meta.env.VITE_VIEWING_PRIVATE_KEY as Hex,
    viewingPublicKey: import.meta.env.VITE_VIEWING_PUBLIC_KEY as Hex,
};

// ── UI ───────────────────────────────────────────────────────────────────────
const out = document.getElementById("output") as HTMLPreElement;
const connectBtn = document.getElementById("btn-connect") as HTMLButtonElement;
const depositBtn = document.getElementById("btn-deposit") as HTMLButtonElement;
const amountInput = document.getElementById("amount") as HTMLInputElement;
const walletStatus = document.getElementById("wallet-status") as HTMLParagraphElement;

function log(msg: string): void {
    out.textContent += msg + "\n";
    out.scrollTop = out.scrollHeight;
}

function clearLog(): void {
    out.textContent = "";
}

// ── State ────────────────────────────────────────────────────────────────────
let poolSession: PoolSession | null = null;

// ── Connect Wallet ───────────────────────────────────────────────────────────
connectBtn.addEventListener("click", async () => {
    clearLog();

    if (!window.ethereum) {
        log("No wallet detected. Install MetaMask or another EIP-1193 wallet.");
        return;
    }

    try {
        log("Connecting wallet...");

        // 1. Connect browser wallet and create viem client with account attached
        const tempClient = createWalletClient({
            chain: sepolia,
            transport: custom(window.ethereum),
        });

        const [address] = await tempClient.requestAddresses();
        log(`Connected: ${address}`);

        // Ensure wallet is on the correct chain
        const chainId = await tempClient.getChainId();
        if (chainId !== sepolia.id) {
            log(`Switching wallet to Sepolia (current chain: ${chainId})...`);
            await tempClient.switchChain({ id: sepolia.id });
            log("Chain switched.");
        }

        walletStatus.textContent = `Connected: ${address}`;
        walletStatus.classList.add("connected");

        // Recreate client with the account so sendTransaction works
        const walletClient = createWalletClient({
            account: address,
            chain: sepolia,
            transport: custom(window.ethereum),
        });

        // 2. Wrap viem WalletClient as a WalletInteractor
        const walletInteractor = new EIP1193WalletInteractor({ provider: window.ethereum });

        // 3. Initialize SDK services
        log("Initializing SDK services...");

        const httpClient = new HTTPClient();
        const cryptoService = new CryptoService();
        const noteManager = new NoteManager({});

        const rpcInteractor = ViemRPCInteractor.create({
            rpcUrl: CONFIG.rpcUrl,
            chain: sepolia,
        });

        const entrypointInteractor = new EntrypointInteractor(
            { rpcInteractor, contractAddress: CONFIG.entrypointAddress },
            { walletInteractor },
        );

        const keystoreInteractor = new KeystoreInteractor(
            { rpcInteractor, contractAddress: CONFIG.keystoreAddress },
            { walletInteractor },
        );

        const poolVaultInteractor = new PoolVaultInteractor(
            { rpcInteractor, contractAddress: CONFIG.poolAddress },
            { walletInteractor },
        );

        const hashService = await PoseidonHashService.create();
        const merkleService = new MerkleService({ hashService });

        const noteComputationService = new NoteComputationService({
            cryptoService,
            hashService,
        });

        const witnessPreparationService = new WitnessPreparationService({
            hashService,
            noteComputationService,
            merkleService,
        });

        const groth16Prover = new Groth16Prover();
        const circuitArtifacts = new FetchCircuitArtifacts(CONFIG.circuitArtifactsUrl);

        const proofService = new ProofService({
            circuitArtifacts,
            groth16Prover,
        });

        const keystoreManager = new KeystoreManager({
            privateNullifyingKey: CONFIG.privateNullifyingKey,
            privateRevocableKey: CONFIG.privateRevocableKey,
            viewingPrivateKey: CONFIG.viewingPrivateKey,
            viewingPublicKey: CONFIG.viewingPublicKey,
            revocableKeyIndex: "0x0",
        });

        const relayerInteractor = new RelayerInteractor({
            relayers: [{
                name: "Relayer",
                url: CONFIG.relayerUrl,
                address: CONFIG.relayerAddress,
                processorAddress: CONFIG.relayerProcessorAddress,
                chainId: CONFIG.chainId,
                chainType: "evm",
                status: "active",
            }],
            httpClient,
        });

        const aspHttpDataProvider = new HttpASPDataProvider({
            aspUrl: CONFIG.aspUrl,
            chainId: CONFIG.chainId,
            httpClient,
        });

        const aspClient = new ASPClient({
            providers: [aspHttpDataProvider],
            merkleService,
        });

        poolSession = PoolSessionFactory.create({
            ownerAddress: address as Hex,
            chainId: CONFIG.chainId,
            poolAddress: CONFIG.poolAddress,
            cryptoService,
            witnessPreparationService,
            proofService,
            entrypointInteractor,
            noteManager,
            keystoreManager,
            keystoreInteractor,
            hashService,
            poolVaultInteractor,
            aspClient,
            relayerInteractor,
            rpcInteractor,
            aspDataProvider: aspHttpDataProvider,
        });

        log("SDK initialized. Ready to deposit.\n");
        depositBtn.disabled = false;
    } catch (err) {
        log(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
});

// ── Deposit ──────────────────────────────────────────────────────────────────
depositBtn.addEventListener("click", async () => {
    if (!poolSession) return;

    const amount = amountInput.value.trim();
    if (!amount || Number(amount) <= 0) {
        log("Enter a valid amount.");
        return;
    }

    depositBtn.disabled = true;

    try {
        const depositValue = `0x${parseEther(amount).toString(16)}` as Hex;

        log(`Depositing ${amount} ETH...`);
        log(`  Token:  ${CONFIG.tokenId}`);
        log(`  Value:  ${depositValue}\n`);

        // One call: prepare proof + approve (if ERC-20) + send + wait for receipt
        const receipt = await poolSession.deposit({
            tokenId: CONFIG.tokenId,
            value: depositValue,
        });

        log("Deposit confirmed!");
        log(`  Block:  ${receipt.blockNumber}`);
        log(`  Tx:     ${receipt.txHash}`);
        log(`  Status: ${receipt.status ? "success" : "reverted"}\n`);
    } catch (err) {
        log(`Deposit failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error(err);
    } finally {
        depositBtn.disabled = false;
    }
});

// ── EIP-1193 type declaration ────────────────────────────────────────────────
declare global {
    interface Window {
        ethereum?: {
            request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
            on?(event: string, handler: (...args: unknown[]) => void): void;
        };
    }
}
