import { decodeEventLog, encodeFunctionData } from "viem";

import type {
    Address,
    ContractInteractorConfig,
    DecodedEventLog,
    DepositedEvent,
    EVMProof,
    Hash,
    Hex,
    ILogger,
    IPoolVaultChainAdapter,
    IRPCInteractor,
    IWalletInteractor,
    NoteData,
    NoteEvent,
    PoolVaultInteractorDependencies,
    PreparedTransaction,
    RagequitEvent,
    TransactedEvent,
    TransactParams,
    TxLog,
} from "../../internal.js";
import {
    bigintToHex,
    BigIntSchema,
    BooleanSchema,
    ContractCallError,
    ContractInteractorBaseError,
    ContractInteractorConfigSchema,
    decodeNoteData,
    DepositedEventArgsSchema,
    InvalidContractResult,
    InvalidInteractorAddress,
    LeavesInsertedEventArgsSchema,
    NoteDataSchema,
    POOL_VAULT_ABI,
    POOL_VAULT_DEPOSITED_EVENT_ABI,
    POOL_VAULT_LEAVES_INSERTED_ABI,
    POOL_VAULT_NOTE_EVENT_ABI,
    POOL_VAULT_RAGEQUIT_ABI,
    POOL_VAULT_RAGEQUIT_EVENT_ABI,
    POOL_VAULT_TRANSACT_ABI,
    POOL_VAULT_TRANSACTED_EVENT_ABI,
    PoolVaultInteractor,
    RagequitEventArgsSchema,
    TransactedEventArgsSchema,
    WalletNotAvailable,
} from "../../internal.js";

/**
 * EVM implementation of {@link IPoolVaultChainAdapter} — viem-backed reads, ABI calldata
 * encoding, and event log decoding for the PoolVault contract. Extracted verbatim from the
 * pre-genericization `PoolVaultInteractor`; behavior is unchanged, only relocated.
 */
export class EvmPoolVaultChainAdapter implements IPoolVaultChainAdapter<PreparedTransaction> {
    private readonly rpcInteractor: IRPCInteractor;
    private readonly contractAddress: Address;
    private readonly deploymentBlock?: bigint;
    private readonly logger?: ILogger;
    private readonly walletInteractor?: IWalletInteractor;

    /**
     * @throws {InvalidInteractorAddress} When the contract address is invalid.
     */
    constructor(config: ContractInteractorConfig, deps?: PoolVaultInteractorDependencies) {
        const validated = ContractInteractorConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidInteractorAddress(validated.error.issues[0].message);
        }

        this.rpcInteractor = config.rpcInteractor;
        this.contractAddress = config.contractAddress;
        this.deploymentBlock = config.deploymentBlock;
        this.logger = deps?.logger;
        this.walletInteractor = deps?.walletInteractor;
    }

    getAddress(): Address {
        return this.contractAddress;
    }

    async getCommitmentValue(commitmentHash: Hash): Promise<bigint> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: POOL_VAULT_ABI,
                functionName: "commitments",
                args: [BigInt(commitmentHash)],
            });
            const safeResult = BigIntSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }
            return safeResult.data;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async getNullifierValue(nullifierHash: Hash): Promise<bigint> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: POOL_VAULT_ABI,
                functionName: "spentNullifiers",
                args: [BigInt(nullifierHash)],
            });
            const safeResult = BigIntSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }
            return safeResult.data;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async isKnownRootRaw(root: Hash): Promise<boolean> {
        try {
            const result = await this.rpcInteractor.readContract({
                address: this.contractAddress,
                abi: POOL_VAULT_ABI,
                functionName: "isKnownRoot",
                args: [BigInt(root)],
            });
            const safeResult = BooleanSchema.safeParse(result);
            if (!safeResult.success) {
                throw new InvalidContractResult(safeResult.error.issues[0].message);
            }
            return safeResult.data;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async getCurrentCursor(): Promise<bigint> {
        return BigInt(await this.rpcInteractor.getBlockNumber());
    }

    /**
     * @inheritdoc IPoolVaultChainAdapter.resolveTokenId
     * EVM's `toTokenIdField` is the identity — `fieldValue` already numerically equals the real
     * address, just missing its fixed-width `0x`-prefixed 20-byte formatting.
     */
    async resolveTokenId(fieldValue: Hash): Promise<Address> {
        return (`0x${BigInt(fieldValue).toString(16).padStart(40, "0")}`) as Address;
    }

    /**
     * Fetches and decodes `LeavesInserted` events in `[fromCursor, toCursor]` into validated
     * `{startIndex, newLeaves}` deltas. Walks chain history in fixed block windows via
     * {@link IRPCInteractor.getLogsPaginated} to stay under common RPC providers' `eth_getLogs`
     * block-range / log-count caps.
     *
     * @throws {InvalidContractResult} When event log args fail validation.
     * @throws {ContractCallError} When the RPC call fails.
     */
    async fetchLeafInsertions(
        fromCursor: bigint | undefined,
        toCursor: bigint,
    ): Promise<{ startIndex: number; newLeaves: Hash[] }[]> {
        try {
            const logs = await this.rpcInteractor.getLogsPaginated({
                address: this.contractAddress,
                events: POOL_VAULT_LEAVES_INSERTED_ABI,
                fromBlock: fromCursor,
                toBlock: toCursor,
            });

            const deltas: { startIndex: number; newLeaves: Hash[] }[] = [];
            for (const log of logs) {
                if (log.eventName !== "LeavesInserted") continue;
                const validatedArgs = LeavesInsertedEventArgsSchema.safeParse(log.args);
                if (!validatedArgs.success) {
                    throw new InvalidContractResult(validatedArgs.error.issues[0].message);
                }
                deltas.push({
                    startIndex: validatedArgs.data._startIndex,
                    newLeaves: validatedArgs.data._newLeaves.map((leaf) => bigintToHex(leaf)),
                });
            }
            return deltas;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async fetchNoteEvents(fromBlock?: Hex, toBlock?: Hex): Promise<NoteEvent[]> {
        try {
            const logs = await this.rpcInteractor.getLogsPaginated({
                address: this.contractAddress,
                events: POOL_VAULT_NOTE_EVENT_ABI,
                fromBlock: fromBlock ? BigInt(fromBlock) : this.deploymentBlock,
                toBlock: toBlock ? BigInt(toBlock) : undefined,
            });
            return this.parseNoteEventLogs(logs);
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async fetchTransactedEvents(fromBlock?: Hex, toBlock?: Hex): Promise<TransactedEvent[]> {
        try {
            const logs = await this.rpcInteractor.getLogsPaginated({
                address: this.contractAddress,
                events: POOL_VAULT_TRANSACTED_EVENT_ABI,
                fromBlock: fromBlock ? BigInt(fromBlock) : this.deploymentBlock,
                toBlock: toBlock ? BigInt(toBlock) : undefined,
            });
            return this.parseTransactedEventLogs(logs);
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async fetchDepositedEvents(fromBlock?: Hex, toBlock?: Hex): Promise<DepositedEvent[]> {
        try {
            const logs = await this.rpcInteractor.getLogsPaginated({
                address: this.contractAddress,
                events: POOL_VAULT_DEPOSITED_EVENT_ABI,
                fromBlock: fromBlock ? BigInt(fromBlock) : this.deploymentBlock,
                toBlock: toBlock ? BigInt(toBlock) : undefined,
            });
            return this.parseDepositedEventLogs(logs);
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    async fetchRagequitEvents(fromBlock?: Hex, toBlock?: Hex): Promise<RagequitEvent[]> {
        try {
            const logs = await this.rpcInteractor.getLogsPaginated({
                address: this.contractAddress,
                events: POOL_VAULT_RAGEQUIT_EVENT_ABI,
                fromBlock: fromBlock ? BigInt(fromBlock) : this.deploymentBlock,
                toBlock: toBlock ? BigInt(toBlock) : undefined,
            });
            return this.parseRagequitEventLogs(logs);
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(error instanceof Error ? error.message : String(error));
        }
    }

    extractSpentNullifiers(logs: TxLog[]): Hex[] {
        const nullifiers: Hex[] = [];

        for (const log of logs) {
            // Emitter==PoolVault gate: a relayer-supplied receipt can carry Transacted
            // logs from an unrelated contract; only THIS pool's logs count toward the
            // spent-nullifier set (AW-L-02 / #1070).
            if (log.address.toLowerCase() !== this.contractAddress.toLowerCase()) continue;

            let decoded;
            try {
                decoded = decodeEventLog({
                    abi: POOL_VAULT_TRANSACTED_EVENT_ABI,
                    data: log.data,
                    topics: log.topics as [signature: Hex, ...args: Hex[]],
                });
            } catch {
                // Not a Transacted log (different event / arity) — ignore.
                continue;
            }

            if (decoded.eventName !== "Transacted") continue;

            const validated = TransactedEventArgsSchema.safeParse(decoded.args);
            if (!validated.success) {
                this.logger?.debug("Skipping malformed Transacted receipt log", {
                    txHash: log.transactionHash,
                });
                continue;
            }

            for (const nullifierHash of validated.data.nullifierHashes) {
                nullifiers.push(bigintToHex(nullifierHash));
            }
        }

        return nullifiers;
    }

    async encodeRagequit(proof: EVMProof, _asset: Address): Promise<PreparedTransaction> {
        return {
            to: this.contractAddress,
            data: encodeFunctionData({
                abi: POOL_VAULT_RAGEQUIT_ABI,
                functionName: "ragequit",
                args: [
                    {
                        pA: proof.pA,
                        pB: proof.pB,
                        pC: proof.pC,
                        pubSignals: proof.pubSignals as unknown as readonly [
                            bigint,
                            bigint,
                            bigint,
                            bigint,
                            bigint,
                            bigint,
                            bigint,
                        ],
                    },
                ],
            }) as Hex,
            value: "0x0" as Hex,
        };
    }

    async encodeTransact(
        proof: EVMProof,
        transactPubSignals: bigint[][],
        transactParams: TransactParams,
        noteData: NoteData[],
        _asset: Address,
    ): Promise<PreparedTransaction> {
        return {
            to: this.contractAddress,
            data: encodeFunctionData({
                abi: POOL_VAULT_TRANSACT_ABI,
                functionName: "transact",
                args: [
                    { pA: proof.pA, pB: proof.pB, pC: proof.pC, pubSignals: transactPubSignals },
                    { processor: transactParams.processor, data: transactParams.data },
                    noteData,
                ],
            }) as Hex,
            value: "0x0" as Hex,
        };
    }

    /**
     * @throws {WalletNotAvailable} When walletInteractor is not configured.
     */
    async submit(tx: PreparedTransaction): Promise<Hex> {
        if (!this.walletInteractor) {
            throw new WalletNotAvailable(
                "PoolVaultInteractor requires a walletInteractor for write operations",
            );
        }
        return this.walletInteractor.sendTransaction(tx);
    }

    private parseNoteEventLogs(logs: DecodedEventLog[]): NoteEvent[] {
        const events: NoteEvent[] = [];

        for (const log of logs) {
            if (log.eventName !== "Note") continue;

            const noteArgs = NoteDataSchema.safeParse(log.args);
            if (!noteArgs.success) {
                this.logger?.debug("Skipping malformed Note event", {
                    txHash: log.transactionHash,
                });
                continue;
            }

            try {
                const { ephemeralPubKey, encryptedPayload } = decodeNoteData(
                    noteArgs.data.data as Hex,
                );
                events.push({
                    blockNumber: log.blockNumber,
                    txHash: log.transactionHash as Hash,
                    hint: noteArgs.data.hint as Hex,
                    ephemeralPubKey,
                    encryptedPayload,
                });
            } catch {
                this.logger?.debug("Skipping Note with undecodable data", {
                    txHash: log.transactionHash,
                });
            }
        }

        return events;
    }

    private parseTransactedEventLogs(logs: DecodedEventLog[]): TransactedEvent[] {
        const events: TransactedEvent[] = [];

        for (const log of logs) {
            if (log.eventName !== "Transacted") continue;

            const validated = TransactedEventArgsSchema.safeParse(log.args);
            if (!validated.success) {
                this.logger?.debug("Skipping malformed Transacted event", {
                    txHash: log.transactionHash,
                });
                continue;
            }

            events.push({
                blockNumber: log.blockNumber,
                txHash: log.transactionHash as Hash,
                outputCommitments: validated.data.outputCommitments.map((c) => bigintToHex(c)),
                nullifierHashes: validated.data.nullifierHashes.map((n) => bigintToHex(n)),
                asset: validated.data.asset as Address,
                withdrawnValue: bigintToHex(validated.data.withdrawnValue),
                caller: validated.data.caller as Address,
            });
        }

        return events;
    }

    private parseDepositedEventLogs(logs: DecodedEventLog[]): DepositedEvent[] {
        const events: DepositedEvent[] = [];

        for (const log of logs) {
            if (log.eventName !== "Deposited") continue;

            const validated = DepositedEventArgsSchema.safeParse(log.args);
            if (!validated.success) {
                this.logger?.debug("Skipping malformed Deposited event", {
                    txHash: log.transactionHash,
                });
                continue;
            }

            events.push({
                blockNumber: log.blockNumber,
                txHash: log.transactionHash,
                outputCommitment: bigintToHex(validated.data.outputCommitment),
                asset: validated.data.asset,
                depositedValue: bigintToHex(validated.data.depositedValue),
                caller: validated.data.caller,
            });
        }

        return events;
    }

    private parseRagequitEventLogs(logs: DecodedEventLog[]): RagequitEvent[] {
        const events: RagequitEvent[] = [];

        for (const log of logs) {
            if (log.eventName !== "Ragequit") continue;

            const validated = RagequitEventArgsSchema.safeParse(log.args);
            if (!validated.success) {
                this.logger?.debug("Skipping malformed Ragequit event", {
                    txHash: log.transactionHash,
                });
                continue;
            }

            events.push({
                blockNumber: log.blockNumber,
                txHash: log.transactionHash as Hash,
                ragequitter: validated.data.ragequitter as Address,
                asset: validated.data.asset as Address,
                commitment: bigintToHex(validated.data.commitment),
                nullifierHash: bigintToHex(validated.data.nullifierHash),
                label: bigintToHex(validated.data.label),
            });
        }

        return events;
    }
}

/**
 * Constructs a `PoolVaultInteractor` bound to the EVM PoolVault contract — wraps
 * {@link EvmPoolVaultChainAdapter} around today's `ContractInteractorConfig`/
 * `PoolVaultInteractorDependencies` shape, so existing callers only rename their construction
 * call (`new PoolVaultInteractor(cfg, deps)` → `createEvmPoolVaultInteractor(cfg, deps)`); the
 * config/mock shape they already pass is unchanged.
 *
 * Deliberately a standalone function here, not a static method on `PoolVaultInteractor` itself —
 * a static factory would force every consumer of the generic class (including a Stellar-only
 * bundle) to statically import this file, pulling in viem and every PoolVault ABI constant even
 * when `.forEvm()`/this function is never called. Keeping the wiring here instead means importing
 * `PoolVaultInteractor` alone stays free of any concrete chain adapter.
 *
 * @throws {InvalidInteractorAddress} When the contract address is invalid.
 */
export function createEvmPoolVaultInteractor(
    config: ContractInteractorConfig,
    deps?: PoolVaultInteractorDependencies,
): PoolVaultInteractor<PreparedTransaction> {
    const adapter = new EvmPoolVaultChainAdapter(config, deps);
    return new PoolVaultInteractor(
        { adapter, deploymentBlock: config.deploymentBlock },
        { seed: deps?.seed },
    );
}
