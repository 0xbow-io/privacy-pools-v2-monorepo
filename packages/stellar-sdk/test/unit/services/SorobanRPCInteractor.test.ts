import { Account, Keypair, rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Hash } from "../../../src/internal.js";
import {
    SorobanRPCInteractor,
    StellarSimulationFailed,
    StellarTransactionFailed,
    StellarTransactionTimedOut,
    WalletSendTransactionFailed,
} from "../../../src/internal.js";

const RPC_URL = "http://localhost:8000/rpc";
const NETWORK_PASSPHRASE = "Standalone Network ; February 2017";
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 1));
const SOURCE_PUBLIC_KEY = Keypair.random().publicKey();
const TX_HASH = `0x${"ab".repeat(32)}` as Hash;

/** A `SimulateTransactionErrorResponse` shape, as `rpc.Api.isSimulationError` recognizes it. */
function simulationErrorResponse(error: string): rpc.Api.SimulateTransactionResponse {
    return {
        id: "1",
        latestLedger: 100,
        events: [],
        error,
        _parsed: true,
    } as unknown as rpc.Api.SimulateTransactionResponse;
}

/** Builds a real `xdr.ContractEvent` the way a Soroban host actually emits one. */
function buildContractEvent(eventName: string, dataValue: bigint, contractId: string = CONTRACT_ID): xdr.ContractEvent {
    const body = new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
            topics: [xdr.ScVal.scvSymbol(eventName)],
            data: xdr.ScVal.scvU64(xdr.Uint64.fromString(dataValue.toString())),
        }),
    );
    return new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        // xdr.Hash's TS type (`Opaque[]`) doesn't match the real runtime Buffer it needs — same
        // cast StellarPreparedTxVerifier relies on for the reverse (decode) direction.
        contractId: Buffer.from(StrKey.decodeContract(contractId)) as unknown as xdr.Hash,
        type: xdr.ContractEventType.contract(),
        body,
    });
}

function successResponse(overrides: Partial<rpc.Api.GetSuccessfulTransactionResponse> = {}) {
    return {
        status: "SUCCESS" as const,
        ledger: 100,
        createdAt: 1_700_000_000,
        txHash: TX_HASH.slice(2),
        events: { contractEventsXdr: [[]], transactionEventsXdr: [] },
        ...overrides,
    } as rpc.Api.GetSuccessfulTransactionResponse;
}

/** `{"fee_charged":"749473","result":{"tx_failed":[{"op_inner":{"invoke_host_function":"trapped"}}]}}`. */
const FAILED_RESULT_XDR = "AAAAAAALb6H/////AAAAAQAAAAAAAAAY/////gAAAAA=";

describe("SorobanRPCInteractor", () => {
    let interactor: SorobanRPCInteractor;
    let getTransactionSpy: MockInstance<Parameters<rpc.Server["getTransaction"]>, ReturnType<rpc.Server["getTransaction"]>>;
    let simulateTransactionSpy: MockInstance<
        Parameters<rpc.Server["simulateTransaction"]>,
        ReturnType<rpc.Server["simulateTransaction"]>
    >;

    beforeEach(() => {
        interactor = new SorobanRPCInteractor({ rpcUrl: RPC_URL, networkPassphrase: NETWORK_PASSPHRASE });
        getTransactionSpy = vi.spyOn(rpc.Server.prototype, "getTransaction");
        vi.spyOn(rpc.Server.prototype, "getAccount").mockResolvedValue(new Account(SOURCE_PUBLIC_KEY, "1"));
        simulateTransactionSpy = vi.spyOn(rpc.Server.prototype, "simulateTransaction");
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe("waitForTransactionReceipt", () => {
        it("decode a confirmed transaction's own contract events into StellarLog entries", async () => {
            const event = buildContractEvent("Transacted", 42n);
            getTransactionSpy.mockResolvedValue(successResponse({ events: { contractEventsXdr: [[event]], transactionEventsXdr: [] } }));

            const receipt = await interactor.waitForTransactionReceipt(TX_HASH);

            expect(receipt.status).toBe(true);
            expect(receipt.logs).toHaveLength(1);
            const [log] = receipt.logs;
            expect(log.type).toBe("Transacted");
            expect(log.contractId).toBe(CONTRACT_ID);
            expect(log.transactionHash).toBe(TX_HASH);
            expect(log.ledger).toBe("0x64");
            expect(scValToNative(xdr.ScVal.fromXDR(log.data, "base64"))).toBe(42n);
        });

        it("flatten contract events across every operation in the transaction", async () => {
            const eventA = buildContractEvent("Deposited", 1n);
            const eventB = buildContractEvent("Transacted", 2n);
            getTransactionSpy.mockResolvedValue(
                successResponse({ events: { contractEventsXdr: [[eventA], [eventB]], transactionEventsXdr: [] } }),
            );

            const receipt = await interactor.waitForTransactionReceipt(TX_HASH);

            expect(receipt.logs.map((log) => log.type)).toEqual(["Deposited", "Transacted"]);
        });

        it("report an empty contractId as an empty string rather than throwing", async () => {
            const body = new xdr.ContractEventBody(
                0,
                new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol("Foo")], data: xdr.ScVal.scvVoid() }),
            );
            const event = new xdr.ContractEvent({
                ext: new xdr.ExtensionPoint(0),
                contractId: null,
                type: xdr.ContractEventType.system(),
                body,
            });
            getTransactionSpy.mockResolvedValue(successResponse({ events: { contractEventsXdr: [[event]], transactionEventsXdr: [] } }));

            const receipt = await interactor.waitForTransactionReceipt(TX_HASH);
            const [log] = receipt.logs;

            expect(log?.contractId).toBe("");
        });

        it("return an empty logs array when the transaction emitted no contract events", async () => {
            getTransactionSpy.mockResolvedValue(successResponse());

            const receipt = await interactor.waitForTransactionReceipt(TX_HASH);

            expect(receipt.logs).toEqual([]);
        });

        it("throw StellarTransactionFailed when the transaction lands FAILED", async () => {
            getTransactionSpy.mockResolvedValue({
                status: "FAILED",
                resultXdr: { toString: () => "failure-detail" },
            } as unknown as rpc.Api.GetFailedTransactionResponse);

            await expect(interactor.waitForTransactionReceipt(TX_HASH)).rejects.toThrow(StellarTransactionFailed);
        });

        it("name the failing operation and the host's error events in the StellarTransactionFailed message", async () => {
            // The real failure that motivated this: a yield deposit whose auth went stale.
            const resultXdr = xdr.TransactionResult.fromXDR(FAILED_RESULT_XDR, "base64");
            const errorEvent = new xdr.DiagnosticEvent({
                inSuccessfulContractCall: false,
                event: new xdr.ContractEvent({
                    ext: new xdr.ExtensionPoint(0),
                    contractId: null,
                    type: xdr.ContractEventType.diagnostic(),
                    body: new xdr.ContractEventBody(
                        0,
                        new xdr.ContractEventV0({
                            topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()))],
                            data: xdr.ScVal.scvString("Unauthorized function call for address"),
                        }),
                    ),
                }),
            });
            getTransactionSpy.mockResolvedValue({
                status: "FAILED",
                resultXdr,
                diagnosticEventsXdr: [errorEvent],
            } as unknown as rpc.Api.GetFailedTransactionResponse);

            const error = await interactor.waitForTransactionReceipt(TX_HASH).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(StellarTransactionFailed);
            expect((error as Error).message).toBe(
                "Transaction failed: txFailed: invokeHostFunction/invokeHostFunctionTrapped — " +
                    'sceAuth/scecInvalidAction: "Unauthorized function call for address"',
            );
        });

        it("re-check a pending transaction at the configured receiptPollIntervalMs", async () => {
            vi.useFakeTimers();
            const fast = new SorobanRPCInteractor({
                rpcUrl: RPC_URL,
                networkPassphrase: NETWORK_PASSPHRASE,
                receiptPollIntervalMs: 200,
            });
            getTransactionSpy
                .mockResolvedValueOnce({ status: "NOT_FOUND" } as unknown as rpc.Api.GetMissingTransactionResponse)
                .mockResolvedValue(successResponse());

            const pending = fast.waitForTransactionReceipt(TX_HASH);
            await vi.advanceTimersByTimeAsync(199);
            expect(getTransactionSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);

            expect((await pending).status).toBe(true);
            expect(getTransactionSpy).toHaveBeenCalledTimes(2);
        });

        it("throw StellarTransactionTimedOut when confirmation never arrives", async () => {
            vi.useFakeTimers();
            getTransactionSpy.mockResolvedValue({ status: "NOT_FOUND" } as unknown as rpc.Api.GetMissingTransactionResponse);

            const pending = expect(interactor.waitForTransactionReceipt(TX_HASH)).rejects.toThrow(
                StellarTransactionTimedOut,
            );
            await vi.advanceTimersByTimeAsync(61_000);
            await pending;

            vi.useRealTimers();
        });
    });

    describe("buildTransaction", () => {
        // Regression: every check the SDK can do locally (schema validation, config reads, the
        // local note manager's own status/value checks) has already run by the time a write
        // reaches this call, so a simulation failure here is Soroban's live-chain-state verdict on
        // submitting the transaction — the same thing a "send failed" error reports on a chain
        // whose RPC only learns this at actual broadcast time. Surfacing it as
        // WalletSendTransactionFailed (not the Stellar-only StellarSimulationFailed) means shared,
        // chain-agnostic core-sdk code doesn't have to special-case Stellar's prepare step.
        it("throw WalletSendTransactionFailed, not StellarSimulationFailed, when simulation reports an error", async () => {
            simulateTransactionSpy.mockResolvedValue(simulationErrorResponse("trustline entry is missing for account"));

            await expect(
                interactor.buildTransaction(CONTRACT_ID, "deposit", [], SOURCE_PUBLIC_KEY),
            ).rejects.toThrow(WalletSendTransactionFailed);
        });
    });

    describe("getEvents", () => {
        /** A `getEvents` paging cursor pointing into `ledger` (a TOID's top 32 bits). */
        function cursorAt(ledger: number): string {
            return `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-4294967295`;
        }

        function eventAt(ledger: number): rpc.Api.EventResponse {
            return {
                id: `${ledger}-0`,
                type: "contract",
                ledger,
                ledgerClosedAt: "2026-09-30T00:00:00Z",
                txHash: "ab".repeat(32),
                topic: [xdr.ScVal.scvSymbol("LeavesInserted")],
                value: xdr.ScVal.scvVoid(),
            } as unknown as rpc.Api.EventResponse;
        }

        function eventsPage(events: rpc.Api.EventResponse[], cursorLedger: number, latestLedger: number) {
            return { events, cursor: cursorAt(cursorLedger), latestLedger } as unknown as rpc.Api.GetEventsResponse;
        }

        it("start the scan at the requested ledger even when it is far behind the head", async () => {
            const getEventsSpy = vi
                .spyOn(rpc.Server.prototype, "getEvents")
                .mockResolvedValue(eventsPage([eventAt(10)], 80_000, 80_000));

            const result = await interactor.getEvents({ contractId: CONTRACT_ID, startLedger: "0xa" });

            expect(getEventsSpy.mock.calls[0][0]).toMatchObject({ startLedger: 10 });
            expect(result.events.map((event) => event.ledger)).toEqual(["0xa"]);
        });

        it("keep paging past a short page until the cursor reaches the head", async () => {
            // stellar-rpc caps the ledgers one request scans, so a page can come back short (here
            // one event, cursor at the end of the first window) long before the range is exhausted.
            const getEventsSpy = vi
                .spyOn(rpc.Server.prototype, "getEvents")
                .mockResolvedValueOnce(eventsPage([eventAt(10)], 10_010, 30_000))
                .mockResolvedValueOnce(eventsPage([], 20_010, 30_000))
                .mockResolvedValueOnce(eventsPage([eventAt(25_000)], 30_000, 30_000));

            const result = await interactor.getEvents({ contractId: CONTRACT_ID, startLedger: "0x1" });

            expect(getEventsSpy).toHaveBeenCalledTimes(3);
            expect(getEventsSpy.mock.calls[1][0]).toMatchObject({ cursor: cursorAt(10_010) });
            expect(result.events.map((event) => event.ledger)).toEqual(["0xa", "0x61a8"]);
        });

        it("retry at the RPC's oldest ledger when the requested start predates its retention", async () => {
            const getEventsSpy = vi
                .spyOn(rpc.Server.prototype, "getEvents")
                .mockRejectedValueOnce(new Error("startLedger must be within the ledger range: 7 - 80000"))
                .mockResolvedValueOnce(eventsPage([eventAt(7)], 80_000, 80_000));

            const result = await interactor.getEvents({ contractId: CONTRACT_ID, startLedger: "0x0" });

            expect(getEventsSpy.mock.calls[0][0]).toMatchObject({ startLedger: 1 });
            expect(getEventsSpy.mock.calls[1][0]).toMatchObject({ startLedger: 7 });
            expect(result.events).toHaveLength(1);
        });
    });

    describe("simulateRead", () => {
        it("still throw StellarSimulationFailed (not WalletSendTransactionFailed) when simulation reports an error", async () => {
            // A read's simulation failure (malformed view call, nonexistent contract) has nothing
            // to do with whether a write would later succeed — only buildTransaction's write path
            // re-throws as WalletSendTransactionFailed; a read keeps its own, real error type.
            simulateTransactionSpy.mockResolvedValue(simulationErrorResponse("nonexistent contract"));

            await expect(
                interactor.simulateRead(CONTRACT_ID, "get_asset_config", [], SOURCE_PUBLIC_KEY),
            ).rejects.toThrow(StellarSimulationFailed);
        });
    });
});
