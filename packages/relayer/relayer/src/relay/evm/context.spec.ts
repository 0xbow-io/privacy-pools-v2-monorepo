import { computeContext, SNARK_SCALAR_FIELD } from "./context";

// Expected values generated independently with foundry, so this test verifies
// fidelity to solidity's abi.encode rather than viem against itself:
//   cast abi-encode "f((address,bytes),(bytes32,bytes)[])" "(<processor>,<data>)" "[(<hint>,<data>)...]" | cast keccak
// then reduced mod SNARK_SCALAR_FIELD.
describe("computeContext", () => {
    const ZERO_HINT = `0x${"00".repeat(32)}` as const;

    it("matches solidity abi.encode for a single zeroed note (e2e default shape)", () => {
        const processor = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
        const data =
            "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c800000000000000000000000000000000000000000000000000000000000003e80000000000000000000000000000000000000000000000000000000000000000";

        const context = computeContext(processor, data, [{ hint: ZERO_HINT, data: "0x" }]);

        expect(context).toBe(11991007382023705029259503657810719081084516644059518116154949016810600016517n);
    });

    it("matches solidity abi.encode for multiple notes with non-zero payloads", () => {
        const context = computeContext("0x0000000000000000000000000000000000000001", "0xdeadbeef", [
            { hint: `0x${"11".repeat(32)}`, data: "0xaabb" },
            { hint: `0x${"22".repeat(32)}`, data: "0xccddeeff00" },
        ]);

        expect(context).toBe(4428624591245506442445705782929861511516884062291627933013007080822541676387n);
    });

    it("rejects a hint that is not exactly 32 bytes", () => {
        // viem's bytes32 encoding does not pad — callers must validate hint
        // length before invoking computeContext.
        expect(() =>
            computeContext("0x0000000000000000000000000000000000000001", "0x", [{ hint: "0xab", data: "0x" }])
        ).toThrow();
    });

    it("returns a value inside the scalar field", () => {
        const context = computeContext("0x0000000000000000000000000000000000000001", "0x", [
            { hint: ZERO_HINT, data: "0x" },
        ]);

        expect(context).toBeGreaterThanOrEqual(0n);
        expect(context).toBeLessThan(SNARK_SCALAR_FIELD);
    });
});
