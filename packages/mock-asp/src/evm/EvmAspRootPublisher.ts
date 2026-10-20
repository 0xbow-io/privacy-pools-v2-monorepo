import type { Address, Chain, Hex as ViemHex } from "viem";
import {
    createPublicClient,
    createWalletClient,
    defineChain,
    encodeFunctionData,
    http,
    parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Hex } from "@privacy-pools-v2/core-sdk";

import type { AspRootPublisher } from "../internal.js";

const ASP_REGISTRY_ABI = parseAbi([
    "function updateASPRoot(uint256 aspRoot, bytes ipfsCID)",
    "function latestASPRoot() view returns (uint256)",
]);

/** Ten ETH, hex — enough to pay for any number of `updateASPRoot` calls on a fork. */
const IMPERSONATED_BALANCE = "0x8AC7230489E80000";

/**
 * Who signs `updateASPRoot`.
 * - `privateKey` — a local key that holds the registry's `postman` role (a from-genesis local deploy).
 * - `impersonate` — anvil's `anvil_impersonateAccount` on the real on-chain postman (a fork of a live chain).
 */
export type EvmPublisherSigner =
    | { kind: "privateKey"; privateKey: Hex }
    | { kind: "impersonate"; address: Address };

export interface EvmAspRootPublisherConfig {
    rpcUrl: string;
    chainId: number;
    aspRegistryAddress: Address;
    signer: EvmPublisherSigner;
    /**
     * Forks of a public RPC intermittently answer "historical state N is not available" on writes and
     * mines. When `true`, every chain-mutating call is retried and the tx is nudged with `evm_mine`.
     * Leave `false` on a local from-genesis chain, where neither is needed.
     */
    forkMode?: boolean;
    log?: (line: string) => void;
}

/**
 * Publishes association-set roots to an EVM `ASPRegistry`. Resolves only after the tx is mined.
 */
export class EvmAspRootPublisher implements AspRootPublisher {
    private readonly config: EvmAspRootPublisherConfig;
    private readonly chain: Chain;
    private readonly publicClient: ReturnType<typeof createPublicClient>;
    private readonly walletClient: ReturnType<typeof createWalletClient>;
    private readonly account: Address | ReturnType<typeof privateKeyToAccount>;
    private prepared: Promise<void> | undefined;

    constructor(config: EvmAspRootPublisherConfig) {
        this.config = config;
        this.chain = defineChain({
            id: config.chainId,
            name: `mock-asp-${config.chainId}`,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: [config.rpcUrl] } },
        });
        this.account =
            config.signer.kind === "privateKey"
                ? privateKeyToAccount(config.signer.privateKey as ViemHex)
                : config.signer.address;
        this.publicClient = createPublicClient({ chain: this.chain, transport: http(config.rpcUrl) });
        this.walletClient = createWalletClient({
            account: this.account,
            chain: this.chain,
            transport: http(config.rpcUrl),
        });
    }

    /**
     * @inheritdoc AspRootPublisher.publishRoot
     * @throws {Error} When the registry rejects the root (e.g. the signer is not the postman).
     */
    async publishRoot(root: bigint, cid: Hex): Promise<{ txId: string }> {
        await this.prepare();
        const data = encodeFunctionData({
            abi: ASP_REGISTRY_ABI,
            functionName: "updateASPRoot",
            args: [root, cid as ViemHex],
        });
        const hash = await this.mutating("sendTransaction(updateASPRoot)", () =>
            this.walletClient.sendTransaction({
                account: this.account,
                chain: this.chain,
                to: this.config.aspRegistryAddress,
                data,
                value: 0n,
            }),
        );
        if (this.config.forkMode) {
            await this.mutating("evm_mine", () => this.rpc("evm_mine", []));
        }
        const receipt = await this.mutating("waitForTransactionReceipt", () =>
            this.publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 }),
        );
        if (receipt.status !== "success") {
            throw new Error(`updateASPRoot reverted (tx ${hash})`);
        }
        return { txId: hash };
    }

    /**
     * @inheritdoc AspRootPublisher.readLatestRoot
     * @returns `null` when the registry has no root yet (the getter reverts on an empty set).
     */
    async readLatestRoot(): Promise<bigint | null> {
        try {
            return (await this.publicClient.readContract({
                address: this.config.aspRegistryAddress,
                abi: ASP_REGISTRY_ABI,
                functionName: "latestASPRoot",
            })) as bigint;
        } catch {
            return null;
        }
    }

    /** Impersonation + funding are one-time and idempotent; done lazily on first publish. */
    private prepare(): Promise<void> {
        this.prepared ??= this.prepareImpersonation();
        return this.prepared;
    }

    private async prepareImpersonation(): Promise<void> {
        const { signer } = this.config;
        if (signer.kind !== "impersonate") return;
        await this.mutating("anvil_impersonateAccount", () =>
            this.rpc("anvil_impersonateAccount", [signer.address]),
        );
        await this.mutating("anvil_setBalance", () =>
            this.rpc("anvil_setBalance", [signer.address, IMPERSONATED_BALANCE]),
        );
    }

    private async rpc(method: string, params: unknown[]): Promise<unknown> {
        const res = await fetch(this.config.rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const json = (await res.json()) as { result?: unknown; error?: { message: string } };
        if (json.error) throw new Error(json.error.message);
        return json.result;
    }

    /** Retries only in fork mode; on a local chain a failure is a real failure. */
    private async mutating<T>(label: string, work: () => Promise<T>): Promise<T> {
        const tries = this.config.forkMode ? 10 : 1;
        let lastError: unknown;
        for (let attempt = 1; attempt <= tries; attempt++) {
            try {
                return await work();
            } catch (error) {
                lastError = error;
                const message = error instanceof Error ? error.message : String(error);
                this.config.log?.(`[mock-asp] ${label} attempt ${attempt}/${tries} failed: ${message}`);
                if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, 2500));
            }
        }
        throw lastError;
    }
}
