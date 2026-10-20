import { zEvmSwapQuoteRequest } from "./evm.schemas";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RECIPIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TOKEN_A = "0x0000000eF0000000000A00000000000000000000";
const TOKEN_B = "0x0000000eF0000000000B00000000000000000000";
const DUST_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SWAP_TARGET = "0x2222222222222222222222222222222222222222";
const SWAP_CALLDATA = "0xdeadbeef";

const baseRequest = {
    asset: TOKEN_A,
    amount: "1000000",
    outputToken: TOKEN_B,
    recipient: RECIPIENT,
    minOutputAmount: "0",
    dustRecipient: DUST_RECIPIENT,
    commit: false,
};

describe("zEvmSwapQuoteRequest", () => {
    // -========- Committed-quote requirements (swapCalldata / swapTarget) -========-

    it("accepts a non-committed quote without swapCalldata/swapTarget", () => {
        const result = zEvmSwapQuoteRequest.safeParse({ ...baseRequest, commit: false });
        expect(result.success).toBe(true);
    });

    it("rejects a committed quote missing swapCalldata", () => {
        const result = zEvmSwapQuoteRequest.safeParse({ ...baseRequest, commit: true, swapTarget: SWAP_TARGET });
        expect(result.success).toBe(false);
    });

    it("rejects a committed quote missing swapTarget", () => {
        const result = zEvmSwapQuoteRequest.safeParse({ ...baseRequest, commit: true, swapCalldata: SWAP_CALLDATA });
        expect(result.success).toBe(false);
    });

    it("accepts a committed quote with swapCalldata and swapTarget", () => {
        const result = zEvmSwapQuoteRequest.safeParse({
            ...baseRequest,
            commit: true,
            swapCalldata: SWAP_CALLDATA,
            swapTarget: SWAP_TARGET,
        });
        expect(result.success).toBe(true);
    });

    // -========- B2 — self-funded bridge msg.value fields -========-

    const committedBase = {
        ...baseRequest,
        recipient: ZERO_ADDRESS,
        commit: true,
        swapCalldata: SWAP_CALLDATA,
        swapTarget: SWAP_TARGET,
    };

    it("accepts a committed reshield quote with the full B2 field set", () => {
        const result = zEvmSwapQuoteRequest.safeParse({
            ...committedBase,
            swapValue: "300000000000000",
            gasSwapMaxInput: "5000",
            gasSwapCalldata: "0xc0ffee",
        });
        expect(result.success).toBe(true);
    });

    it("accepts a committed quote with swapValue omitted (non-B2 path)", () => {
        const result = zEvmSwapQuoteRequest.safeParse(committedBase);
        expect(result.success).toBe(true);
    });

    it("rejects swapValue > 0 without gasSwapCalldata", () => {
        const result = zEvmSwapQuoteRequest.safeParse({
            ...committedBase,
            swapValue: "300000000000000",
            gasSwapMaxInput: "5000",
        });
        expect(result.success).toBe(false);
    });

    it("rejects swapValue > 0 with a zero gasSwapMaxInput", () => {
        const result = zEvmSwapQuoteRequest.safeParse({
            ...committedBase,
            swapValue: "300000000000000",
            gasSwapMaxInput: "0",
            gasSwapCalldata: "0xc0ffee",
        });
        expect(result.success).toBe(false);
    });

    it("does not require the B2 companions when swapValue is 0", () => {
        const result = zEvmSwapQuoteRequest.safeParse({ ...committedBase, swapValue: "0" });
        expect(result.success).toBe(true);
    });

    // -========- Zero-recipient invariant (reshield / cross-chain) -========-

    it("accepts a nonzero recipient with nonzero minOutputAmount and extraGas", () => {
        const result = zEvmSwapQuoteRequest.safeParse({
            ...baseRequest,
            minOutputAmount: "990000",
            extraGas: true,
        });
        expect(result.success).toBe(true);
    });

    it("defaults extraGas to false when omitted", () => {
        const result = zEvmSwapQuoteRequest.safeParse(baseRequest);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.extraGas).toBe(false);
        }
    });

    it("accepts a zero recipient when extraGas is off and minOutputAmount is zero", () => {
        const result = zEvmSwapQuoteRequest.safeParse({
            ...baseRequest,
            recipient: ZERO_ADDRESS,
        });
        expect(result.success).toBe(true);
    });

    it("accepts a zero recipient with explicit extraGas false", () => {
        const result = zEvmSwapQuoteRequest.safeParse({
            ...baseRequest,
            recipient: ZERO_ADDRESS,
            extraGas: false,
        });
        expect(result.success).toBe(true);
    });

    it("rejects a zero recipient with extraGas enabled", () => {
        const result = zEvmSwapQuoteRequest.safeParse({
            ...baseRequest,
            recipient: ZERO_ADDRESS,
            extraGas: true,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].path).toEqual(["extraGas"]);
        }
    });

    it("rejects a zero recipient with nonzero minOutputAmount", () => {
        const result = zEvmSwapQuoteRequest.safeParse({
            ...baseRequest,
            recipient: ZERO_ADDRESS,
            minOutputAmount: "1",
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues[0].path).toEqual(["minOutputAmount"]);
        }
    });
});
