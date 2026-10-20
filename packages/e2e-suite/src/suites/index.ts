import type { ChainE2E } from "../internal.js";
import type { SuiteName } from "./names.js";
import { aspApprovalSuite } from "./aspApproval.js";
import { aspHttpSuite } from "./aspHttp.js";
import { batchWithdrawSuite } from "./batchWithdraw.js";
import { depositSuite } from "./deposit.js";
import { discoverySuite } from "./discovery.js";
import { keystoreSuite } from "./keystore.js";
import { paymentRequestsSuite } from "./paymentRequests.js";
import { ragequitSuite } from "./ragequit.js";
import { relayerFaultsSuite } from "./relayerFaults.js";
import { transferSuite } from "./transfer.js";
import { withdrawSuite } from "./withdraw.js";
import { yieldSuite } from "./yield.js";

export * from "./names.js";
export * from "./aspApproval.js";
export * from "./aspHttp.js";
export * from "./batchWithdraw.js";
export * from "./yield.js";
export * from "./deposit.js";
export * from "./discovery.js";
export * from "./keystore.js";
export * from "./paymentRequests.js";
export * from "./ragequit.js";
export * from "./relayerFaults.js";
export * from "./transfer.js";
export * from "./withdraw.js";

/**
 * Every shared suite, by name. Each registers one operation's ladders for `chain`. Typed against
 * {@link SUITE_NAMES}, so the registry and the list can never drift.
 */
export const suites: Record<SuiteName, (chain: ChainE2E) => void> = {
    aspApproval: aspApprovalSuite,
    aspHttp: aspHttpSuite,
    batchWithdraw: batchWithdrawSuite,
    deposit: depositSuite,
    discovery: discoverySuite,
    keystore: keystoreSuite,
    paymentRequests: paymentRequestsSuite,
    ragequit: ragequitSuite,
    relayerFaults: relayerFaultsSuite,
    transfer: transferSuite,
    withdraw: withdrawSuite,
    yield: yieldSuite,
};
