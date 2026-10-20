import { StellarChainConfigWrapper } from "./stellar-chain-config";

// Covers the chain-type-namespaced env override keys. The regression this guards: when an EVM
// chain and a Stellar chain share a numeric id, the old id-only key (e.g. FEE_RECEIVER_ADDRESS_1)
// collided — the Stellar chain would read the EVM chain's 0x fee receiver and fail StrKey parsing
// on the commit path. The namespaced key (FEE_RECEIVER_ADDRESS_STELLAR_<id>) isolates them.

const CONFIG_RECEIVER = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const ENV_RECEIVER = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";

function chain1(): StellarChainConfigWrapper {
    return new StellarChainConfigWrapper({ id: 1, fee_receiver_address: CONFIG_RECEIVER } as never);
}

describe("StellarChainConfigWrapper.feeReceiverAddress namespacing", () => {
    afterEach(() => {
        delete process.env.FEE_RECEIVER_ADDRESS_STELLAR_1;
        delete process.env.FEE_RECEIVER_ADDRESS_1;
    });

    it("falls back to the config value when no env override is set", () => {
        expect(chain1().feeReceiverAddress()).toBe(CONFIG_RECEIVER);
    });

    it("reads the chain-type-namespaced key", () => {
        process.env.FEE_RECEIVER_ADDRESS_STELLAR_1 = ENV_RECEIVER;
        expect(chain1().feeReceiverAddress()).toBe(ENV_RECEIVER);
    });

    it("ignores the legacy id-only key set by a colliding EVM chain", () => {
        // An EVM 0x fee receiver left in the legacy FEE_RECEIVER_ADDRESS_1 must not reach the
        // Stellar chain sharing id 1 (it would throw a StrKey error on commit). It is ignored.
        process.env.FEE_RECEIVER_ADDRESS_1 = "0x1111111111111111111111111111111111111111";
        expect(chain1().feeReceiverAddress()).toBe(CONFIG_RECEIVER);
    });
});

describe("StellarChainConfigWrapper.flatFeeAmount", () => {
    const USDC = "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU";
    const WBTC = "CAP5AMC2OHNVREO66DFIN6DHJMPOBAJ2KCDDIMFBR7WWJH5RZBFM3UEI";
    const chain = () =>
        new StellarChainConfigWrapper({
            id: 1,
            flat_fee_amount: 200_000n,
            supported_assets: [
                { address: USDC, ticker: "USDC", decimals: 7 },
                { address: WBTC, ticker: "wBTC", decimals: 7, flat_fee_amount: 3n },
            ],
        } as never);

    it("returns the asset's own flat fee when it sets one", () => {
        expect(chain().flatFeeAmount(WBTC)).toBe(3n);
    });

    it("falls back to the chain default for an asset that sets none", () => {
        expect(chain().flatFeeAmount(USDC)).toBe(200_000n);
    });

    it("returns the chain default when no asset is named", () => {
        expect(chain().flatFeeAmount()).toBe(200_000n);
    });
});
