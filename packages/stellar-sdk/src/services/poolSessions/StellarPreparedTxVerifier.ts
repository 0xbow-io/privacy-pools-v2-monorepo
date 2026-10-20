import { scValToNative, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

import type {
    IPreparedTxVerifier,
    PreparedTxOperation,
    PreparedTxVerification,
    StellarAddress,
    StellarPreparedTxVerifierConfig,
} from "../../internal.js";
import { stellarErrorMessage, UnexpectedTransactionTarget } from "../../internal.js";

/**
 * Resolves an opaque {@link PreparedTxOperation} to the pool/keystore contract's Rust function
 * name. "approve" has no Stellar counterpart (SEP-41 tokens have no allowance/approve step —
 * see `StellarEntrypointChainAdapter.encodeApprove`, which throws rather than encode one).
 */
function operationFunctionName(operation: PreparedTxOperation): string {
    switch (operation) {
        case "deposit":
            return "deposit";
        case "ragequit":
            return "ragequit";
        case "transact":
            return "transact";
        case "setAuthPolicy":
            return "set_auth_policy";
        case "setViewingKey":
            return "set_viewing_key";
        case "updateAuthPolicy":
            return "update_auth_policy";
        case "approve":
            throw new UnexpectedTransactionTarget(
                "approve is not a valid Stellar operation: SEP-41 tokens have no allowance/approve step",
            );
        case "relayBatch":
            return "relay_batch";
    }
}

/**
 * Stellar implementation of {@link IPreparedTxVerifier} — parses the unsigned transaction XDR
 * back into its `InvokeHostFunction` operation and checks the invoked contract ID and function
 * name before the transaction is handed to a wallet for signing. Same defense as EVM's
 * `assertPreparedTxMatches`: a tampered/attacker-supplied `PrepareXResult` could otherwise carry
 * an arbitrary contract call, and the execute step would sign it blindly.
 */
export class StellarPreparedTxVerifier implements IPreparedTxVerifier<string, StellarAddress> {
    private readonly networkPassphrase: string;

    constructor(config: StellarPreparedTxVerifierConfig) {
        this.networkPassphrase = config.networkPassphrase;
    }

    /**
     * @inheritdoc IPreparedTxVerifier.assertMatches
     * @throws {UnexpectedTransactionTarget} If `tx` doesn't invoke exactly one contract function,
     *   targets a different contract, or calls a different function than expected.
     */
    assertMatches(
        tx: string,
        expected: { to: StellarAddress; operation: PreparedTxOperation },
    ): PreparedTxVerification {
        const expectedFunctionName = operationFunctionName(expected.operation);

        let parsed;
        try {
            parsed = TransactionBuilder.fromXDR(tx, this.networkPassphrase);
        } catch (error) {
            throw new UnexpectedTransactionTarget(
                `failed to parse transaction XDR: ${stellarErrorMessage(error)}`,
            );
        }

        if (!("operations" in parsed) || parsed.operations.length !== 1) {
            throw new UnexpectedTransactionTarget(
                "expected exactly one operation in the prepared transaction",
            );
        }

        const [operation] = parsed.operations;
        if (operation.type !== "invokeHostFunction" || operation.func.switch().name !== "hostFunctionTypeInvokeContract") {
            throw new UnexpectedTransactionTarget(
                `expected an InvokeHostFunction contract call, got operation type "${operation.type}"`,
            );
        }

        const invoke = operation.func.invokeContract();
        const contractAddress = invoke.contractAddress();
        if (contractAddress.switch().name !== "scAddressTypeContract") {
            throw new UnexpectedTransactionTarget("expected the call target to be a contract address");
        }
        // xdr.Hash is a real Buffer at runtime despite its imprecise `Opaque[]` TS type.
        const contractId = StrKey.encodeContract(contractAddress.contractId() as unknown as Buffer);
        if (contractId !== expected.to) {
            throw new UnexpectedTransactionTarget(
                `transaction targets ${contractId}, expected ${expected.to}`,
            );
        }

        const functionName = invoke.functionName().toString();
        // `deposit_with_label` is `deposit` plus the ASP label registration in one invocation.
        const acceptsLabelled = expectedFunctionName === "deposit" && functionName === "deposit_with_label";
        if (functionName !== expectedFunctionName && !acceptsLabelled) {
            throw new UnexpectedTransactionTarget(
                `transaction calls "${functionName}", expected "${expectedFunctionName}"`,
            );
        }

        const args = invoke.args().map((arg) => scValToNative(arg));
        return {
            operation: expected.operation,
            // Every Stellar contract call needs the acting account explicit (Soroban's
            // `require_auth()` has no implicit msg.sender), so `update_auth_policy`'s Rust
            // signature is `(owner, old_auth_digest, new_auth_digest, siblings)` — one arg ahead
            // of EVM's `updateAuthPolicy(oldAuthDigest, newAuthDigest, siblingNodes)`, which has
            // no such param (implicit via msg.sender). `PoolSessionKeystore.executeRotateRevocableKey`
            // is shared core-sdk code that destructures `args` positionally against EVM's shape
            // (`[oldDigestWord, newDigestWord] = decoded.args`), so the leading owner is dropped
            // here to match — confirmed live: without this, `newDigestWord` was actually
            // `oldAuthDigest`'s value, and rotation always failed `RotationKeyMismatch`.
            args: expected.operation === "updateAuthPolicy" ? args.slice(1) : args,
        };
    }
}
