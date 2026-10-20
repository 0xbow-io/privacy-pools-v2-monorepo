import { defineChainE2E } from "@privacy-pools-v2/e2e-suite";

import { StellarDriver } from "./driver/StellarDriver.js";
import { STELLAR_E2E } from "./harness/context.js";
import { e2eYieldKinds, NETWORK_MODE } from "./network.js";

const yieldKinds = e2eYieldKinds();

/**
 * The Stellar chain as the shared conformance suite sees it. `e2e/vitest.config.ts` runs the
 * shared suites against it (`defineChainVitestConfig`).
 */
export const stellarE2E = defineChainE2E({
    name: "stellar",
    enabled: STELLAR_E2E,
    unsupported: {
        // PaymentRequestService/PaymentRequestStorageAdapter are, per their own doc comments,
        // "concretely EVM-shaped by design... not yet genericized" — StellarPoolSessionFactory
        // already bridges this with a documented `ownerAddress as unknown as Address` cast, which
        // produces invalid Hex for a StrKey address the moment a real payment-request round-trips
        // through validation. Confirmed live: PaymentRequestService.generate rejects Stellar's
        // ownerAddress with "Must represent a valid hexadecimal integer value with 0x prefix".
        paymentRequests: "PaymentRequestService is EVM-address-shaped, not yet generic over TAddress",
        // The yield suite needs the network's yield modules (deploy-yield.mts): one per underlying
        // kind it runs the ladder over. Local deploys both (XLM and the deployer-issued USDC);
        // testnet's only module is over XLM, and its USDC is issued by Blend's faucet, not us.
        ...(!yieldKinds.native && !yieldKinds.token
            ? { yield: "no yield module deployed on this network (scripts/deploy/deploy-yield.mts)" }
            : {}),
        ...(!yieldKinds.native ? { yieldNative: "no yield module over native XLM on this network" } : {}),
        ...(!yieldKinds.token ? { yieldToken: "no yield module over a classic asset on this network" } : {}),
        // Manual testnet run only (STELLAR_E2E_NETWORK=testnet, see network.ts): the testnet
        // deployment has no second test asset provisioned, unlike the local deploy pipeline's
        // LOCAL_MOCK_TOKEN.
        ...(NETWORK_MODE === "testnet"
            ? { token: "no second test asset provisioned on the testnet deployment" }
            : {}),
    },
    createDriver: () => StellarDriver.fromInjected(),
});

// The suite entries import the chain through the `@e2e/chain` alias `defineChainVitestConfig` sets up.
export default stellarE2E;
