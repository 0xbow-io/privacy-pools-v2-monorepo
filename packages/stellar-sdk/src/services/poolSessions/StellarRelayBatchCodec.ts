import type {
    IRelayBatchCodec,
    IStellarRPCInteractor,
    RelayBatchEncodeItem,
    StellarAddress,
    StellarProof,
    StellarRelayBatchCodecConfig,
} from "../../internal.js";
import {
    addressScVal,
    groth16ProofScVal,
    noteDataScVal,
    StellarPayoutRoutingCodec,
    structScVal,
    u128ScVal,
    u256ScVal,
    u32ScVal,
    vecScVal,
} from "../../internal.js";

/**
 * Stellar implementation of {@link IRelayBatchCodec}: builds (and simulates) the relay contract's
 * `relay_batch(relayer, asset, items)` for a self-submitted batch withdrawal.
 *
 * The submitting account is the `relayer` (it authorizes the call and pays the resource fee), each
 * item is the contract's `BatchItem` struct, and each item's `routing` is the `PayoutRouting` its
 * proof already committed to — decoded from the item's `transactParams.data` with the same codec
 * that encoded it, since `relay_batch` takes the struct and re-derives the bytes itself.
 */
export class StellarRelayBatchCodec implements IRelayBatchCodec<string, StellarAddress, StellarProof> {
    private readonly rpcInteractor: IStellarRPCInteractor;
    private readonly sourceAddress: StellarAddress;
    private readonly payoutRoutingCodec = new StellarPayoutRoutingCodec();

    constructor(config: StellarRelayBatchCodecConfig) {
        this.rpcInteractor = config.rpcInteractor;
        this.sourceAddress = config.sourceAddress;
    }

    /** @inheritdoc IRelayBatchCodec.encodeRelayBatch */
    async encodeRelayBatch(
        relayAddress: StellarAddress,
        items: RelayBatchEncodeItem<StellarAddress, StellarProof>[],
        asset: StellarAddress,
    ): Promise<string> {
        const batchItems = items.map((item) => {
            // [nullifiers, commitments, [stateRoot], [keystoreRoot], [aspRoot], [amountOut], [tokenIdOut], [context]]
            const [nullifiers, commitments, [stateRoot], [keystoreRoot], [aspRoot], [amountOut], [tokenIdOut]] =
                item.pubSignals as [bigint[], bigint[], [bigint], [bigint], [bigint], [bigint], [bigint]];
            const routing = this.payoutRoutingCodec.decode(item.transactParams.data);
            return structScVal({
                n: u32ScVal(nullifiers.length),
                m: u32ScVal(commitments.length),
                proof: groth16ProofScVal(item.proof),
                state_root: u256ScVal(stateRoot),
                keystore_root: u256ScVal(keystoreRoot),
                asp_root: u256ScVal(aspRoot),
                amount_out: u128ScVal(amountOut),
                token_id_out: u256ScVal(tokenIdOut),
                nullifier_hashes: vecScVal(nullifiers.map((h) => u256ScVal(h))),
                output_commitments: vecScVal(commitments.map((c) => u256ScVal(c))),
                note_data: vecScVal(item.noteData.map((nd) => noteDataScVal(nd))),
                routing: structScVal({
                    recipient: addressScVal(routing.recipient),
                    fee_recipient: addressScVal(routing.feeRecipient),
                    fee_amount: u128ScVal(routing.feeAmount),
                }),
            });
        });

        return this.rpcInteractor.buildTransaction(
            relayAddress,
            "relay_batch",
            [addressScVal(this.sourceAddress), addressScVal(asset), vecScVal(batchItems)],
            this.sourceAddress,
        );
    }
}
