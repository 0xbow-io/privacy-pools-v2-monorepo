import { ApiProperty } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import {
    zEvmQuoteRequest,
    zEvmShieldedQuoteRequest,
    zEvmBatchQuoteRequest,
    zEvmSwapQuoteRequest,
    zTransferQuoteResponse,
    zWithdrawalQuoteResponse,
    zBatchWithdrawalQuoteResponse,
    zSwapQuoteResponse,
} from "../quote/evm/evm.schemas";
import type { EvmDustRescue } from "../quote/evm/types";
import type {
    ISignedTransferFeeCommitment,
    ISignedWithdrawalFeeCommitment,
    ISignedSwapFeeCommitment,
    ITransferQuoteRequest,
    ITransferQuoteResponse,
    IWithdrawalQuoteRequest,
    IWithdrawalQuoteResponse,
} from "../relayer.types";
import type { Gas, Wei } from "../quote/evm/unit.types";
import type { EvmAddress } from "../config/evm/evm.types";
import { SignedTransferFeeCommitmentDto, SignedSwapFeeCommitmentDto, SignedWithdrawalFeeCommitmentDto } from "./evm.fee-commitment.dto";

// Request DTOs
export class EvmWithdrawalQuoteRequestDto extends createZodDto(zEvmQuoteRequest) implements IWithdrawalQuoteRequest {
    @ApiProperty({
        description: "Token address",
        type: "string",
        example: "0x0000000000000000000000000000000000000000",
    })
    declare asset: EvmAddress;

    @ApiProperty({
        description: "Whether to include an extra amount of native tokens. Defaults to false.",
        required: false,
        example: false,
    })
    declare extraGas: boolean;

    @ApiProperty({
        description: "Recipient address",
        type: "string",
        required: false,
        example: "0x0000000000000000000000000000000000000000",
    })
    declare recipient?: EvmAddress;

    @ApiProperty({
        description: "Amount of token to quote",
        type: "string",
        example: "10000",
    })
    declare amount: Wei;

    @ApiProperty({
        description: "Whether to commit to the quoted fee. If true, a recipient must be provided.",
        example: false,
    })
    declare commit: boolean;
}

export class EvmTransferQuoteRequestDto
    extends createZodDto(zEvmShieldedQuoteRequest)
    implements ITransferQuoteRequest
{
    @ApiProperty({
        description: "Token address",
        type: "string",
        example: "0x0000000000000000000000000000000000000000",
    })
    declare asset: EvmAddress;

    @ApiProperty({
        description: "Whether to commit to the quoted fee. If true, a recipient must be provided.",
        example: false,
    })
    declare commit: boolean;
}

export class EvmBatchWithdrawalQuoteRequestDto extends createZodDto(zEvmBatchQuoteRequest) {
    @ApiProperty({ description: "Token address", type: "string", example: "0x0000000000000000000000000000000000000000" })
    declare asset: EvmAddress;

    @ApiProperty({ description: "Recipient address shared by every batch item", type: "string", example: "0x0000000000000000000000000000000000000000" })
    declare recipient: EvmAddress;

    @ApiProperty({ description: "Whether to include extra native gas. Defaults to false.", required: false, example: false })
    declare extraGas: boolean;

    @ApiProperty({
        description: "Per-item withdrawal amounts, in batch order.",
        type: "string",
        isArray: true,
        example: ["10000", "5000"],
    })
    declare amounts: Wei[];

    @ApiProperty({ description: "Whether to commit to the quoted fee.", example: true })
    declare commit: boolean;
}

// Response DTOs
export class EvmBatchWithdrawalQuoteResponseDto extends createZodDto(zBatchWithdrawalQuoteResponse) {
    @ApiProperty({ description: "Estimated gas units for the whole batch tx", type: "string", example: "1200000" })
    declare txCost: Gas;

    @ApiProperty({ description: "Current gas price in wei", type: "string", example: "10000" })
    declare gasPrice: Wei;

    @ApiProperty({ description: "Total relayer fee for the whole batch, in token units", type: "string", example: "400000000000" })
    declare totalFee: Wei;

    @ApiProperty({ description: "Per-item maximum relay fee cap", type: "string", example: "200000000000" })
    declare maxRelayFee: Wei;
}

export class EvmWithdrawalQuoteResponseDto
    extends createZodDto(zWithdrawalQuoteResponse)
    implements IWithdrawalQuoteResponse
{
    @ApiProperty({
        description: "Estimated gas units for the transaction",
        type: "string",
        example: "21000",
    })
    declare txCost: Gas;

    @ApiProperty({
        description: "Current gas price in wei",
        type: "string",
        example: "10000",
    })
    declare gasPrice: Wei;

    @ApiProperty({
        description: "Total relayer fee amount in token units",
        type: "string",
        example: "200000000000",
    })
    declare feeAmount: Wei;

    @ApiProperty({
        description:
            "Default processor for a relayed withdrawal (the relay contract). Bind this address into the proof context. " +
            "A withdrawal relayed with an alternate `processorAddress` (an allowlisted PPRouter, from /details `yield[].router`) " +
            "must bind that address instead — this quote does not reflect it.",
        type: "string",
        example: "0x0000000000000000000000000000000000000000",
    })
    declare processor: EvmAddress;

    @ApiProperty({
        description: "Total amount that user sends",
        type: "string",
        example: "1100000000000",
    })
    declare amountSent: Wei;

    @ApiProperty({
        description: "Amount to be received",
        type: "string",
        example: "1100000000000",
    })
    declare amountReceived: Wei;

    @ApiProperty({
        description: "Gas units for the extra gas send transaction",
        type: "string",
        required: false,
        example: "21000",
    })
    declare extraGasTxCost?: Gas;

    @ApiProperty({
        description: "Gas units reserved to send in native token",
        type: "string",
        required: false,
        example: "21000",
    })
    declare extraGasFundAmount?: Gas;

    @ApiProperty({
        description: "Fee commitment signed by relayer",
        type: SignedWithdrawalFeeCommitmentDto,
        required: false,
    })
    declare feeCommitment?: ISignedWithdrawalFeeCommitment;
}

export class EvmTransferQuoteResponseDto
    extends createZodDto(zTransferQuoteResponse)
    implements ITransferQuoteResponse
{
    @ApiProperty({
        description: "Estimated gas units for the transaction",
        type: "string",
        example: "21000",
    })
    declare txCost: Gas;

    @ApiProperty({
        description: "Current gas price in wei",
        type: "string",
        example: "20000",
    })
    declare gasPrice: Wei;

    @ApiProperty({
        description: "Total relayer fee amount in token units",
        type: "string",
        example: "200000000000",
    })
    declare feeAmount: Wei;

    @ApiProperty({
        description:
            "Processor the relayer binds for a relayed transfer: the relayer signer address (it calls PoolVault.transact " +
            "directly). Transfers take no alternate processor. Bind this address into the proof context.",
        type: "string",
        example: "0x0000000000000000000000000000000000000000",
    })
    declare processor: EvmAddress;

    @ApiProperty({
        description: "Fee commitment signed by relayer",
        type: SignedTransferFeeCommitmentDto,
        required: false,
    })
    declare feeCommitment?: ISignedTransferFeeCommitment;
}

// Swap quote DTOs
export class EvmSwapQuoteRequestDto extends createZodDto(zEvmSwapQuoteRequest) {
    @ApiProperty({ description: "Input token address (withdrawn from pool)", type: "string" })
    declare asset: EvmAddress;

    @ApiProperty({ description: "Withdrawal amount in input token units", type: "string" })
    declare amount: Wei;

    @ApiProperty({ description: "Desired output token address", type: "string" })
    declare outputToken: EvmAddress;

    @ApiProperty({ description: "Output recipient address", type: "string" })
    declare recipient: EvmAddress;

    @ApiProperty({ description: "Fallback address for cross-chain bridge failure refunds", type: "string", required: false })
    declare fallbackAddress?: EvmAddress;

    @ApiProperty({ description: "Minimum output amount (from LiFi quote)", type: "string" })
    declare minOutputAmount: Wei;

    @ApiProperty({
        description:
            "Opt-in ETH gas top-up for the recipient; the relayer computes and caps the funded amount and folds its cost into feeAmount",
        type: "boolean",
        required: false,
    })
    declare extraGas: boolean;

    @ApiProperty({ description: "full LiFi swap calldata (proof-bound via the RelaySwaps SwapRouting struct)", required: false })
    declare swapCalldata?: `0x${string}`;

    @ApiProperty({ description: "Address of the swap target contract (for RelaySwaps proof-binding)", required: false })
    declare swapTarget?: `0x${string}`;

    @ApiProperty({ description: "Address for token approval (may differ from swapTarget, e.g. LiFi v4 ERC20Proxy)", required: false })
    declare approvalAddress?: `0x${string}`;

    @ApiProperty({
        description:
            "B2 (Mainnet-destination reshield only): native wei RelaySwaps mints in-contract and forwards as msg.value to the bridge. Capped by max_swap_value_wei. Omit / 0 on every other path.",
        type: "string",
        required: false,
    })
    declare swapValue?: Wei;

    @ApiProperty({
        description: "B2: upper bound on input-token units RelaySwaps may approve for the in-contract gas swap. Required when swapValue > 0.",
        type: "string",
        required: false,
    })
    declare gasSwapMaxInput?: Wei;

    @ApiProperty({
        description: "B2: same-chain input-token->native-ETH LiFi calldata for the in-contract gas swap (proof-bound). Required when swapValue > 0.",
        required: false,
    })
    declare gasSwapCalldata?: `0x${string}`;

    @ApiProperty({ description: "Address to receive any dust left on the processor contract after swap" })
    declare dustRecipient: `0x${string}`;

    @ApiProperty({
        description:
            "Opt-in dust rescue for a cross-chain reshield/swap. Only valid when recipient is the zero " +
            "address; encoded into the committed routing's dustRescue field, inheriting its proof-context binding.",
        required: false,
    })
    declare dustRescue?: EvmDustRescue;

    @ApiProperty({ description: "Whether to commit to the quoted fee", example: false })
    declare commit: boolean;
}

export class EvmSwapQuoteResponseDto extends createZodDto(zSwapQuoteResponse) {
    @ApiProperty({ description: "Estimated gas units", type: "string" })
    declare txCost: Gas;

    @ApiProperty({ description: "Current gas price in wei", type: "string" })
    declare gasPrice: Wei;

    @ApiProperty({ description: "Relay fee in input token units", type: "string" })
    declare feeAmount: Wei;

    @ApiProperty({ description: "Signed swap fee commitment", type: SignedSwapFeeCommitmentDto, required: false })
    declare feeCommitment?: ISignedSwapFeeCommitment;
}
