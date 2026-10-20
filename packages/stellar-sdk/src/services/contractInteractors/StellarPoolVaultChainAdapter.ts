import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import {
    addressScVal,
    bigintToHex,
    boolScVal,
    bufferToHex,
    bytesScVal,
    bytesToBigIntBE,
    ContractCallError,
    ContractInteractorBaseError,
    decodeNoteData,
    decodeScVal,
    DepositedEvent,
    groth16ProofScVal,
    Hash,
    Hex,
    IPoolVaultChainAdapter,
    InvalidContractResult,
    IStellarRPCInteractor,
    IStellarWalletInteractor,
    ledgerClosedAtToUnixSeconds,
    NoteData,
    noteDataScVal,
    NoteEvent,
    PoolVaultInteractor,
    RagequitEvent,
    StellarAddress,
    StellarContractInteractorConfig,
    stellarErrorMessage,
    StellarLog,
    StellarPoolVaultInteractorDependencies,
    StellarProof,
    TransactedEvent,
    TransactParams,
    u128ScVal,
    u256ScVal,
    u32ScVal,
    vecScVal,
    WalletNotAvailable,
} from "../../internal.js";

// Soroban's #[contractevent] macro emits topic[0] as the snake_case conversion of the Rust
// struct name (verified live against the local network's raw event responses — e.g.
// `Deposited` -> "deposited", `NoteEvent` -> "note_event", `LeavesInserted` ->
// "leaves_inserted"), not the PascalCase struct name itself.
const EVENT = {
    LEAVES_INSERTED: "leaves_inserted",
    NOTE_EVENT: "note_event",
    TRANSACTED: "transacted",
    DEPOSITED: "deposited",
    RAGEQUIT: "ragequit_event",
} as const;

/** `2^160 - 1` — mirrors `StellarAddressFieldConverter.toTokenIdField`'s mask, for `resolveTokenId`. */
const TOKEN_ID_MASK = (1n << 160n) - 1n;

/**
 * Stellar implementation of {@link IPoolVaultChainAdapter} — Soroban RPC-backed reads, ScVal
 * argument encoding, and event decoding for the pool contract's `transact`/`ragequit`/state-read
 * surface. Ported from the reference Rust contract's pool contract signatures
 * (verified directly against the source, no reference client to port from) and the
 * `#[contractevent]` struct definitions in the same file.
 *
 * `getCommitmentValue`/`getNullifierValue` read the pool's `commitment_created_at` /
 * `nullifier_spent_at` timestamps directly, falling back to reconstructing them from event history
 * only when the read fails (see their own doc comments).
 */
export class StellarPoolVaultChainAdapter
    implements IPoolVaultChainAdapter<string, StellarAddress, StellarProof, StellarLog>
{
    private readonly rpcInteractor: IStellarRPCInteractor;
    private readonly contractId: string;
    private readonly readSourcePublicKey: string;
    private readonly deploymentLedger?: bigint;
    private readonly walletInteractor?: IStellarWalletInteractor;
    /** Field-hash (minimal hex, no padding) -> real asset address, built lazily by `resolveTokenId`. */
    private readonly tokenIdCache = new Map<string, StellarAddress>();
    private tokenIdCacheFetchedThrough: bigint | undefined;

    constructor(
        config: StellarContractInteractorConfig,
        deps?: StellarPoolVaultInteractorDependencies,
    ) {
        this.rpcInteractor = config.rpcInteractor;
        this.contractId = config.contractId;
        this.readSourcePublicKey = config.readSourcePublicKey;
        this.deploymentLedger = config.deploymentLedger;
        this.walletInteractor = deps?.walletInteractor;
    }

    getAddress(): StellarAddress {
        return this.contractId;
    }

    /**
     * Reads the pool's `commitment_created_at` (the ledger timestamp it stores). If that read fails
     * — an archived entry, say — the timestamp is reconstructed from `Deposited`/`Transacted` event history,
     * using the matching event's own `ledgerClosedAt` (bundled with every `getEvents` page, no
     * extra RPC round-trip) as the insertion timestamp. Returns `0n` if never inserted, matching
     * EVM's `PoolVault.commitments(hash)` zero-means-absent convention.
     */
    async getCommitmentValue(commitmentHash: Hash): Promise<bigint> {
        const direct = await this.readTimestamp("commitment_created_at", commitmentHash);
        if (direct !== undefined) return direct;
        const target = BigInt(commitmentHash);

        const events = await this.fetchEventsByNames(
            [EVENT.DEPOSITED, EVENT.TRANSACTED],
            this.deploymentLedger,
            undefined,
        );
        for (const event of events) {
            if (event.type === EVENT.DEPOSITED) {
                const commitment = decodeScVal(event.topics[1]) as bigint;
                if (commitment === target) return ledgerClosedAtToUnixSeconds(event.ledgerClosedAt);
            } else {
                const data = decodeScVal(event.data) as { commitments: bigint[] };
                if (data.commitments.some((c) => c === target)) {
                    return ledgerClosedAtToUnixSeconds(event.ledgerClosedAt);
                }
            }
        }

        return 0n;
    }

    /**
     * Reads the pool's `nullifier_spent_at`. If that read fails, the spend timestamp is reconstructed
     * from `Transacted`/`RagequitEvent` history (the two calls that can spend a nullifier), same
     * `ledgerClosedAt`-as-timestamp approach as {@link getCommitmentValue}. Returns `0n` if
     * unspent.
     */
    async getNullifierValue(nullifierHash: Hash): Promise<bigint> {
        const direct = await this.readTimestamp("nullifier_spent_at", nullifierHash);
        if (direct !== undefined) return direct;
        const target = BigInt(nullifierHash);

        const events = await this.fetchEventsByNames(
            [EVENT.TRANSACTED, EVENT.RAGEQUIT],
            this.deploymentLedger,
            undefined,
        );
        for (const event of events) {
            if (event.type === EVENT.TRANSACTED) {
                const data = decodeScVal(event.data) as { nullifiers: bigint[] };
                if (data.nullifiers.some((n) => n === target)) {
                    return ledgerClosedAtToUnixSeconds(event.ledgerClosedAt);
                }
            } else {
                const data = decodeScVal(event.data) as { nullifier_hash: bigint };
                if (data.nullifier_hash === target) {
                    return ledgerClosedAtToUnixSeconds(event.ledgerClosedAt);
                }
            }
        }

        return 0n;
    }

    async isKnownRootRaw(root: Hash): Promise<boolean> {
        try {
            const result = await this.rpcInteractor.simulateRead(
                this.contractId,
                "is_known_root",
                [u256ScVal(root)],
                this.readSourcePublicKey,
            );
            if (typeof result !== "boolean") {
                throw new InvalidContractResult(
                    `Expected boolean from is_known_root, got ${typeof result}`,
                );
            }
            return result;
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(stellarErrorMessage(error));
        }
    }

    async getCurrentCursor(): Promise<bigint> {
        return BigInt(await this.rpcInteractor.getLatestLedger());
    }

    /**
     * @inheritdoc IPoolVaultChainAdapter.resolveTokenId
     *
     * `toTokenIdField`'s `keccak256(strkey) & (2^160-1)` has no general inverse, so this
     * resolves the real StrKey by cross-referencing `Deposited` events' cleartext `asset` field
     * instead — every asset ever deposited into this pool is observable there. Lazily builds and
     * incrementally extends an in-memory field-hash -> address cache (keyed by minimal, not
     * zero-padded, hex — matching `toTokenIdField`'s own un-padded output) rather than rescanning
     * from genesis on every call.
     */
    async resolveTokenId(fieldValue: Hash): Promise<StellarAddress | null> {
        const key = BigInt(fieldValue).toString(16);
        const cached = this.tokenIdCache.get(key);
        if (cached) return cached;

        const currentCursor = await this.getCurrentCursor();
        const fromCursor =
            this.tokenIdCacheFetchedThrough !== undefined
                ? bigintToHex(this.tokenIdCacheFetchedThrough + 1n)
                : undefined;
        const events = await this.fetchDepositedEvents(fromCursor, bigintToHex(currentCursor));
        for (const event of events) {
            const assetHash = keccak_256(utf8ToBytes(event.asset));
            const assetFieldKey = (bytesToBigIntBE(assetHash) & TOKEN_ID_MASK).toString(16);
            this.tokenIdCache.set(assetFieldKey, event.asset);
        }
        this.tokenIdCacheFetchedThrough = currentCursor;

        return this.tokenIdCache.get(key) ?? null;
    }

    async fetchLeafInsertions(
        fromCursor: bigint | undefined,
        toCursor: bigint,
    ): Promise<{ startIndex: number; newLeaves: Hash[] }[]> {
        const events = await this.fetchEventsByNames([EVENT.LEAVES_INSERTED], fromCursor, toCursor);
        return events.map((event) => {
            const data = decodeScVal(event.data) as {
                leaves: bigint[];
                root: bigint;
                start_index: number;
            };
            return {
                startIndex: data.start_index,
                newLeaves: data.leaves.map((leaf) => bigintToHex(leaf)),
            };
        });
    }

    async fetchNoteEvents(fromCursor?: Hex, toCursor?: Hex): Promise<NoteEvent[]> {
        const events = await this.fetchEventsByNames(
            [EVENT.NOTE_EVENT],
            fromCursor ? BigInt(fromCursor) : this.deploymentLedger,
            toCursor ? BigInt(toCursor) : undefined,
        );

        const results: NoteEvent[] = [];
        for (const event of events) {
            try {
                const hint = bufferToHex(decodeScVal(event.topics[1]));
                // NoteEvent has a single non-topic field ("data"), but Soroban's #[contractevent]
                // macro still wraps it in a one-key map keyed by field name (verified live —
                // decodeScVal(event.data) returns `{ data: Buffer }`, not the raw bytes), the same
                // convention confirmed for multi-field events (e.g. LeavesInserted) elsewhere in
                // this file — so unwrap the "data" key rather than treating the map as the buffer.
                const { data } = decodeScVal(event.data) as { data: Uint8Array };
                const rawData = bufferToHex(data);
                const { ephemeralPubKey, encryptedPayload } = decodeNoteData(rawData);
                results.push({
                    blockNumber: event.ledger,
                    txHash: event.transactionHash,
                    hint,
                    ephemeralPubKey,
                    encryptedPayload,
                });
            } catch {
                continue;
            }
        }
        return results;
    }

    async fetchTransactedEvents(
        fromCursor?: Hex,
        toCursor?: Hex,
    ): Promise<TransactedEvent<StellarAddress>[]> {
        const events = await this.fetchEventsByNames(
            [EVENT.TRANSACTED],
            fromCursor ? BigInt(fromCursor) : this.deploymentLedger,
            toCursor ? BigInt(toCursor) : undefined,
        );
        return events.map((event) => {
            const data = decodeScVal(event.data) as {
                commitments: bigint[];
                nullifiers: bigint[];
                asset: StellarAddress;
                amount_out: bigint;
                processor: StellarAddress;
            };
            return {
                blockNumber: event.ledger,
                txHash: event.transactionHash,
                outputCommitments: data.commitments.map((c) => bigintToHex(c)),
                nullifierHashes: data.nullifiers.map((n) => bigintToHex(n)),
                asset: data.asset,
                withdrawnValue: bigintToHex(data.amount_out),
                caller: data.processor,
            };
        });
    }

    async fetchDepositedEvents(
        fromCursor?: Hex,
        toCursor?: Hex,
    ): Promise<DepositedEvent<StellarAddress>[]> {
        const events = await this.fetchEventsByNames(
            [EVENT.DEPOSITED],
            fromCursor ? BigInt(fromCursor) : this.deploymentLedger,
            toCursor ? BigInt(toCursor) : undefined,
        );
        return events.map((event) => {
            const commitment = decodeScVal(event.topics[1]) as bigint;
            const data = decodeScVal(event.data) as {
                asset: StellarAddress;
                value: bigint;
                depositor: StellarAddress;
            };
            return {
                blockNumber: event.ledger,
                txHash: event.transactionHash,
                outputCommitment: bigintToHex(commitment),
                asset: data.asset,
                depositedValue: bigintToHex(data.value),
                caller: data.depositor,
            };
        });
    }

    async fetchRagequitEvents(
        fromCursor?: Hex,
        toCursor?: Hex,
    ): Promise<RagequitEvent<StellarAddress>[]> {
        const events = await this.fetchEventsByNames(
            [EVENT.RAGEQUIT],
            fromCursor ? BigInt(fromCursor) : this.deploymentLedger,
            toCursor ? BigInt(toCursor) : undefined,
        );
        return events.map((event) => {
            const owner = decodeScVal(event.topics[1]) as StellarAddress;
            const data = decodeScVal(event.data) as {
                asset: StellarAddress;
                value: bigint;
                commitment: bigint;
                nullifier_hash: bigint;
                label: bigint;
            };
            return {
                blockNumber: event.ledger,
                txHash: event.transactionHash,
                ragequitter: owner,
                asset: data.asset,
                commitment: bigintToHex(data.commitment),
                nullifierHash: bigintToHex(data.nullifier_hash),
                label: bigintToHex(data.label),
            };
        });
    }

    /**
     * Decodes spent nullifiers from `Transacted` event logs on this pool contract — mirrors
     * `EvmPoolVaultChainAdapter.extractSpentNullifiers`'s emitter gate (only this pool's own
     * logs count) and best-effort decode (a log that isn't a `Transacted` event is skipped, not
     * treated as an error).
     */
    extractSpentNullifiers(logs: StellarLog[]): Hex[] {
        const nullifiers: Hex[] = [];
        for (const log of logs) {
            if (log.contractId !== this.contractId) continue;
            if (log.type !== EVENT.TRANSACTED) continue;
            try {
                const data = decodeScVal(log.data) as { nullifiers: bigint[] };
                for (const n of data.nullifiers) nullifiers.push(bigintToHex(n));
            } catch {
                continue;
            }
        }
        return nullifiers;
    }

    /**
     * @throws {WalletNotAvailable} When no wallet is configured — the ragequit call's `owner`
     *   argument is the signer's own StrKey address, resolved here rather than passed in.
     */
    async encodeRagequit(proof: StellarProof, asset: StellarAddress): Promise<string> {
        const owner = await this.requireSourceAccount();
        // circom/snarkjs order outputs before inputs: [nullifierHash, commitment, keystoreRoot,
        // ownerAddress, value, tokenId, label] — matches ProofLibV2.RagequitProof's pubSignals[0..6]
        // (packages/contracts/src/libraries/ProofLibV2.sol) and the Ragequit circuit's own
        // Output/Input Signal tables (packages/circuits/docs/circuits/Ragequit.md).
        const [nullifierHash, commitment, keystoreRoot, , value, tokenId, label] =
            proof.pubSignals;
        return this.rpcInteractor.buildTransaction(
            this.contractId,
            "ragequit",
            [
                addressScVal(owner),
                groth16ProofScVal(proof),
                u256ScVal(nullifierHash),
                u256ScVal(commitment),
                u256ScVal(keystoreRoot),
                u128ScVal(value),
                u256ScVal(tokenId),
                u256ScVal(label),
                addressScVal(asset),
            ],
            owner,
        );
    }

    /**
     * @param transactPubSignals - `[nullifiers, outputCommitments, [stateRoot], [keystoreRoot],
     *   [aspRoot], [amountOut], [tokenIdOut], [context]]`, matching
     *   `TransactOrchestrator.restructureTransactPubSignals`'s exact output shape — `context` is
     *   unused here (the contract recomputes it on-chain from `processor`/`processorData`/
     *   `noteData`, same as EVM's contract does from `pubSignals` alone).
     * @throws {WalletNotAvailable} When no wallet is configured — the transact call's submission
     *   needs a signer identity to build against.
     */
    async encodeTransact(
        proof: StellarProof,
        transactPubSignals: bigint[][],
        transactParams: TransactParams<StellarAddress>,
        noteData: NoteData[],
        asset: StellarAddress,
        options?: { deferSimulation?: boolean },
    ): Promise<string> {
        const sourcePublicKey = await this.requireSourceAccount();
        const [nullifierHashes, outputCommitments, [stateRoot], [keystoreRoot], [aspRoot], [amountOut], [tokenIdOut]] =
            transactPubSignals;

        const build = options?.deferSimulation
            ? this.rpcInteractor.buildUnsimulatedTransaction.bind(this.rpcInteractor)
            : this.rpcInteractor.buildTransaction.bind(this.rpcInteractor);
        return build(
            this.contractId,
            "transact",
            [
                addressScVal(transactParams.processor),
                // Whether the processor's own signature gates the call. EVM's PoolVault requires
                // `msg.sender === _transactParams.processor` unconditionally, so every transact
                // this SDK builds is processor-authorized — `true` mirrors that same requirement
                // on Stellar (an ungated call is a distinct on-chain mode no caller path here uses).
                boolScVal(true),
                u32ScVal(nullifierHashes.length),
                u32ScVal(outputCommitments.length),
                groth16ProofScVal(proof),
                u256ScVal(stateRoot),
                u256ScVal(keystoreRoot),
                u256ScVal(aspRoot),
                u128ScVal(amountOut),
                u256ScVal(tokenIdOut),
                vecScVal(nullifierHashes.map((h) => u256ScVal(h))),
                vecScVal(outputCommitments.map((c) => u256ScVal(c))),
                addressScVal(asset),
                vecScVal(noteData.map((nd) => noteDataScVal(nd))),
                bytesScVal(transactParams.data),
            ],
            sourcePublicKey,
        );
    }

    /** @throws {WalletNotAvailable} When no wallet interactor is configured. */
    async submit(tx: string): Promise<Hex> {
        if (!this.walletInteractor) {
            throw new WalletNotAvailable(
                "PoolVaultInteractor requires a walletInteractor for write operations",
            );
        }
        return this.walletInteractor.sendTransaction(tx);
    }

    /**
     * The pool's own O(1) timestamp getter (`commitment_created_at` / `nullifier_spent_at`, which
     * store the ledger timestamp since the CG-4 storage change): the timestamp, `0n` for absent, or
     * `undefined` when the read itself failed (e.g. an archived entry) so the caller falls back to
     * the event history.
     */
    private async readTimestamp(method: string, key: Hash): Promise<bigint | undefined> {
        try {
            const result = await this.rpcInteractor.simulateRead(this.contractId, method, [u256ScVal(key)], this.readSourcePublicKey);
            if (result === undefined || result === null) return 0n;
            return typeof result === "bigint" ? result : undefined;
        } catch {
            return undefined;
        }
    }

    private async requireSourceAccount(): Promise<string> {
        if (!this.walletInteractor) {
            throw new WalletNotAvailable(
                "PoolVaultInteractor requires a walletInteractor to encode a write transaction",
            );
        }
        const [account] = await this.walletInteractor.getAccounts();
        return account;
    }

    /**
     * Fetches every event matching any of `names` in one `getEvents` round-trip — the RPC
     * already returns every event type for the contract per page (this adapter never narrows by
     * topic at the RPC level), so a caller needing more than one event type (e.g.
     * `getCommitmentValue` scanning both `Deposited` and `Transacted`) should always batch them
     * into a single call here rather than fetching the same page once per type.
     */
    private async fetchEventsByNames(
        names: readonly string[],
        fromCursor: bigint | undefined,
        toCursor: bigint | undefined,
    ): Promise<StellarLog[]> {
        try {
            const result = await this.rpcInteractor.getEvents({
                contractId: this.contractId,
                startLedger: fromCursor !== undefined ? (`0x${fromCursor.toString(16)}` as Hex) : undefined,
            });
            const nameSet = new Set(names);
            return result.events.filter((event) => {
                if (!nameSet.has(event.type)) return false;
                if (toCursor === undefined) return true;
                return BigInt(event.ledger) <= toCursor;
            });
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(stellarErrorMessage(error));
        }
    }
}

/**
 * Constructs a `PoolVaultInteractor` bound to the Stellar pool contract — wraps
 * {@link StellarPoolVaultChainAdapter} around `StellarContractInteractorConfig`/
 * `StellarPoolVaultInteractorDependencies`, mirroring `createEvmPoolVaultInteractor`'s role.
 */
export function createStellarPoolVaultInteractor(
    config: StellarContractInteractorConfig,
    deps?: StellarPoolVaultInteractorDependencies,
): PoolVaultInteractor<string, StellarAddress, StellarProof, StellarLog> {
    const adapter = new StellarPoolVaultChainAdapter(config, deps);
    return new PoolVaultInteractor(
        { adapter, deploymentBlock: config.deploymentLedger },
        { seed: deps?.seed },
    );
}
