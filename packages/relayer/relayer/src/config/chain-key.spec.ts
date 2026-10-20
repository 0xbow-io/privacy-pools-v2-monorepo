import { chainKey } from "./chain-key";
import { ChainType } from "./enums";

// Guards against network identification collision, for example misktaking
// SUI chain id 1 for EVM chain id 1.
describe("chainKey", () => {
    it("namespaces by the uppercased chain type", () => {
        expect(chainKey(ChainType.EVM, 1)).toBe("EVM_1");
        expect(chainKey(ChainType.STELLAR, 1)).toBe("STELLAR_1");
    });

    it("produces distinct keys for different chain types sharing the same numeric id", () => {
        expect(chainKey(ChainType.EVM, 1)).not.toBe(chainKey(ChainType.STELLAR, 1));
        expect(chainKey(ChainType.EVM, 1)).not.toBe(chainKey(ChainType.STARKNET, 1));
    });

    it("produces distinct keys for different ids on the same chain type", () => {
        expect(chainKey(ChainType.EVM, 1)).not.toBe(chainKey(ChainType.EVM, 2));
    });
});
