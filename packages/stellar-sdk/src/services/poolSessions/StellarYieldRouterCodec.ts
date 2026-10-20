import { scValToNative, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Transaction, xdr } from "@stellar/stellar-sdk";

import type {
    IStellarRPCInteractor,
    IYieldRouterCodec,
    StellarAddress,
    StellarYieldRouterCodecConfig,
    YieldDeploymentConfig,
} from "../../internal.js";
import {
    addressScVal,
    bufferToHex,
    bytesScVal,
    i128ScVal,
    InvalidYieldAmount,
    StellarPayoutRoutingCodec,
    stellarErrorMessage,
    structScVal,
    u128ScVal,
    UnexpectedDepositCalldata,
    UnexpectedWithdrawCalldata,
} from "../../internal.js";

/** One parsed `InvokeHostFunction(InvokeContract)` operation. */
interface ParsedInvocation {
    source: string;
    contractId: string;
    functionName: string;
    args: xdr.ScVal[];
}

/**
 * Soroban implementation of {@link IYieldRouterCodec}: lifts the arguments out of the pool call a
 * yield session built — `deposit`/`deposit_with_label` or `transact` — and rebuilds (and
 * simulates) the router's `deposit_exact_shares` / `withdraw_to_underlying` around them. The proof,
 * note data and every value the proof commits to are reused verbatim as ScVals, so the context the
 * pool recomputes is unchanged.
 *
 * `withdraw_to_underlying` takes the `PayoutRouting` struct rather than the encoded
 * `processor_data` bytes (the router re-derives them — see its doc), so the routing is decoded
 * from the transact's `processor_data` with the same codec that encoded it.
 *
 * Funding is always empty: SEP-41 transfers are authorized by the depositor's signature on the
 * router call itself, with no allowance step.
 */
export class StellarYieldRouterCodec implements IYieldRouterCodec<string, StellarAddress> {
    private readonly rpcInteractor: IStellarRPCInteractor;
    private readonly networkPassphrase: string;
    private readonly payoutRoutingCodec: StellarPayoutRoutingCodec;

    constructor(config: StellarYieldRouterCodecConfig) {
        this.rpcInteractor = config.rpcInteractor;
        this.networkPassphrase = config.networkPassphrase;
        this.payoutRoutingCodec = new StellarPayoutRoutingCodec();
    }

    /**
     * @inheritdoc IYieldRouterCodec.encodeDepositExactShares
     * @throws {UnexpectedDepositCalldata} When `depositTx` is not a pool deposit of the share token
     *   for exactly `sharesValue`.
     */
    async encodeDepositExactShares(
        depositTx: string,
        args: { deployment: YieldDeploymentConfig<StellarAddress>; sharesValue: bigint; maxUnderlyingIn: bigint },
    ): Promise<string> {
        const call = this.parse(depositTx, (reason) => new UnexpectedDepositCalldata(reason));
        if (call.functionName !== "deposit" && call.functionName !== "deposit_with_label") {
            throw new UnexpectedDepositCalldata(`expected pool deposit, decoded ${call.functionName}`);
        }
        // deposit(depositor, asset, value, output_commitment, proof, note_data[, ciphertext])
        const [depositor, asset, value, outputCommitment, proof, noteData, ciphertext] = call.args;
        if (!depositor || !asset || !value || !outputCommitment || !proof || !noteData) {
            throw new UnexpectedDepositCalldata(`deposit carries ${call.args.length} arguments, expected 6 or 7`);
        }
        if (scValToNative(asset) !== args.deployment.shareToken) {
            throw new UnexpectedDepositCalldata(
                `deposit is for ${String(scValToNative(asset))}, expected share token ${args.deployment.shareToken}`,
            );
        }
        if (BigInt(scValToNative(value) as bigint) !== args.sharesValue) {
            throw new UnexpectedDepositCalldata(
                `deposit value ${String(scValToNative(value))} does not match the requested shares ${args.sharesValue}`,
            );
        }

        // deposit_exact_shares(from, value, output_commitment, proof, note_data, asp_ciphertext,
        // max_underlying_in). An empty ciphertext skips registration, as it does upstream.
        return this.rpcInteractor.buildTransaction(
            args.deployment.router,
            "deposit_exact_shares",
            [
                depositor,
                value,
                outputCommitment,
                proof,
                noteData,
                ciphertext ?? bytesScVal("0x"),
                i128ScVal(args.maxUnderlyingIn),
            ],
            call.source,
        );
    }

    /** @inheritdoc IYieldRouterCodec.planDepositFunding */
    async planDepositFunding(): Promise<string[]> {
        return [];
    }

    /**
     * @inheritdoc IYieldRouterCodec.encodeWithdrawToUnderlying
     * @throws {InvalidYieldAmount} When `nativeGas` is non-zero (Stellar's routing has no gas leg).
     * @throws {UnexpectedWithdrawCalldata} When `transactTx` is not a pool transact of the share
     *   token processed by the router.
     */
    async encodeWithdrawToUnderlying(
        transactTx: string,
        args: { deployment: YieldDeploymentConfig<StellarAddress>; minUnderlyingOut: bigint; nativeGas: bigint },
    ): Promise<string> {
        if (args.nativeGas !== 0n) {
            throw new InvalidYieldAmount(
                `nativeGas ${args.nativeGas} is not supported on Stellar: PayoutRouting has no native-gas leg`,
            );
        }
        const call = this.parse(transactTx, (reason) => new UnexpectedWithdrawCalldata(reason));
        if (call.functionName !== "transact") {
            throw new UnexpectedWithdrawCalldata(`expected pool transact, decoded ${call.functionName}`);
        }
        // transact(processor, processor_gated, n, m, proof, state_root, keystore_root, asp_root,
        //          amount_out, token_id_out, nullifiers, commitments, asset, note_data, processor_data)
        if (call.args.length !== 15) {
            throw new UnexpectedWithdrawCalldata(`transact carries ${call.args.length} arguments, expected 15`);
        }
        const arg = (i: number): xdr.ScVal => call.args[i] as xdr.ScVal;
        const processor = scValToNative(arg(0)) as unknown;
        if (processor !== args.deployment.router) {
            throw new UnexpectedWithdrawCalldata(
                `transact processor ${String(processor)} is not the router ${args.deployment.router}`,
            );
        }
        const asset = scValToNative(arg(12)) as unknown;
        if (asset !== args.deployment.shareToken) {
            throw new UnexpectedWithdrawCalldata(
                `transact asset ${String(asset)} is not the share token ${args.deployment.shareToken}`,
            );
        }

        let routing;
        try {
            routing = this.payoutRoutingCodec.decode(bufferToHex(scValToNative(arg(14)) as Uint8Array));
        } catch (error) {
            throw new UnexpectedWithdrawCalldata(`transact processor_data is not a PayoutRouting: ${stellarErrorMessage(error)}`);
        }

        return this.rpcInteractor.buildTransaction(
            args.deployment.router,
            "withdraw_to_underlying",
            [
                // n, m, proof, state_root, keystore_root, asp_root, amount_out, token_id_out,
                // nullifiers, commitments — verbatim; then note_data (13), the routing, the floor.
                ...call.args.slice(2, 12),
                arg(13),
                structScVal({
                    recipient: addressScVal(routing.recipient),
                    fee_recipient: addressScVal(routing.feeRecipient),
                    fee_amount: u128ScVal(routing.feeAmount),
                }),
                i128ScVal(args.minUnderlyingOut),
            ],
            call.source,
        );
    }

    private parse(tx: string, fail: (reason: string) => Error): ParsedInvocation {
        let parsed;
        try {
            parsed = TransactionBuilder.fromXDR(tx, this.networkPassphrase);
        } catch (error) {
            throw fail(`failed to parse transaction XDR: ${stellarErrorMessage(error)}`);
        }
        if (!("operations" in parsed) || parsed.operations.length !== 1) {
            throw fail("expected exactly one operation");
        }
        const [operation] = parsed.operations;
        if (operation?.type !== "invokeHostFunction" || operation.func.switch().name !== "hostFunctionTypeInvokeContract") {
            throw fail(`expected an InvokeHostFunction contract call, got "${String(operation?.type)}"`);
        }
        const invoke = operation.func.invokeContract();
        const address = invoke.contractAddress();
        if (address.switch().name !== "scAddressTypeContract") {
            throw fail("expected the call target to be a contract");
        }
        return {
            source: (parsed as Transaction).source,
            contractId: StrKey.encodeContract(address.contractId() as unknown as Buffer),
            functionName: invoke.functionName().toString(),
            args: invoke.args(),
        };
    }
}
