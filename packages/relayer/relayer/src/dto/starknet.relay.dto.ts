import { ApiProperty } from "@nestjs/swagger";

// TODO: Implement proper Starknet relay DTOs when Starknet support is added.
// These are placeholders to show the multichain Swagger schema.

export class StarknetWithdrawalRelayRequestDto {
    @ApiProperty({ description: "Starknet proof data" })
    declare proof: Record<string, unknown>;

    @ApiProperty({ description: "Signed fee commitment from quote" })
    declare signedFeeCommitment: Record<string, unknown>;
}

export class StarknetTransferRelayRequestDto {
    @ApiProperty({ description: "Starknet proof data" })
    declare proof: Record<string, unknown>;

    @ApiProperty({ description: "Signed fee commitment from quote" })
    declare signedFeeCommitment: Record<string, unknown>;
}

export class StarknetRelayResponseDto {
    @ApiProperty({ description: "Starknet transaction hash", type: "string" })
    declare txHash: string;
}
