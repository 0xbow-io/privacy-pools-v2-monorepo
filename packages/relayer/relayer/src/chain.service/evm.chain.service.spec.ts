import { Test, TestingModule } from "@nestjs/testing";
import {
    ContractFunctionExecutionError,
    ContractFunctionRevertedError,
    encodeErrorResult,
    getAddress,
} from "viem";
import { EVMChainService } from "./evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { createMockLoggerProvider } from "../test/mocks";
import { ChainType } from "../config/enums";
import { CHAIN_CONTEXT } from "../core/chain-context.token";
import { IWithdrawalFeeCommitment } from "../relayer.types";
import { Gas, Wei } from "../quote/evm/unit.types";
import { Bytes } from "../relay/evm/types";

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const exampleFeeCommitment: IWithdrawalFeeCommitment = {
    feeAmount: Wei(3500000000000000n),
    asset: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    extraGas: true,
    amountSent: Wei(1000000000000000000n),
    amountReceived: Wei(996500000000000000n),
    extraGasTxCost: Gas(320000n),
    extraGasFundAmount: Gas(600000n),
    data: "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df000000000000000000000000000000000000000000000000000c6f3b40b6c000",
    expiration: Date.now() + 10_000_000_000,
};

describe("EVM chain service.", () => {
    let service: EVMChainService;

    const mockConfigService = {
        asset: jest.fn(),
        assetByTicker: jest.fn(),
        feeReceiverAddress: jest.fn(),
        signerPrivateKey: jest.fn(),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        isFeeReceiverSameAsSigner: jest.fn(),
        flatFeeAmount: jest.fn(),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8545"),
        relayContractAddress: jest.fn().mockReturnValue("0x5FbDB2315678afecb367f032d93F642f64180aa3"),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EVMChainService,
                { provide: EvmConfigService, useValue: mockConfigService },
                createMockLoggerProvider(),
                {
                    provide: CHAIN_CONTEXT,
                    useValue: {
                        chainType: ChainType.EVM,
                        chainId: "31337",
                    },
                },
            ],
        }).compile();

        jest.clearAllMocks();
        service = await module.resolve<EVMChainService>(EVMChainService);
    });

    it("Should be defined", () => {
        expect(service).toBeDefined();
    });

    it("Signs a quote.", async () => {
        // Mock response so a signature is available.
        mockConfigService.signerPrivateKey.mockReturnValue(FIRST_ANVIL_PKEY);
        const signature: Bytes = await service.signRelayWithdrawalCommitment(exampleFeeCommitment);
        expect(signature).toBeDefined();
    });

    it("Signs a non extra gas quote and validates it.", async () => {
        // Mock response so a signature is available.
        mockConfigService.signerPrivateKey.mockReturnValue(FIRST_ANVIL_PKEY);
        const signature: Bytes = await service.signRelayWithdrawalCommitment(exampleFeeCommitment);

        const verificationParams = {
            ...exampleFeeCommitment,
            signedRelayerCommitment: signature,
        };

        const verification = await service.verifyRelayWithdrawalCommitment(verificationParams);
        expect(verification).toBe(true);
    });

    it("Signs an extra gas quote and validates it.", async () => {
        // Mock response so a signature is available.
        mockConfigService.signerPrivateKey.mockReturnValue(FIRST_ANVIL_PKEY);
        const signature: Bytes = await service.signRelayWithdrawalCommitment(exampleFeeCommitment);

        const verificationParams = {
            ...exampleFeeCommitment,
            signedRelayerCommitment: signature,
            extraGasTxCost: 320000n,
            extraGasFundAmount: 600000n,
        };

        const verification = await service.verifyRelayWithdrawalCommitment(verificationParams);
        expect(verification).toBe(true);
    });

    describe("signerAddress (issue #222 — dust #1 forwarding)", () => {
        it("derives this chain's signer address from the configured private key.", async () => {
            mockConfigService.signerPrivateKey.mockReturnValue(FIRST_ANVIL_PKEY);

            const address = await service.signerAddress();

            expect(address).toBe(getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
        });
    });

    // sendRawTransaction / waitForTransactionReceipt make real RPC calls (like every
    // other write/read method on this service — see the file's existing coverage
    // boundary above) and so aren't unit-tested here; dust-rescue-forwarding.service.spec.ts
    // covers their call sites with EVMChainService itself mocked.

    describe("safeErrorMessage (audit R-H4)", () => {
        const SENTINEL_RECIPIENT = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
        const TEST_ABI = [
            {
                type: "function",
                name: "relay",
                stateMutability: "nonpayable",
                inputs: [{ name: "recipient", type: "address" }],
                outputs: [],
            },
            { type: "error", name: "NullifierAlreadySpent", inputs: [] },
        ] as const;

        const safeErrorMessage = (error: unknown): string =>
            (service as unknown as { safeErrorMessage(e: unknown): string }).safeErrorMessage(error);

        it("Strips call args from viem contract errors but keeps the decoded revert name.", () => {
            const revert = new ContractFunctionRevertedError({
                abi: TEST_ABI,
                functionName: "relay",
                data: encodeErrorResult({ abi: TEST_ABI, errorName: "NullifierAlreadySpent" }),
            });
            const error = new ContractFunctionExecutionError(revert, {
                abi: TEST_ABI,
                functionName: "relay",
                args: [SENTINEL_RECIPIENT],
                contractAddress: getAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3"),
            });

            // Guard: the raw viem message really does embed the call args.
            expect(error.message.toLowerCase()).toContain(SENTINEL_RECIPIENT.toLowerCase());

            const safe = safeErrorMessage(error);
            expect(safe.toLowerCase()).not.toContain(SENTINEL_RECIPIENT.toLowerCase());
            expect(safe).toContain("NullifierAlreadySpent");
        });

        it("Passes plain Error messages through and falls back for non-Errors.", () => {
            expect(safeErrorMessage(new Error("boom"))).toBe("boom");
            expect(safeErrorMessage("boom")).toBe("Unknown error");
        });
    });
});
