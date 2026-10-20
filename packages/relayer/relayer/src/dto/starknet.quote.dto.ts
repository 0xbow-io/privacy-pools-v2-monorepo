import { ApiProperty } from "@nestjs/swagger";

// TODO: Implement proper Starknet quote DTOs when Starknet support is added.
// These are placeholders to show the multichain Swagger schema.

export class StarknetWithdrawalQuoteRequestDto {
    @ApiProperty({ description: "Starknet asset address (felt252)", type: "string" })
    declare asset: string;

    @ApiProperty({ description: "Amount to quote", type: "string" })
    declare amount: string;

    @ApiProperty({ description: "Recipient Starknet address", type: "string", required: false })
    declare recipient?: string;

    @ApiProperty({ description: "Whether to commit to the quoted fee", example: false })
    declare commit: boolean;
}

export class StarknetTransferQuoteRequestDto {
    @ApiProperty({ description: "Starknet asset address (felt252)", type: "string" })
    declare asset: string;

    @ApiProperty({ description: "Whether to commit to the quoted fee", example: false })
    declare commit: boolean;
}

export class StarknetWithdrawalQuoteResponseDto {
    @ApiProperty({ description: "Total relayer fee amount", type: "string" })
    declare feeAmount: string;
}

export class StarknetTransferQuoteResponseDto {
    @ApiProperty({ description: "Total relayer fee amount", type: "string" })
    declare feeAmount: string;
}
