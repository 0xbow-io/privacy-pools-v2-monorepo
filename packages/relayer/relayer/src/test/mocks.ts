import { FATLoggerService } from "../logger/fat.logger.provider";

export const createMockLogger = () => ({
    log: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    turbo: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    setContext: jest.fn(),
});

export const createMockLoggerProvider = () => ({
    provide: FATLoggerService,
    useValue: createMockLogger(),
});
