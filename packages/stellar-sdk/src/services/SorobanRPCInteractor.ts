import { Account, Address, Contract, Operation, StrKey, TransactionBuilder, rpc, scValToNative, xdr, BASE_FEE } from "@stellar/stellar-sdk";

import {
    FinalizedBlockResult,
    Hex,
    ILogger,
    IStellarRPCInteractor,
    sleep,
    SorobanRPCInteractorConfig,
    SorobanRPCInteractorDependencies,
    StellarAccountInfo,
    stellarErrorMessage,
    StellarEventRetentionWindowExceeded,
    StellarGetEventsParams,
    StellarGetEventsResult,
    StellarLog,
    StellarRPCCallTimedOut,
    StellarSimulationFailed,
    StellarTransactionFailed,
    StellarTransactionSendFailed,
    StellarTransactionTimedOut,
    TxReceipt,
    WalletSendTransactionFailed,
} from "../internal.js";

const DEFAULT_TX_TIMEOUT_SECONDS = 30;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_WAIT_TIMEOUT_MS = 60000;
const DEFAULT_RPC_TIMEOUT_MS = 30000;
const DEFAULT_EVENTS_PAGE_LIMIT = 100;
const MAX_EVENT_PAGES_PER_CALL = 10_000;

/**
 * Soroban RPC access — build/simulate/assemble/submit the Stellar transaction lifecycle (minus
 * signing, owned by `IStellarWalletInteractor`) plus event pagination, ported from
 * the reference implementation's proven build-simulate-assemble-
 * submit-poll algorithm, using this SDK's typed errors instead of the reference's plain `Error`.
 */
export class SorobanRPCInteractor implements IStellarRPCInteractor {
    private readonly server: rpc.Server;
    private readonly networkPassphrase: string;
    private readonly receiptPollIntervalMs: number;
    private readonly logger?: ILogger;

    constructor(config: SorobanRPCInteractorConfig, deps?: SorobanRPCInteractorDependencies) {
        this.server = new rpc.Server(config.rpcUrl, {
            allowHttp: config.rpcUrl.startsWith("http://"),
        });
        this.networkPassphrase = config.networkPassphrase;
        this.receiptPollIntervalMs = config.receiptPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IStellarRPCInteractor.getLatestLedger
     * @throws {StellarRPCCallTimedOut} If the call exceeds its bounded timeout.
     */
    async getLatestLedger(): Promise<Hex> {
        const result = await this.withTimeout(this.server.getLatestLedger(), "getLatestLedger");
        return toHex(result.sequence);
    }

    /**
     * @inheritdoc IStellarRPCInteractor.getFinalizedBlockNumber
     * @throws {StellarRPCCallTimedOut} If the underlying {@link getLatestLedger} call exceeds its
     *   bounded timeout.
     */
    async getFinalizedBlockNumber(): Promise<FinalizedBlockResult> {
        return { status: "finalized", blockNumber: await this.getLatestLedger() };
    }

    /**
     * @inheritdoc IStellarRPCInteractor.getAccount
     * @throws {StellarRPCCallTimedOut} If the call exceeds its bounded timeout.
     */
    async getAccount(publicKey: string): Promise<StellarAccountInfo> {
        const account = await this.withTimeout(this.server.getAccount(publicKey), "getAccount");
        return { publicKey: account.accountId(), sequence: account.sequenceNumber() };
    }

    /**
     * @inheritdoc IStellarRPCInteractor.simulateRead
     * @throws {StellarSimulationFailed} If the simulation reports an error.
     */
    async simulateRead(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        sourcePublicKey: string,
    ): Promise<unknown> {
        const tx = await this.buildCallTransaction(contractId, method, args, sourcePublicKey, 1);
        const simResult = await this.simulate(tx);
        if (!simResult.result) return undefined;
        return scValToNative(simResult.result.retval);
    }

    /**
     * @inheritdoc IStellarRPCInteractor.buildTransaction
     * @throws {WalletSendTransactionFailed} If the simulation reports the call would fail — see
     *   the interface doc for why that's surfaced as a send failure, not a Stellar-only
     *   "simulation" error every caller would otherwise have to special-case.
     */
    async buildTransaction(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        sourcePublicKey: string,
        sequenceOffset = 1,
    ): Promise<string> {
        const tx = await this.buildCallTransaction(contractId, method, args, sourcePublicKey, sequenceOffset);
        const simResult = await this.simulateForWrite(tx);
        const preparedTx = rpc.assembleTransaction(tx, simResult).build();
        return preparedTx.toXDR();
    }

    /** @inheritdoc IStellarRPCInteractor.buildUnsimulatedTransaction */
    async buildUnsimulatedTransaction(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        sourcePublicKey: string,
    ): Promise<string> {
        return new TransactionBuilder(new Account(sourcePublicKey, "0"), {
            fee: BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(new Contract(contractId).call(method, ...args))
            .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
            .build()
            .toXDR();
    }

    /**
     * @inheritdoc IStellarRPCInteractor.buildTransactionWithAuth
     * @throws {WalletSendTransactionFailed} If the enforcing-mode simulation rejects the call or its auth.
     */
    async buildTransactionWithAuth(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        sourcePublicKey: string,
        auth: xdr.SorobanAuthorizationEntry[],
    ): Promise<string> {
        const fetchedAccount = await this.withTimeout(this.server.getAccount(sourcePublicKey), "getAccount");
        const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
                contractAddress: new Address(contractId).toScAddress(),
                functionName: method,
                args,
            }),
        );
        // The source account's own `require_auth()` gets nothing for free once the operation
        // carries explicit auth (the simulation then ENFORCES rather than records), so its
        // source-account credential for the root call goes first.
        const sourceEntry = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
            rootInvocation: new xdr.SorobanAuthorizedInvocation({
                function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                    new xdr.InvokeContractArgs({
                        contractAddress: new Address(contractId).toScAddress(),
                        functionName: method,
                        args,
                    }),
                ),
                subInvocations: [],
            }),
        });
        const tx = new TransactionBuilder(fetchedAccount, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
            .addOperation(Operation.invokeHostFunction({ func, auth: [sourceEntry, ...auth] }))
            .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
            .build();
        const simResult = await this.simulateForWrite(tx);
        // assembleTransaction keeps an operation's explicit auth verbatim, adding only resources.
        return rpc.assembleTransaction(tx, simResult).build().toXDR();
    }

    /**
     * @inheritdoc IStellarRPCInteractor.submitTransaction
     * @throws {StellarTransactionSendFailed} If the RPC immediately rejects the transaction.
     */
    async submitTransaction(signedXdr: string): Promise<Hex> {
        const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
        const sendResult = await this.server.sendTransaction(tx);
        if (sendResult.status === "ERROR") {
            // `errorResult` is an XDR TransactionResult object — `.toString()` on it produces
            // the unhelpful "[object Object]" (it has no custom toString), so surface its actual
            // result-code switch name (e.g. "txBadSeq") instead, falling back to the raw XDR
            // base64 if the shape is ever unexpected.
            const code = sendResult.errorResult?.result?.().switch?.().name;
            const detail = code ?? sendResult.errorResult?.toXDR?.("base64") ?? "unknown error";
            throw new StellarTransactionSendFailed(detail);
        }
        // Stellar SDK's `sendTransaction`/`getTransaction` speak plain (unprefixed) hex tx
        // hashes — the SDK's public API surface always speaks `0x`-prefixed Hex (see the SDK's
        // "Hex as the external data format" rule), so prefix on the way out and strip it again
        // in `waitForTransactionReceipt` below before calling back into the same unprefixed API.
        return `0x${sendResult.hash}` as Hex;
    }

    /**
     * @inheritdoc ITxReceiptWaiter.waitForTransactionReceipt
     * @throws {StellarTransactionFailed} If the transaction lands on-chain with status "FAILED".
     * @throws {StellarTransactionTimedOut} If confirmation isn't observed within the timeout.
     */
    async waitForTransactionReceipt(hash: Hex): Promise<TxReceipt<StellarLog>> {
        const unprefixedHash = hash.startsWith("0x") ? hash.slice(2) : hash;
        const start = Date.now();
        while (Date.now() - start < DEFAULT_WAIT_TIMEOUT_MS) {
            const result = await this.server.getTransaction(unprefixedHash);
            if (result.status === "SUCCESS") {
                return {
                    status: true,
                    blockNumber: toHex(result.ledger),
                    txHash: hash,
                    logs: contractEventsToStellarLogs(result, hash),
                };
            }
            if (result.status === "FAILED") {
                throw new StellarTransactionFailed(describeFailedTransaction(result));
            }
            await sleep(this.receiptPollIntervalMs);
        }
        throw new StellarTransactionTimedOut(hash, DEFAULT_WAIT_TIMEOUT_MS);
    }

    /**
     * @inheritdoc IStellarRPCInteractor.getEvents
     * @throws {StellarEventRetentionWindowExceeded} If the requested range predates the RPC's
     *   retention window.
     * @throws {StellarRPCCallTimedOut} If a page fetch exceeds its bounded timeout.
     */
    async getEvents(params: StellarGetEventsParams): Promise<StellarGetEventsResult> {
        const events: StellarLog[] = [];
        let latestLedger: Hex | undefined;
        let cursor = params.cursor;
        let startLedger = params.startLedger;
        const pageLimit = params.limit ?? DEFAULT_EVENTS_PAGE_LIMIT;

        if (!cursor) {
            // Soroban RPC only retains a recent ledger window (rejects anything older with
            // "startLedger must be within the ledger range: <min> - <max>") — unlike EVM's
            // `eth_getLogs`, there is no way to query "from genesis." A caller scanning "from
            // the beginning" (e.g. a fresh session's NoteManager cursor, "0x0") legitimately
            // passes a `startLedger` below the retention window; keep the requested start and
            // let fetchEventsPage retry at the RPC-reported minimum. Never clamp to a fixed
            // lookback from the head: that silently drops older events (e.g. a pool's first
            // LeavesInserted), leaving the rebuilt state tree sparse.
            const requested = startLedger === undefined ? 0 : Number(BigInt(startLedger));
            startLedger = toHex(Math.max(requested, 1));
        }

        for (let page = 0; page < MAX_EVENT_PAGES_PER_CALL; page++) {
            const request = cursor
                ? { filters: [{ type: "contract" as const, contractIds: [params.contractId] }], cursor, limit: pageLimit }
                : {
                      filters: [{ type: "contract" as const, contractIds: [params.contractId] }],
                      startLedger: Number(BigInt(startLedger ?? "0x0")),
                      limit: pageLimit,
                  };
            const result = await this.fetchEventsPage(request, startLedger);
            events.push(...result.events.map(toStellarLog));
            latestLedger = toHex(result.latestLedger);
            const nonAdvancing = result.cursor === cursor;
            cursor = result.cursor;
            if (nonAdvancing) break;
            // A short page is not the end of the range: the RPC caps how many ledgers one request
            // scans (~10k on stellar-rpc 28, verified live), returning fewer events with a cursor
            // at the end of that window. Only stop once the cursor has reached the head.
            if (result.events.length < pageLimit && cursorLedger(result.cursor) >= result.latestLedger) break;
        }

        return { events, latestLedger: latestLedger ?? toHex(0), cursor };
    }

    private async buildCallTransaction(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        sourcePublicKey: string,
        sequenceOffset: number,
    ) {
        const contract = new Contract(contractId);
        const fetchedAccount = await this.withTimeout(this.server.getAccount(sourcePublicKey), "getAccount");
        // TransactionBuilder always targets currentSequence + 1. For sequenceOffset > 1 (a
        // second/third/... transaction from this source built before the prior one has been
        // submitted and confirmed), start from a synthetic Account whose sequence is already
        // advanced by (sequenceOffset - 1), so the built transaction lands on exactly
        // currentSequence + sequenceOffset.
        const account =
            sequenceOffset === 1
                ? fetchedAccount
                : new Account(
                      fetchedAccount.accountId(),
                      (BigInt(fetchedAccount.sequenceNumber()) + BigInt(sequenceOffset - 1)).toString(),
                  );
        return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
            .addOperation(contract.call(method, ...args))
            .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
            .build();
    }

    private async simulate(tx: Parameters<rpc.Server["simulateTransaction"]>[0]) {
        const simResult = await this.withTimeout(this.server.simulateTransaction(tx), "simulateTransaction");
        if (rpc.Api.isSimulationError(simResult)) {
            throw new StellarSimulationFailed(simResult.error ?? "unknown error");
        }
        return simResult;
    }

    /**
     * `buildTransaction`'s own simulate call, not `simulateRead`'s: a *read*'s simulation failure
     * is a real `StellarSimulationFailed` (a malformed view call, a nonexistent contract — nothing
     * to do with whether some account could later submit a write). A *write*'s simulation failure
     * is different — every check the SDK can do locally (schema validation, config reads, the
     * local note manager's own status/value checks) has already run by the time a write's
     * `buildTransaction` reaches this call, so whatever `simulateTransaction` rejects here is
     * Soroban's live-chain-state verdict on submitting this transaction, not a local mistake.
     * Unlike EVM, whose prepare is gas-estimation-only and only learns this at the later
     * `sendTransaction`, Soroban's simulate IS that check — so this re-throws as the same
     * `WalletSendTransactionFailed` every chain's wallet interactor already throws for a real send
     * failure, instead of leaving callers to special-case a Stellar-only "simulation" error.
     */
    private async simulateForWrite(tx: Parameters<rpc.Server["simulateTransaction"]>[0]) {
        try {
            return await this.simulate(tx);
        } catch (error) {
            if (error instanceof StellarSimulationFailed) {
                throw new WalletSendTransactionFailed(error.message);
            }
            throw error;
        }
    }

    private async fetchEventsPage(
        request: Parameters<rpc.Server["getEvents"]>[0],
        requestedStartLedger: Hex | undefined,
    ) {
        try {
            return await this.withTimeout(this.server.getEvents(request), "getEvents");
        } catch (error) {
            const message = stellarErrorMessage(error);
            // The proactive retention-floor clamp in getEvents (above) assumes the RPC's usable
            // minimum is ledger 1, but a young network's true floor is tied to when the node's
            // own event index began (verified live: a freshly reset local node rejected
            // startLedger=1 with "must be within the ledger range: 7 - 137") — not always 1. On
            // this specific rejection, retry once against the RPC-reported minimum rather than
            // surfacing a spurious failure for what our own clamp under-shot.
            const rangeMatch = /must be within the ledger range:\s*(\d+)\s*-\s*(\d+)/i.exec(message);
            if (
                rangeMatch &&
                "startLedger" in request &&
                !("cursor" in request) &&
                request.startLedger !== Number(rangeMatch[1])
            ) {
                return await this.withTimeout(
                    this.server.getEvents({
                        filters: request.filters,
                        startLedger: Number(rangeMatch[1]),
                        limit: request.limit,
                    }),
                    "getEvents",
                );
            }
            if (/start.?ledger|out of range|retention|must be within/i.test(message)) {
                throw new StellarEventRetentionWindowExceeded(
                    `requested startLedger ${requestedStartLedger ?? "(cursor)"}: ${message}`,
                );
            }
            throw error;
        }
    }

    private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new StellarRPCCallTimedOut(label, DEFAULT_RPC_TIMEOUT_MS)), DEFAULT_RPC_TIMEOUT_MS);
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            clearTimeout(timer!);
        }
    }
}

function toHex(value: number | string | bigint): Hex {
    return `0x${BigInt(value).toString(16)}` as Hex;
}

/** The ledger a `getEvents` paging cursor ("<TOID>-<event index>") points into — a TOID's top 32 bits. */
function cursorLedger(cursor: string): number {
    return Number(BigInt(cursor.split("-")[0]) >> 32n);
}

/**
 * Decodes a confirmed transaction's own contract events (`result.events.contractEventsXdr`, one
 * array per operation — flattened since every call this SDK builds has exactly one) into the same
 * {@link StellarLog} shape {@link toStellarLog} produces from `getEvents` polling, so
 * `extractSpentNullifiers`/deposit-and-ragequit event decoders work identically regardless of
 * which path (a fresh receipt vs. a later `getEvents` scan) supplied them.
 *
 * `system`-level `transactionEventsXdr` (fee charges, etc.) are deliberately excluded — they carry
 * no `contractId`/domain topics a decoder could match against, mirroring `getEvents`'s own
 * contract-events-only filter.
 */
function contractEventsToStellarLogs(result: rpc.Api.GetSuccessfulTransactionResponse, hash: Hex): StellarLog[] {
    const ledgerClosedAt = new Date(result.createdAt * 1000).toISOString();
    const ledgerPadded = String(result.ledger).padStart(10, "0");
    return result.events.contractEventsXdr.flat().map((event, index) => {
        const v0 = event.body().v0();
        const contractId = event.contractId();
        return {
            id: `${ledgerPadded}-${String(index).padStart(10, "0")}`,
            type: decodeScValNameSafe(v0.topics()[0]),
            ledger: toHex(result.ledger),
            ledgerClosedAt,
            // xdr.Hash is a real Buffer at runtime despite its imprecise `Opaque[]` TS type (same
            // cast StellarPreparedTxVerifier's own contractId decode already relies on).
            contractId: contractId ? StrKey.encodeContract(contractId as unknown as Buffer) : "",
            topics: v0.topics().map((t) => t.toXDR("base64")),
            data: v0.data().toXDR("base64"),
            transactionHash: hash,
        };
    });
}

/**
 * A readable reason for a transaction that landed FAILED: the result code down to the operation
 * (e.g. `txFailed: invokeHostFunction/invokeHostFunctionTrapped`) plus the host's `error`
 * diagnostic events, which carry the actual cause (e.g. `sceAuth/scecInvalidAction: Unauthorized
 * function call for address G…`). `resultXdr` is a parsed object, so stringifying it directly gave
 * `[object Object]`. Never throws: a part that cannot be decoded is left out.
 */
function describeFailedTransaction(result: rpc.Api.GetFailedTransactionResponse): string {
    const parts: string[] = [];
    try {
        const txResult = result.resultXdr.result();
        const ops = (() => {
            try {
                return txResult.results().map((op) => {
                    const tr = op.tr();
                    const inner = (tr.value() as { switch?: () => { name: string } }).switch?.().name;
                    return inner ? `${tr.switch().name}/${inner}` : tr.switch().name;
                });
            } catch {
                return [];
            }
        })();
        parts.push(ops.length ? `${txResult.switch().name}: ${ops.join(", ")}` : txResult.switch().name);
    } catch {
        parts.push("unknown result");
    }
    const errors = new Set<string>();
    for (const diagnostic of result.diagnosticEventsXdr ?? []) {
        try {
            const body = diagnostic.event().body().v0();
            const [kind, code] = body.topics();
            if (kind?.switch().name !== "scvSymbol" || kind.sym().toString() !== "error" || !code) continue;
            const error = code.error();
            const detail =
                error.switch().name === "sceContract" ? `contract error ${error.contractCode()}` : `${error.switch().name}/${error.code().name}`;
            errors.add(`${detail}: ${describeScVal(body.data())}`);
        } catch {
            // An event that does not decode as an error event carries nothing useful here.
        }
    }
    if (errors.size) parts.push([...errors].slice(0, 3).join("; "));
    return parts.join(" — ");
}

/** A compact rendering of a diagnostic event's data, tolerant of values `scValToNative` rejects. */
function describeScVal(value: xdr.ScVal): string {
    try {
        return JSON.stringify(scValToNative(value), (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
        return value.switch().name;
    }
}

function toStellarLog(event: rpc.Api.EventResponse): StellarLog {
    const topics = event.topic.map((t) => t.toXDR("base64"));
    const eventName = decodeScValNameSafe(event.topic[0]);
    return {
        id: event.id,
        type: eventName,
        ledger: toHex(event.ledger),
        ledgerClosedAt: event.ledgerClosedAt,
        contractId: event.contractId?.toString() ?? "",
        topics,
        data: event.value.toXDR("base64"),
        // event.txHash is plain (unprefixed) hex, same underlying convention as
        // sendTransaction's hash — see submitTransaction's doc comment above.
        transactionHash: `0x${event.txHash}` as Hex,
    };
}

function decodeScValNameSafe(value: xdr.ScVal | undefined): string {
    if (!value) return "";
    try {
        return String(scValToNative(value));
    } catch {
        return "";
    }
}
