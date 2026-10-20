import { Inject, Injectable, NotImplementedException, PipeTransform, Scope } from "@nestjs/common";
import { RELAY_SERVICE, type IRelayService } from "./relay.interface";

@Injectable({ scope: Scope.REQUEST })
export class WithdrawalValidationPipe implements PipeTransform {
    constructor(@Inject(RELAY_SERVICE) private readonly relayService: IRelayService) {}

    transform(value: unknown) {
        return this.relayService.withdrawalSchema.parse(value);
    }
}

@Injectable({ scope: Scope.REQUEST })
export class RegisterAndWithdrawalValidationPipe implements PipeTransform {
    constructor(@Inject(RELAY_SERVICE) private readonly relayService: IRelayService) {}

    transform(value: unknown) {
        return this.relayService.registerAndWithdrawalSchema.parse(value);
    }
}

@Injectable({ scope: Scope.REQUEST })
export class RelayAndAnnounceValidationPipe implements PipeTransform {
    constructor(@Inject(RELAY_SERVICE) private readonly relayService: IRelayService) {}

    transform(value: unknown) {
        return this.relayService.relayAndAnnounceSchema.parse(value);
    }
}

@Injectable({ scope: Scope.REQUEST })
export class TransferValidationPipe implements PipeTransform {
    constructor(@Inject(RELAY_SERVICE) private readonly relayService: IRelayService) {}

    transform(value: unknown) {
        return this.relayService.transferSchema.parse(value);
    }
}

@Injectable({ scope: Scope.REQUEST })
export class BatchWithdrawalValidationPipe implements PipeTransform {
    constructor(@Inject(RELAY_SERVICE) private readonly relayService: IRelayService) {}

    transform(value: unknown) {
        return this.relayService.batchSchema.parse(value);
    }
}

@Injectable({ scope: Scope.REQUEST })
export class SwapValidationPipe implements PipeTransform {
    constructor(@Inject(RELAY_SERVICE) private readonly relayService: IRelayService) {}

    transform(value: unknown) {
        if (!this.relayService.relaySwapSchema) {
            throw new NotImplementedException("RelaySwaps not supported on this chain type");
        }
        return this.relayService.relaySwapSchema.parse(value);
    }
}
