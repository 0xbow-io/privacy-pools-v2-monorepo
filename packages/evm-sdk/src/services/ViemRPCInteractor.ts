import type {
    Abi,
    AbiEvent,
    ContractFunctionArgs,
    ContractFunctionName,
    ContractFunctionReturnType,
} from "viem";
import {
    createPublicClient,
    http,
    HttpRequestError,
    InvalidParamsRpcError,
    LimitExceededRpcError,
    numberToHex,
} from "viem";

import type {
    Address,
    CreateViemRPCInteractorConfig,
    DecodedEventLog,
    FinalizedBlockResult,
    GetLogsParams,
    Hex,
    ILogger,
    IRPCInteractor,
    ReadContractParams,
    TxLog,
    TxReceipt,
    ViemRPCInteractorConfig,
    ViemRPCInteractorDependencies,
} from "../internal.js";
import {
    AddressSchema,
    ChainSchema,
    ContractReadError,
    EventReadError,
    GetBlockNumberError,
    InvalidABIFunctionName,
    InvalidChain,
    InvalidContractAddress,
    InvalidRpcUrl,
    InvalidViemRPCInteractorConfig,
    RPCInteractorBaseError,
    RpcUrlSchema,
    sleep,
    WaitForReceiptError,
} from "../internal.js";

/**
 * Default chunk size for `getLogsPaginated`.
 *
 * Picked to stay under the block-range cap of common RPC providers (Alchemy
 * free tier: 10k blocks per query; Infura: 10k blocks). Narrower ABIs at the
 * call site additionally help keep responses under per-call log-count /
 * payload-size caps within each window.
 */
const DEFAULT_LOGS_CHUNK_BLOCKS = 10_000n;

/** Linear backoff (×1, ×2, ×3 seconds) before retrying an HTTP 429 chunk. */
const RATE_LIMIT_RETRY_BASE_MS = 1_000;
const MAX_RATE_LIMIT_RETRIES = 3;

interface ViemReadContractParams<
    TAbi extends Abi,
    TFunctionName extends ContractFunctionName<TAbi, "pure" | "view">,
> {
    address: Address;
    abi: TAbi;
    functionName: TFunctionName;
    args?: ContractFunctionArgs<TAbi, "pure" | "view", TFunctionName>;
}

/**
 * Whether an error means the node does not understand the `finalized` block tag,
 * as opposed to a request that happened to fail.
 *
 * Phrases, not bare words: a node that has simply not finalized anything yet, or a
 * gateway returning an error that merely mentions a block, must not be read as
 * "this provider has no finality". Anything unrecognised is treated as transient,
 * which is the direction that keeps the stricter rule in force.
 */
function isUnknownBlockTagError(reason: string): boolean {
    const text = reason.toLowerCase();
    return (
        text.includes("unknown block") ||
        text.includes("invalid block tag") ||
        text.includes("unsupported block tag") ||
        text.includes("safe and finalized") ||
        text.includes("finalized block not found") ||
        text.includes("method not found") ||
        text.includes("not supported")
    );
}

/** Viem-backed implementation of {@link IRPCInteractor}. */
export class ViemRPCInteractor implements IRPCInteractor {
    /**
     * Creates a ViemRPCInteractor with an internally-managed PublicClient.
     *
     * @param config - RPC URL and optional chain.
     * @returns A new ViemRPCInteractor instance.
     * @throws {InvalidRpcUrl} When the RPC URL is malformed or uses an unsupported protocol.
     * @throws {InvalidChain} When the chain config is invalid or unsupported.
     */
    static create(
        config: CreateViemRPCInteractorConfig,
        deps?: ViemRPCInteractorDependencies,
    ): ViemRPCInteractor {
        const urlResult = RpcUrlSchema.safeParse(config.rpcUrl);
        if (!urlResult.success) {
            throw new InvalidRpcUrl(urlResult.error.issues[0].message);
        }

        if (config.chain !== undefined) {
            const chainResult = ChainSchema.safeParse(config.chain);
            if (!chainResult.success) {
                throw new InvalidChain(chainResult.error.issues[0].message);
            }
        }

        const publicClient = createPublicClient({
            transport: http(config.rpcUrl),
            chain: config.chain,
        });
        return new ViemRPCInteractor({ publicClient, minFromBlock: config.minFromBlock }, deps);
    }

    private readonly publicClient: ViemRPCInteractorConfig["publicClient"];
    private readonly chunkSize: bigint;
    private readonly minFromBlock: bigint;
    private readonly logger?: ILogger;

    constructor(config: ViemRPCInteractorConfig, deps?: ViemRPCInteractorDependencies) {
        this.publicClient = config.publicClient;
        const chunkSize = config.chunkSize ?? DEFAULT_LOGS_CHUNK_BLOCKS;
        if (chunkSize <= 0n) {
            throw new InvalidViemRPCInteractorConfig(`chunkSize must be > 0, got ${chunkSize}`);
        }
        this.chunkSize = chunkSize;
        this.minFromBlock = config.minFromBlock ?? 0n;
        this.logger = deps?.logger;
    }

    /** Floors a requested log-scan start block at the configured {@link minFromBlock}. */
    private floorFromBlock(fromBlock?: bigint): bigint {
        const from = fromBlock ?? 0n;
        return from > this.minFromBlock ? from : this.minFromBlock;
    }

    /**
     * @inheritdoc IRPCInteractor.readContract
     * @throws {InvalidContractAddress} When the contract address is invalid.
     * @throws {InvalidABIFunctionName} When the function name is not found in the ABI.
     * @throws {ContractReadError} When the contract read fails.
     */
    readContract<
        const TAbi extends Abi,
        TFunctionName extends ContractFunctionName<TAbi, "pure" | "view">,
    >(
        params: ViemReadContractParams<TAbi, TFunctionName>,
    ): Promise<ContractFunctionReturnType<TAbi, "pure" | "view", TFunctionName>>;
    readContract(params: ReadContractParams): Promise<unknown>;
    async readContract(params: ReadContractParams): Promise<unknown> {
        const addressResult = AddressSchema.safeParse(params.address);
        if (!addressResult.success) {
            throw new InvalidContractAddress(addressResult.error.issues[0].message);
        }

        this.validateFunctionInAbi(params.abi, params.functionName);

        try {
            return await this.publicClient.readContract({
                address: params.address,
                abi: params.abi as unknown as Abi,
                functionName: params.functionName,
                args: params.args as unknown[],
            });
        } catch (error) {
            throw new ContractReadError(error instanceof Error ? error.message : String(error), error);
        }
    }

    /**
     * @inheritdoc IRPCInteractor.getBlockNumber
     *
     * Always asks the node: viem otherwise caches the head for the client's `cacheTime`
     * (4 s by default), and a scan bounded by a cached head misses the blocks a caller
     * just waited for — a note deposited or a key rotated in the last few seconds.
     * @throws {GetBlockNumberError} When the RPC call fails.
     */
    async getBlockNumber(): Promise<Hex> {
        try {
            const blockNumber = await this.publicClient.getBlockNumber({ cacheTime: 0 });
            return numberToHex(blockNumber) as Hex;
        } catch (error) {
            throw new GetBlockNumberError(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * @inheritdoc IRPCInteractor.getFinalizedBlockNumber
     *
     * Never throws. A provider that does not serve the `finalized` tag is an
     * ordinary configuration, not an error, and it must not be able to fail the
     * whole discovery pass that asks for the boundary.
     *
     * Classification is deliberately conservative: `unsupported` only on wording
     * that actually indicates the node does not know the tag, and `unavailable` for
     * everything else. Guessing wrong toward `unsupported` is the harmful direction
     * — it hands a caller a weaker rule on the strength of one failed request, which
     * is exactly what anyone able to induce a timeout would want.
     */
    async getFinalizedBlockNumber(): Promise<FinalizedBlockResult> {
        try {
            const block = await this.publicClient.getBlock({ blockTag: "finalized" });
            if (block.number === null || block.number === undefined) {
                // A node that answers the tag with a pending-shaped block has no
                // finalized head to give. Permanent enough to treat as unsupported.
                return { status: "unsupported" };
            }
            return { status: "finalized", blockNumber: numberToHex(block.number) as Hex };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return isUnknownBlockTagError(reason)
                ? { status: "unsupported" }
                : { status: "unavailable", reason };
        }
    }

    /**
     * @inheritdoc IRPCInteractor.waitForTransactionReceipt
     * @throws {WaitForReceiptError} When the RPC call fails.
     */
    async waitForTransactionReceipt(hash: Hex): Promise<TxReceipt> {
        try {
            const receipt = await this.publicClient.waitForTransactionReceipt({
                hash: hash as `0x${string}`,
            });
            const logs: TxLog[] = receipt.logs.map((log) => ({
                address: log.address as Hex,
                topics: (log.topics as string[]).map((t) => t as Hex),
                data: log.data as Hex,
                blockNumber: numberToHex(log.blockNumber) as Hex,
                transactionHash: log.transactionHash as Hex,
                logIndex: log.logIndex,
            }));
            return {
                txHash: receipt.transactionHash,
                status: receipt.status === "success",
                blockNumber: numberToHex(receipt.blockNumber) as Hex,
                logs,
            };
        } catch (error) {
            if (error instanceof RPCInteractorBaseError) throw error;
            throw new WaitForReceiptError(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * @inheritdoc IRPCInteractor.getLogs
     * @throws {InvalidContractAddress} When the contract address is invalid.
     * @throws {EventReadError} When the log fetch fails.
     */
    async getLogs(params: GetLogsParams): Promise<DecodedEventLog[]> {
        const addressResult = AddressSchema.safeParse(params.address);
        if (!addressResult.success) {
            throw new InvalidContractAddress(addressResult.error.issues[0].message);
        }

        try {
            const logs = await this.publicClient.getLogs({
                address: params.address,
                events: params.events as unknown as AbiEvent[],
                fromBlock: this.floorFromBlock(params.fromBlock),
                toBlock: params.toBlock ?? "latest",
            });

            return logs.map((log) => ({
                eventName: log.eventName as string,
                args: log.args as Record<string, unknown>,
                blockNumber: numberToHex(log.blockNumber),
                transactionHash: log.transactionHash,
            }));
        } catch (error) {
            // Preserve the upstream viem error on `.cause` so
            // `getLogsPaginated`'s shrink helper can `instanceof`-check the
            // structured RPC error (e.g. `LimitExceededRpcError`) without
            // resorting to substring matching on the message.
            throw new EventReadError(error instanceof Error ? error.message : String(error), error);
        }
    }

    /**
     * @inheritdoc IRPCInteractor.getLogsPaginated
     * @throws {InvalidContractAddress} When the contract address is invalid.
     * @throws {EventReadError} When a chunk fails for a reason that bisection cannot resolve.
     */
    async getLogsPaginated(params: GetLogsParams): Promise<DecodedEventLog[]> {
        const fromBlock = this.floorFromBlock(params.fromBlock);
        const toBlock = params.toBlock ?? BigInt(await this.getBlockNumber());
        const totalChunks = ((toBlock - fromBlock) / this.chunkSize + 1n).toString();

        this.logger?.debug("getLogsPaginated start", {
            address: params.address,
            fromBlock: fromBlock.toString(),
            toBlock: toBlock.toString(),
            chunkSize: this.chunkSize.toString(),
            totalChunks,
        });

        const all: DecodedEventLog[] = [];
        let chunkIndex = 0;
        for (let start = fromBlock; start <= toBlock; start += this.chunkSize) {
            const end =
                start + this.chunkSize - 1n < toBlock ? start + this.chunkSize - 1n : toBlock;
            ++chunkIndex;
            await this.fetchRangeWithShrink(params, start, end, all);
        }

        this.logger?.debug("getLogsPaginated done", {
            chunks: chunkIndex,
            totalLogs: all.length,
        });
        return all;
    }

    /**
     * Fetches logs for `[start, end]` (with rate-limit retry via
     * {@link getLogsWithRateLimitRetry}) and appends them to `out`. On a
     * provider response-cap error (`LimitExceededRpcError`,
     * `InvalidParamsRpcError` preserved on `EventReadError.cause`), bisects
     * the range and retries each half. Bottoms out at a one-block range.
     *
     * Any other error propagates immediately — bisection cannot fix
     * transport, auth, or method errors.
     */
    private async fetchRangeWithShrink(
        params: GetLogsParams,
        start: bigint,
        end: bigint,
        out: DecodedEventLog[],
    ): Promise<void> {
        try {
            const logs = await this.getLogsWithRateLimitRetry({
                ...params,
                fromBlock: start,
                toBlock: end,
            });
            for (const log of logs) out.push(log);
        } catch (err) {
            if (!ViemRPCInteractor.isProviderLimitError(err)) throw err;
            if (end <= start) throw err;
            const mid = start + (end - start) / 2n;
            this.logger?.warn("getLogs response cap — bisecting range", {
                from: start.toString(),
                to: end.toString(),
                mid: mid.toString(),
            });
            await this.fetchRangeWithShrink(params, start, mid, out);
            await this.fetchRangeWithShrink(params, mid + 1n, end, out);
        }
    }

    /**
     * Calls `getLogs` and retries on HTTP 429 with linear backoff
     * (`RATE_LIMIT_RETRY_BASE_MS * attempt`). Gives up after
     * {@link MAX_RATE_LIMIT_RETRIES} retries and rethrows the last error.
     * Non-429 errors propagate on the first attempt.
     */
    private async getLogsWithRateLimitRetry(params: GetLogsParams): Promise<DecodedEventLog[]> {
        for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
            try {
                return await this.getLogs(params);
            } catch (err) {
                const exhausted = attempt === MAX_RATE_LIMIT_RETRIES;
                if (!ViemRPCInteractor.isRateLimitError(err) || exhausted) throw err;
                const waitMs = RATE_LIMIT_RETRY_BASE_MS * (attempt + 1);
                this.logger?.warn("getLogs rate-limited — backing off", {
                    attempt: attempt + 1,
                    maxAttempts: MAX_RATE_LIMIT_RETRIES + 1,
                    waitMs,
                });
                await sleep(waitMs);
            }
        }
        throw new Error("getLogsWithRateLimitRetry: unreachable");
    }

    /**
     * Returns true when an error from `getLogs` is one of the viem RPC error
     * classes that providers use to signal block-range / response-size limits.
     * `EventReadError` preserves the upstream viem error on `.cause`.
     *
     * - `LimitExceededRpcError` (-32005): Infura emits this for "query returned
     *   more than X results" and similar caps.
     * - `InvalidParamsRpcError` (-32602): Alchemy emits this for "block range
     *   is too wide" / "Log response size exceeded".
     *
     * Other classes (`InvalidRequestRpcError`, `InternalRpcError`,
     * `HttpRequestError`) are deliberately not bisected on — they signal
     * malformed requests or transport failures rather than provider caps, and
     * retrying with a smaller window cannot resolve them.
     */
    private static isProviderLimitError(err: unknown): boolean {
        const cause = (err as { cause?: unknown } | null)?.cause;
        return cause instanceof LimitExceededRpcError || cause instanceof InvalidParamsRpcError;
    }

    /**
     * Returns true when the upstream viem error preserved on `EventReadError.cause`
     * is an `HttpRequestError` with HTTP status 429 (rate limit). Used by
     * `fetchRangeWithShrink` to distinguish rate-limit errors (retry the same
     * range after a sleep) from response-cap errors (bisect the range).
     */
    private static isRateLimitError(err: unknown): boolean {
        const cause = (err as { cause?: unknown } | null)?.cause;
        return cause instanceof HttpRequestError && cause.status === 429;
    }

    private validateFunctionInAbi(
        abi: readonly Record<string, unknown>[],
        functionName: string,
    ): void {
        const hasFunction = abi.some(
            (entry) => entry["type"] === "function" && entry["name"] === functionName,
        );
        if (!hasFunction) {
            throw new InvalidABIFunctionName(
                `Function "${functionName}" not found in provided ABI`,
            );
        }
    }
}
