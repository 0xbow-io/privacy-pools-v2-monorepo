import { getAddress } from "viem";
import { zEvmRelayWithdrawalRequest } from "./schemas";

// TG-2: the RECEIVING side of the yield-withdraw seam. The sending SDK asserts
// `processorAddress` + `minUnderlyingOut` survive its own serialization; this
// pins the relayer's `zEvmRelayWithdrawalRequest.parse()` to preserve BOTH
// optional fields (no strip) and to reject a malformed `processorAddress` /
// non-integer `minUnderlyingOut`. Mirrors the parse-survival pattern used for
// the register-and-relay hex fields (`evm.relay.service.spec.ts`) and the
// batch wire shape (`schemas.batch-wire.spec.ts`).

const ASSET = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
// Lowercase on the wire so the checksum transform is observable after parse.
const PROCESSOR = "0x7c7c871fbeb28f90a85d47868aa5245f370e142f";

// A valid single-withdrawal wire body: snarkjs proof (pi_a/pi_c 3-tuples, pi_b
// 3x2), publicSignals length = inputNullifierNumber (1) + outputCommitmentNumber
// (1) + 6 scalars = 8, plus a signed withdrawal fee commitment.
function makeWireBody() {
    return {
        proof: {
            pi_a: ["0x01", "0x02", "0x03"],
            pi_b: [
                ["0x04", "0x05"],
                ["0x06", "0x07"],
                ["0x08", "0x09"],
            ],
            pi_c: ["0x0a", "0x0b", "0x0c"],
            protocol: "groth16",
            curve: "bn128",
            publicSignals: ["0x11", "0x12", "0x13", "0x14", "0x15", "0x16", "0x17", "0x18"],
        },
        inputNullifierNumber: 1,
        outputCommitmentNumber: 1,
        noteData: [{ hint: "0x01", data: "0xabcdef" }],
        signedFeeCommitment: {
            data: "0x00",
            asset: ASSET,
            expiration: Date.now() + 3_600_000,
            feeAmount: "10000",
            recipient: RECIPIENT,
            amountSent: "1000000",
            amountReceived: "990000",
            signedRelayerCommitment: "0x00",
        },
        processorAddress: PROCESSOR,
        minUnderlyingOut: "990000",
    } as Record<string, unknown>;
}

describe("zEvmRelayWithdrawalRequest — processor/minUnderlyingOut parse survival", () => {
    it("parses a valid request and PRESERVES processorAddress + minUnderlyingOut (no strip)", () => {
        const parsed = zEvmRelayWithdrawalRequest.parse(makeWireBody());

        // processorAddress survives, checksummed by the zEvmAddress transform.
        expect(parsed.processorAddress).toBe(getAddress(PROCESSOR));
        // minUnderlyingOut survives, coerced string -> bigint.
        expect(parsed.minUnderlyingOut).toBe(990_000n);
    });

    it("leaves both fields undefined when the client omits them (optional, not injected)", () => {
        const body = makeWireBody();
        delete body.processorAddress;
        delete body.minUnderlyingOut;

        const parsed = zEvmRelayWithdrawalRequest.parse(body);
        expect(parsed.processorAddress).toBeUndefined();
        expect(parsed.minUnderlyingOut).toBeUndefined();
    });

    it("rejects a malformed processorAddress", () => {
        const body = makeWireBody();
        body.processorAddress = "0xnot-an-address";
        expect(() => zEvmRelayWithdrawalRequest.parse(body)).toThrow();
    });

    it("rejects a non-integer minUnderlyingOut", () => {
        const body = makeWireBody();
        body.minUnderlyingOut = "1.5";
        expect(() => zEvmRelayWithdrawalRequest.parse(body)).toThrow();
    });

    it("rejects a negative minUnderlyingOut", () => {
        const body = makeWireBody();
        body.minUnderlyingOut = "-1";
        expect(() => zEvmRelayWithdrawalRequest.parse(body)).toThrow();
    });

    // cubic finding [8]: the slippage floor must not lose precision. A decimal
    // STRING above Number.MAX_SAFE_INTEGER must round-trip to the exact bigint.
    it("preserves full precision for a large minUnderlyingOut sent as a decimal string", () => {
        const body = makeWireBody();
        // MAX_SAFE_INTEGER (9007199254740991) + 2 — a value a JS number cannot hold exactly.
        const big = "9007199254740993";
        body.minUnderlyingOut = big;

        const parsed = zEvmRelayWithdrawalRequest.parse(body);
        expect(parsed.minUnderlyingOut).toBe(9007199254740993n);
        // Sanity: coercing via a JS number would have rounded to ...992, losing precision.
        expect(parsed.minUnderlyingOut).not.toBe(BigInt(Number(big)));
    });

    it("rejects a minUnderlyingOut JS number above Number.MAX_SAFE_INTEGER (would lose precision)", () => {
        const body = makeWireBody();
        // A JSON number above MAX_SAFE_INTEGER the parser has already rounded; accepting it
        // would silently weaken the client's intended floor. Computed (not a literal) so
        // eslint's no-loss-of-precision doesn't flag the intentionally-imprecise value.
        body.minUnderlyingOut = Number.MAX_SAFE_INTEGER + 2;
        expect(() => zEvmRelayWithdrawalRequest.parse(body)).toThrow();
    });

    it("still accepts a safe minUnderlyingOut JS number", () => {
        const body = makeWireBody();
        body.minUnderlyingOut = 990_000;
        const parsed = zEvmRelayWithdrawalRequest.parse(body);
        expect(parsed.minUnderlyingOut).toBe(990_000n);
    });
});
