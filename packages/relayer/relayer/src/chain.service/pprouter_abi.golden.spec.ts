import { toFunctionSelector, type AbiFunction } from "viem";
import { PP_ROUTER_WITHDRAW_ABI } from "../sdk/pprouter.abi";

// C2 drift guard: `PP_ROUTER_WITHDRAW_ABI` in `src/sdk/pprouter.abi.ts` is a
// jest/CJS-safe MIRROR of the SDK's canonical `PP_ROUTER_WITHDRAW_ABI`
// (`@privacy-pools-v2/evm-sdk`, defined in `packages/evm-sdk/src/constant/Yield.ts`).
// The relayer cannot import the SDK main entry under ts-jest (it transitively
// `require`s ESM-only `@noble/ciphers` / `multiformats/cid` / ...) — the same
// limitation `fee_abi.golden.spec.ts` and `schemas.batch-wire.spec.ts` document.
//
// This pins the mirror's function-signature TYPES (which is exactly what viem
// encodes for the on-chain `withdrawToUnderlying` call) to the canonical
// signature string below. Any add/reorder/retype of the router-withdraw args on
// either side (relayer mirror or the SDK/contract it mirrors) changes the
// 4-byte selector and fails this default-gate test. The SDK side is exercised
// against the live contract by `PoolSessionYieldWithdraw` (unit + realproof
// integration tests), keeping the two copies converged.
//
// Canonical `PPRouter.withdrawToUnderlying` signature (types only, from
// contracts/out/PPRouter.sol/PPRouter.json): a TransactProof tuple, an
// IPPPoolVault.TransactParams tuple, an IPPEntrypoint.NoteData[] tuple[], and a
// trailing `minUnderlyingOut` uint256.
const CANONICAL_WITHDRAW_TO_UNDERLYING_SIG =
    "withdrawToUnderlying((uint256[2],uint256[2][2],uint256[2],uint256[][]),(address,bytes),(bytes32,bytes)[],uint256)";

describe("PPRouter ABI drift — relayer pprouter.abi mirror vs canonical signature", () => {
    const fragment = PP_ROUTER_WITHDRAW_ABI.find(
        (f) => f.type === "function" && f.name === "withdrawToUnderlying"
    ) as unknown as AbiFunction;

    it("exposes exactly one withdrawToUnderlying function fragment", () => {
        const fns = PP_ROUTER_WITHDRAW_ABI.filter(
            (f) => f.type === "function" && f.name === "withdrawToUnderlying"
        );
        expect(fns).toHaveLength(1);
        expect(fragment).toBeDefined();
    });

    it("the fragment's selector matches the canonical withdrawToUnderlying signature", () => {
        // toFunctionSelector derives from the argument TYPES only, so this pins
        // the whole tuple/array structure regardless of parameter names.
        expect(toFunctionSelector(fragment)).toBe(
            toFunctionSelector(CANONICAL_WITHDRAW_TO_UNDERLYING_SIG)
        );
    });

    it("has the expected proof / transactParams / noteData / minUnderlyingOut input types", () => {
        expect(fragment.inputs).toHaveLength(4);

        const [proof, transactParams, noteData, minUnderlyingOut] = fragment.inputs;

        // proof tuple: pA uint256[2], pB uint256[2][2], pC uint256[2], pubSignals uint256[][]
        expect(proof.type).toBe("tuple");
        expect((proof as { components: { type: string }[] }).components.map((c) => c.type)).toEqual([
            "uint256[2]",
            "uint256[2][2]",
            "uint256[2]",
            "uint256[][]",
        ]);

        // transactParams tuple: (address processor, bytes data)
        expect(transactParams.type).toBe("tuple");
        expect(
            (transactParams as { components: { type: string }[] }).components.map((c) => c.type)
        ).toEqual(["address", "bytes"]);

        // noteData tuple[]: (bytes32 hint, bytes data)[]
        expect(noteData.type).toBe("tuple[]");
        expect((noteData as { components: { type: string }[] }).components.map((c) => c.type)).toEqual([
            "bytes32",
            "bytes",
        ]);

        // trailing slippage floor
        expect(minUnderlyingOut.type).toBe("uint256");
        expect(minUnderlyingOut.name).toBe("minUnderlyingOut");
    });

    it("returns two uint256 outputs (underlyingToRecipient, underlyingFee) and is payable", () => {
        expect(fragment.outputs.map((o) => o.type)).toEqual(["uint256", "uint256"]);
        expect(fragment.stateMutability).toBe("payable");
    });
});
