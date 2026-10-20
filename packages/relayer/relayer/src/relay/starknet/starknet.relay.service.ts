import { Injectable, NotImplementedException } from "@nestjs/common";
import { ChainedRelayService } from "../relay.interface";
import { ChainType } from "../../config/enums";
import {
    StarknetRelayWithdrawalRequest,
    StarknetRelayWithdrawalResponse,
    StarknetRelaySendRequest,
    StarknetRelaySendResponse,
} from "./types";
import { FATLoggerService } from "../../logger/fat.logger.provider";
import { zStarknetRelayRequest } from "./schemas";

@Injectable()
export class StarknetRelayService implements ChainedRelayService<ChainType.STARKNET> {
    withdrawalSchema = zStarknetRelayRequest;
    transferSchema = zStarknetRelayRequest;
    batchSchema = zStarknetRelayRequest;
    registerAndWithdrawalSchema = zStarknetRelayRequest;
    relayAndAnnounceSchema = zStarknetRelayRequest;

    constructor(private readonly logger: FATLoggerService) {}

    async withdrawal(_request: StarknetRelayWithdrawalRequest): Promise<StarknetRelayWithdrawalResponse> {
        this.logger.warn("Starknet relay withdrawal not implemented");
        throw new NotImplementedException("Starknet relay withdrawal not implemented");
    }

    async registerAndWithdrawal(_request: StarknetRelayWithdrawalRequest): Promise<StarknetRelayWithdrawalResponse> {
        this.logger.warn("Starknet relay register-and-withdrawal not implemented");
        throw new NotImplementedException("Starknet relay register-and-withdrawal not implemented");
    }

    async relayAndAnnounce(_request: StarknetRelayWithdrawalRequest): Promise<StarknetRelayWithdrawalResponse> {
        this.logger.warn("Starknet relay relay-and-announce not implemented");
        throw new NotImplementedException("Starknet relay relay-and-announce not implemented");
    }

    async transfer(_request: StarknetRelaySendRequest): Promise<StarknetRelaySendResponse> {
        this.logger.warn("Starknet relay send not implemented");
        throw new NotImplementedException("Starknet relay send not implemented");
    }

    async batchWithdrawal(_request: StarknetRelayWithdrawalRequest): Promise<StarknetRelayWithdrawalResponse> {
        this.logger.warn("Starknet relay batch withdrawal not implemented");
        throw new NotImplementedException("Starknet relay batch withdrawal not implemented");
    }
}
