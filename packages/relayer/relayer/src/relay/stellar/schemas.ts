import { z } from "zod";
import { zNonNegativeBigInt, zHex } from "../../relayer.schemas";
import {
    STELLAR_MAX_BATCH,
    zStellarSignedBatchFeeCommitment,
    zStellarSignedTransferFeeCommitment,
    zStellarSignedWithdrawalFeeCommitment,
} from "../../quote/stellar/schemas";
import { zStellarAddress } from "../../config/stellar/stellar.config.schemas";

// -========- Proof schemas -========-

// Stellar's proof is already `{a, b, c}` byte-string form on the wire (the client formats it via
// StellarProofService.formatForChain before sending — no snarkjs pi_a/pi_b/pi_c geometry swap
// quirk to undo here, unlike EVM's zSnarkjsProof transform).
const zStellarRawProof = z.object({
    a: zHex,
    b: zHex,
    c: zHex,
    publicSignals: z.array(zNonNegativeBigInt).min(6),
});

const parsePubSignals = (s: bigint[][]) => ({
    nullifierHashes: s[0],
    outputCommitments: s[1],
    stateRoot: s[2][0],
    keystoreRoot: s[3][0],
    aspRoot: s[4][0],
    amountOut: s[5][0],
    tokenIdOut: s[6][0],
    context: s[7][0],
});

// Reshape flat publicSignals into the 2D layout used internally (mirrors relay/evm/schemas.ts's
// identical reshape, field-renamed for Stellar's param names: keystoreRoot not keyRegistryRoot,
// aspRoot not associationSetRoot).
function reshapePublicSignals(flat: bigint[], nInputs: number, mOutputs: number) {
    const nullifiers = flat.slice(0, nInputs);
    const commitments = flat.slice(nInputs, nInputs + mOutputs);
    const scalars = flat.slice(nInputs + mOutputs);

    const pubSignals: bigint[][] = [
        nullifiers,
        commitments,
        [scalars[0]],
        [scalars[1]],
        [scalars[2]],
        [scalars[3]],
        [scalars[4]],
        [scalars[5]],
    ];
    const parsedPubSignals = parsePubSignals(pubSignals);
    return { pubSignals, parsedPubSignals };
}

const FIXED_SCALAR_COUNT = 6; // stateRoot, keystoreRoot, aspRoot, amountOut, tokenIdOut, context

const validatePublicSignalsLength = (
    req: { proof: { publicSignals: bigint[] }; inputNullifierNumber: number; outputCommitmentNumber: number },
    ctx: z.RefinementCtx
) => {
    const expected = req.inputNullifierNumber + req.outputCommitmentNumber + FIXED_SCALAR_COUNT;
    if (req.proof.publicSignals.length !== expected) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Expected ${expected} publicSignals (${req.inputNullifierNumber} nullifiers + ${req.outputCommitmentNumber} commitments + ${FIXED_SCALAR_COUNT} scalars), got ${req.proof.publicSignals.length}`,
            path: ["proof", "publicSignals"],
        });
    }
};

// -========- NoteData schema -========-

export const zStellarNoteData = z.object({
    hint: zHex,
    data: zHex,
});

// -========- Withdrawal request schema -========-

const zNullifierOrCommitment = z.number().int().positive();

const zBaseStellarRelayRequest = z.object({
    proof: zStellarRawProof,
    inputNullifierNumber: zNullifierOrCommitment,
    outputCommitmentNumber: zNullifierOrCommitment,
    noteData: z.array(zStellarNoteData),
});

const reshapeRequestProof = <T extends z.infer<typeof zBaseStellarRelayRequest>>(req: T) => {
    const { pubSignals, parsedPubSignals } = reshapePublicSignals(
        req.proof.publicSignals,
        req.inputNullifierNumber,
        req.outputCommitmentNumber
    );
    return {
        ...req,
        proof: { a: req.proof.a, b: req.proof.b, c: req.proof.c, pubSignals, parsedPubSignals },
    };
};

export const zStellarRelayWithdrawalRequest = zBaseStellarRelayRequest
    .extend({
        signedFeeCommitment: zStellarSignedWithdrawalFeeCommitment,
        // A yield withdrawal names the share's `yield-router` as processor (it must be the
        // `yield_router` configured for the committed asset) and carries the recipient's slippage
        // floor in the UNDERLYING, which the relayer cannot derive — the commitment binds shares only.
        processorAddress: zStellarAddress.optional(),
        minUnderlyingOut: zNonNegativeBigInt.optional(),
    })
    .superRefine(validatePublicSignalsLength)
    .transform(reshapeRequestProof);

// -========- Register-and-withdrawal request schema -========-

/**
 * The owner's registration: the keystore fields and, as `signature`, the owner's SIGNED Soroban auth
 * entry (hex of its XDR) over the keystore's nested `set_auth_policy(account, nullifyingKeyHash,
 * authDigest)`. `deadline` is informational here — the entry's own expiry ledger is what binds.
 */
const zStellarRelayedRegistration = z.object({
    account: zStellarAddress,
    authDigest: zHex,
    nullifyingKeyHash: zHex,
    deadline: zHex,
    signature: zHex,
});

export const zStellarRelayRegisterAndWithdrawalRequest = zBaseStellarRelayRequest
    .extend({
        signedFeeCommitment: zStellarSignedWithdrawalFeeCommitment,
        registration: zStellarRelayedRegistration,
    })
    .superRefine(validatePublicSignalsLength)
    .transform(reshapeRequestProof);

// -========- Transfer request schema -========-

export const zStellarRelayTransferRequest = zBaseStellarRelayRequest
    .extend({ signedFeeCommitment: zStellarSignedTransferFeeCommitment })
    .superRefine(validatePublicSignalsLength)
    .transform(reshapeRequestProof);

// -========- Batch request schema -========-

const zStellarRelayBatchItem = zBaseStellarRelayRequest.superRefine(validatePublicSignalsLength).transform(reshapeRequestProof);

export const zStellarRelayBatchRequest = z.object({
    // Capped at the contract's MAX_BATCH before any per-item work (EVM audit M-1).
    items: z.array(zStellarRelayBatchItem).min(1).max(STELLAR_MAX_BATCH),
    signedBatchFeeCommitment: zStellarSignedBatchFeeCommitment,
});

// -========- Response schema -========-

export const zStellarRelayResponse = z.object({
    txHash: zHex,
    error: z.string().optional(),
});

// -========- Not-implemented placeholder -========-

// Every other relay operation (registerAndWithdrawal, relayAndAnnounce, transfer,
// batchWithdrawal, relaySwap) has no Stellar wire shape — see the Stellar plan's Scope section
// for why each is confirmed architecturally absent on-chain, not merely unbuilt.
export const zStellarRelayNotImplemented = z.object({}).passthrough();
