import type { Abi } from "viem";

import type {
    Address,
    IPreparedTxVerifier,
    PreparedTransaction,
    PreparedTxOperation,
    PreparedTxVerification,
} from "../../internal.js";
import {
    assertPreparedTxMatches,
    ENTRYPOINT_DEPOSIT_ABI,
    ERC20_APPROVE_ABI,
    KEYSTORE_WRITE_ABI,
    POOL_VAULT_RAGEQUIT_ABI,
    POOL_VAULT_TRANSACT_ABI,
    PP_RELAY_BATCH_ABI,
    UnexpectedTransactionTarget,
} from "../../internal.js";

/**
 * Resolves an opaque {@link PreparedTxOperation} to its concrete `{abi, functionName}` pair.
 * A function rather than a module-scope lookup table: `internal.js`'s barrel re-exports form a
 * circular graph, so a top-level object literal built from these ABI constants can capture
 * `undefined` if this module happens to load before `constant/ContractInteractor.ts`/
 * `constant/PoolSessionKeystore.ts` finish initializing. Reading them lazily, inside a function
 * body that only runs after the whole module graph has settled, sidesteps that ordering hazard
 * without needing a direct (non-barrel) import.
 */
function operationAbi(operation: PreparedTxOperation): { abi: Abi; functionName: string } {
    switch (operation) {
        case "deposit":
            return { abi: ENTRYPOINT_DEPOSIT_ABI, functionName: "deposit" };
        case "approve":
            return { abi: ERC20_APPROVE_ABI, functionName: "approve" };
        case "ragequit":
            return { abi: POOL_VAULT_RAGEQUIT_ABI, functionName: "ragequit" };
        case "transact":
            return { abi: POOL_VAULT_TRANSACT_ABI, functionName: "transact" };
        case "relayBatch":
            return { abi: PP_RELAY_BATCH_ABI, functionName: "relayBatch" };
        case "setAuthPolicy":
            return { abi: KEYSTORE_WRITE_ABI, functionName: "setAuthPolicy" };
        case "setViewingKey":
            return { abi: KEYSTORE_WRITE_ABI, functionName: "setViewingKey" };
        case "updateAuthPolicy":
            return { abi: KEYSTORE_WRITE_ABI, functionName: "updateAuthPolicy" };
    }
}

/**
 * The internal consistency a self-submit `relayBatch` call must have: no value, and every item
 * routes to the contract being called. A self-submit batch pays no relayer and funds no gas
 * top-up, so every item was built with a zero fee and zero nativeGas — any value attached is
 * value the caller did not intend to spend. Routing is bound into each proof and the vault checks
 * it on-chain, so this is the off-chain half of a check the chain also makes, not the only one.
 *
 * Deliberately self-contained: it reads the target out of the transaction rather than comparing
 * it against state held by the orchestrator that prepared the batch, so a prepared batch stays
 * transportable.
 *
 * @throws {UnexpectedTransactionTarget} If the batch carries value, carries no items, or any item
 *   routes elsewhere than `tx.to`.
 */
function assertSelfSubmitRelayBatch(tx: PreparedTransaction, args: readonly unknown[]): void {
    if (BigInt(tx.value) !== 0n) {
        throw new UnexpectedTransactionTarget(
            `self-submit batch carries value ${tx.value}, expected 0`,
        );
    }

    const transactParams = args[1] as readonly { processor: Address }[] | undefined;
    if (!transactParams || transactParams.length === 0) {
        throw new UnexpectedTransactionTarget("relayBatch calldata carries no transactParams");
    }
    for (const params of transactParams) {
        if (params.processor.toLowerCase() !== tx.to.toLowerCase()) {
            throw new UnexpectedTransactionTarget(
                `relayBatch item routes to processor ${params.processor}, but the transaction targets ${tx.to}`,
            );
        }
    }
}

/**
 * EVM implementation of {@link IPreparedTxVerifier} — delegates to the existing
 * `assertPreparedTxMatches` ABI-decode guard, resolving each opaque {@link PreparedTxOperation}
 * to its concrete `{abi, functionName}` pair. Extracted from what were previously direct,
 * un-injected calls in each `PoolSession*` orchestrator; behavior is unchanged, only relocated.
 */
export class EvmPreparedTxVerifier implements IPreparedTxVerifier {
    /** @inheritdoc IPreparedTxVerifier.assertMatches */
    assertMatches(
        tx: PreparedTransaction,
        expected: { to: Address; operation: PreparedTxOperation },
    ): PreparedTxVerification {
        const { abi, functionName } = operationAbi(expected.operation);
        const decoded = assertPreparedTxMatches(tx, { to: expected.to, abi, functionName });
        if (expected.operation === "relayBatch") {
            assertSelfSubmitRelayBatch(tx, decoded.args);
        }
        return { operation: expected.operation, args: decoded.args };
    }
}
