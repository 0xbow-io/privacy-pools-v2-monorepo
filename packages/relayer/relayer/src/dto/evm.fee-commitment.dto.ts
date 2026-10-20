import { ApiProperty } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { zSignedTransferFeeCommitment, zSignedWithdrawalFeeCommitment, zSignedSwapFeeCommitment } from "../quote/evm/evm.schemas";
import type { Wei } from "../quote/evm/unit.types";
import type { EvmAddress } from "../config/evm/evm.types";

export class SignedTransferFeeCommitmentDto extends createZodDto(zSignedTransferFeeCommitment) {
    @ApiProperty({
        description: "Encoded fee commitment data",
        type: "string",
        example: "0xdeadbeef",
    })
    declare data: `0x${string}`;

    @ApiProperty({
        description: "Token address",
        type: "string",
        example: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    })
    declare asset: EvmAddress;

    @ApiProperty({
        description: "Expiration timestamp (unix seconds)",
        type: "number",
        example: 1700000000,
    })
    declare expiration: number;

    @ApiProperty({
        description: "Fee amount in token units",
        type: "string",
        example: "100",
    })
    declare feeAmount: Wei;

    @ApiProperty({
        description: "Relayer signature over the fee commitment",
        type: "string",
        example: "0x0000000000001",
    })
    declare signedRelayerCommitment: `0x${string}`;
}

export class SignedSwapFeeCommitmentDto extends createZodDto(zSignedSwapFeeCommitment) {
    @ApiProperty({ description: "Encoded SwapRouting data", type: "string" })
    declare data: `0x${string}`;

    @ApiProperty({ description: "Input token address", type: "string" })
    declare asset: EvmAddress;

    @ApiProperty({ description: "Expiration timestamp (unix ms)", type: "number" })
    declare expiration: number;

    @ApiProperty({ description: "Relay fee in input token units", type: "string" })
    declare feeAmount: Wei;

    @ApiProperty({ description: "Recipient address", type: "string" })
    declare recipient: EvmAddress;

    @ApiProperty({ description: "Total withdrawal amount", type: "string" })
    declare amountSent: Wei;

    @ApiProperty({ description: "Relayer signature over the swap commitment", type: "string" })
    declare signedRelayerCommitment: `0x${string}`;
}

export class SignedWithdrawalFeeCommitmentDto extends createZodDto(zSignedWithdrawalFeeCommitment) {
    @ApiProperty({
        description: "Encoded fee commitment data",
        type: "string",
        example: "0xdeadbeef",
    })
    declare data: `0x${string}`;

    @ApiProperty({
        description: "Token address",
        type: "string",
        example: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    })
    declare asset: EvmAddress;

    @ApiProperty({
        description: "Expiration timestamp (unix seconds)",
        type: "number",
        example: 1700000000,
    })
    declare expiration: number;

    @ApiProperty({
        description: "Fee amount in token units",
        type: "string",
        example: "100",
    })
    declare feeAmount: Wei;

    @ApiProperty({
        description: "Recipient address",
        type: "string",
        example: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    })
    declare recipient: EvmAddress;

    @ApiProperty({
        description: "Total amount that user sends",
        type: "string",
        example: "100000",
    })
    declare amountSent: Wei;

    @ApiProperty({
        description: "Amount to be received",
        type: "string",
        example: "99900",
    })
    declare amountReceived: Wei;

    @ApiProperty({
        description: "Relayer signature over the fee commitment",
        type: "string",
        example: "0x0000000000001",
    })
    declare signedRelayerCommitment: `0x${string}`;
}
