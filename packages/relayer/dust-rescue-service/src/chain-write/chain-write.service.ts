import { Injectable, Logger } from "@nestjs/common";
import {
    BaseError,
    ContractFunctionRevertedError,
    createPublicClient,
    createWalletClient,
    http,
    type Address,
    type Hex,
    type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DustRescueConfigService } from "../config/dust-rescue-config.service";
import type { PreparedApprovalTx } from "../jobs/job.types";

/**
 * Minimal chain-write module — approve() + deposit() only, no batching, no EIP-712
 * commitment logic (dust_collection_service_detailed_design.org §5 / design doc §2).
 * Deliberately does NOT use viem's `nonceManager`: this process is scale-to-zero and
 * doesn't stay warm across invocations, so a cached nonce would be actively wrong here
 * (unlike the relayer's EVMChainService, which is a long-lived per-request client).
 * Every nonce is fetched fresh, immediately before the write it's used for.
 */
@Injectable()
export class ChainWriteService {
    private readonly logger = new Logger(ChainWriteService.name);

    constructor(private readonly config: DustRescueConfigService) {}

    async approve(chainId: number, tx: PreparedApprovalTx): Promise<Hex> {
        return this.send(chainId, { to: tx.to, data: tx.data, value: BigInt(tx.value) }, "approval");
    }

    async deposit(chainId: number, target: Address, data: Hex, value: Hex): Promise<Hex> {
        return this.send(chainId, { to: target, data, value: BigInt(value) }, "deposit");
    }

    async waitForReceipt(chainId: number, hash: Hex): Promise<TransactionReceipt | undefined> {
        const rpcUrl = this.config.chain(chainId).rpcUrl;
        const client = createPublicClient({ transport: http(rpcUrl) });
        try {
            return await client.getTransactionReceipt({ hash });
        } catch {
            // Not mined yet — the sweep re-checks next invocation, not a failure.
            return undefined;
        }
    }

    private async send(
        chainId: number,
        tx: { to: Address; data: Hex; value: bigint },
        label: string,
    ): Promise<Hex> {
        const rpcUrl = this.config.chain(chainId).rpcUrl;
        const account = privateKeyToAccount(this.config.signerPrivateKey());
        const publicClient = createPublicClient({ transport: http(rpcUrl) });
        const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

        const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });

        try {
            const hash = await walletClient.sendTransaction({
                chain: null,
                account,
                to: tx.to,
                data: tx.data,
                value: tx.value,
                nonce,
            });
            this.logger.log(`Submitted ${label} tx ${hash} on chain ${chainId} (nonce ${nonce})`);
            return hash;
        } catch (error) {
            const msg = this.safeErrorMessage(error);
            this.logger.error(`${label} tx failed on chain ${chainId}: ${msg}`);
            throw new Error(`${label} tx failed: ${msg}`);
        }
    }

    /// Short, arg-free error text — mirrors EVMChainService.safeErrorMessage
    /// (packages/relayer/relayer/src/chain.service/evm.chain.service.ts). Full call
    /// args here would include the recipient/calldata, the same de-anonymization
    /// concern that method guards against.
    private safeErrorMessage(error: unknown): string {
        if (error instanceof BaseError) {
            const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
            const errorName = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
            return errorName ? `${error.shortMessage} (${errorName})` : error.shortMessage;
        }
        return error instanceof Error ? error.message : "Unknown error";
    }
}
