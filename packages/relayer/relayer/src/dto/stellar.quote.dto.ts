import { ApiProperty } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { zStellarQuoteRequest, zStellarQuoteResponse } from "../quote/stellar/schemas";
import type { StellarSignedWithdrawalFeeCommitment } from "../quote/stellar/types";

export class StellarWithdrawalQuoteRequestDto extends createZodDto(zStellarQuoteRequest) {
    @ApiProperty({ description: "Stellar StrKey asset (token contract) address", type: "string" })
    declare asset: string;

    @ApiProperty({ description: "Amount of token to quote", type: "string", example: "10000" })
    declare amount: bigint;

    @ApiProperty({ description: "Recipient StrKey address", type: "string", required: false })
    declare recipient?: string;

    @ApiProperty({
        description: "Whether to commit to the quoted fee. If true, a recipient must be provided.",
        example: false,
    })
    declare commit: boolean;
}

export class StellarWithdrawalQuoteResponseDto extends createZodDto(zStellarQuoteResponse) {
    @ApiProperty({ description: "Relayer fee amount", type: "string" })
    declare feeAmount: bigint;

    @ApiProperty({ description: "Total amount sent from the pool", type: "string" })
    declare amountSent: bigint;

    @ApiProperty({ description: "Amount received by the recipient after the fee", type: "string" })
    declare amountReceived: bigint;

    @ApiProperty({
        description: "Present only when the request set commit: true.",
        required: false,
    })
    declare feeCommitment?: StellarSignedWithdrawalFeeCommitment;
}
