import { encodeAbiParameters, toFunctionSelector, toFunctionSignature } from "viem";
import { describe, expect, it } from "vitest";

import {
    PAYOUT_ROUTING_ABI,
    PAYOUT_ROUTING_ARRAY_ABI,
    PP_ROUTER_WITHDRAW_ABI,
} from "../../../src/internal.js";

// GAP-5: The relayer's production encoder (`relay/evm/fee_abi.ts`) defines its own
// copy of the PayoutRouting tuple ABI, independent of the SDK's PAYOUT_ROUTING_ABI /
// PAYOUT_ROUTING_ARRAY_ABI. Both must encode `transactParams.data` identically to
// what the contract decodes as `IPrivacyPoolRelay.PayoutRouting`; a silent field
// add/reorder on either side would only surface on-chain (PoolVault_ProofContextMismatch).
//
// A single test importing BOTH real encoders would be ideal, but is blocked by the
// toolchain: the relayer's jest cannot load the SDK's built main entry (it pulls in
// `@noble/ciphers` ESM), and importing the relayer's TS source into the SDK drags the
// relayer subtree under the SDK tsc rootDir (TS6059). So drift is pinned from BOTH
// sides against the SAME golden fixtures below: this SDK test pins PAYOUT_ROUTING_ABI,
// and the mirror relayer test (fee_abi.golden.spec.ts) pins encodeWithdrawalFeeSplit /
// encodeBatchFeeSplit to these identical bytes. A unilateral field change on either
// side breaks that side's pin.

const RECIPIENT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const FEE_RECIPIENT = "0xc1ebfda3114bc2496e86d466b3082491a96767df" as const;
const OTHER_RECIPIENT = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as const;

// -========- Golden canonical PayoutRouting encodings (shared with the relayer) -========-
// tuple(address recipient, address feeRecipient, uint256 feeAmount, uint256 nativeGas)
const GOLDEN_SINGLE =
    "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df00000000000000000000000000000000000000000000000000000000075bcd15000000000000000000000000000000000000000000000000000000000000002a";
const GOLDEN_ZERO =
    "0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
const GOLDEN_ARRAY =
    "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000300000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000003c44cdddb6a900fa2b585dd299e03d12fa4293bc000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000000500000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8000000000000000000000000c1ebfda3114bc2496e86d466b3082491a96767df00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
const GOLDEN_EMPTY_ARRAY =
    "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000";

describe("PayoutRouting ABI drift — SDK PAYOUT_ROUTING_ABI vs canonical golden bytes", () => {
    it("encode a single PayoutRouting to the canonical golden bytes", () => {
        const encoded = encodeAbiParameters(PAYOUT_ROUTING_ABI, [
            {
                recipient: RECIPIENT,
                feeRecipient: FEE_RECIPIENT,
                feeAmount: 123_456_789n,
                nativeGas: 42n,
            },
        ]);
        expect(encoded).toBe(GOLDEN_SINGLE);
    });

    it("encode a zero-fee PayoutRouting to the canonical golden bytes", () => {
        const encoded = encodeAbiParameters(PAYOUT_ROUTING_ABI, [
            { recipient: RECIPIENT, feeRecipient: FEE_RECIPIENT, feeAmount: 0n, nativeGas: 0n },
        ]);
        expect(encoded).toBe(GOLDEN_ZERO);
    });

    it("encode a PayoutRouting[] to the canonical golden bytes", () => {
        const encoded = encodeAbiParameters(PAYOUT_ROUTING_ARRAY_ABI, [
            [
                {
                    recipient: RECIPIENT,
                    feeRecipient: FEE_RECIPIENT,
                    feeAmount: 10n,
                    nativeGas: 0n,
                },
                {
                    recipient: OTHER_RECIPIENT,
                    feeRecipient: FEE_RECIPIENT,
                    feeAmount: 20n,
                    nativeGas: 5n,
                },
                { recipient: RECIPIENT, feeRecipient: FEE_RECIPIENT, feeAmount: 0n, nativeGas: 0n },
            ],
        ]);
        expect(encoded).toBe(GOLDEN_ARRAY);
    });

    it("encode an empty PayoutRouting[] to the canonical golden bytes", () => {
        const encoded = encodeAbiParameters(PAYOUT_ROUTING_ARRAY_ABI, [[]]);
        expect(encoded).toBe(GOLDEN_EMPTY_ARRAY);
    });
});

// GAP-3: `PP_ROUTER_WITHDRAW_ABI` is the SDK's copy of the deployed `PPRouter.withdrawToUnderlying`
// signature. The yield-withdraw session decodes a `PoolVault.transact` proof and re-encodes it under
// this ABI; a silent field add/reorder/type change (e.g. `uint256[][]` -> `uint256[8]` on
// `proof.pubSignals`, or dropping `minUnderlyingOut`) would only surface on-chain as a failed call.
// Pin both the canonical human-readable signature and its 4-byte selector against golden values.
describe("PPRouter.withdrawToUnderlying ABI drift — SDK PP_ROUTER_WITHDRAW_ABI vs canonical signature", () => {
    // Canonical signature of the deployed `withdrawToUnderlying(proof, transactParams, noteData, min)`.
    const GOLDEN_WITHDRAW_SIGNATURE =
        "withdrawToUnderlying((uint256[2],uint256[2][2],uint256[2],uint256[][]),(address,bytes),(bytes32,bytes)[],uint256)";
    const GOLDEN_WITHDRAW_SELECTOR = "0x23b370bb";

    const withdrawItem = PP_ROUTER_WITHDRAW_ABI[0];

    it("pin the exact PPRouter.withdrawToUnderlying function name", () => {
        expect(withdrawItem.name).toBe("withdrawToUnderlying");
    });

    it("pin the canonical withdrawToUnderlying signature", () => {
        expect(toFunctionSignature(withdrawItem)).toBe(GOLDEN_WITHDRAW_SIGNATURE);
    });

    it("pin the canonical withdrawToUnderlying 4-byte selector", () => {
        expect(toFunctionSelector(withdrawItem)).toBe(GOLDEN_WITHDRAW_SELECTOR);
    });
});
