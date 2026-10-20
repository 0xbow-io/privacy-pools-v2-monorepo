import { encodeWithdrawalFeeSplit, encodeBatchFeeSplit } from "./fee_abi";
import { FeeSplit } from "./types";

// GAP-5 (relayer side): pins the relayer's PRODUCTION PayoutRouting encoders to the
// same canonical golden bytes the SDK test (test/unit/constant/PayoutRoutingAbiDrift.test.ts)
// pins PAYOUT_ROUTING_ABI / PAYOUT_ROUTING_ARRAY_ABI to. The SDK's built main entry
// cannot be imported here (jest cannot transform the `@noble/ciphers` ESM it pulls in),
// so the two independent ABI copies are cross-checked indirectly: both encode these
// identical bytes. A field add/reorder on the relayer's `fee_abi.ts` tuple breaks this
// test; the same change on the SDK side breaks the SDK test. Keep the two golden-byte
// sets in sync — they are the canonical IPrivacyPoolRelay.PayoutRouting ABI encoding.

const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const FEE_RECIPIENT = "0xc1ebfda3114bc2496e86d466b3082491a96767df" as const;
const OTHER_RECIPIENT = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as const;

const GOLDEN_SINGLE =
    "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df00000000000000000000000000000000000000000000000000000000075bcd15000000000000000000000000000000000000000000000000000000000000002a";
const GOLDEN_ZERO =
    "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
const GOLDEN_ARRAY =
    "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000300000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000500000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
const GOLDEN_EMPTY_ARRAY =
    "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";

describe("PayoutRouting ABI drift — relayer fee_abi vs canonical golden bytes", () => {
    it("encodeWithdrawalFeeSplit matches the canonical single-routing golden bytes", () => {
        expect(encodeWithdrawalFeeSplit(RECIPIENT, FEE_RECIPIENT, 123_456_789n, 42n)).toBe(
            GOLDEN_SINGLE
        );
    });

    it("encodeWithdrawalFeeSplit matches the canonical zero-fee golden bytes (default nativeGas)", () => {
        expect(encodeWithdrawalFeeSplit(RECIPIENT, FEE_RECIPIENT, 0n)).toBe(GOLDEN_ZERO);
    });

    it("encodeBatchFeeSplit matches the canonical PayoutRouting[] golden bytes", () => {
        const routings: FeeSplit[] = [
            { recipient: RECIPIENT, feeRecipient: FEE_RECIPIENT, feeAmount: 10n, nativeGas: 0n },
            { recipient: OTHER_RECIPIENT, feeRecipient: FEE_RECIPIENT, feeAmount: 20n, nativeGas: 5n },
            { recipient: RECIPIENT, feeRecipient: FEE_RECIPIENT, feeAmount: 0n, nativeGas: 0n },
        ];
        expect(encodeBatchFeeSplit(routings)).toBe(GOLDEN_ARRAY);
    });

    it("encodeBatchFeeSplit matches the canonical empty PayoutRouting[] golden bytes", () => {
        expect(encodeBatchFeeSplit([])).toBe(GOLDEN_EMPTY_ARRAY);
    });
});
