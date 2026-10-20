import { Test, TestingModule } from "@nestjs/testing";
import { HttpStatus } from "@nestjs/common";
import { HTTP_CODE_METADATA } from "@nestjs/common/constants";
import { mock } from "jest-mock-extended";
import { RelayController } from "./relay.controller";
import { RELAY_SERVICE, type IRelayService } from "./relay.interface";
import {
    WithdrawalRelayRequestDto,
    RegisterAndWithdrawalRelayRequestDto,
    RelayAndAnnounceRequestDto,
    TransferRelayRequestDto,
    BatchWithdrawalRelayRequestDto,
    RelayResponseDto,
} from "../dto/evm.relay.dto";

// Controller-layer coverage (code-review R1 TEST-1): the RelayController had no
// spec. These verify each route forwards its (already-validated) body to the
// injected IRelayService and returns the service result unchanged. The validation
// pipes are exercised separately; here we assert the delegation contract only.

const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as const;

describe("RelayController", () => {
    let controller: RelayController;
    const relayService = mock<IRelayService>();

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            controllers: [RelayController],
            providers: [{ provide: RELAY_SERVICE, useValue: relayService }],
        }).compile();

        controller = await module.resolve<RelayController>(RelayController);
        jest.clearAllMocks();
    });

    it("delegate a withdrawal to the relay service", async () => {
        const body = { kind: "withdrawal" } as unknown as WithdrawalRelayRequestDto;
        const response: RelayResponseDto = { txHash: TX_HASH };
        relayService.withdrawal.mockResolvedValue(response);

        const result = await controller.withdrawal(body);

        expect(relayService.withdrawal).toHaveBeenCalledWith(body);
        expect(result).toBe(response);
    });

    it("delegate a register-and-withdrawal to the relay service", async () => {
        const body = { kind: "register-and-withdrawal" } as unknown as RegisterAndWithdrawalRelayRequestDto;
        const response: RelayResponseDto = { txHash: TX_HASH };
        relayService.registerAndWithdrawal.mockResolvedValue(response);

        const result = await controller.registerAndWithdrawal(body);

        expect(relayService.registerAndWithdrawal).toHaveBeenCalledWith(body);
        expect(result).toBe(response);
    });

    it("delegate a relay-and-announce to the relay service", async () => {
        const body = { kind: "relay-and-announce" } as unknown as RelayAndAnnounceRequestDto;
        const response: RelayResponseDto = { txHash: TX_HASH };
        relayService.relayAndAnnounce.mockResolvedValue(response);

        const result = await controller.relayAndAnnounce(body);

        expect(relayService.relayAndAnnounce).toHaveBeenCalledWith(body);
        expect(result).toBe(response);
    });

    it("delegate a transfer to the relay service", async () => {
        const body = { kind: "transfer" } as unknown as TransferRelayRequestDto;
        const response: RelayResponseDto = { txHash: TX_HASH };
        relayService.transfer.mockResolvedValue(response);

        const result = await controller.transfer(body);

        expect(relayService.transfer).toHaveBeenCalledWith(body);
        expect(result).toBe(response);
    });

    it("delegate a batch withdrawal to the relay service", async () => {
        const body = { items: [], signedBatchFeeCommitment: {} } as unknown as BatchWithdrawalRelayRequestDto;
        const response: RelayResponseDto = { txHash: TX_HASH };
        relayService.batchWithdrawal.mockResolvedValue(response);

        const result = await controller.batchWithdrawal(body);

        expect(relayService.batchWithdrawal).toHaveBeenCalledWith(body);
        expect(result).toBe(response);
    });

    it("propagate errors thrown by the relay service", async () => {
        const body = { items: [] } as unknown as BatchWithdrawalRelayRequestDto;
        relayService.batchWithdrawal.mockRejectedValue(new Error("relay reverted"));

        await expect(controller.batchWithdrawal(body)).rejects.toThrow("relay reverted");
    });

    // 201->202 fix: none of these routes create a resource or confirm on-chain
    // execution — they only accept a broadcast for async processing (see
    // nonce_control_plan.org Part B). Checked via the route's reflected
    // @HttpCode metadata rather than a live HTTP call, matching this file's
    // existing unit-level (non-e2e) style.
    describe("response status", () => {
        const routes: [string, keyof RelayController][] = [
            ["withdrawal", "withdrawal"],
            ["register-and-withdrawal", "registerAndWithdrawal"],
            ["relay-and-announce", "relayAndAnnounce"],
            ["transfer", "transfer"],
            ["batch", "batchWithdrawal"],
            ["relay-swap", "relaySwap"],
        ];

        it.each(routes)("%s returns 202 Accepted, not the implicit 201", (_route, method) => {
            const httpCode = Reflect.getMetadata(HTTP_CODE_METADATA, RelayController.prototype[method]);
            expect(httpCode).toBe(HttpStatus.ACCEPTED);
        });
    });
});
