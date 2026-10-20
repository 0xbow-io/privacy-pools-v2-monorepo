import { Test, TestingModule } from "@nestjs/testing";
import { AppController } from "./app.controller";
import { FATLoggerService } from "./logger/fat.logger.provider";
import { createMockLoggerProvider } from "./test/mocks";

describe("AppController", () => {
    let appController: AppController;
    let logger: FATLoggerService;

    beforeEach(async () => {
        const app: TestingModule = await Test.createTestingModule({
            controllers: [AppController],
            providers: [createMockLoggerProvider()],
        }).compile();

        appController = app.get<AppController>(AppController);
        logger = await app.resolve<FATLoggerService>(FATLoggerService);
    });

    describe("ping", () => {
        it('should return "pong"', () => {
            expect(appController.ping()).toBe("pong");
        });
    });

    describe("Logging correctly", () => {
        it("Should log the ping request.", () => {
            const spiedLogger = jest.spyOn(logger, "log");

            expect(appController.ping()).toBe("pong");

            expect(spiedLogger).toHaveBeenCalledWith("ping endpoint called");
        });
    });
});
