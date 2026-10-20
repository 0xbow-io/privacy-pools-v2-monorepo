import { createZodDto } from "nestjs-zod";
import { ApiProperty } from "@nestjs/swagger";
import {
    zEvmRelayWithdrawalRequest,
    zEvmRelayRegisterAndWithdrawalRequest,
    zEvmRelayAndAnnounceRequest,
    zEvmRelayTransferRequest,
    zEvmRelayResponse,
    zEvmRelayBatchRequest,
    zEvmRelaySwapRequest,
} from "../relay/evm/schemas";
import type {
    ISignedWithdrawalFeeCommitment,
    ISignedTransferFeeCommitment,
    ISignedSwapFeeCommitment,
    IWithdrawalRelayRequest,
    ITransferRelayRequest,
    ISwapRelayRequest,
    IRegisterAndWithdrawalRelayRequest,
    IKeystoreRegistration,
    IRelayResponse,
} from "../relayer.types";
import { type NoteData, type ReshapedProof, type Announcement } from "../relay/evm/types";
import type { Hash } from "viem";
import { SignedTransferFeeCommitmentDto, SignedSwapFeeCommitmentDto, SignedWithdrawalFeeCommitmentDto } from "./evm.fee-commitment.dto";

export class WithdrawalRelayRequestDto
    extends createZodDto(zEvmRelayWithdrawalRequest)
    implements IWithdrawalRelayRequest
{
    @ApiProperty({
        description:
            "A SNARK proof obtained using the associated circuits, proving the user's address belongs in the ASP tree, the user's note's exist in the notes tree and the user owns the notes.",
    })
    declare proof: ReshapedProof;

    @ApiProperty({
        description: "Number of input nullifiers in the proof (N in transact_NxM).",
        example: 1,
    })
    declare inputNullifierNumber: number;

    @ApiProperty({
        description: "Number of output commitments in the proof (M in transact_NxM).",
        example: 1,
    })
    declare outputCommitmentNumber: number;

    @ApiProperty({
        description: "Note data for the transaction, containing hints and encrypted data.",
    })
    declare noteData: NoteData[];

    @ApiProperty({
        description:
            "A signed fee commitment from a previous quote response, in which a transaction price was committed to.",
        type: SignedWithdrawalFeeCommitmentDto,
    })
    declare signedFeeCommitment: ISignedWithdrawalFeeCommitment;

    @ApiProperty({
        description:
            "Optional alternate transact processor address (e.g. a PPRouter for yield withdrawals). " +
            "When omitted, the default PrivacyPoolRelay is used. Must be in the chain's allowed_processors allowlist.",
        required: false,
        example: "0x7C7c871FBeB28f90a85D47868AA5245F370E142F",
    })
    declare processorAddress?: `0x${string}`;

    @ApiProperty({
        description:
            "Optional client-supplied slippage floor for the PPRouter redeem leg, in the " +
            "UNDERLYING token (e.g. USDC). Only used when processorAddress is set. When omitted, " +
            "defaults to 0 (no slippage protection on the redeem leg).",
        required: false,
        type: "string",
        example: "990000",
    })
    declare minUnderlyingOut?: bigint;
}

export class RegisterAndWithdrawalRelayRequestDto
    extends createZodDto(zEvmRelayRegisterAndWithdrawalRequest)
    implements IRegisterAndWithdrawalRelayRequest
{
    @ApiProperty({
        description:
            "A SNARK proof obtained using the associated circuits, proving the user's address belongs in the ASP tree, the user's note's exist in the notes tree and the user owns the notes. Must be proven against the predicted post-registration keystore root.",
    })
    declare proof: ReshapedProof;

    @ApiProperty({
        description: "Number of input nullifiers in the proof (N in transact_NxM).",
        example: 1,
    })
    declare inputNullifierNumber: number;

    @ApiProperty({
        description: "Number of output commitments in the proof (M in transact_NxM).",
        example: 1,
    })
    declare outputCommitmentNumber: number;

    @ApiProperty({
        description: "Note data for the transaction, containing hints and encrypted data.",
    })
    declare noteData: NoteData[];

    @ApiProperty({
        description:
            "A signed fee commitment from a previous quote response, in which a transaction price was committed to.",
        type: SignedWithdrawalFeeCommitmentDto,
    })
    declare signedFeeCommitment: ISignedWithdrawalFeeCommitment;

    @ApiProperty({
        description:
            "The signature-authorized keystore registration to perform atomically before the withdrawal. " +
            "Lets the relayer register a fresh, unfunded recipient address on its behalf. `deadline` bounds " +
            "how long the signed authorization stays valid on-chain (Keystore_SignatureExpired).",
        example: {
            account: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
            authDigest: "0x1a2b3c",
            nullifyingKeyHash: "0x4d5e6f",
            deadline: "0x64",
            signature: "0xabcd",
        },
    })
    declare registration: IKeystoreRegistration;
}

export class RelayAndAnnounceRequestDto extends createZodDto(zEvmRelayAndAnnounceRequest) {
    @ApiProperty({
        description:
            "A SNARK proof obtained using the associated circuits, proving the user's address belongs in the ASP tree, the user's note's exist in the notes tree and the user owns the notes.",
    })
    declare proof: ReshapedProof;

    @ApiProperty({
        description: "Number of input nullifiers in the proof (N in transact_NxM).",
        example: 1,
    })
    declare inputNullifierNumber: number;

    @ApiProperty({
        description: "Number of output commitments in the proof (M in transact_NxM).",
        example: 1,
    })
    declare outputCommitmentNumber: number;

    @ApiProperty({
        description: "Note data for the transaction, containing hints and encrypted data.",
    })
    declare noteData: NoteData[];

    @ApiProperty({
        description:
            "A signed fee commitment from a previous quote response, in which a transaction price was committed to. " +
            "The withdrawal fee quote is reused for the relay leg; the announcement carries no value.",
        type: SignedWithdrawalFeeCommitmentDto,
    })
    declare signedFeeCommitment: ISignedWithdrawalFeeCommitment;

    @ApiProperty({
        description:
            "The ERC-5564 stealth-payment announcement leg. Relays the withdrawal to the stealth address " +
            "and publishes its ERC-5564 announcement atomically in one transaction, so the recipient can " +
            "discover the payment. The contract enforces that stealthAddress equals the payout recipient.",
        example: {
            schemeId: "0x1",
            stealthAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
            ephemeralPubKey: "0x0399999999999999999999999999999999999999999999999999999999999999ab",
            metadata: "0x01",
        },
    })
    declare announcement: Announcement;
}

export class TransferRelayRequestDto extends createZodDto(zEvmRelayTransferRequest) implements ITransferRelayRequest {
    @ApiProperty({
        description:
            "A SNARK proof obtained using the associated circuits, proving the user's address belongs in the ASP tree, the user's note's exist in the notes tree and the user owns the notes.",
    })
    declare proof: ReshapedProof;

    @ApiProperty({
        description: "Number of input nullifiers in the proof (N in transact_NxM).",
        example: 1,
    })
    declare inputNullifierNumber: number;

    @ApiProperty({
        description: "Number of output commitments in the proof (M in transact_NxM).",
        example: 2,
    })
    declare outputCommitmentNumber: number;

    @ApiProperty({
        description: "Note data for the transaction, containing hints and encrypted data.",
    })
    declare noteData: NoteData[];

    @ApiProperty({
        description:
            "A signed fee commitment from a previous quote response, in which a transaction price was committed to.",
        type: SignedTransferFeeCommitmentDto,
    })
    declare signedFeeCommitment: ISignedTransferFeeCommitment;
}

/**
 * Batch withdrawal relay request: N per-item proofs + note data, plus one signed
 * batch fee commitment whose `data` ABI-encodes the whole PayoutRouting[]. The
 * field shapes are inferred from `zEvmRelayBatchRequest`; nestjs-zod derives the
 * Swagger schema from the zod definition.
 */
export class BatchWithdrawalRelayRequestDto extends createZodDto(zEvmRelayBatchRequest) {}

export class SwapRelayRequestDto extends createZodDto(zEvmRelaySwapRequest) implements ISwapRelayRequest {
    @ApiProperty({ description: "ZK proof for the withdrawal" })
    declare proof: ReshapedProof;

    @ApiProperty({ description: "Number of input nullifiers in the proof", example: 1 })
    declare inputNullifierNumber: number;

    @ApiProperty({ description: "Number of output commitments in the proof", example: 1 })
    declare outputCommitmentNumber: number;

    @ApiProperty({ description: "Note data for the transaction" })
    declare noteData: NoteData[];

    @ApiProperty({
        description: "Signed swap fee commitment from a previous swap quote",
        type: SignedSwapFeeCommitmentDto,
    })
    declare signedSwapCommitment: ISignedSwapFeeCommitment;
}

export class RelayResponseDto extends createZodDto(zEvmRelayResponse) implements IRelayResponse {
    @ApiProperty({
        description: "Transaction hash emitted by the blockchain.",
        example: "0x0bf2faf0cbd3dd3f796ef6b4deeb2f6cbb976e63404714bf23673b9443258262",
    })
    declare txHash: Hash;

    @ApiProperty({
        description: "Error message if the relay failed.",
        type: "string",
        required: false,
        example: "Transaction reverted",
    })
    declare error?: string;

    @ApiProperty({
        description:
            "Set only on a swap relay that opted into dustRescue: the transaction above succeeded on-chain, " +
            "but the dust-rescue job could not be priced/registered for automatic tracking. Distinct from " +
            "`error` — do not retry based on this field alone, the transaction already succeeded.",
        type: "string",
        required: false,
        example: "No wrapped-native address configured for chainId=8453",
    })
    declare dustRescueWarning?: string;
}
