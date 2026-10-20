import type { Hex } from "viem";
import { queryRateForPair } from "./curve_quote_obtention";
import { ChainType } from "../../config/enums";
import { RateProvider } from "../rate_types";
import type { TokenDescription } from "../rate_types";

const readContract = jest.fn();
const getBlockNumber = jest.fn();
jest.mock("../utilities", () => ({
    getWallet: () => ({ readContract, getBlockNumber }),
}));

const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Hex;
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const SOME_OTHER_TOKEN = "0x0000000000000000000000000000000000000042" as Hex;

const CURRENT_RATE = 2_500n * 10n ** 18n;

function token(address: Hex, ticker: string, decimals = 18): TokenDescription {
    return { address, ticker, quoter: RateProvider.CURVE, decimals, chainType: ChainType.EVM, chainId: 1 };
}

describe("Curve queryRateForPair — historic-rate self-check on the anchor", () => {
    beforeEach(() => {
        readContract.mockReset();
        getBlockNumber.mockReset();
        delete process.env.DISABLE_CURVE_HISTORIC_RATE_CHECK;
    });

    it("skips the historic-manipulation check when input_token IS the chain's anchor (WETH)", async () => {
        readContract.mockResolvedValueOnce(CURRENT_RATE); // the one and only get_aggregated_rate call

        const quote = await queryRateForPair(
            token(MAINNET_WETH, "WETH"),
            token(MAINNET_USDC, "USDC", 6),
            ChainType.EVM,
            1,
            "https://rpc.example",
        );

        expect(quote.num).toBe(CURRENT_RATE);
        expect(readContract).toHaveBeenCalledTimes(1); // no second (historic) read
        expect(getBlockNumber).not.toHaveBeenCalled();
    });

    it("still runs the historic-manipulation check for a real, non-anchor input token", async () => {
        readContract.mockResolvedValueOnce(CURRENT_RATE); // current rate
        getBlockNumber.mockResolvedValueOnce(1_000_000n);
        readContract.mockResolvedValueOnce(CURRENT_RATE); // historic rate, same value: passes

        const quote = await queryRateForPair(
            token(SOME_OTHER_TOKEN, "SOME"),
            token(MAINNET_USDC, "USDC", 6),
            ChainType.EVM,
            1,
            "https://rpc.example",
        );

        expect(quote.num).toBe(CURRENT_RATE);
        expect(readContract).toHaveBeenCalledTimes(2);
        expect(getBlockNumber).toHaveBeenCalledTimes(1);
    });
});
