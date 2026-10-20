import { toFunctionSelector, type AbiFunction, type AbiError } from "viem";
import { PP_RELAY_ABI } from "../sdk/relayer_abi";
import { ALL_CONTRACT_ERRORS } from "./contract_errors";

// G2 (TEST-8) drift guard for the relayed key-registration path.
//
// The relayer decodes register-and-relay reverts using a HAND-LISTED ABI: the
// `registerAndRelay` fragment in `src/sdk/relayer_abi.ts` (PP_RELAY_ABI) and the
// Keystore custom errors in `src/chain.service/contract_errors.ts` (folded into
// ALL_CONTRACT_ERRORS). Nothing else pins those hand copies to the compiled
// contract: `contract_errors.spec` re-encodes from the SAME names (self-referential),
// so a Solidity rename/retype would silently regress register-path reverts to raw
// `0x…` selectors with no failing test.
//
// This is the golden. The GOLDEN_SELECTOR values below are transcribed from the
// compiled artifacts and are the independent source of truth:
//   packages/contracts/out/IKeystore.sol/IKeystore.json          (Keystore errors)
//   packages/contracts/out/PrivacyPoolRelay.sol/PrivacyPoolRelay.json (registerAndRelay)
// Recompute after a contract change with:
//   node -e "const {toFunctionSelector}=require('viem');const fs=require('fs');\
//     const j=JSON.parse(fs.readFileSync('out/IKeystore.sol/IKeystore.json'));\
//     j.abi.filter(x=>x.type==='error').forEach(e=>console.log(e.name,\
//     toFunctionSelector(e.name+'('+e.inputs.map(i=>i.type).join(',')+')')))"
//
// If the relayer's hand-listed ABI drifts from the contract, the derived selector
// diverges from the frozen golden and this test fails. Mirrors
// `fee_abi.golden.spec.ts` and `pprouter_abi.golden.spec.ts` (the SDK main entry
// cannot be imported under ts-jest, so the compiled artifact is pinned by value).

// Canonical `IPrivacyPoolRelay.registerAndRelay` signature (types only), from
// out/PrivacyPoolRelay.sol/PrivacyPoolRelay.json: account, authDigest,
// nullifyingKeyHash, deadline (uint256×4 after the address), signature (bytes), a
// TransactProof tuple, an IPoolVault.TransactParams tuple, an IPoolVault.NoteData[] tuple[].
const CANONICAL_REGISTER_AND_RELAY_SIG =
    "registerAndRelay(address,uint256,uint256,uint256,bytes,(uint256[2],uint256[2][2],uint256[2],uint256[][]),(address,bytes),(bytes32,bytes)[])";
const GOLDEN_REGISTER_AND_RELAY_SELECTOR = "0xaaa7a340";

// Every Keystore custom error the relayer decodes on the register-and-relay path,
// pinned to its artifact-verified 4-byte selector (all are zero-input).
const GOLDEN_KEYSTORE_ERROR_SELECTORS: Record<string, `0x${string}`> = {
    Keystore_AuthPolicyAlreadySet: "0x70d48a55",
    Keystore_AuthPolicyNotSet: "0xe2e716bd",
    Keystore_InvalidNullifyingKeyHash: "0xbde6fb2a",
    Keystore_OutOfScalarField: "0x8379dcb3",
    Keystore_KeystoreTreeFull: "0x384dd891",
    Keystore_InvalidMaxTreeSize: "0x3542d539",
    Keystore_InvalidSignature: "0x0ae65d93",
    Keystore_SignatureExpired: "0xfae4046b",
};

/** Build the canonical error signature `name(type,type,...)` from an ABI error fragment. */
function errorSignature(fragment: AbiError): string {
    return `${fragment.name}(${fragment.inputs.map((i) => i.type).join(",")})`;
}

describe("register-and-relay ABI drift — relayer hand-listed ABI vs compiled-artifact golden", () => {
    describe("registerAndRelay function fragment (PP_RELAY_ABI)", () => {
        const fragment = PP_RELAY_ABI.find(
            (f) => f.type === "function" && f.name === "registerAndRelay"
        ) as unknown as AbiFunction;

        it("exposes exactly one registerAndRelay function fragment", () => {
            const fns = PP_RELAY_ABI.filter(
                (f) => f.type === "function" && f.name === "registerAndRelay"
            );
            expect(fns).toHaveLength(1);
            expect(fragment).toBeDefined();
        });

        it("matches the frozen artifact selector", () => {
            expect(toFunctionSelector(fragment)).toBe(GOLDEN_REGISTER_AND_RELAY_SELECTOR);
        });

        it("matches the canonical signature-string selector (types + order)", () => {
            expect(toFunctionSelector(fragment)).toBe(
                toFunctionSelector(CANONICAL_REGISTER_AND_RELAY_SIG)
            );
        });

        it("has the expected 8 input types in order", () => {
            expect(fragment.inputs.map((i) => i.type)).toEqual([
                "address",
                "uint256",
                "uint256",
                "uint256",
                "bytes",
                "tuple", // TransactProof
                "tuple", // TransactParams
                "tuple[]", // NoteData[]
            ]);
        });
    });

    describe("Keystore error fragments the relayer decodes (ALL_CONTRACT_ERRORS)", () => {
        const errorFragments = ALL_CONTRACT_ERRORS.filter(
            (f): f is AbiError => f.type === "error"
        );

        it.each(Object.entries(GOLDEN_KEYSTORE_ERROR_SELECTORS))(
            "%s is present and matches its frozen artifact selector",
            (name, goldenSelector) => {
                const fragment = errorFragments.find((f) => f.name === name);
                expect(fragment).toBeDefined();
                // Zero-input error → selector is keccak(name())[0:4]. A rename/retype on the
                // relayer's hand-listed KEYSTORE_ERRORS diverges from the golden and fails here.
                expect(toFunctionSelector(errorSignature(fragment as AbiError))).toBe(goldenSelector);
            }
        );

        it("pins every Keystore error the register path can surface (no silent drop)", () => {
            const keystoreNames = errorFragments
                .map((f) => f.name)
                .filter((n) => n?.startsWith("Keystore_"));
            // The relayer must carry AT LEAST the golden set; a dropped entry would regress that
            // revert to a raw selector on the register-and-relay path.
            for (const name of Object.keys(GOLDEN_KEYSTORE_ERROR_SELECTORS)) {
                expect(keystoreNames).toContain(name);
            }
        });
    });
});
