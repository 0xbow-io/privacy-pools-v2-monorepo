import { z } from "zod";
import type { Hex } from "viem";
import { MAX_BATCH } from "@privacy-pools-v2/core-sdk/batch-fee";
import { zNonNegativeBigInt, zHex } from "../../relayer.schemas";
import { zEvmAddress } from "../../config/evm/evm.config.schemas";
import {
    zSignedWithdrawalFeeCommitment,
    zSignedTransferFeeCommitment,
    zSignedBatchWithdrawalFeeCommitment,
    zSignedSwapFeeCommitment,
} from "../../quote/evm/evm.schemas";

// -========- Helper schemas -========-

const toHex = (v: bigint): Hex => `0x${v.toString(16)}`;

// A slippage/amount floor that MUST keep full precision. The shared
// `zNonNegativeBigInt` now enforces this itself (rejects unsafe JS numbers,
// parses strings losslessly) — this alias survives only to keep the schema
// below self-documenting.
const zPreciseNonNegativeBigInt = zNonNegativeBigInt;

// -========- Proof schemas -========-

const parsePubSignals = (s: bigint[][]) => ({
    nullifierHashes: s[0].map(toHex),
    outputCommitments: s[1].map(toHex),
    stateRoot: toHex(s[2][0]),
    keyRegistryRoot: toHex(s[3][0]),
    associationSetRoot: toHex(s[4][0]),
    amountOut: s[5][0],
    tokenIdOut: s[6][0],
    context: toHex(s[7][0]),
});

// Snarkjs proof format schema (for Swagger DTOs)
const zSnarkjsProofPair = z.tuple([zNonNegativeBigInt, zNonNegativeBigInt, zNonNegativeBigInt]);
const zSnarkjsProofMatrix = z.tuple([
    z.tuple([zNonNegativeBigInt, zNonNegativeBigInt]),
    z.tuple([zNonNegativeBigInt, zNonNegativeBigInt]),
    z.tuple([zNonNegativeBigInt, zNonNegativeBigInt]),
]);
const zSnarkjsPublicSignals = z.array(zNonNegativeBigInt).min(8);

const zSnarkjsProof = z.object({
    pi_a: zSnarkjsProofPair,
    pi_b: zSnarkjsProofMatrix,
    pi_c: zSnarkjsProofPair,
    publicSignals: zSnarkjsPublicSignals,
    protocol: z.string().optional(),
    curve: z.string().optional(),
});

// Transform snarkjs format to internal format (proof geometry only, publicSignals stay flat)
const transformSnarkjsProof = (proof: z.infer<typeof zSnarkjsProof>) => {
    const { pi_a, pi_b, pi_c, publicSignals } = proof;

    // Note: pi_b elements are swapped intentionally (snarkjs format quirk)
    const pA: [bigint, bigint] = [pi_a[0], pi_a[1]];
    const pB: [[bigint, bigint], [bigint, bigint]] = [
        [pi_b[0][1], pi_b[0][0]],
        [pi_b[1][1], pi_b[1][0]],
    ];
    const pC: [bigint, bigint] = [pi_c[0], pi_c[1]];

    return { pA, pB, pC, publicSignals };
};

export const zTransactProof = zSnarkjsProof.transform(transformSnarkjsProof);

// Reshape flat snarkjs publicSignals into the 2D layout expected by the contract
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

// -========- TransactParams schemas -========-

export const zTransactParams = z.object({
    processor: zEvmAddress,
    data: zHex,
});

// -========- NoteData schema -========-

export const zNoteData = z.object({
    hint: zHex,
    data: zHex,
});

// -========- Request schemas -========-

const zNullifierOrCommitment = z.number().int().positive();

const zBaseRelayRequest = z.object({
    proof: zTransactProof,
    inputNullifierNumber: zNullifierOrCommitment,
    outputCommitmentNumber: zNullifierOrCommitment,
    noteData: z.array(zNoteData),
});

const reshapeRequestProof = <T extends z.infer<typeof zBaseRelayRequest>>(req: T) => {
    const { pubSignals, parsedPubSignals } = reshapePublicSignals(
        req.proof.publicSignals,
        req.inputNullifierNumber,
        req.outputCommitmentNumber
    );
    return {
        ...req,
        proof: { pA: req.proof.pA, pB: req.proof.pB, pC: req.proof.pC, pubSignals, parsedPubSignals },
    };
};

export const zEvmRelayWithdrawalRequest = zBaseRelayRequest
    .extend({
        signedFeeCommitment: zSignedWithdrawalFeeCommitment,
        // Optional alternate transact processor (e.g. PPRouter). When absent,
        // the relayer uses the default PrivacyPoolRelay. Must be allowlisted.
        processorAddress: zEvmAddress.optional(),
        // Optional client-supplied slippage floor (in the UNDERLYING token) for the
        // PPRouter `withdrawToUnderlying` redeem leg. The relayer cannot derive this
        // itself — the fee commitment only binds pp-share amounts and there is no
        // redeem-rate quote here — so the client passes its own floor. Defaults to
        // 0n (no protection) when absent; ignored unless `processorAddress` is set
        // (code-review R1 SEC-2). Validated as a precision-safe bigint (decimal
        // string, or a safe JS integer): a JSON number above Number.MAX_SAFE_INTEGER
        // is pre-rounded by the JSON parser, which would silently weaken the floor,
        // so unsafe numbers are rejected (cubic finding [8]).
        minUnderlyingOut: zPreciseNonNegativeBigInt.optional(),
    })
    .superRefine(validatePublicSignalsLength)
    .transform(reshapeRequestProof);

// -========- Keystore registration schema -========-

// The keystore auth-policy registration leg of an atomic `registerAndRelay`.
// `account` is validated as an EVM address; the three uint256 fields (`authDigest`,
// `nullifyingKeyHash`, `deadline`) and the signature are validated as hex on the wire
// (0x-prefixed) and converted to the contract's uint256/bytes args at the chain-service
// layer. `deadline` bounds how long a signed-but-unsubmitted authorization stays usable
// (the contract enforces `block.timestamp <= deadline`, reverting Keystore_SignatureExpired).
// These fields are explicit keys on the schema so zod does NOT strip them — they must reach
// the on-chain call args unchanged.
export const zKeystoreRegistration = z.object({
    account: zEvmAddress,
    authDigest: zHex,
    nullifyingKeyHash: zHex,
    deadline: zHex,
    signature: zHex,
});

// A register-and-withdrawal request is an ordinary withdrawal relay request plus the
// nested `registration` object. It reuses the same proof reshape, publicSignals length
// refinement, and withdrawal fee commitment as `zEvmRelayWithdrawalRequest`; the
// registration transfers no value and its gas is absorbed by the withdrawal feeAmount, so
// it reuses the same fee quote verification. No processor/minUnderlyingOut — atomic
// register-and-withdraw over PPRouter (yield) is a deferred follow-up (INTL-05).
export const zEvmRelayRegisterAndWithdrawalRequest = zBaseRelayRequest
    .extend({
        signedFeeCommitment: zSignedWithdrawalFeeCommitment,
        registration: zKeystoreRegistration,
    })
    .superRefine(validatePublicSignalsLength)
    .transform(reshapeRequestProof);

// -========- Relay-and-announce announcement schema -========-

// The ERC-5564 stealth-payment announcement leg of an atomic `relayAndAnnounce`.
// `stealthAddress` is validated as an EVM address; `schemeId` is validated as hex
// on the wire (0x-prefixed) and converted to the contract's uint256 arg at the
// chain-service layer; `ephemeralPubKey` and `metadata` are opaque bytes passed
// straight through. These fields are explicit keys on the schema so zod does NOT
// strip them — they must reach the on-chain call args unchanged.
export const zAnnouncement = z.object({
    schemeId: zHex,
    stealthAddress: zEvmAddress,
    ephemeralPubKey: zHex,
    metadata: zHex,
});

// A relay-and-announce request is an ordinary withdrawal relay request plus the
// nested `announcement` object. It reuses the same proof reshape, publicSignals
// length refinement, and withdrawal fee commitment as `zEvmRelayWithdrawalRequest`;
// the announcement transfers no value (the withdrawal fee quote is reused for the
// relay leg exactly like register-and-withdrawal). Unlike withdrawal/register-and-withdrawal,
// it accepts NO processorAddress/minUnderlyingOut — stealth×yield is unsupported,
// so this endpoint is standard-relay only.
export const zEvmRelayAndAnnounceRequest = zBaseRelayRequest
    .extend({
        signedFeeCommitment: zSignedWithdrawalFeeCommitment,
        announcement: zAnnouncement,
    })
    .superRefine(validatePublicSignalsLength)
    .transform(reshapeRequestProof);

export const zEvmRelayTransferRequest = zBaseRelayRequest
    .extend({
        signedFeeCommitment: zSignedTransferFeeCommitment,
    })
    .superRefine(validatePublicSignalsLength)
    .transform(reshapeRequestProof);

// -========- Batch withdrawal request schema -========-

// One batch item: a transact proof + shapes, with its publicSignals validated
// and reshaped per item. The fee commitment is at the batch level, not per item.
const zEvmRelayBatchItem = zBaseRelayRequest
    .superRefine(validatePublicSignalsLength)
    .transform(reshapeRequestProof);

export const zEvmRelayBatchRequest = z.object({
    // Cap at MAX_BATCH: the contract rejects larger batches (BatchTooLarge), and
    // an unbounded array lets an unauthenticated request force O(N) decode/validate
    // work before the signature is checked (audit M-1).
    items: z.array(zEvmRelayBatchItem).min(1).max(MAX_BATCH),
    signedBatchFeeCommitment: zSignedBatchWithdrawalFeeCommitment,
});

// -========- Cross-chain-reshield dust-rescue opt-in -========-

// RC-10: dustRescue is NOT part of the relay request wire shape — it travelled here
// unsigned, with no anchor to the proof (a caller could attach an arbitrary, unpriced
// dustRescue block to an otherwise-ordinary committed swap). It is now encoded into the
// committed SwapRouting.dustRescue field at quote time (quote/evm/evm.schemas.ts's
// zDustRescue) and decoded straight off the executed, proof-bound routing at relay time
// (relay/evm/evm.relay.service.ts) — see docs/tech-design/sdk/withdraw-and-swap.md
// §Cross-Chain Reshield for the trust extension this implies.
export const zEvmRelaySwapRequest = zBaseRelayRequest
    .extend({
        signedSwapCommitment: zSignedSwapFeeCommitment,
    })
    .superRefine(validatePublicSignalsLength)
    .transform(reshapeRequestProof);

// -========- Response schemas -========-

export const zEvmRelayResponse = z.object({
    txHash: zHex,
    error: z.string().optional(),
    // Only ever set by relaySwap when the request opted into dustRescue: the on-chain
    // relay-swap succeeded (txHash above is real and final) but the dust-rescue job
    // couldn't be priced/registered for automatic tracking — distinct from `error`,
    // which callers reasonably treat as "the whole operation failed" and might retry
    // (a real risk here: retrying spends a note that's already spent). Absent/undefined
    // on every other endpoint and on a fully successful relaySwap.
    dustRescueWarning: z.string().optional(),
});
