import { describe, expect, it } from "vitest";

import type { RelayerChainDetails } from "../../../src/internal.js";
import { InvalidRelayerConfig } from "../../../src/internal.js";
import {
    relayerInfoFromDetails,
    relaySwapsAddressFromDetails,
    yieldDeploymentsFromDetails,
} from "../../../src/utils/RelayerDetails.js";

const details: RelayerChainDetails = {
    id: 1,
    name: "mainnet",
    type: "evm",
    contracts: {
        entrypoint: "0x00000000000000000000000000000000000000e1",
        poolVault: "0x00000000000000000000000000000000000000e2",
        relay: "0x00000000000000000000000000000000000000e3",
        relaySwaps: "0x00000000000000000000000000000000000000e4",
    },
    swapsSupported: true,
    assets: [],
    relayerAddress: "0x00000000000000000000000000000000000000f1",
    processors: ["0x00000000000000000000000000000000000000d1"],
    yield: [
        {
            ppToken: "0x00000000000000000000000000000000000000b1",
            underlying: "0x00000000000000000000000000000000000000a1",
            router: "0x00000000000000000000000000000000000000d1",
            zap: "0x00000000000000000000000000000000000000c1",
            ppDecimals: 18,
            underlyingDecimals: 6,
            underlyingSymbol: "USDC",
        },
    ],
};

describe("relayerInfoFromDetails", () => {
    it("binds address to the relayer's signer and processorAddress to PrivacyPoolRelay (never RelaySwaps or a router)", () => {
        const info = relayerInfoFromDetails({ url: "https://r.example", name: "r" }, details);

        expect(info).toEqual({
            url: "https://r.example",
            name: "r",
            status: "active",
            chainId: 1,
            chainType: "evm",
            address: details.relayerAddress,
            processorAddress: details.contracts.relay,
        });
    });

    it("refuses a relayer that predates discovery instead of guessing its address", () => {
        const { relayerAddress: _a, ...legacy } = details;

        expect(() =>
            relayerInfoFromDetails({ url: "https://r.example", name: "r" }, legacy),
        ).toThrow(InvalidRelayerConfig);
    });
});

describe("yieldDeploymentsFromDetails", () => {
    it("maps every published wrapper onto a YieldDeployment whose ppRouter is the wrapper's router", () => {
        expect(yieldDeploymentsFromDetails(details)).toEqual([
            {
                ppRouter: "0x00000000000000000000000000000000000000d1",
                zap: "0x00000000000000000000000000000000000000c1",
                ppUSDC: "0x00000000000000000000000000000000000000b1",
                ppUSDCDecimals: 18,
                underlying: "0x00000000000000000000000000000000000000a1",
                underlyingDecimals: 6,
                underlyingSymbol: "USDC",
            },
        ]);
    });

    it("yields [] for a relayer without wrappers or predating discovery", () => {
        expect(yieldDeploymentsFromDetails({ ...details, yield: [] })).toEqual([]);
        const { yield: _y, ...legacy } = details;
        expect(yieldDeploymentsFromDetails(legacy)).toEqual([]);
    });
});

describe("relaySwapsAddressFromDetails", () => {
    it("returns RelaySwaps only when the relayer says swaps are supported", () => {
        expect(relaySwapsAddressFromDetails(details)).toBe(details.contracts.relaySwaps);
        expect(relaySwapsAddressFromDetails({ ...details, swapsSupported: false })).toBeUndefined();
    });
});
