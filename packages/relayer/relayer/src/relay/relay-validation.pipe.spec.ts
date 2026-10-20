import { NotImplementedException, Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { mock } from "jest-mock-extended";
import { z } from "zod";
import {
    WithdrawalValidationPipe,
    RegisterAndWithdrawalValidationPipe,
    RelayAndAnnounceValidationPipe,
    TransferValidationPipe,
    BatchWithdrawalValidationPipe,
    SwapValidationPipe,
} from "./relay-validation.pipe";
import { RELAY_SERVICE, type IRelayService } from "./relay.interface";

// Regression coverage for the bug these pipes used to have: every pipe hardcoded an
// EVM zod import regardless of which chain RELAY_SERVICE actually resolved to for the
// request, so a real second/third chain's differently-shaped body either got silently
// force-parsed as EVM or rejected before ever reaching the (correctly chain-aware)
// RELAY_SERVICE DI factory. Each pipe must now validate against whatever schema the
// resolved service exposes. A schema shape that is obviously not EVM's real request
// shape proves the pipe isn't secretly still importing an EVM schema directly.
const NOT_EVM_SCHEMA = z.object({ marker: z.literal("not-evm") });
const VALID_BODY = { marker: "not-evm" };

async function resolvePipe<T>(pipeClass: Type<T>, relayService: IRelayService): Promise<T> {
    const module = await Test.createTestingModule({
        providers: [pipeClass, { provide: RELAY_SERVICE, useValue: relayService }],
    }).compile();
    return module.resolve(pipeClass);
}

describe("relay validation pipes", () => {
    it("WithdrawalValidationPipe delegates to the resolved service's withdrawalSchema", async () => {
        const relayService = mock<IRelayService>();
        relayService.withdrawalSchema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(WithdrawalValidationPipe, relayService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("RegisterAndWithdrawalValidationPipe delegates to the resolved service's registerAndWithdrawalSchema", async () => {
        const relayService = mock<IRelayService>();
        relayService.registerAndWithdrawalSchema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(RegisterAndWithdrawalValidationPipe, relayService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("RelayAndAnnounceValidationPipe delegates to the resolved service's relayAndAnnounceSchema", async () => {
        const relayService = mock<IRelayService>();
        relayService.relayAndAnnounceSchema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(RelayAndAnnounceValidationPipe, relayService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("TransferValidationPipe delegates to the resolved service's transferSchema", async () => {
        const relayService = mock<IRelayService>();
        relayService.transferSchema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(TransferValidationPipe, relayService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("BatchWithdrawalValidationPipe delegates to the resolved service's batchSchema", async () => {
        const relayService = mock<IRelayService>();
        relayService.batchSchema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(BatchWithdrawalValidationPipe, relayService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("SwapValidationPipe delegates to the resolved service's relaySwapSchema", async () => {
        const relayService = mock<IRelayService>();
        relayService.relaySwapSchema = NOT_EVM_SCHEMA;
        const pipe = await resolvePipe(SwapValidationPipe, relayService);

        expect(pipe.transform(VALID_BODY)).toEqual(VALID_BODY);
        expect(() => pipe.transform({})).toThrow();
    });

    it("SwapValidationPipe throws NotImplementedException when the resolved service has no relaySwapSchema (e.g. Starknet)", async () => {
        const relayService = mock<IRelayService>();
        relayService.relaySwapSchema = undefined;
        const pipe = await resolvePipe(SwapValidationPipe, relayService);

        expect(() => pipe.transform(VALID_BODY)).toThrow(NotImplementedException);
    });
});
