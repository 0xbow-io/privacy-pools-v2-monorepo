import { Test, TestingModule } from "@nestjs/testing";
import { RateProvider } from "../../rate_provider/rate_types";
import { mock } from "jest-mock-extended";
import { BadRequestException } from "@nestjs/common";
import { Address, Hex, getAddress, encodeErrorResult, getContractError, HttpRequestError, RawContractError } from "viem";
import { EvmRelayService } from "./evm.relay.service";
import { DustRescueOrchestratorService } from "./dust-rescue-orchestrator.service";
import { DustRescuePricingService } from "./dust-rescue-pricing.service";
import { DustRescueForwardingService } from "./dust-rescue-forwarding.service";
import { YieldZapRegistry } from "../../rate_provider/yield_zap_registry";

// Auto-mocked: the real module imports @privacy-pools-v2/evm-sdk's LiFiSwapQuoteProvider,
// whose built CJS bundle require()s `multiformats/cid` — an ESM-only package with no
// `require` export condition, so it can't be loaded under jest's CJS test runtime at
// all (pre-existing SDK build issue, unrelated to this file). Same reason
// detection.service.spec.ts mocks "@privacy-pools-v2/evm-sdk" directly.
jest.mock("./dust-rescue-forwarding.service", () => ({ DustRescueForwardingService: jest.fn() }));
import { EVMChainService } from "../../chain.service/evm.chain.service";
import { ALL_CONTRACT_ERRORS } from "../../chain.service/contract_errors";
import { EvmContractService } from "../../sdk/evm.contract.service";
import { EvmConfigService } from "../../config/evm/evm-config.service";
import { createMockLogger, createMockLoggerProvider } from "../../test/mocks";
import { FATLoggerService } from "../../logger/fat.logger.provider";
import { encodeWithdrawalFeeSplit } from "./fee_abi";
import { encodeRelaySwapRouting, RelaySwapRouting } from "./swap_routing_abi";
import { zEvmRelayRegisterAndWithdrawalRequest, zEvmRelayAndAnnounceRequest } from "./schemas";
import { CHAIN_CONTEXT } from "../../core/chain-context.token";
import { ChainType } from "../../config/enums";
import { EvmRelaySwapRequest } from "./types";
import { Wei } from "../../quote/evm/unit.types";
import type {
    EvmRelayRegisterAndWithdrawalRequest,
    EvmRelayAndAnnounceRequest,
    ReshapedProof,
    KeystoreRegistration,
    Announcement,
    Bytes,
} from "./types";
import type { ISignedWithdrawalFeeCommitment } from "../../relayer.types";

// Coverage for the atomic register-and-withdrawal path (register the account's keystore
// auth policy, then relay its withdrawal in one tx). Two layers:
//   1. EvmRelayService.registerAndWithdrawal — reuses the withdrawal fee quote and
//      forwards the registration leg untouched.
//   2. EVMChainService.simulateAndWriteRegisterAndRelay — builds the exact
//      on-chain call args, converting the hex uint256 registration fields to
//      bigint and targeting the relay contract's `registerAndRelay`.
// Plus a schema-level check that a malformed account is rejected.

const ASSET = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
const TOKEN_ID_OUT = BigInt(ASSET.toLowerCase());
const RECIPIENT = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const FEE_RECIPIENT = getAddress("0xc1ebfda3114bc2496e86d466b3082491a96767df");
const ACCOUNT = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const TX_HASH = "0xabc0000000000000000000000000000000000000000000000000000000000abc" as const;

const AMOUNT_OUT = 1_000_000n;
const FEE_AMOUNT = 10_000n;

const REGISTRATION: KeystoreRegistration = {
    account: ACCOUNT,
    authDigest: "0x1a2b3c",
    nullifyingKeyHash: "0x4d5e6f",
    deadline: "0x64",
    signature: "0xabcd",
};

const ANNOUNCEMENT: Announcement = {
    schemeId: "0x1",
    stealthAddress: RECIPIENT,
    ephemeralPubKey: "0x0369abcd",
    metadata: "0x01",
};

function makeProof(): ReshapedProof {
    return {
        pA: [0n, 0n],
        pB: [
            [0n, 0n],
            [0n, 0n],
        ],
        pC: [0n, 0n],
        pubSignals: [[], [], [0n], [0n], [0n], [AMOUNT_OUT], [TOKEN_ID_OUT], [0n]],
        parsedPubSignals: {
            nullifierHashes: [],
            outputCommitments: [],
            stateRoot: "0x0",
            keyRegistryRoot: "0x0",
            associationSetRoot: "0x0",
            amountOut: AMOUNT_OUT,
            tokenIdOut: TOKEN_ID_OUT,
            context: "0x0",
        },
    } as unknown as ReshapedProof;
}

function makeCommitment(): ISignedWithdrawalFeeCommitment {
    return {
        data: encodeWithdrawalFeeSplit(RECIPIENT, FEE_RECIPIENT, FEE_AMOUNT, 0n),
        asset: ASSET,
        expiration: Date.now() + 10_000_000,
        feeAmount: FEE_AMOUNT,
        recipient: RECIPIENT,
        amountSent: AMOUNT_OUT,
        amountReceived: AMOUNT_OUT - FEE_AMOUNT,
        signedRelayerCommitment: "0x00",
    } as unknown as ISignedWithdrawalFeeCommitment;
}

function makeRequest(
    overrides: Partial<EvmRelayRegisterAndWithdrawalRequest> = {}
): EvmRelayRegisterAndWithdrawalRequest {
    return {
        proof: makeProof(),
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: [],
        signedFeeCommitment: makeCommitment(),
        registration: REGISTRATION,
        ...overrides,
    } as unknown as EvmRelayRegisterAndWithdrawalRequest;
}

describe("EvmRelayService.registerAndWithdrawal", () => {
    let service: EvmRelayService;
    let module: TestingModule;

    const chainService = mock<EVMChainService>();
    const contractService = mock<EvmContractService>();
    const config = mock<EvmConfigService>();
    const dustRescueOrchestrator = mock<DustRescueOrchestratorService>();
    const dustRescuePricing = mock<DustRescuePricingService>();
    const dustRescueForwarding = mock<DustRescueForwardingService>();
    const yieldZapRegistry = mock<YieldZapRegistry>();

    beforeEach(async () => {
        module = await Test.createTestingModule({
            providers: [
                EvmRelayService,
                createMockLoggerProvider(),
                { provide: EVMChainService, useValue: chainService },
                { provide: EvmContractService, useValue: contractService },
                { provide: EvmConfigService, useValue: config },
                { provide: DustRescueOrchestratorService, useValue: dustRescueOrchestrator },
                { provide: DustRescuePricingService, useValue: dustRescuePricing },
                { provide: DustRescueForwardingService, useValue: dustRescueForwarding },
                { provide: YieldZapRegistry, useValue: yieldZapRegistry },
            ],
        }).compile();

        service = await module.resolve<EvmRelayService>(EvmRelayService);
        jest.clearAllMocks();

        chainService.verifyRelayWithdrawalCommitment.mockResolvedValue(true);
        contractService.sdkRegisterAndWithdraw.mockResolvedValue({
            txHash: TX_HASH,
            amountOut: AMOUNT_OUT,
            recipientAddress: RECIPIENT,
            fee: FEE_AMOUNT,
        });
    });

    it("forward the registration leg to the SDK and return the tx hash", async () => {
        const result = await service.registerAndWithdrawal(makeRequest());

        expect(result.txHash).toBe(TX_HASH);
        expect(contractService.sdkRegisterAndWithdraw).toHaveBeenCalledTimes(1);
        const [payload] = contractService.sdkRegisterAndWithdraw.mock.calls[0];
        // The registration object must survive the schema/service and reach the SDK.
        expect(payload.registration).toEqual(REGISTRATION);
        expect(payload.registration.account).toBe(ACCOUNT);
        expect(payload.registration.signature).toBe("0xabcd");
        // Reuses the withdrawal fee quote for the relay leg.
        expect(chainService.verifyRelayWithdrawalCommitment).toHaveBeenCalledTimes(1);
    });

    it("reject a zero amountOut proof", async () => {
        const zeroProof = makeProof();
        (zeroProof as unknown as { parsedPubSignals: { amountOut: bigint } }).parsedPubSignals.amountOut = 0n;

        await expect(
            service.registerAndWithdrawal(makeRequest({ proof: zeroProof }))
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(contractService.sdkRegisterAndWithdraw).not.toHaveBeenCalled();
    });

    it("never logs the request payload (proof, registration, routing) — issue #400", async () => {
        await service.registerAndWithdrawal(makeRequest());

        const logger = module.get(FATLoggerService) as unknown as ReturnType<typeof createMockLogger>;
        const logs = JSON.stringify(
            [logger.log, logger.info, logger.error, logger.warn, logger.debug, logger.verbose].map((fn) => fn.mock.calls),
            (_key, value) => (typeof value === "bigint" ? value.toString() : value)
        );
        expect(logs.toLowerCase()).not.toContain(RECIPIENT.toLowerCase());
        expect(logs).not.toContain(REGISTRATION.signature);
        expect(logs).not.toContain(REGISTRATION.authDigest);
        expect(logs).not.toContain(AMOUNT_OUT.toString());
    });
});

// -========- Schema validation -========-

describe("zEvmRelayRegisterAndWithdrawalRequest schema", () => {
    // A well-formed snarkjs 1x1 proof body (8 public signals) so validation
    // reaches the registration.account check rather than failing earlier.
    const baseBody = () => ({
        proof: {
            pi_a: ["1", "2", "1"],
            pi_b: [
                ["1", "2"],
                ["3", "4"],
                ["1", "0"],
            ],
            pi_c: ["5", "6", "1"],
            publicSignals: ["1", "2", "3", "4", "5", "6", "7", "8"],
        },
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: [],
        signedFeeCommitment: {
            data: "0x00",
            asset: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            expiration: Date.now() + 10_000_000,
            feeAmount: "1",
            recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
            amountSent: "1",
            amountReceived: "0",
            signedRelayerCommitment: "0x00",
        },
        registration: {
            account: "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
            authDigest: "0x1a2b3c",
            nullifyingKeyHash: "0x4d5e6f",
            deadline: "0x64",
            signature: "0xabcd",
        },
    });

    it("reject a malformed registration.account", () => {
        const body = baseBody();
        body.registration.account = "0xnot-an-address";

        expect(() => zEvmRelayRegisterAndWithdrawalRequest.parse(body)).toThrow();
    });

    it("preserve the registration hex fields through parsing", () => {
        const parsed = zEvmRelayRegisterAndWithdrawalRequest.parse(baseBody());
        expect(parsed.registration.authDigest).toBe("0x1a2b3c");
        expect(parsed.registration.nullifyingKeyHash).toBe("0x4d5e6f");
        expect(parsed.registration.deadline).toBe("0x64");
        expect(parsed.registration.signature).toBe("0xabcd");
    });
});

// -========- Chain-service on-chain arg construction -========-

const FIRST_ANVIL_PKEY: Bytes = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAY_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;

describe("EVMChainService.simulateAndWriteRegisterAndRelay", () => {
    let service: EVMChainService;

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8545"),
        relayContractAddress: jest.fn().mockReturnValue(RELAY_CONTRACT),
    };

    function stubClients() {
        const simulateContract = jest.fn(async () => ({ request: { some: "request" } }));
        const writeContract = jest.fn(async () => TX_HASH);
        const mockPublicClient = { simulateContract, estimateContractGas: jest.fn(async () => 500_000n) };
        const mockWalletClient = {
            account: { address: "0x0000000000000000000000000000000000000001" },
            writeContract,
        };
        jest.spyOn(service as unknown as { client: () => unknown }, "client").mockResolvedValue(mockPublicClient);
        jest.spyOn(service as unknown as { signer: () => unknown }, "signer").mockResolvedValue(mockWalletClient);
        return { simulateContract, writeContract };
    }

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EVMChainService,
                { provide: EvmConfigService, useValue: mockConfigService },
                createMockLoggerProvider(),
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.EVM, chainId: "31337" } },
            ],
        }).compile();

        service = await module.resolve<EVMChainService>(EVMChainService);
        jest.clearAllMocks();
    });

    it("build the registerAndRelay call args with hex uint256 fields converted to bigint", async () => {
        const { simulateContract, writeContract } = stubClients();

        const result = await service.simulateAndWriteRegisterAndRelay({
            proof: makeProof(),
            noteData: [],
            data: "0x00",
            registration: REGISTRATION,
        });

        expect(result).toBe(TX_HASH);
        expect(simulateContract).toHaveBeenCalledTimes(1);
        const [call] = simulateContract.mock.calls[0] as [Record<string, unknown>];
        expect(call.address).toBe(RELAY_CONTRACT);
        expect(call.functionName).toBe("registerAndRelay");

        // args = [account, authDigest, nullifyingKeyHash, deadline, signature,
        //         proof, {data, processor}, noteData]
        const args = call.args as unknown[];
        expect(args[0]).toBe(ACCOUNT);
        expect(args[1]).toBe(BigInt("0x1a2b3c"));
        expect(args[2]).toBe(BigInt("0x4d5e6f"));
        expect(args[3]).toBe(BigInt("0x64"));
        expect(args[4]).toBe("0xabcd");
        expect((args[6] as { processor: string; data: string }).processor).toBe(RELAY_CONTRACT);
        expect((args[6] as { processor: string; data: string }).data).toBe("0x00");
        expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request" }));
    });

    it("wrap a simulation revert in a BadRequestException", async () => {
        const simulateContract = jest.fn(async () => {
            throw new Error("register reverted");
        });
        jest.spyOn(service as unknown as { client: () => unknown }, "client").mockResolvedValue({ simulateContract, estimateContractGas: jest.fn(async () => 500_000n) });
        jest.spyOn(service as unknown as { signer: () => unknown }, "signer").mockResolvedValue({
            account: { address: "0x0000000000000000000000000000000000000001" },
            writeContract: jest.fn(),
        });

        await expect(
            service.simulateAndWriteRegisterAndRelay({
                proof: makeProof(),
                noteData: [],
                data: "0x00",
                registration: REGISTRATION,
            })
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    // G1 (TEST-7): the register leg calls Keystore.setAuthPolicyWithSig, so a bad/expired
    // signature reverts with a Keystore custom error. The production catch surfaces the revert
    // via viem's `error.message`, which viem decodes using the `ALL_CONTRACT_ERRORS` list embedded
    // in the simulate ABI (evm.chain.service.ts:470). This drives that path with REAL encoded
    // revert bytes wrapped exactly as viem's `simulateContract` wraps them (`getContractError` +
    // `RawContractError`, decoding against the SAME production `ALL_CONTRACT_ERRORS`), and asserts
    // the surfaced BadRequestException names the actual Keystore error rather than a raw selector.
    it("surface the decoded Keystore error name when the register simulation reverts with real revert data", async () => {
        const revertData = encodeErrorResult({
            abi: [{ type: "error", name: "Keystore_SignatureExpired", inputs: [] }],
            errorName: "Keystore_SignatureExpired",
        });
        // Wrap the raw revert exactly as viem's simulateContract does on a real revert, decoding
        // against the relayer's actual ALL_CONTRACT_ERRORS (not a bespoke throwaway ABI).
        const viemRevert = getContractError(new RawContractError({ data: revertData }), {
            abi: ALL_CONTRACT_ERRORS,
            functionName: "registerAndRelay",
            args: [],
        });
        const simulateContract = jest.fn(async () => {
            throw viemRevert;
        });
        jest.spyOn(service as unknown as { client: () => unknown }, "client").mockResolvedValue({ simulateContract, estimateContractGas: jest.fn(async () => 500_000n) });
        jest.spyOn(service as unknown as { signer: () => unknown }, "signer").mockResolvedValue({
            account: { address: "0x0000000000000000000000000000000000000001" },
            writeContract: jest.fn(),
        });

        const error = await service
            .simulateAndWriteRegisterAndRelay({
                proof: makeProof(),
                noteData: [],
                data: "0x00",
                registration: REGISTRATION,
            })
            .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BadRequestException);
        // The message names the decoded Keystore error, proving ALL_CONTRACT_ERRORS decodes real
        // register-path revert bytes on this exact path — not a raw `0x…` selector.
        expect((error as Error).message).toContain("Keystore_SignatureExpired");
        expect((error as Error).message).not.toMatch(/0x[0-9a-f]{8}\b/i);
    });
});

// -========- relay-and-announce -========-

// Coverage for the atomic `relayAndAnnounce` path (relay the withdrawal to a
// stealth address, then publish its ERC-5564 announcement in one tx). Mirrors the
// register-and-relay coverage above: the service reuses the withdrawal fee quote
// and forwards the announcement leg untouched; the chain service builds the exact
// on-chain call args (schemeId hex→bigint, announcement tuple); and the schema
// rejects a malformed stealthAddress while preserving the announcement fields.

function makeAnnounceRequest(overrides: Partial<EvmRelayAndAnnounceRequest> = {}): EvmRelayAndAnnounceRequest {
    return {
        proof: makeProof(),
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: [],
        signedFeeCommitment: makeCommitment(),
        announcement: ANNOUNCEMENT,
        ...overrides,
    } as unknown as EvmRelayAndAnnounceRequest;
}

describe("EvmRelayService.relayAndAnnounce", () => {
    let service: EvmRelayService;
    let module: TestingModule;

    const chainService = mock<EVMChainService>();
    const contractService = mock<EvmContractService>();
    const config = mock<EvmConfigService>();
    const dustRescueOrchestrator = mock<DustRescueOrchestratorService>();
    const dustRescuePricing = mock<DustRescuePricingService>();
    const dustRescueForwarding = mock<DustRescueForwardingService>();
    const yieldZapRegistry = mock<YieldZapRegistry>();

    beforeEach(async () => {
        module = await Test.createTestingModule({
            providers: [
                EvmRelayService,
                createMockLoggerProvider(),
                { provide: EVMChainService, useValue: chainService },
                { provide: EvmContractService, useValue: contractService },
                { provide: EvmConfigService, useValue: config },
                { provide: DustRescueOrchestratorService, useValue: dustRescueOrchestrator },
                { provide: DustRescuePricingService, useValue: dustRescuePricing },
                { provide: DustRescueForwardingService, useValue: dustRescueForwarding },
                { provide: YieldZapRegistry, useValue: yieldZapRegistry },
            ],
        }).compile();

        service = await module.resolve<EvmRelayService>(EvmRelayService);
        jest.clearAllMocks();

        chainService.verifyRelayWithdrawalCommitment.mockResolvedValue(true);
        contractService.sdkRelayAndAnnounce.mockResolvedValue({
            txHash: TX_HASH,
            amountOut: AMOUNT_OUT,
            recipientAddress: RECIPIENT,
            fee: FEE_AMOUNT,
        });
    });

    it("forward the announcement leg to the SDK and return the tx hash", async () => {
        const result = await service.relayAndAnnounce(makeAnnounceRequest());

        expect(result.txHash).toBe(TX_HASH);
        expect(contractService.sdkRelayAndAnnounce).toHaveBeenCalledTimes(1);
        const [payload] = contractService.sdkRelayAndAnnounce.mock.calls[0];
        // The announcement object must survive the schema/service and reach the SDK untouched.
        expect(payload.announcement).toEqual(ANNOUNCEMENT);
        expect(payload.announcement.stealthAddress).toBe(RECIPIENT);
        expect(payload.announcement.ephemeralPubKey).toBe("0x0369abcd");
        // Reuses the withdrawal fee quote for the relay leg (verified exactly once).
        expect(chainService.verifyRelayWithdrawalCommitment).toHaveBeenCalledTimes(1);
    });

    it("reject a zero amountOut proof", async () => {
        const zeroProof = makeProof();
        (zeroProof as unknown as { parsedPubSignals: { amountOut: bigint } }).parsedPubSignals.amountOut = 0n;

        await expect(
            service.relayAndAnnounce(makeAnnounceRequest({ proof: zeroProof }))
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(contractService.sdkRelayAndAnnounce).not.toHaveBeenCalled();
    });

    it("never logs the request payload (proof, stealth announcement, routing) — issue #400", async () => {
        await service.relayAndAnnounce(makeAnnounceRequest());

        const logger = module.get(FATLoggerService) as unknown as ReturnType<typeof createMockLogger>;
        const logs = JSON.stringify(
            [logger.log, logger.info, logger.error, logger.warn, logger.debug, logger.verbose].map((fn) => fn.mock.calls),
            (_key, value) => (typeof value === "bigint" ? value.toString() : value)
        );
        expect(logs.toLowerCase()).not.toContain(ANNOUNCEMENT.stealthAddress.toLowerCase());
        expect(logs).not.toContain(ANNOUNCEMENT.ephemeralPubKey);
        expect(logs).not.toContain(AMOUNT_OUT.toString());
    });
});

describe("zEvmRelayAndAnnounceRequest schema", () => {
    const baseBody = () => ({
        proof: {
            pi_a: ["1", "2", "1"],
            pi_b: [
                ["1", "2"],
                ["3", "4"],
                ["1", "0"],
            ],
            pi_c: ["5", "6", "1"],
            publicSignals: ["1", "2", "3", "4", "5", "6", "7", "8"],
        },
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: [],
        signedFeeCommitment: {
            data: "0x00",
            asset: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            expiration: Date.now() + 10_000_000,
            feeAmount: "1",
            recipient: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
            amountSent: "1",
            amountReceived: "0",
            signedRelayerCommitment: "0x00",
        },
        announcement: {
            schemeId: "0x1",
            stealthAddress: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
            ephemeralPubKey: "0x0369abcd",
            metadata: "0x01",
        },
    });

    it("accept a valid relay-and-announce request", () => {
        expect(() => zEvmRelayAndAnnounceRequest.parse(baseBody())).not.toThrow();
    });

    it("reject a malformed announcement.stealthAddress", () => {
        const body = baseBody();
        body.announcement.stealthAddress = "0xnot-an-address";

        expect(() => zEvmRelayAndAnnounceRequest.parse(body)).toThrow();
    });

    it("preserve the announcement fields through parsing (not stripped)", () => {
        const parsed = zEvmRelayAndAnnounceRequest.parse(baseBody());
        expect(parsed.announcement.schemeId).toBe("0x1");
        // zEvmAddress normalizes to the EIP-55 checksummed form.
        expect(parsed.announcement.stealthAddress).toBe(getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8"));
        expect(parsed.announcement.ephemeralPubKey).toBe("0x0369abcd");
        expect(parsed.announcement.metadata).toBe("0x01");
    });
});

describe("EVMChainService.simulateAndWriteRelayAndAnnounce", () => {
    let service: EVMChainService;

    const mockConfigService = {
        signerPrivateKey: jest.fn().mockReturnValue(FIRST_ANVIL_PKEY),
        relayGasCapMultiplier: jest.fn().mockReturnValue(3n),
        chainConfig: jest.fn().mockReturnValue({ name: "anvil" }),
        nativeCurrency: jest.fn().mockReturnValue({ name: "Ether", symbol: "ETH", decimals: 18 }),
        rpcUrl: jest.fn().mockReturnValue("http://localhost:8545"),
        relayContractAddress: jest.fn().mockReturnValue(RELAY_CONTRACT),
    };

    function stubClients() {
        const simulateContract = jest.fn(async () => ({ request: { some: "request" } }));
        const writeContract = jest.fn(async () => TX_HASH);
        const mockPublicClient = { simulateContract, estimateContractGas: jest.fn(async () => 500_000n) };
        const mockWalletClient = {
            account: { address: "0x0000000000000000000000000000000000000001" },
            writeContract,
        };
        jest.spyOn(service as unknown as { client: () => unknown }, "client").mockResolvedValue(mockPublicClient);
        jest.spyOn(service as unknown as { signer: () => unknown }, "signer").mockResolvedValue(mockWalletClient);
        return { simulateContract, writeContract };
    }

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                EVMChainService,
                { provide: EvmConfigService, useValue: mockConfigService },
                createMockLoggerProvider(),
                { provide: CHAIN_CONTEXT, useValue: { chainType: ChainType.EVM, chainId: "31337" } },
            ],
        }).compile();

        service = await module.resolve<EVMChainService>(EVMChainService);
        jest.clearAllMocks();
    });

    it("build the relayAndAnnounce call args with schemeId hex converted to bigint and the announcement tuple", async () => {
        const { simulateContract, writeContract } = stubClients();

        const result = await service.simulateAndWriteRelayAndAnnounce({
            proof: makeProof(),
            noteData: [],
            data: "0x00",
            announcement: ANNOUNCEMENT,
        });

        expect(result).toBe(TX_HASH);
        expect(simulateContract).toHaveBeenCalledTimes(1);
        const [call] = simulateContract.mock.calls[0] as [Record<string, unknown>];
        expect(call.address).toBe(RELAY_CONTRACT);
        expect(call.functionName).toBe("relayAndAnnounce");

        // args = [proof, {data, processor}, noteData, announcement]
        const args = call.args as unknown[];
        expect((args[1] as { processor: string; data: string }).processor).toBe(RELAY_CONTRACT);
        expect((args[1] as { processor: string; data: string }).data).toBe("0x00");
        const ann = args[3] as {
            schemeId: bigint;
            stealthAddress: string;
            ephemeralPubKey: string;
            metadata: string;
        };
        expect(ann.schemeId).toBe(BigInt("0x1"));
        expect(ann.stealthAddress).toBe(RECIPIENT);
        expect(ann.ephemeralPubKey).toBe("0x0369abcd");
        expect(ann.metadata).toBe("0x01");
        expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ some: "request" }));
    });

    it("wrap a simulation revert in a BadRequestException", async () => {
        const simulateContract = jest.fn(async () => {
            throw new Error("announce reverted");
        });
        jest.spyOn(service as unknown as { client: () => unknown }, "client").mockResolvedValue({ simulateContract, estimateContractGas: jest.fn(async () => 500_000n) });
        jest.spyOn(service as unknown as { signer: () => unknown }, "signer").mockResolvedValue({
            account: { address: "0x0000000000000000000000000000000000000001" },
            writeContract: jest.fn(),
        });

        await expect(
            service.simulateAndWriteRelayAndAnnounce({
                proof: makeProof(),
                noteData: [],
                data: "0x00",
                announcement: ANNOUNCEMENT,
            })
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});

// -========- relaySwap -========-

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const SWAP_RECIPIENT: Address = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
const FEE_RECEIVER: Address = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
// Arbitrary key distinct from FEE_RECEIVER, used only to assert the relay-time guard
// accepts the signer-routed feeRecipient a nativeGas > 0 quote produces (F-242 follow-up).
const SIGNER_PKEY: Hex = "0x07a2daa03a9e3588f4bff7f6f7ed419f1f3e90846133ec8f01c450f536fb8e1d";
const SIGNER_ADDRESS: Address = "0x972e3115864993BD97cE4D09Bd18B2aa685515e9";
const SWAP_TARGET: Address = getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
const RELAY_SWAPS_ADDRESS: Address = getAddress("0x000000000000000000000000000000000e1a75aa");
const TEST_ASSET: Address = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const OUTPUT_TOKEN: Address = getAddress("0x0000000eF0000000000B00000000000000000000");

const AMOUNT = 1_000_000n;

const NO_DUST_RESCUE: RelaySwapRouting["dustRescue"] = {
    chainId: 0n,
    tokenId: ZERO_ADDRESS,
    isCanonical: false,
    spendingPubKey: "0x",
    viewingPubKey: "0x",
};

function buildRouting(overrides: Partial<RelaySwapRouting> = {}): RelaySwapRouting {
    return {
        swapTarget: SWAP_TARGET,
        approvalAddress: SWAP_TARGET,
        outputToken: OUTPUT_TOKEN,
        recipient: SWAP_RECIPIENT,
        feeRecipient: FEE_RECEIVER,
        fallbackAddress: SWAP_RECIPIENT,
        dustRecipient: SWAP_RECIPIENT,
        feeAmount: 0n,
        minOutputAmount: 0n,
        nativeGas: 0n,
        swapValue: 0n,
        gasSwapMaxInput: 0n,
        gasSwapCalldata: "0x",
        swapCalldata: "0xdeadbeef",
        dustRescue: NO_DUST_RESCUE,
        ...overrides,
    };
}

// RC-10: dustRescue now rides inside the routing itself (proof-bound), not a separate
// request field — every dustRescue-opted-in test below shares this fixture.
const DUST_ROUTING: RelaySwapRouting["dustRescue"] = {
    chainId: 8453n,
    tokenId: TEST_ASSET,
    isCanonical: false,
    spendingPubKey: "0xdead",
    viewingPubKey: "0x",
};

function buildDustRescueRequest(): EvmRelaySwapRequest {
    return buildRequest(buildRouting({ recipient: ZERO_ADDRESS, dustRescue: DUST_ROUTING }));
}

function buildRequest(routing: RelaySwapRouting): EvmRelaySwapRequest {
    const asset = BigInt(TEST_ASSET);
    return {
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: [],
        proof: {
            pA: [0n, 0n],
            pB: [
                [0n, 0n],
                [0n, 0n],
            ],
            pC: [0n, 0n],
            pubSignals: [[0n], [0n], [0n], [0n], [0n], [AMOUNT], [asset], [0n]],
            parsedPubSignals: {
                nullifierHashes: ["0x0"],
                outputCommitments: ["0x0"],
                stateRoot: "0x0",
                keyRegistryRoot: "0x0",
                associationSetRoot: "0x0",
                amountOut: AMOUNT,
                tokenIdOut: asset,
                context: "0x0",
            },
        },
        signedSwapCommitment: {
            data: encodeRelaySwapRouting(routing),
            asset: TEST_ASSET,
            expiration: Number(new Date()) + 60_000,
            feeAmount: Wei(0n),
            recipient: routing.recipient,
            amountSent: Wei(AMOUNT),
            signedRelayerCommitment: "0xdeadbeef",
        },
    } as unknown as EvmRelaySwapRequest;
}

describe("EvmRelayService (relaySwap)", () => {
    let service: EvmRelayService;
    let module: TestingModule;

    const mockConfigService = mock<EvmConfigService>();
    const mockChainService = mock<EVMChainService>();
    const mockContractService = mock<EvmContractService>();
    const mockDustRescueOrchestrator = mock<DustRescueOrchestratorService>();
    const mockDustRescuePricing = mock<DustRescuePricingService>();
    const mockDustRescueForwarding = mock<DustRescueForwardingService>();
    const mockYieldZapRegistry = mock<YieldZapRegistry>();

    beforeEach(async () => {
        module = await Test.createTestingModule({
            providers: [
                EvmRelayService,
                createMockLoggerProvider(),
                { provide: EvmConfigService, useValue: mockConfigService },
                { provide: EVMChainService, useValue: mockChainService },
                { provide: EvmContractService, useValue: mockContractService },
                { provide: DustRescueOrchestratorService, useValue: mockDustRescueOrchestrator },
                { provide: DustRescuePricingService, useValue: mockDustRescuePricing },
                { provide: DustRescueForwardingService, useValue: mockDustRescueForwarding },
                { provide: YieldZapRegistry, useValue: mockYieldZapRegistry },
            ],
        }).compile();

        service = await module.resolve<EvmRelayService>(EvmRelayService);

        jest.clearAllMocks();
        mockConfigService.relaySwapsContractAddress.mockReturnValue(RELAY_SWAPS_ADDRESS);
        mockConfigService.feeReceiverAddress.mockReturnValue(FEE_RECEIVER);
        mockConfigService.chainId.mockReturnValue(42161);
        // Default: fee receiver and signer are the same operator address, so nativeGas > 0
        // never redirects the expected fee recipient away from FEE_RECEIVER in these specs.
        mockConfigService.isFeeReceiverSameAsSigner.mockReturnValue(true);
        mockConfigService.maxSwapValueWei.mockReturnValue(Wei(5_000_000_000_000_000n)); // 0.005 ETH (B2)
        mockChainService.verifyRelaySwapCommitment.mockResolvedValue(true);
        // Default: matches buildRouting()'s default dustRecipient, so the RC-03
        // dustRescue/dustRecipient guard doesn't fire for specs that don't test it.
        mockChainService.signerAddress.mockResolvedValue(SWAP_RECIPIENT);
        mockContractService.sdkRelaySwap.mockResolvedValue({ txHash: "0xabc123" } as never);
        mockDustRescuePricing.priceForRescue.mockResolvedValue({
            source: "Curve",
            microUsdPerWholeTokenX1e18: "0x1",
            tokenDecimals: 18,
        } as never);
        // Default: uncapped (maxRelayFee === 0n) so the L-4 ceiling never blocks the
        // routing.feeAmount === 0n cases used by the other specs.
        mockContractService.getAssetConfig.mockResolvedValue({ maxRelayFee: Wei(0n) } as never);
        // Default: a plain (non-yield) asset — relayed through execute(), no zap.
        mockConfigService.asset.mockReturnValue({
            address: TEST_ASSET,
            ticker: "USDC",
            quoter: RateProvider.COWSWAP,
            decimals: 6,
        } as never);
    });

    it("Relays a yield share through executeUnwrapped with the boot-derived zap.", async () => {
        const ZAP = "0x000000000000000000000000000000000000Za90".replace("Za", "0a") as `0x${string}`;
        mockConfigService.asset.mockReturnValue({
            address: TEST_ASSET,
            ticker: "ppUSDC",
            quoter: RateProvider.UNDERLYING,
            underlying: "0x000000000000000000000000000000000000000a",
            decimals: 18,
        } as never);
        mockYieldZapRegistry.zapForShare.mockReturnValue(ZAP);
        const request = buildRequest(buildRouting({ recipient: ZERO_ADDRESS }));
        await service.relaySwap(request);
        expect(mockContractService.sdkRelaySwap).toHaveBeenCalledWith(expect.objectContaining({ zap: ZAP }));
    });

    it("Rejects a yield share with no boot-derived zap.", async () => {
        mockConfigService.asset.mockReturnValue({
            address: TEST_ASSET,
            ticker: "ppUSDC",
            quoter: RateProvider.UNDERLYING,
            underlying: "0x000000000000000000000000000000000000000a",
            decimals: 18,
        } as never);
        mockYieldZapRegistry.zapForShare.mockReturnValue(undefined);
        const request = buildRequest(buildRouting({ recipient: ZERO_ADDRESS }));
        await expect(service.relaySwap(request)).rejects.toThrow(/no approved zap was derived/);
        expect(mockContractService.sdkRelaySwap).not.toHaveBeenCalled();
    });

    it("Relays a plain asset through execute() with no zap.", async () => {
        const request = buildRequest(buildRouting({ recipient: ZERO_ADDRESS }));
        await service.relaySwap(request);
        const payload = mockContractService.sdkRelaySwap.mock.calls[0][0];
        expect(payload.zap).toBeUndefined();
    });

    it("Relays a swap with a zero recipient when nativeGas and minOutputAmount are zero.", async () => {
        const request = buildRequest(buildRouting({ recipient: ZERO_ADDRESS }));

        const result = await service.relaySwap(request);

        expect(result.txHash).toBe("0xabc123");
        expect(mockContractService.sdkRelaySwap).toHaveBeenCalled();
    });

    it("Rejects a zero recipient with nonzero nativeGas.", async () => {
        const request = buildRequest(buildRouting({ recipient: ZERO_ADDRESS, nativeGas: 1n }));

        await expect(service.relaySwap(request)).rejects.toThrow(
            "nativeGas must be 0 when recipient is the zero address"
        );
    });

    it("Rejects a zero recipient with nonzero minOutputAmount.", async () => {
        const request = buildRequest(buildRouting({ recipient: ZERO_ADDRESS, minOutputAmount: 1n }));

        await expect(service.relaySwap(request)).rejects.toThrow(
            "minOutputAmount must be 0 when recipient is the zero address"
        );
    });

    it("Rejects a zero dustRecipient.", async () => {
        const request = buildRequest(buildRouting({ dustRecipient: ZERO_ADDRESS }));

        await expect(service.relaySwap(request)).rejects.toThrow("dustRecipient must not be zero");
    });

    // RC-03: a request that opts into dustRescue but names a dustRecipient other than
    // the relayer's own signer address is rejected up front, before broadcasting —
    // DustRescueForwardingService would silently forward nothing for it anyway (it
    // only ever measures transfers into its own signer wallet), so this exists purely
    // to fail loudly on a stale/misconfigured caller rather than degrade silently.
    it("Rejects a dustRescue-opted-in request whose dustRecipient is not the relayer's signer address.", async () => {
        const request = buildRequest(
            buildRouting({ recipient: ZERO_ADDRESS, dustRecipient: SWAP_RECIPIENT, dustRescue: DUST_ROUTING }),
        );
        mockChainService.signerAddress.mockResolvedValue(FEE_RECEIVER); // != SWAP_RECIPIENT

        await expect(service.relaySwap(request)).rejects.toThrow(
            /dustRecipient .* must equal the relayer's own signer address/
        );
        expect(mockContractService.sdkRelaySwap).not.toHaveBeenCalled();
    });

    // RC-10 defense-in-depth: mirrors RelaySwaps.sol's own zero-recipient invariant, in
    // case a stale commitment (signed by an older relayer version) carries a nonzero
    // recipient alongside a dustRescue opt-in that quote-time validation should have
    // already refused to sign.
    it("Rejects a dustRescue-opted-in request whose routing recipient is not the zero address.", async () => {
        const request = buildRequest(
            buildRouting({ recipient: SWAP_RECIPIENT, dustRecipient: SWAP_RECIPIENT, dustRescue: DUST_ROUTING }),
        );

        await expect(service.relaySwap(request)).rejects.toThrow(
            /dustRescue may only be requested when recipient is the zero address/
        );
        expect(mockDustRescueOrchestrator.registerPending).not.toHaveBeenCalled();
    });

    it("Does not check dustRecipient against the signer address when dustRescue is not requested.", async () => {
        const request = buildRequest(buildRouting({ dustRecipient: SWAP_RECIPIENT }));
        mockChainService.signerAddress.mockResolvedValue(FEE_RECEIVER); // != SWAP_RECIPIENT, irrelevant here

        const result = await service.relaySwap(request);

        expect(result.txHash).toBe("0xabc123");
    });

    // B2 defense-in-depth: re-cap the committed swapValue (native LZ fee RelaySwaps mints
    // in-contract) and the bounded gas-swap approval before dispatch.
    it("Rejects a reshield routing whose swapValue exceeds max_swap_value_wei.", async () => {
        const request = buildRequest(
            buildRouting({ recipient: ZERO_ADDRESS, swapValue: 20_000_000_000_000_000n }), // 0.02 ETH > 0.005 cap
        );

        await expect(service.relaySwap(request)).rejects.toThrow(/swapValue .* exceeds the maximum allowed/);
        expect(mockContractService.sdkRelaySwap).not.toHaveBeenCalled();
    });

    it("Rejects a reshield routing whose gasSwapMaxInput exceeds the post-fee amount.", async () => {
        // AMOUNT is the proof amountOut; feeAmount 0 here, so gasSwapMaxInput > AMOUNT fails.
        const request = buildRequest(
            buildRouting({
                recipient: ZERO_ADDRESS,
                swapValue: 1_000_000_000_000_000n,
                gasSwapMaxInput: AMOUNT * 2n,
            }),
        );

        await expect(service.relaySwap(request)).rejects.toThrow(/gasSwapMaxInput .* exceeds the post-fee amount/);
        expect(mockContractService.sdkRelaySwap).not.toHaveBeenCalled();
    });

    it("Relays a reshield with a within-bounds swapValue + gasSwapMaxInput.", async () => {
        const request = buildRequest(
            buildRouting({
                recipient: ZERO_ADDRESS,
                swapValue: 300_000_000_000_000n,
                gasSwapMaxInput: 1_000n,
                gasSwapCalldata: "0xc0ffee",
            }),
        );

        const result = await service.relaySwap(request);
        expect(result.txHash).toBe("0xabc123");
        expect(mockContractService.sdkRelaySwap).toHaveBeenCalled();
    });

    // L-4 defense-in-depth: re-check feeAmount <= maxRelayFee at relay time (the swap
    // relay path previously omitted this, unlike the batch/quote paths). maxRelayFee is
    // looked up from the Entrypoint asset config; a nonzero ceiling rejects an over-max fee.
    it("Rejects a routing whose feeAmount exceeds the asset's maxRelayFee.", async () => {
        mockContractService.getAssetConfig.mockResolvedValue({ maxRelayFee: Wei(100n) } as never);
        const request = buildRequest(buildRouting({ recipient: SWAP_RECIPIENT, feeAmount: 500n }));

        await expect(service.relaySwap(request)).rejects.toThrow(
            /feeAmount \(500\) exceeds maxRelayFee \(100\)/
        );
        expect(mockContractService.sdkRelaySwap).not.toHaveBeenCalled();
    });

    it("Allows a routing whose feeAmount is at or below the asset's maxRelayFee.", async () => {
        mockContractService.getAssetConfig.mockResolvedValue({ maxRelayFee: Wei(500n) } as never);
        const request = buildRequest(buildRouting({ recipient: SWAP_RECIPIENT, feeAmount: 500n }));

        const result = await service.relaySwap(request);

        expect(result.txHash).toBe("0xabc123");
        expect(mockContractService.sdkRelaySwap).toHaveBeenCalled();
    });

    // F-242 follow-up: quote-time routes the fee to the signer instead of the configured
    // feeReceiverAddress when nativeGas > 0 and isFeeReceiverSameAsSigner is false
    // (evm.quote.service.ts). The relay-time guard must accept that same commitment
    // rather than always comparing against feeReceiverAddress(), or every legitimately
    // signer-routed swap relay is rejected as a fee-recipient mismatch.
    it("Accepts a routing whose feeRecipient is the signer address when nativeGas > 0 and isFeeReceiverSameAsSigner is false.", async () => {
        mockConfigService.isFeeReceiverSameAsSigner.mockReturnValue(false);
        mockConfigService.signerPrivateKey.mockReturnValue(SIGNER_PKEY);
        const request = buildRequest(
            buildRouting({ recipient: SWAP_RECIPIENT, nativeGas: 1_000n, feeAmount: 10n, feeRecipient: SIGNER_ADDRESS })
        );

        const result = await service.relaySwap(request);

        expect(result.txHash).toBe("0xabc123");
        expect(mockContractService.sdkRelaySwap).toHaveBeenCalled();
    });

    it("Still rejects a feeRecipient that matches neither the signer nor the configured receiver (nativeGas > 0, isFeeReceiverSameAsSigner false).", async () => {
        mockConfigService.isFeeReceiverSameAsSigner.mockReturnValue(false);
        mockConfigService.signerPrivateKey.mockReturnValue(SIGNER_PKEY);
        const request = buildRequest(
            buildRouting({ recipient: SWAP_RECIPIENT, nativeGas: 1_000n, feeAmount: 10n, feeRecipient: FEE_RECEIVER })
        );

        await expect(service.relaySwap(request)).rejects.toThrow(/feeRecipient .* does not match relayer's fee address/);
        expect(mockContractService.sdkRelaySwap).not.toHaveBeenCalled();
    });

    it("Never logs proof, routing data, or recipient (audit R-H4).", async () => {
        const request = buildRequest(buildRouting());

        await service.relaySwap(request);

        const logger = module.get(FATLoggerService) as unknown as ReturnType<typeof createMockLogger>;
        const logs = JSON.stringify(
            [logger.log, logger.info, logger.error, logger.warn, logger.debug, logger.verbose].map((fn) => fn.mock.calls),
            (_key, value) => (typeof value === "bigint" ? value.toString() : value)
        );
        expect(logs.toLowerCase()).not.toContain(SWAP_RECIPIENT.toLowerCase());
        expect(logs).not.toContain(request.signedSwapCommitment.data);
        expect(logs).not.toContain("0xdeadbeef"); // swapCalldata / signed commitment
    });

    // dust-rescue-service handoff: registerPending is now published to Pub/Sub by
    // DustRescueOrchestratorService, and needs fromChainId sourced from the relayer's
    // own request-scoped EvmConfigService (the source chain of this relaySwap call), not
    // client-supplied wire data (dust_collection_service_detailed_design.org §9).
    it("Registers a pending dust rescue with fromChainId sourced from EvmConfigService.chainId() when dustRescue is opted in.", async () => {
        const request = buildDustRescueRequest();

        await service.relaySwap(request);

        expect(mockDustRescuePricing.priceForRescue).toHaveBeenCalledWith(8453, TEST_ASSET);
        expect(mockDustRescueOrchestrator.registerPending).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceTxHash: "0xabc123",
                fromChainId: 42161,
                destinationChainId: 8453,
                tokenId: TEST_ASSET,
                usdRate: { source: "Curve", microUsdPerWholeTokenX1e18: "0x1", tokenDecimals: 18 },
                // 10% of AMOUNT_OUT (1_000_000) — anything swept above this is principal, not dust (minr #2)
                maxDustAmount: "0x186a0",
            })
        );
    });

    it("Does not price or register a dust rescue when the request did not opt in.", async () => {
        const request = buildRequest(buildRouting());

        await service.relaySwap(request);

        expect(mockDustRescuePricing.priceForRescue).not.toHaveBeenCalled();
        expect(mockDustRescueOrchestrator.registerPending).not.toHaveBeenCalled();
    });

    // Issue #222: dust #1 (source-chain swap-input dust) forwarding, awaited
    // synchronously before responding — see dust-rescue-forwarding.service.ts.
    it("Forwards dust #1 and includes its tx hash on the registered job when forwarding succeeds.", async () => {
        mockDustRescueForwarding.forward.mockResolvedValue("0xforwardtx" as never);
        const request = buildDustRescueRequest();

        await service.relaySwap(request);

        expect(mockDustRescueForwarding.forward).toHaveBeenCalledWith(
            42161,
            expect.objectContaining({
                sourceTxHash: "0xabc123",
                proofAsset: TEST_ASSET,
                dustRecipient: SWAP_RECIPIENT,
                destinationChainId: 8453,
                tokenId: TEST_ASSET,
            })
        );
        expect(mockDustRescueOrchestrator.registerPending).toHaveBeenCalledWith(
            expect.objectContaining({ dust1ForwardTxHash: "0xforwardtx" })
        );
    });

    it("Registers the dust rescue without dust1ForwardTxHash when forwarding finds nothing to forward.", async () => {
        mockDustRescueForwarding.forward.mockResolvedValue(undefined);
        const request = buildDustRescueRequest();

        await service.relaySwap(request);

        const [job] = mockDustRescueOrchestrator.registerPending.mock.calls[0];
        expect(job.dust1ForwardTxHash).toBeUndefined();
    });

    // The relay-swap tx already succeeded on-chain by the time any of this runs — a
    // pricing/forwarding/registration failure must degrade the response, never fail it.
    const dustRescueRequest = buildDustRescueRequest;

    // The failure is logged with the opt-in alert marker (logger/alert-transport.ts), which pages the
    // operators at severity "warn"; it must NOT be logged at `turbo` (the relayer keeps operating).
    const expectDustRescueAlert = () => {
        const logger = module.get(FATLoggerService) as unknown as ReturnType<typeof createMockLogger>;
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Dust rescue pricing/registration failed"), {
            alert: true,
            dedupKey: "dustRescue.42161",
        });
        expect(logger.turbo).not.toHaveBeenCalled();
    };

    it("Has no dustRescueWarning when dust rescue succeeds.", async () => {
        const result = await service.relaySwap(dustRescueRequest());

        expect(result.dustRescueWarning).toBeUndefined();
    });

    it("Still returns the real txHash and surfaces a dustRescueWarning when pricing fails.", async () => {
        // *Once — a mockRejectedValue without "Once" would otherwise leak into every
        // later test's call on this shared, describe-scoped mock (jest.clearAllMocks()
        // in beforeEach resets call history, not a configured implementation).
        mockDustRescuePricing.priceForRescue.mockRejectedValueOnce(
            new Error("No wrapped-native address configured for chainId=8453"),
        );

        const result = await service.relaySwap(dustRescueRequest());

        expect(result.txHash).toBe("0xabc123");
        expect(result.error).toBeUndefined();
        expect(result.dustRescueWarning).toBe("No wrapped-native address configured for chainId=8453");
        expect(mockDustRescueForwarding.forward).not.toHaveBeenCalled();
        expect(mockDustRescueOrchestrator.registerPending).not.toHaveBeenCalled();
        expectDustRescueAlert();
    });

    it("Never puts the pricing RPC URL (and its key) into dustRescueWarning.", async () => {
        mockDustRescuePricing.priceForRescue.mockRejectedValueOnce(
            new HttpRequestError({
                url: "https://bsc-mainnet.g.alchemy.com/v2/alch_SECRETKEY0123456789",
                body: { method: "eth_call" },
                details: "fetch failed",
            }),
        );

        const result = await service.relaySwap(dustRescueRequest());

        expect(result.txHash).toBe("0xabc123");
        expect(result.dustRescueWarning).toBe("HTTP request failed (RPC bsc-mainnet.<…>.alchemy.com).");
        expect(JSON.stringify(result)).not.toContain("alch_SECRETKEY0123456789");
    });

    it("Still returns the real txHash and surfaces a dustRescueWarning when registration fails.", async () => {
        mockDustRescueOrchestrator.registerPending.mockRejectedValueOnce(new Error("Pub/Sub unavailable"));

        const result = await service.relaySwap(dustRescueRequest());

        expect(result.txHash).toBe("0xabc123");
        expect(result.dustRescueWarning).toBe("Pub/Sub unavailable");
        expectDustRescueAlert();
    });
});
