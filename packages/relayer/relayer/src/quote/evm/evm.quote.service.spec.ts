import { Test, TestingModule } from "@nestjs/testing";
import { mock } from "jest-mock-extended";
import { DiscoveryService } from "@nestjs/core";
import { EvmQuoteService } from "./evm.quote.service";
import { EVMChainService } from "../../chain.service/evm.chain.service";
import { EvmContractService } from "../../sdk/evm.contract.service";
import { createMockLogger, createMockLoggerProvider } from "../../test/mocks";
import { FATLoggerService } from "../../logger/fat.logger.provider";
import { Address, Hex, getAddress } from "viem";
import { BPS, Wei } from "./unit.types";
import { EvmConfigService } from "../../config/evm/evm-config.service";
import { decodeBatchFeeSplit } from "../../relay/evm/fee_abi";
import { RateProvider } from "../../rate_provider/rate_types";
import { RateProviderService } from "../../rate_provider/rate_provider.service";
import { decodeRelaySwapRouting } from "../../relay/evm/swap_routing_abi";
import { YieldZapRegistry } from "../../rate_provider/yield_zap_registry";
import { RELAY_GAS_BUDGET } from "./relay_gas_budget";

// const ANVIL_FIRST_PKEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_FIRST_ADDRESS: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// const ANVIL_SECOND_PKEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ANVIL_SECOND_ADDRESS: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
// Arbitrary key distinct from ANVIL_FIRST/SECOND, used only to assert the relayer routes
// a fee to its OWN signer address (F-242) — the corresponding address is derived in the
// test itself via privateKeyToAccount, not hardcoded, so this never needs to match a
// specific chain's funded account.
const TEST_SIGNER_PKEY: Hex = "0x07a2daa03a9e3588f4bff7f6f7ed419f1f3e90846133ec8f01c450f536fb8e1d";
const TEST_SIGNER_ADDRESS: Address = "0x972e3115864993BD97cE4D09Bd18B2aa685515e9";
const CURRENT_RELAY_TX_COST = RELAY_GAS_BUDGET.relay * 1_000_000_000n; // relay budget × the 1 gwei TEST_GAS_PRICE

describe("EvmQuoteService", () => {
    let service: EvmQuoteService;
    let module: TestingModule;

    const mockConfigService = mock<EvmConfigService>();

    const mockChainService = mock<EVMChainService>();

    const mockDiscoveryService = {
        getProviders: jest.fn().mockReturnValue([]),
    };

    const mockContractService = mock<EvmContractService>();
    const mockRateProvider = mock<RateProviderService>();
    const mockYieldZapRegistry = mock<YieldZapRegistry>();

    const TEST_ASSET = getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");
    const TEST_NON_NATIVE_ASSET = getAddress("0x0000000eF0000000000A00000000000000000000");
    const TEST_GAS_PRICE = 1_000_000_000n; // 1 gwei
    const TEST_BASE_FEE_BPS = BPS(50n); // 0.5%
    const TEST_FLAT_FEE_AMOUNT = Wei(21_000n); // 21k gas units
    const TEST_MAX_RELAY_FEE = Wei(100_000_000_000_000_000n); // 0.1 ETH (high cap)
    const TEST_RELAY_CONTRACT = getAddress("0x00000000000000000000000000000000DeaDBeef");

    beforeEach(async () => {
        module = await Test.createTestingModule({
            providers: [
                EvmQuoteService,
                { provide: EvmConfigService, useValue: mockConfigService },
                createMockLoggerProvider(),
                { provide: EVMChainService, useValue: mockChainService },
                { provide: DiscoveryService, useValue: mockDiscoveryService },
                { provide: EvmContractService, useValue: mockContractService },
                { provide: RateProvider.MOCK, useValue: mockRateProvider },
                { provide: YieldZapRegistry, useValue: mockYieldZapRegistry },
            ],
        }).compile();

        service = await module.resolve<EvmQuoteService>(EvmQuoteService);

        jest.clearAllMocks();
        mockChainService.getGasPrice.mockResolvedValue(Wei(TEST_GAS_PRICE));
        mockConfigService.asset.mockReturnValue({
            fee_bps: TEST_BASE_FEE_BPS,
            ticker: "ETH",
            address: TEST_ASSET,
            quoter: RateProvider.CURVE,
            decimals: 18,
        });
        mockConfigService.flatFeeAmount.mockReturnValue(TEST_FLAT_FEE_AMOUNT);
        mockConfigService.processorAddress.mockImplementation((op) =>
            op === "transfer" ? ANVIL_FIRST_ADDRESS : TEST_RELAY_CONTRACT
        );
        // Default: fee receiver and signer are the same operator address, so nativeGas > 0
        // never needs to redirect the fee (F-242 tests below override this explicitly).
        mockConfigService.isFeeReceiverSameAsSigner.mockReturnValue(true);
        // ERC20 quotes resolve the chain's native asset from the full asset list
        // (sentinel-addressed entry) rather than by ETH/WETH ticker lookup.
        mockConfigService.allAssets.mockReturnValue([
            {
                ticker: "ETH",
                address: TEST_ASSET,
                quoter: RateProvider.MOCK,
                decimals: 18,
            },
        ]);
        mockContractService.getAssetConfig.mockResolvedValue({
            maxRelayFee: TEST_MAX_RELAY_FEE,
            enabled: true,
            minAmount: Wei(1_000_000_000_000_000n),
            vettingFeeBPS: BPS(20n),
        });
    });

    describe("Quote with fixed sent amount.", () => {
        it("Should calculate feeAmount and output amount (no extraGas)", async () => {
            const inputAmount = Wei(1_000_000_000_000_000_000n); // 1 ETH in wei

            const result = await service.quote(
                {
                    asset: TEST_ASSET,
                    amount: inputAmount,
                    extraGas: false,
                    commit: false,
                },
                false
            );

            expect(result.feeAmount).toBeGreaterThan(TEST_BASE_FEE_BPS);
            expect(result.amountSent).toBe(inputAmount);
            expect(result.gasPrice).toBe(TEST_GAS_PRICE);
            expect(result.txCost).toBe(RELAY_GAS_BUDGET.relay);
            expect(result.processor).toBe(TEST_RELAY_CONTRACT);
            expect(mockConfigService.processorAddress).toHaveBeenCalledWith("withdrawal");
            expect(result.extraGasTxCost).toBeUndefined();
            expect(result.extraGasFundAmount).toBeUndefined();
        });

        it("should calculate feeAmount and output amount (with extraGas)", async () => {
            const inputAmount = Wei(1_000_000_000_000_000_000n); // 1 ETH in wei

            const result = await service.quote(
                {
                    asset: TEST_ASSET,
                    amount: inputAmount,
                    extraGas: true,
                    commit: false,
                },
                false
            );

            expect(result.feeAmount).toBeGreaterThan(TEST_BASE_FEE_BPS);
            expect(result.amountSent).toBe(inputAmount);
            expect(result.extraGasTxCost).toBe(30_000n);
            expect(result.extraGasFundAmount).toBe(600_000n);
        });

        it("Gets equal fees besides extra gas cost for quotes which are otherwise similar.", async () => {
            const desiredOutput = Wei(1_000_000_000_000_000_000n); // 1 ETH in wei

            const resultWithGas = await service.quote(
                {
                    asset: TEST_ASSET,
                    amount: desiredOutput,
                    extraGas: true,
                    commit: false,
                },
                false
            );
            const resultNoGas = await service.quote(
                {
                    asset: TEST_ASSET,
                    amount: desiredOutput,
                    extraGas: false,
                    commit: false,
                },
                false
            );

            if (!resultWithGas.extraGasFundAmount) {
                throw new Error("¡Gas transaction lacks gas!");
            }
            if (!resultWithGas.extraGasTxCost) {
                throw new Error("¡Gas transaction lacks gas!");
            }
            const gasSpending =
                resultWithGas.gasPrice * (resultWithGas.extraGasTxCost + resultWithGas.extraGasFundAmount);
            const feeDelta = resultWithGas.feeAmount - resultNoGas.feeAmount;
            const receivedAmountDelta = resultNoGas.amountReceived - resultWithGas.amountReceived;
            // Variation in total amounts is explained by variation in fees.
            expect(feeDelta).toBe(receivedAmountDelta);
            expect(feeDelta).toBe(gasSpending);
            // In this situation, extra gas will cause amount received to be smaller.
            expect(receivedAmountDelta).toBe(gasSpending);
        });

        it("Follows expected proportion.", async () => {
            const inputAmount = Wei(1_000_000_000_000_000_000n); // 1 ETH in wei

            const resultNoGas = await service.quote(
                {
                    asset: TEST_ASSET,
                    amount: inputAmount,
                    extraGas: false,
                    commit: false,
                },
                false
            );

            const resultWithGas = await service.quote(
                {
                    asset: TEST_ASSET,
                    amount: inputAmount,
                    extraGas: true,
                    commit: false,
                },
                false
            );

            if (!resultWithGas.extraGasFundAmount) {
                throw new Error("¡Gas transaction lacks gas!");
            }
            if (!resultWithGas.extraGasTxCost) {
                throw new Error("¡Gas transaction lacks gas!");
            }
            const gasSpending =
                resultWithGas.gasPrice * (resultWithGas.extraGasTxCost + resultWithGas.extraGasFundAmount);
            const feeDelta = resultWithGas.feeAmount - resultNoGas.feeAmount;
            const receivedAmountDelta = resultNoGas.amountReceived - resultWithGas.amountReceived;
            // Variation in total amounts is explained by variation in fees.
            expect(feeDelta).toBe(receivedAmountDelta);
            expect(feeDelta).toBe(gasSpending);
            // In this situation, extra gas will cause amount received to be smaller.
            expect(receivedAmountDelta).toBe(gasSpending);
        });

        // R-C2: the native->token conversion must scale by 10^tokenDecimals. The oracle
        // `num` is the WETH cost of one WHOLE token, normalized to 18 decimals (Curve
        // convention), so fixtures here use Curve-magnitude rates — the old toy rates
        // (num=2,den=2) cancelled the missing factor and hid the bug.
        describe("Non native tokens (decimals-correct conversion — R-C2)", () => {
            const commonFeeBps = BPS(10n);
            const ONE = 1_000_000_000_000_000_000n; // 1e18
            const NATIVE_18 = {
                address: TEST_ASSET,
                ticker: "ETH",
                fee_bps: commonFeeBps,
                quoter: RateProvider.MOCK,
                decimals: 18,
            };
            // An 18-decimal ERC20 (rate expressed the Curve way: WETH per whole token, 1e18-normalized).
            const TOKEN_18 = {
                address: TEST_NON_NATIVE_ASSET,
                ticker: "WSOMETHING",
                fee_bps: commonFeeBps,
                quoter: RateProvider.MOCK,
                decimals: 18,
            };
            // A 6-decimal stablecoin, flat-fee (no fee_bps).
            const USDC = {
                address: TEST_NON_NATIVE_ASSET,
                ticker: "USDC",
                quoter: RateProvider.MOCK,
                decimals: 6,
            };

            beforeEach(() => {
                mockDiscoveryService.getProviders.mockReturnValue({
                    find: () => ({ instance: mockRateProvider, token: RateProvider.MOCK }),
                });
            });

            it("A token worth 1 ETH (18 dec) is charged the same as ETH.", async () => {
                mockConfigService.asset.mockReturnValue(TOKEN_18);
                // 1 whole token = 1 WETH => rate normalized to 1e18.
                mockRateProvider.quote.mockResolvedValue({
                    source: RateProvider.MOCK, num: ONE, den: 1n, token_in: TOKEN_18, token_out: NATIVE_18,
                });
                const resultToken = await service.quote(
                    { asset: TEST_NON_NATIVE_ASSET, amount: Wei(ONE), extraGas: false, commit: false }, false
                );

                mockConfigService.asset.mockReturnValue(NATIVE_18);
                const resultETH = await service.quote(
                    { asset: TEST_ASSET, amount: Wei(ONE), extraGas: false, commit: false }, false
                );

                expect(resultToken.feeAmount).toBe(resultETH.feeAmount);
            });

            it("A token worth 1/2 ETH is charged proportionally to the equivalent ETH.", async () => {
                const proportion = 2n;
                mockConfigService.asset.mockReturnValue(TOKEN_18);
                // 1 whole token = 0.5 WETH => rate = 5e17 (1e18-normalized).
                mockRateProvider.quote.mockResolvedValue({
                    source: RateProvider.MOCK, num: 500_000_000_000_000_000n, den: 1n, token_in: TOKEN_18, token_out: NATIVE_18,
                });
                const resultNonNative = await service.quote(
                    { asset: TEST_NON_NATIVE_ASSET, amount: Wei(ONE), extraGas: false, commit: false }, false
                );

                mockConfigService.asset.mockReturnValue(NATIVE_18);
                const resultETH = await service.quote(
                    { asset: TEST_ASSET, amount: Wei(ONE), extraGas: false, commit: false }, false
                );

                // The gas (relay-cost) component is `proportion`x larger for the cheaper token;
                // the bps component (same amount, same bps) is identical, so it cancels here.
                expect(resultETH.feeAmount - CURRENT_RELAY_TX_COST).toBe(
                    resultNonNative.feeAmount - CURRENT_RELAY_TX_COST * proportion
                );
            });

            it("Prices the gas component of a USDC (6 dec) fee in base units, not ~0.", async () => {
                mockConfigService.asset.mockReturnValue(USDC);
                // ETH = $2500 => WETH per whole USDC, 1e18-normalized = (1/2500)e18 = 4e14.
                mockRateProvider.quote.mockResolvedValue({
                    source: RateProvider.MOCK, num: 400_000_000_000_000n, den: 1n, token_in: USDC, token_out: USDC,
                });
                const result = await service.quote(
                    { asset: TEST_NON_NATIVE_ASSET, amount: Wei(1_000_000_000n), extraGas: false, commit: false }, false
                );

                // relayPrice = gasPrice * relayTxCost wei. In USDC base units at 4e14 wei per USDC:
                // relayPrice * 10^6 / 4e14 (e.g. 1.05e15 wei -> 2_625_000 = 2.625 USDC), NOT the
                // buggy 1 base unit. Flat-fee path (no fee_bps) adds flatFeeAmount on top.
                expect(result.feeAmount).toBe((TEST_GAS_PRICE * RELAY_GAS_BUDGET.relay * 1_000_000n) / 400_000_000_000_000n + TEST_FLAT_FEE_AMOUNT);
                expect(result.feeAmount).toBeGreaterThan(1_000_000n);
            });

            it("Scales the gas cost by token decimals (18-dec is 10^12x the 6-dec base-unit cost).", async () => {
                // Same $-rate for both; only decimals differ. Raise the cap so neither is clamped.
                mockContractService.getAssetConfig.mockResolvedValue({
                    maxRelayFee: Wei(10n ** 30n), enabled: true, minAmount: Wei(0n), vettingFeeBPS: BPS(20n),
                });
                const RATE = { source: RateProvider.MOCK, num: 400_000_000_000_000n, den: 1n };

                mockConfigService.asset.mockReturnValue(USDC);
                mockRateProvider.quote.mockResolvedValue({ ...RATE, token_in: USDC, token_out: USDC });
                const res6 = await service.quote(
                    { asset: TEST_NON_NATIVE_ASSET, amount: Wei(1_000_000_000n), extraGas: false, commit: false }, false
                );

                const DAI = { ...USDC, ticker: "DAI", decimals: 18 };
                mockConfigService.asset.mockReturnValue(DAI);
                mockRateProvider.quote.mockResolvedValue({ ...RATE, token_in: DAI, token_out: DAI });
                const res18 = await service.quote(
                    { asset: TEST_NON_NATIVE_ASSET, amount: Wei(ONE * 1000n), extraGas: false, commit: false }, false
                );

                // Isolate the relay-cost (gas) component by removing the shared flat fee.
                const relayCost6 = res6.feeAmount - TEST_FLAT_FEE_AMOUNT;
                const relayCost18 = res18.feeAmount - TEST_FLAT_FEE_AMOUNT;
                expect(relayCost18).toBe(relayCost6 * 10n ** 12n);
            });
        });
    });

    describe("ERC-4626 share tokens (quoter Underlying — ppUSDC over USDC)", () => {
        const ONE = 1_000_000_000_000_000_000n; // 1e18
        const PP_USDC_ADDRESS = getAddress("0x0000000000000000000000000000000000000b01");
        const USDC = { address: TEST_NON_NATIVE_ASSET, ticker: "USDC", quoter: RateProvider.MOCK, decimals: 6 };
        const PP_USDC = {
            address: PP_USDC_ADDRESS,
            ticker: "ppUSDC",
            quoter: RateProvider.UNDERLYING,
            underlying: TEST_NON_NATIVE_ASSET,
            decimals: 18,
        };
        const NATIVE_18 = { address: TEST_ASSET, ticker: "ETH", quoter: RateProvider.NATIVE, decimals: 18 };
        // 1 whole USDC = 0.0005 WETH (ETH at $2000), 1e18-normalized.
        const USDC_TO_WETH_NUM = 500_000_000_000_000n;

        beforeEach(() => {
            mockDiscoveryService.getProviders.mockReturnValue({
                find: () => ({ instance: mockRateProvider, token: RateProvider.MOCK }),
            });
            mockConfigService.asset.mockImplementation((address: string) => {
                if (address.toLowerCase() === PP_USDC_ADDRESS.toLowerCase()) return PP_USDC;
                if (address.toLowerCase() === TEST_NON_NATIVE_ASSET.toLowerCase()) return USDC;
                return NATIVE_18;
            });
            mockRateProvider.quote.mockResolvedValue({
                source: RateProvider.MOCK, num: USDC_TO_WETH_NUM, den: 1n, token_in: USDC, token_out: NATIVE_18,
            });
            // Share fees are 18-decimal base units, so the default 0.1-ETH-sized cap would clamp
            // them; lift it so the tests below observe the raw conversion.
            mockContractService.getAssetConfig.mockResolvedValue({
                maxRelayFee: Wei(10n ** 30n),
                enabled: true,
                minAmount: Wei(0n),
                vettingFeeBPS: BPS(0n),
            });
        });

        it("prices a share as previewRedeem(1 share) worth of the underlying's quote", async () => {
            // 1 share redeems to 2 USDC (2e6 base units): a share is worth twice a USDC.
            mockChainService.readContract.mockResolvedValue(2_000_000n);

            const shareQuote = await service.quoteInNativeToken(PP_USDC_ADDRESS);
            const usdcQuote = await service.quoteInNativeToken(TEST_NON_NATIVE_ASSET);

            // Exact fraction: num scaled by the redeem amount, den by 10^underlyingDecimals.
            expect(shareQuote.num).toBe(usdcQuote.num * 2_000_000n);
            expect(shareQuote.den).toBe(usdcQuote.den * 1_000_000n);
            // Decimals-invariant convention: whole-WETH per whole-share == 2x whole-WETH per whole-USDC.
            expect(shareQuote.num * usdcQuote.den).toBe(2n * usdcQuote.num * shareQuote.den);
            expect(mockChainService.readContract).toHaveBeenCalledWith(
                expect.objectContaining({ address: PP_USDC_ADDRESS, functionName: "previewRedeem", args: [ONE] })
            );
            // The underlying's quoter was consulted for USDC, never for the share itself.
            const quotedTickers = mockRateProvider.quote.mock.calls.map(([input]) => input.ticker);
            expect(quotedTickers).toEqual(["USDC", "USDC"]);
        });

        it("charges a fee in shares that is the USDC fee divided by the redeem rate, 18-decimal scaled", async () => {
            // 1 share redeems to exactly 1 USDC: fee in shares == USDC fee * 10^12 (6 -> 18 decimals).
            mockChainService.readContract.mockResolvedValue(1_000_000n);
            const shareResult = await service.quote(
                { asset: PP_USDC_ADDRESS, amount: Wei(ONE * 100n), extraGas: false, commit: false }, false
            );
            const usdcResult = await service.quote(
                { asset: TEST_NON_NATIVE_ASSET, amount: Wei(100_000_000n), extraGas: false, commit: false }, false
            );
            // Both are flat-fee assets: fee = gas cost in token + the raw flat amount. Only the
            // gas component is rate-converted, so compare that part.
            // The share also prices more gas: it leaves through its PPRouter (yieldRelay budget).
            const usdcGasCost = usdcResult.feeAmount - TEST_FLAT_FEE_AMOUNT;
            const shareGasCostInUsdc = (usdcGasCost * RELAY_GAS_BUDGET.yieldRelay) / RELAY_GAS_BUDGET.relay;
            expect(shareResult.feeAmount - TEST_FLAT_FEE_AMOUNT).toBe(shareGasCostInUsdc * 1_000_000_000_000n);

            // 1 share redeems to 1.25 USDC: fewer shares needed for the same USDC-denominated cost.
            mockChainService.readContract.mockResolvedValue(1_250_000n);
            const richerShare = await service.quote(
                { asset: PP_USDC_ADDRESS, amount: Wei(ONE * 100n), extraGas: false, commit: false }, false
            );
            expect(richerShare.feeAmount - TEST_FLAT_FEE_AMOUNT).toBe((shareGasCostInUsdc * 1_000_000_000_000n * 4n) / 5n);
        });

        it("rejects a share whose previewRedeem is 0 instead of dividing by zero", async () => {
            mockChainService.readContract.mockResolvedValue(0n);
            await expect(service.quoteInNativeToken(PP_USDC_ADDRESS)).rejects.toThrow(/previewRedeem\(1 share\) returned 0/);
        });

        it("pages the operator (alert, per-chain dedupKey) when previewRedeem is 0", async () => {
            mockChainService.readContract.mockResolvedValue(0n);
            const logger = module.get(FATLoggerService) as unknown as ReturnType<typeof createMockLogger>;
            await expect(service.quoteInNativeToken(PP_USDC_ADDRESS)).rejects.toThrow();
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("previewRedeem(1 share) returned 0"), {
                alert: true,
                dedupKey: expect.stringMatching(/^quote\.previewRedeemZero\./),
            });
        });

        it("prices a native-mode wrapper (ppETH over WETH) as previewRedeem(1 share) worth of native — no rate provider", async () => {
            const WETH = { address: getAddress("0x0000000000000000000000000000000000000c02"), ticker: "WETH", quoter: RateProvider.NATIVE, decimals: 18 };
            const PP_ETH = { ...PP_USDC, ticker: "ppETH", underlying: WETH.address };
            mockConfigService.asset.mockImplementation((address: string) => {
                if (address.toLowerCase() === PP_USDC_ADDRESS.toLowerCase()) return PP_ETH;
                if (address.toLowerCase() === WETH.address.toLowerCase()) return WETH;
                return NATIVE_18;
            });
            // 1 ppETH redeems to 1.05 WETH.
            mockChainService.readContract.mockResolvedValue(1_050_000_000_000_000_000n);
            const shareQuote = await service.quoteInNativeToken(PP_USDC_ADDRESS);
            // WETH is native-treated: {num: 1e18, den: 1}; share = that x redeem / 1e18 = 1.05 whole-native per whole-share.
            expect(shareQuote.num * 1n).toBe(10n ** 18n * 1_050_000_000_000_000_000n);
            expect(shareQuote.den).toBe(10n ** 18n);
            expect(mockRateProvider.quote).not.toHaveBeenCalled();
        });

        it("rejects an underlying that is itself another share token", async () => {
            const CHAINED = { ...PP_USDC, ticker: "ppppUSDC", underlying: PP_USDC_ADDRESS };
            const CHAINED_ADDRESS = getAddress("0x0000000000000000000000000000000000000b02");
            mockConfigService.asset.mockImplementation((address: string) =>
                address.toLowerCase() === CHAINED_ADDRESS.toLowerCase() ? CHAINED : PP_USDC
            );
            await expect(service.quoteInNativeToken(CHAINED_ADDRESS)).rejects.toThrow(/chained wrappers are not supported/);
            const logger = module.get(FATLoggerService) as unknown as ReturnType<typeof createMockLogger>;
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("chained wrappers are not supported"), {
                alert: true,
                dedupKey: expect.stringMatching(/^quote\.underlyingMisconfigured\./),
            });
            expect(mockChainService.readContract).not.toHaveBeenCalled();
        });
    });

    describe("Native asset detection (sentinel address — Citrea cBTC)", () => {
        // cBTC: native by sentinel address, ticker matches neither ETH nor WETH.
        const CBTC = {
            address: TEST_ASSET, // sentinel 0xEeee...EEeE
            ticker: "cBTC",
            fee_bps: TEST_BASE_FEE_BPS,
            quoter: RateProvider.MOCK,
            decimals: 18,
        };

        it("short-circuits a sentinel-addressed non-ETH native without touching a rate provider", async () => {
            mockConfigService.asset.mockReturnValue(CBTC);

            const result = await service.quote(
                { asset: TEST_ASSET, amount: Wei(1_000_000_000_000_000_000n), extraGas: false, commit: false },
                false
            );

            expect(mockRateProvider.quote).not.toHaveBeenCalled();
            expect(result.feeAmount).toBeGreaterThan(0n);
            expect(result.amountReceived).toBe(result.amountSent - result.feeAmount);
        });

        it("returns the exact no-op rate for the native asset", async () => {
            mockConfigService.asset.mockReturnValue(CBTC);

            const quote = await service.quoteInNativeToken(TEST_ASSET);

            expect(quote).toEqual({ num: 10n ** 18n, den: 1n });
        });

        it("rejects an ERC20 quote with a clean 400 when no native asset is configured", async () => {
            mockConfigService.asset.mockReturnValue({
                address: TEST_NON_NATIVE_ASSET,
                ticker: "USDC",
                quoter: RateProvider.MOCK,
                decimals: 6,
            });
            mockConfigService.allAssets.mockReturnValue([]);

            await expect(
                service.quote(
                    { asset: TEST_NON_NATIVE_ASSET, amount: Wei(1_000_000_000n), extraGas: false, commit: false },
                    false
                )
            ).rejects.toThrow(/No native asset configured/);
        });

        it("pages the operator when no native asset is configured", async () => {
            mockConfigService.asset.mockReturnValue({
                address: TEST_NON_NATIVE_ASSET,
                ticker: "USDC",
                quoter: RateProvider.MOCK,
                decimals: 6,
            });
            mockConfigService.allAssets.mockReturnValue([]);
            const logger = module.get(FATLoggerService) as unknown as ReturnType<typeof createMockLogger>;
            await expect(
                service.quote(
                    { asset: TEST_NON_NATIVE_ASSET, amount: Wei(1_000_000_000n), extraGas: false, commit: false },
                    false
                )
            ).rejects.toThrow(/No native asset configured/);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("No native asset configured"), {
                alert: true,
                dedupKey: expect.stringMatching(/^quote\.nativeAssetMissing\./),
            });
        });
    });

    describe("quote with fixed received amount.", () => {
        describe("With commitment", () => {
            it("should calculate required input for desired output (no extraGas)", async () => {
                const desiredOutput = Wei(1_000_000_000_000_000_000n); // 1 ETH in wei
                mockChainService.signRelayWithdrawalCommitment.mockResolvedValue("0xAaaaAaaaaaaaaadEadbeAf");
                mockConfigService.feeReceiverAddress.mockReturnValue(ANVIL_SECOND_ADDRESS);

                const result = await service.quote(
                    {
                        asset: TEST_ASSET,
                        amount: desiredOutput,
                        extraGas: false,
                        commit: true,
                        recipient: ANVIL_FIRST_ADDRESS,
                    },
                    true
                );

                // The actual charged fees are over the minimum we want to allow.
                expect(result.feeAmount).toBeGreaterThan(TEST_BASE_FEE_BPS);
                // In exact mode, amountSent = amount (to be received, the input) + fee, amountReceived = amount
                expect(result.amountReceived).toBe(desiredOutput);
                expect(result.amountSent).toBeGreaterThan(desiredOutput);
                expect(result.gasPrice).toBe(TEST_GAS_PRICE);
                expect(result.txCost).toBe(RELAY_GAS_BUDGET.relay);
            });
        });

        it("should calculate required input for desired output (with extraGas)", async () => {
            const desiredOutput = Wei(1_000_000_000_000_000_000n); // 1 ETH in wei

            const result = await service.quote(
                {
                    asset: TEST_ASSET,
                    amount: desiredOutput,
                    extraGas: true,
                    commit: false,
                },
                true
            );

            expect(result.feeAmount).toBeGreaterThan(TEST_BASE_FEE_BPS);
            expect(result.amountReceived).toBe(desiredOutput);
            expect(result.amountSent).toBeGreaterThan(desiredOutput);
            expect(result.extraGasTxCost).toBe(30_000n);
            expect(result.extraGasFundAmount).toBe(600_000n);
        });

        it("commitments with and without extra gas should exclusively differ in the gas amounts", async () => {
            const desiredOutput = Wei(1_000_000_000_000_000_000n); // 1 ETH in wei

            const resultWithGas = await service.quote(
                {
                    asset: TEST_ASSET,
                    amount: desiredOutput,
                    extraGas: true,
                    commit: false,
                },
                true
            );
            const resultNoGas = await service.quote(
                {
                    asset: TEST_ASSET,
                    amount: desiredOutput,
                    extraGas: false,
                    commit: false,
                },
                true
            );

            if (!resultWithGas.extraGasFundAmount) {
                throw new Error("¡Gas transaction lacks gas!");
            }
            if (!resultWithGas.extraGasTxCost) {
                throw new Error("¡Gas transaction lacks gas!");
            }
            const gasSpending =
                resultWithGas.gasPrice * (resultWithGas.extraGasTxCost + resultWithGas.extraGasFundAmount);
            const sentAmountDelta = resultWithGas.amountSent - resultNoGas.amountSent;
            const feeDelta = resultWithGas.feeAmount - resultNoGas.feeAmount;
            expect(feeDelta).toBe(gasSpending);
            expect(sentAmountDelta).toBe(gasSpending);
        });
    });

    describe("quote transfer (shielded)", () => {
        it("should calculate flat fee", async () => {
            // For shielded transfer, no fee_bps — use flat fee path
            mockConfigService.asset.mockReturnValue({
                fee_bps: TEST_BASE_FEE_BPS,
                ticker: "ETH",
                address: TEST_ASSET,
                quoter: RateProvider.CURVE,
                decimals: 18,
            });

            const result = await service.quoteTransfer({
                asset: TEST_ASSET,
                commit: false,
            });

            // flatFee = min(gasPrice * shieldedTransferTxCost + flatFeeAmount, maxRelayFee)
            const expectedFlatFee = TEST_GAS_PRICE * RELAY_GAS_BUDGET.shieldedTransfer + TEST_FLAT_FEE_AMOUNT;

            expect(result.feeAmount).toBe(expectedFlatFee);
            expect(result.gasPrice).toBe(TEST_GAS_PRICE);
            expect(result.txCost).toBe(RELAY_GAS_BUDGET.shieldedTransfer);
            expect(result.processor).toBe(ANVIL_FIRST_ADDRESS);
            expect(mockConfigService.processorAddress).toHaveBeenCalledWith("transfer");
        });
    });

    describe("quoteBatch — per-item normal single-tx fees", () => {
        beforeEach(() => {
            mockConfigService.feeReceiverAddress.mockReturnValue(ANVIL_SECOND_ADDRESS);
            mockConfigService.quoteExpirationMs.mockReturnValue(60_000);
            mockChainService.signRelayBatchWithdrawalCommitment.mockResolvedValue("0xsig");
        });

        it("charges each item the fee it would pay as a standalone withdrawal (bps)", async () => {
            const amounts = [Wei(1_000_000_000_000_000_000n), Wei(2_000_000_000_000_000_000n)];

            const res = await service.quoteBatch({
                asset: TEST_ASSET,
                recipient: ANVIL_FIRST_ADDRESS,
                amounts,
                extraGas: false,
                commit: true,
            });

            // Native asset (num/den = 1): relayCost is the SINGLE-tx relay gas cost,
            // and the variable part is the bps fee on each item's own amount — i.e.
            // exactly the single-withdraw fee formula, applied per item.
            const relayCost = TEST_GAS_PRICE * RELAY_GAS_BUDGET.relayBatchItem;
            const expected = amounts.map((a) => {
                const raw = relayCost + (a * TEST_BASE_FEE_BPS) / 10_000n;
                return raw < TEST_MAX_RELAY_FEE ? raw : TEST_MAX_RELAY_FEE;
            });

            const routings = decodeBatchFeeSplit(res.feeCommitment.data);
            expect(routings.map((r) => r.feeAmount)).toEqual(expected);
            expect(BigInt(res.totalFee)).toBe(expected.reduce((s, f) => s + f, 0n));
            expect(BigInt(res.feeCommitment.relayCost)).toBe(relayCost);
            expect(BigInt(res.feeCommitment.feeBps)).toBe(TEST_BASE_FEE_BPS);
            expect(BigInt(res.feeCommitment.flatFee)).toBe(0n);
        });

        // SEC-1: a non-committing batch quote must NOT sign an EIP-712 commitment,
        // matching the single-withdraw quote path. Otherwise an unauthenticated
        // caller could force unbounded signer work via POST /v1/quote/.../batch.
        it("returns the fee estimate without signing when commit is false", async () => {
            const amounts = [Wei(1_000_000_000_000_000_000n), Wei(2_000_000_000_000_000_000n)];

            const res = await service.quoteBatch({
                asset: TEST_ASSET,
                recipient: ANVIL_FIRST_ADDRESS,
                amounts,
                extraGas: false,
                commit: false,
            });

            expect(res.feeCommitment).toBeUndefined();
            expect(BigInt(res.totalFee)).toBeGreaterThan(0n);
            expect(mockChainService.signRelayBatchWithdrawalCommitment).not.toHaveBeenCalled();
        });
    });

    describe("Exceptions", () => {
        it("Rejects transactions in which the total withdrawal amount is not enough to cover the fees", async () => {
            const inputAmount = Wei(1_000_000n); // Very small, indeed.

            const smallWithdrawalParameters = {
                asset: TEST_ASSET,
                amount: inputAmount,
                extraGas: false,
                commit: false,
            };
            async function smallWithdrawal() {
                await service.quote(smallWithdrawalParameters, false);
            }

            await expect(smallWithdrawal()).rejects.toThrow(
                `Relay fee (${RELAY_GAS_BUDGET.relay * TEST_GAS_PRICE + 5000n}) exceeds withdrawal amount (${inputAmount}). Increase the withdrawal amount.`
            );
        });

        it("Rejects commitment generation if a recipient is missing.", async () => {
            const inputAmount = Wei(1_000_000_000_000_000_000n); // 1 ETH.

            const withdrawalParameters = {
                asset: TEST_ASSET,
                amount: inputAmount,
                extraGas: false,
                commit: true,
            };
            async function smallWithdrawal() {
                await service.quote(withdrawalParameters, false);
            }

            await expect(smallWithdrawal()).rejects.toThrow(
                "Recipient value missing: cannot commit to a fee without a recipient"
            );
        });
    });

    describe("Swap quote (quoteSwap).", () => {
        const ZERO_ADDRESS = getAddress("0x0000000000000000000000000000000000000000");
        const TEST_RELAY_SWAPS_ADDRESS = getAddress("0x000000000000000000000000000000000e1a75aa");
        const TEST_OUTPUT_TOKEN = getAddress("0x0000000eF0000000000B00000000000000000000");
        const TEST_SWAP_TARGET = getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
        const TEST_SWAP_CALLDATA = `0x${"ab".repeat(32)}` as `0x${string}`;

        const baseSwapParams = {
            asset: TEST_ASSET,
            amount: Wei(1_000_000_000_000_000_000n), // 1 ETH
            outputToken: TEST_OUTPUT_TOKEN,
            recipient: ANVIL_FIRST_ADDRESS,
            minOutputAmount: Wei(0n),
            extraGas: false,
            swapCalldata: TEST_SWAP_CALLDATA,
            swapTarget: TEST_SWAP_TARGET,
            dustRecipient: ANVIL_FIRST_ADDRESS,
            commit: false,
        };

        beforeEach(() => {
            mockConfigService.relaySwapsContractAddress.mockReturnValue(TEST_RELAY_SWAPS_ADDRESS);
            mockConfigService.feeReceiverAddress.mockReturnValue(ANVIL_SECOND_ADDRESS);
            mockChainService.signRelaySwapCommitment.mockResolvedValue("0xAaaaAaaaaaaaaadEadbeAf");
        });

        it("Rejects when the RelaySwaps contract is not configured.", async () => {
            mockConfigService.relaySwapsContractAddress.mockReturnValue(undefined);
            mockConfigService.chainId.mockReturnValue(11155111);

            await expect(service.quoteSwap(baseSwapParams)).rejects.toThrow(
                "Swaps not supported for chain 11155111"
            );
        });

        it("Calculates feeAmount without committing.", async () => {
            const result = await service.quoteSwap(baseSwapParams);

            expect(result.feeAmount).toBeGreaterThan(0n);
            expect(result.gasPrice).toBe(TEST_GAS_PRICE);
            expect(result.txCost).toBe(RELAY_GAS_BUDGET.relaySwap);
            expect(result.feeCommitment).toBeUndefined();
        });

        it("Commits a routing blob with a nonzero recipient.", async () => {
            const result = await service.quoteSwap({
                ...baseSwapParams,
                minOutputAmount: Wei(990_000n),
                commit: true,
            });

            expect(result.feeCommitment).toBeDefined();
            const routing = decodeRelaySwapRouting(result.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion
            expect(routing.recipient).toBe(ANVIL_FIRST_ADDRESS);
            expect(routing.minOutputAmount).toBe(990_000n);
            expect(routing.nativeGas).toBe(0n);
            expect(routing.feeRecipient).toBe(ANVIL_SECOND_ADDRESS);
            // fallbackAddress defaults to recipient when omitted
            expect(routing.fallbackAddress).toBe(ANVIL_FIRST_ADDRESS);
        });

        it("Commits a routing blob with a zero recipient (reshield / cross-chain).", async () => {
            const result = await service.quoteSwap({
                ...baseSwapParams,
                recipient: ZERO_ADDRESS,
                commit: true,
            });

            expect(result.feeCommitment).toBeDefined();
            const routing = decodeRelaySwapRouting(result.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion
            expect(routing.recipient).toBe(ZERO_ADDRESS);
            expect(routing.minOutputAmount).toBe(0n);
            expect(routing.nativeGas).toBe(0n);
        });

        // G4 (TEST-8, schema -> wire): assert the swap-specific routing fields survive
        // the quote's build -> encode -> sign path into the committed blob. The other
        // swap-quote specs cover recipient / minOutputAmount / nativeGas / feeRecipient /
        // fallbackAddress; these were the untested ones (swapTarget, approvalAddress,
        // outputToken, swapCalldata, dustRecipient) plus the `approvalAddress ?? swapTarget`
        // default (audit H3).
        it("Commits a blob that carries swapTarget / outputToken / swapCalldata / dustRecipient, defaulting approvalAddress to swapTarget when omitted.", async () => {
            const result = await service.quoteSwap({ ...baseSwapParams, commit: true });

            expect(result.feeCommitment).toBeDefined();
            const routing = decodeRelaySwapRouting(result.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion
            expect(routing.swapTarget).toBe(TEST_SWAP_TARGET);
            expect(routing.outputToken).toBe(TEST_OUTPUT_TOKEN);
            expect(routing.swapCalldata).toBe(TEST_SWAP_CALLDATA);
            expect(routing.dustRecipient).toBe(ANVIL_FIRST_ADDRESS);
            // H3: approvalAddress omitted from the request => defaults to swapTarget.
            expect(routing.approvalAddress).toBe(TEST_SWAP_TARGET);
        });

        it("Commits an explicit approvalAddress verbatim (distinct from swapTarget).", async () => {
            const TEST_APPROVAL_ADDRESS = getAddress("0x2222222222222222222222222222222222222222");
            const result = await service.quoteSwap({
                ...baseSwapParams,
                approvalAddress: TEST_APPROVAL_ADDRESS,
                commit: true,
            });

            expect(result.feeCommitment).toBeDefined();
            const routing = decodeRelaySwapRouting(result.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion
            expect(routing.approvalAddress).toBe(TEST_APPROVAL_ADDRESS);
            expect(routing.swapTarget).toBe(TEST_SWAP_TARGET);
        });

        // B2 — self-funded bridge msg.value (Mainnet-destination reshield).
        describe("B2 self-funded bridge value", () => {
            const MAX_SWAP_VALUE = Wei(5_000_000_000_000_000n); // 0.005 ETH
            const b2Params = {
                ...baseSwapParams,
                recipient: ZERO_ADDRESS,
                commit: true,
                swapValue: Wei(300_000_000_000_000n), // 0.0003 ETH
                gasSwapMaxInput: Wei(2_000_000_000_000_000n),
                gasSwapCalldata: `0x${"cd".repeat(16)}` as `0x${string}`,
            };

            beforeEach(() => {
                mockConfigService.maxSwapValueWei.mockReturnValue(MAX_SWAP_VALUE);
            });

            it("commits the three B2 routing fields verbatim", async () => {
                const res = await service.quoteSwap(b2Params);
                const routing = decodeRelaySwapRouting(res.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion
                expect(routing.swapValue).toBe(b2Params.swapValue);
                expect(routing.gasSwapMaxInput).toBe(b2Params.gasSwapMaxInput);
                expect(routing.gasSwapCalldata).toBe(b2Params.gasSwapCalldata);
            });

            it("surcharges txCost by the gas-swap surcharge only when swapValue > 0", async () => {
                const withB2 = await service.quoteSwap(b2Params);
                const withoutB2 = await service.quoteSwap({
                    ...baseSwapParams,
                    recipient: ZERO_ADDRESS,
                    commit: true,
                });
                expect(withB2.txCost - withoutB2.txCost).toBe(160_000n);
            });

            it("does NOT add the LZ fee to feeAmount (borne by the reshielded principal)", async () => {
                const withB2 = await service.quoteSwap(b2Params);
                const withoutB2 = await service.quoteSwap({
                    ...baseSwapParams,
                    recipient: ZERO_ADDRESS,
                    commit: true,
                });
                // feeAmount only reflects the (surcharged) gas cost, not swapValue itself.
                expect(withB2.feeAmount - withoutB2.feeAmount).toBeLessThan(b2Params.swapValue);
            });

            it("rejects swapValue above max_swap_value_wei", async () => {
                await expect(
                    service.quoteSwap({ ...b2Params, swapValue: Wei(MAX_SWAP_VALUE + 1n) }),
                ).rejects.toThrow(/swapValue .* exceeds max_swap_value_wei/);
            });

            it("rejects gasSwapMaxInput above the post-fee amount", async () => {
                await expect(
                    service.quoteSwap({
                        ...b2Params,
                        gasSwapMaxInput: Wei(2_000_000_000_000_000_000n),
                    }),
                ).rejects.toThrow(/gasSwapMaxInput .* exceeds the post-fee amount/);
            });
        });

        // C1 / R-C3: the ETH top-up is funded as msg.value from the relayer's own
        // wallet at relay time. The client only opts in via the `extraGas` flag
        // (mirroring the withdrawal path); the RELAYER computes the amount
        // (extraGasFundAmount × gasPrice) and folds it into feeAmount (user pre-pays) —
        // never client-chosen.
        describe("extraGas top-up (C1 / R-C3)", () => {
            // extraGasFundAmount (600k gas) × TEST_GAS_PRICE (1 gwei) = 0.0006 ETH
            const COMPUTED_TOP_UP = Wei(600_000n * TEST_GAS_PRICE);

            it("Computes the top-up from extraGasFundAmount × gasPrice, folds it into feeAmount, and commits it.", async () => {
                const withoutGas = await service.quoteSwap(baseSwapParams);
                const withGas = await service.quoteSwap({ ...baseSwapParams, extraGas: true });

                // Native asset (num/den = 1) => nativeGasInToken == nativeGas: the entire
                // top-up is added to the fee so the relayer is reimbursed, not out of pocket.
                expect(withGas.feeAmount - withoutGas.feeAmount).toBe(COMPUTED_TOP_UP);

                const committed = await service.quoteSwap({ ...baseSwapParams, extraGas: true, commit: true });
                const routing = decodeRelaySwapRouting(committed.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion
                expect(routing.nativeGas).toBe(COMPUTED_TOP_UP);
                expect(routing.feeAmount).toBe(withGas.feeAmount);
            });

            it("Does not clamp the top-up during a gas spike: it is the fixed budget × gasPrice.", async () => {
                // max_native_gas_wei is gone: 600k gas at 20 gwei = 0.012 ETH (above the old 0.01 ETH
                // default) is funded as computed; the user pre-pays it through feeAmount, bounded by
                // the amount check and maxRelayFee (a far larger spike fails maxRelayFee outright).
                const SPIKE_GAS_PRICE = 20_000_000_000n;
                mockChainService.getGasPrice.mockResolvedValue(Wei(SPIKE_GAS_PRICE));

                const committed = await service.quoteSwap({ ...baseSwapParams, extraGas: true, commit: true });
                const routing = decodeRelaySwapRouting(committed.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion
                expect(routing.nativeGas).toBe(600_000n * SPIKE_GAS_PRICE);
            });

            it("Leaves routing.nativeGas at 0 when extraGas is off.", async () => {
                const committed = await service.quoteSwap({ ...baseSwapParams, commit: true });
                const routing = decodeRelaySwapRouting(committed.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion
                expect(routing.nativeGas).toBe(0n);
            });

            // F-242: nativeGas is funded as msg.value from the relayer's own signer wallet
            // at relay time (evm.chain.service.ts), while the token-denominated fee here
            // was, before this fix, always routed to the configured feeReceiverAddress —
            // even when that differs from the signer. That silently drained the signer hot
            // wallet on every swap relay with a top-up. This mirrors the withdrawal path's
            // existing (correct) behavior.
            it("Routes the fee to the signer, not the configured fee receiver, when isFeeReceiverSameAsSigner is false (F-242).", async () => {
                mockConfigService.isFeeReceiverSameAsSigner.mockReturnValue(false);
                mockConfigService.signerPrivateKey.mockReturnValue(TEST_SIGNER_PKEY);

                const committed = await service.quoteSwap({ ...baseSwapParams, extraGas: true, commit: true });
                const routing = decodeRelaySwapRouting(committed.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion

                expect(routing.nativeGas).toBeGreaterThan(0n);
                expect(routing.feeRecipient).toBe(TEST_SIGNER_ADDRESS);
                expect(routing.feeRecipient).not.toBe(ANVIL_SECOND_ADDRESS); // not the configured receiver
            });

            it("Still routes the fee to the configured receiver when isFeeReceiverSameAsSigner is true, even with nativeGas > 0 (regression).", async () => {
                mockConfigService.isFeeReceiverSameAsSigner.mockReturnValue(true);

                const committed = await service.quoteSwap({ ...baseSwapParams, extraGas: true, commit: true });
                const routing = decodeRelaySwapRouting(committed.feeCommitment!.data); // eslint-disable-line @typescript-eslint/no-non-null-assertion

                expect(routing.nativeGas).toBeGreaterThan(0n);
                expect(routing.feeRecipient).toBe(ANVIL_SECOND_ADDRESS);
            });
        });
    });

    describe("Log hygiene (audit R-H4)", () => {
        const serializedLogCalls = () => {
            const logger = module.get(FATLoggerService) as unknown as ReturnType<typeof createMockLogger>;
            return JSON.stringify(
                [logger.log, logger.info, logger.error, logger.warn, logger.debug, logger.verbose].map((fn) => fn.mock.calls),
                (_key, value) => (typeof value === "bigint" ? value.toString() : value)
            );
        };

        it("Never logs recipient or amount for withdrawal quotes.", async () => {
            const amount = Wei(123_456_789_123_456_789n);
            await service.quote(
                { asset: TEST_ASSET, amount, extraGas: false, commit: false, recipient: ANVIL_SECOND_ADDRESS },
                false
            );

            const logs = serializedLogCalls();
            expect(logs.toLowerCase()).not.toContain(ANVIL_SECOND_ADDRESS.toLowerCase());
            expect(logs).not.toContain("123456789123456789");
        });

        it("Never logs recipient, amount, or swap routing for swap quotes.", async () => {
            mockConfigService.relaySwapsContractAddress.mockReturnValue(
                getAddress("0x000000000000000000000000000000000e1a75aa")
            );
            const swapCalldata = `0x${"ab".repeat(32)}` as `0x${string}`;
            const amount = Wei(987_654_321_987_654_321n);
            await service.quoteSwap({
                asset: TEST_ASSET,
                amount,
                outputToken: getAddress("0x0000000eF0000000000B00000000000000000000"),
                recipient: ANVIL_SECOND_ADDRESS,
                minOutputAmount: Wei(0n),
                extraGas: false,
                swapCalldata,
                swapTarget: getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"),
                dustRecipient: ANVIL_SECOND_ADDRESS,
                commit: false,
            });

            const logs = serializedLogCalls();
            expect(logs.toLowerCase()).not.toContain(ANVIL_SECOND_ADDRESS.toLowerCase());
            expect(logs).not.toContain("987654321987654321");
            expect(logs).not.toContain(swapCalldata);
        });
    });
});
