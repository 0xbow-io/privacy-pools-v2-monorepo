import { EvmChainConfigWrapper } from "./evm-chain-config";
import { zEvmSafeChainConfig } from "./evm.config.schemas";

// evm-chain-config.spec.ts tests EvmChainConfigWrapper without a full RelayerConfig.
// Real (non-mocked) coverage for the processor allowlist matching logic. Previously only the
// mocked boolean `isAllowedProcessor(...)` was exercised (in the relay-service specs); the actual
// case-insensitive match + empty/undefined-default behaviour in `evm-chain-config.ts` had no test, so a
// drift there (e.g. a missing lowercase, or a non-empty default) would ship uncaught. This builds a
// real EvmChainConfigWrapper over just the `allowed_processors` field and asserts the real method.

const ADDR_A = "0xAbCdEf0000000000000000000000000000000001";
const ADDR_B = "0x00000000000000000000000000000000000000B2";

function chainWithAllowlist(allowed?: string[]): EvmChainConfigWrapper {
    // Only `allowed_processors` is read by isAllowedProcessor; cast the rest away for a focused unit.
    return new EvmChainConfigWrapper({ allowed_processors: allowed } as never);
}

function chainWithRelaySwaps(relaySwaps?: string): EvmChainConfigWrapper {
    return new EvmChainConfigWrapper({ relay_swaps_contract: relaySwaps } as never);
}

describe("EvmChainConfigWrapper.isAllowedProcessor", () => {
    it("returns false when the allowlist is empty", () => {
        expect(chainWithAllowlist([]).isAllowedProcessor(ADDR_A)).toBe(false);
    });

    it("returns false when allowed_processors is undefined (empty default, never open)", () => {
        expect(chainWithAllowlist(undefined).isAllowedProcessor(ADDR_A)).toBe(false);
    });

    it("matches an allowlisted processor case-insensitively", () => {
        const chain = chainWithAllowlist([ADDR_A.toLowerCase()]);
        expect(chain.isAllowedProcessor(ADDR_A)).toBe(true);
        expect(chain.isAllowedProcessor(ADDR_A.toUpperCase().replace("0X", "0x"))).toBe(true);
        expect(chain.isAllowedProcessor(ADDR_A.toLowerCase())).toBe(true);
    });

    it("rejects an address not in the allowlist", () => {
        const chain = chainWithAllowlist([ADDR_A]);
        expect(chain.isAllowedProcessor(ADDR_B)).toBe(false);
    });

    it("matches one processor among several", () => {
        const chain = chainWithAllowlist([ADDR_A, ADDR_B]);
        expect(chain.isAllowedProcessor(ADDR_B.toLowerCase())).toBe(true);
        expect(chain.isAllowedProcessor(ADDR_A.toLowerCase())).toBe(true);
        expect(chain.isAllowedProcessor("0x0000000000000000000000000000000000000009")).toBe(false);
    });
});

describe("EvmChainConfigWrapper.relaySwapsContractAddress", () => {
    it("returns the configured address", () => {
        const chain = chainWithRelaySwaps(ADDR_A);
        expect(chain.relaySwapsContractAddress()).toBe(ADDR_A);
    });

    it("returns undefined when unset", () => {
        const chain = chainWithRelaySwaps(undefined);
        expect(chain.relaySwapsContractAddress()).toBeUndefined();
    });

    it("treats the zero address as unset (fail closed, never target 0x0)", () => {
        const chain = chainWithRelaySwaps("0x0000000000000000000000000000000000000000");
        expect(chain.relaySwapsContractAddress()).toBeUndefined();
    });
});

describe("EvmChainConfigWrapper.maxSwapValueWei (B2)", () => {
    afterEach(() => {
        delete process.env.MAX_SWAP_VALUE_WEI_EVM_10;
    });

    function chain10(maxSwapValueWei?: bigint): EvmChainConfigWrapper {
        return new EvmChainConfigWrapper({
            id: 10,
            max_swap_value_wei: maxSwapValueWei,
        } as never);
    }

    it("returns the configured per-chain value", () => {
        expect(chain10(5_000_000_000_000_000n).maxSwapValueWei()).toBe(5_000_000_000_000_000n);
    });

    it("defaults to 0.08 native when the config omits max_swap_value_wei", () => {
        // Sized for BSC (B2's real funding chain): a ~0.006 BNB Stargate fee x 1.2 headroom tripped
        // the old 0.005 default in prod. Mainnet is tightened to 0.02 via MAX_SWAP_VALUE_WEI_EVM_1.
        const parsed = zEvmSafeChainConfig.shape.max_swap_value_wei.parse(undefined);
        expect(parsed).toBe(80_000_000_000_000_000n);
    });

    it("MAX_SWAP_VALUE_WEI_EVM_<id> env overrides the config value", () => {
        process.env.MAX_SWAP_VALUE_WEI_EVM_10 = "1234000000000000";
        expect(chain10(5_000_000_000_000_000n).maxSwapValueWei()).toBe(1_234_000_000_000_000n);
    });
});

describe("EvmChainConfigWrapper.destinationCallsSupported", () => {
    afterEach(() => {
        delete process.env.DESTINATION_CALLS_SUPPORTED_EVM_10;
    });

    function chain10(destinationCallsSupported?: boolean): EvmChainConfigWrapper {
        return new EvmChainConfigWrapper({
            id: 10,
            destination_calls_supported: destinationCallsSupported,
        } as never);
    }

    it("returns the configured per-chain value", () => {
        expect(chain10(true).destinationCallsSupported()).toBe(true);
    });

    it("defaults to false when the config omits destination_calls_supported", () => {
        expect(zEvmSafeChainConfig.shape.destination_calls_supported.parse(undefined)).toBe(false);
        expect(chain10(undefined).destinationCallsSupported()).toBe(false);
    });

    it("DESTINATION_CALLS_SUPPORTED_EVM_<id> env overrides the config value", () => {
        process.env.DESTINATION_CALLS_SUPPORTED_EVM_10 = "false";
        expect(chain10(true).destinationCallsSupported()).toBe(false);
        process.env.DESTINATION_CALLS_SUPPORTED_EVM_10 = "true";
        expect(chain10(false).destinationCallsSupported()).toBe(true);
    });

    it("throws on an env value other than true/false", () => {
        process.env.DESTINATION_CALLS_SUPPORTED_EVM_10 = "yes";
        expect(() => chain10(true).destinationCallsSupported()).toThrow(/DESTINATION_CALLS_SUPPORTED_EVM_10/);
    });
});

describe("EvmChainConfigWrapper env override namespacing", () => {
    const EVM_RECEIVER = "0x1111111111111111111111111111111111111111";
    const CONFIG_RECEIVER = "0x2222222222222222222222222222222222222222";

    afterEach(() => {
        delete process.env.FEE_RECEIVER_ADDRESS_EVM_1;
        delete process.env.FEE_RECEIVER_ADDRESS_1;
    });

    function chain1(): EvmChainConfigWrapper {
        return new EvmChainConfigWrapper({ id: 1, fee_receiver_address: CONFIG_RECEIVER } as never);
    }

    it("reads the chain-type-namespaced key", () => {
        process.env.FEE_RECEIVER_ADDRESS_EVM_1 = EVM_RECEIVER;
        expect(chain1().feeReceiverAddress()).toBe(EVM_RECEIVER);
    });

    it("ignores the legacy id-only key (no cross-chain-type collision)", () => {
        // A Stellar address left in the legacy FEE_RECEIVER_ADDRESS_1 must NOT be picked up by the
        // EVM chain that happens to share id 1 — this is the bug the namespacing fixes.
        process.env.FEE_RECEIVER_ADDRESS_1 = "GCPHLYQQAORO7PUAG2RMPPI466WFH3PDOYS5QWTOUBPX6OPJRKKOZFET";
        expect(chain1().feeReceiverAddress()).toBe(CONFIG_RECEIVER);
    });
});
