import { Body, Controller, HttpCode, HttpStatus, Inject, NotImplementedException, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { RELAY_SERVICE, type IRelayService } from "./relay.interface";
import {
    RelayResponseDto,
    TransferRelayRequestDto,
    WithdrawalRelayRequestDto,
    BatchWithdrawalRelayRequestDto,
    SwapRelayRequestDto,
    RegisterAndWithdrawalRelayRequestDto,
    RelayAndAnnounceRequestDto,
} from "../dto/evm.relay.dto";
import { ApiBody, ApiExtraModels, ApiOkResponse, ApiOperation, getSchemaPath } from "@nestjs/swagger";
import {
    WithdrawalValidationPipe,
    TransferValidationPipe,
    BatchWithdrawalValidationPipe,
    SwapValidationPipe,
    RegisterAndWithdrawalValidationPipe,
    RelayAndAnnounceValidationPipe,
} from "./relay-validation.pipe";
import {
    StarknetWithdrawalRelayRequestDto,
    StarknetTransferRelayRequestDto,
    StarknetRelayResponseDto,
} from "../dto/starknet.relay.dto";
import { StellarWithdrawalRelayRequestDto, StellarRelayResponseDto } from "../dto/stellar.relay.dto";

@ApiExtraModels(
    WithdrawalRelayRequestDto,
    RegisterAndWithdrawalRelayRequestDto,
    RelayAndAnnounceRequestDto,
    TransferRelayRequestDto,
    BatchWithdrawalRelayRequestDto,
    SwapRelayRequestDto,
    RelayResponseDto,
    StarknetWithdrawalRelayRequestDto,
    StarknetTransferRelayRequestDto,
    StarknetRelayResponseDto,
    StellarWithdrawalRelayRequestDto,
    StellarRelayResponseDto,
)
@Controller("relay/:chainType/:chainId")
export class RelayController {
    constructor(@Inject(RELAY_SERVICE) private readonly relayService: IRelayService) {}

    @Post("withdrawal")
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ relay: {} })
    @ApiOperation({
        summary: "A withdrawal will prompt the relayer send funds out of the pool into a provided address.",
    })
    @ApiBody({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(WithdrawalRelayRequestDto) },
                { $ref: getSchemaPath(StarknetWithdrawalRelayRequestDto) },
                { $ref: getSchemaPath(StellarWithdrawalRelayRequestDto) },
            ],
        },
    })
    @ApiOkResponse({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(RelayResponseDto) },
                { $ref: getSchemaPath(StarknetRelayResponseDto) },
                { $ref: getSchemaPath(StellarRelayResponseDto) },
            ],
        },
    })
    async withdrawal(@Body(WithdrawalValidationPipe) body: WithdrawalRelayRequestDto): Promise<RelayResponseDto> {
        return this.relayService.withdrawal(body);
    }

    @Post("register-and-withdrawal")
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ relay: {} })
    @ApiOperation({
        summary:
            "Registers a fresh, unfunded recipient in the keystore (authorized by an off-chain EIP-712 signature) and withdraws their note atomically, so the recipient never has to fund their address to pay registration gas.",
    })
    @ApiBody({
        schema: {
            oneOf: [{ $ref: getSchemaPath(RegisterAndWithdrawalRelayRequestDto) }],
        },
    })
    @ApiOkResponse({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(RelayResponseDto) },
                { $ref: getSchemaPath(StarknetRelayResponseDto) },
            ],
        },
    })
    async registerAndWithdrawal(
        @Body(RegisterAndWithdrawalValidationPipe) body: RegisterAndWithdrawalRelayRequestDto
    ): Promise<RelayResponseDto> {
        return this.relayService.registerAndWithdrawal(body);
    }

    @Post("relay-and-announce")
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ relay: {} })
    @ApiOperation({
        summary:
            "Atomically relays a withdrawal to a stealth address and publishes its ERC-5564 announcement " +
            "in one transaction, so a stealth payment never splits into a relayed withdraw plus a separately " +
            "submitted announce. The contract enforces that the announcement's stealthAddress equals the " +
            "payout recipient.",
    })
    @ApiBody({ schema: { $ref: getSchemaPath(RelayAndAnnounceRequestDto) } })
    @ApiOkResponse({ schema: { $ref: getSchemaPath(RelayResponseDto) } })
    async relayAndAnnounce(
        @Body(RelayAndAnnounceValidationPipe) body: RelayAndAnnounceRequestDto
    ): Promise<RelayResponseDto> {
        return this.relayService.relayAndAnnounce(body);
    }

    @Post("transfer")
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ relay: {} })
    @ApiOperation({
        summary:
            "A transfer is an operation in which funds are reassigned ownership across two privacy pools users without ever being withdrawn from the pool. It does not require an exterior address, but a target note ownership identifier and the amount will be a secret, with a fee amount withdrawn out of the pool",
    })
    @ApiBody({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(TransferRelayRequestDto) },
                { $ref: getSchemaPath(StarknetTransferRelayRequestDto) },
            ],
        },
    })
    @ApiOkResponse({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(RelayResponseDto) },
                { $ref: getSchemaPath(StarknetRelayResponseDto) },
            ],
        },
    })
    async transfer(@Body(TransferValidationPipe) body: TransferRelayRequestDto): Promise<RelayResponseDto> {
        return this.relayService.transfer(body);
    }

    @Post("batch")
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ relay: {} })
    @ApiOperation({
        summary:
            "A batch withdrawal relays up to MAX_BATCH transacts in ONE on-chain relayBatch transaction, all paying the same recipient/asset with one aggregate fee split across the items.",
    })
    @ApiBody({ schema: { $ref: getSchemaPath(BatchWithdrawalRelayRequestDto) } })
    @ApiOkResponse({ schema: { $ref: getSchemaPath(RelayResponseDto) } })
    async batchWithdrawal(
        @Body(BatchWithdrawalValidationPipe) body: BatchWithdrawalRelayRequestDto
    ): Promise<RelayResponseDto> {
        return this.relayService.batchWithdrawal(body);
    }

    @Post("relay-swap")
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ relay: {} })
    @ApiOperation({ summary: "Unified withdraw + swap via RelaySwaps processor (proof-bound calldata)" })
    @ApiBody({ schema: { $ref: getSchemaPath(SwapRelayRequestDto) } })
    @ApiOkResponse({ schema: { $ref: getSchemaPath(RelayResponseDto) } })
    async relaySwap(@Body(SwapValidationPipe) body: SwapRelayRequestDto): Promise<RelayResponseDto> {
        if (!this.relayService.relaySwap) {
            throw new NotImplementedException("RelaySwaps not supported on this chain type");
        }
        return this.relayService.relaySwap(body);
    }
}
