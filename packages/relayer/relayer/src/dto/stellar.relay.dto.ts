import { createZodDto } from "nestjs-zod";
import { ApiProperty } from "@nestjs/swagger";
import { zStellarRelayWithdrawalRequest, zStellarRelayResponse } from "../relay/stellar/schemas";
import type { StellarNoteData, StellarRelayWithdrawalRequest } from "../relay/stellar/types";
import type { StellarSignedWithdrawalFeeCommitment } from "../quote/stellar/types";

// Does not `implements IWithdrawalRelayRequest` (relayer.types.ts) — that interface is
// EVM-address-typed, same reason the Starknet placeholder DTOs don't implement it either.
export class StellarWithdrawalRelayRequestDto extends createZodDto(zStellarRelayWithdrawalRequest) {
    @ApiProperty({
        description: "Groth16 proof {a, b, c} (Soroban byte layout) plus the flat publicSignals array.",
    })
    declare proof: StellarRelayWithdrawalRequest["proof"];

    @ApiProperty({ description: "Number of input nullifiers in the proof (N in transact_NxM).", example: 1 })
    declare inputNullifierNumber: number;

    @ApiProperty({ description: "Number of output commitments in the proof (M in transact_NxM).", example: 1 })
    declare outputCommitmentNumber: number;

    @ApiProperty({ description: "Note data for the transaction, containing hints and encrypted data." })
    declare noteData: StellarNoteData[];

    @ApiProperty({
        description: "A signed fee commitment from a previous Stellar quote response.",
    })
    declare signedFeeCommitment: StellarSignedWithdrawalFeeCommitment;
}

export class StellarRelayResponseDto extends createZodDto(zStellarRelayResponse) {
    @ApiProperty({ description: "Stellar transaction hash", type: "string" })
    declare txHash: `0x${string}`;

    @ApiProperty({ description: "Error message, if any", required: false })
    declare error?: string;
}
