import { beforeAll, describe, expect, it } from "vitest";

import type { Address, Hex } from "../../src/internal.js";
import { InvalidBuilderConfig, PoolSessionBuilder, RegistrationCheckFailed, UnsupportedChainId } from "../../src/internal.js";
import type { Actor } from "../harness/actors.js";
import { createActor } from "../harness/actors.js";
import { NATIVE_ASSET } from "../harness/chain.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";
import { createNoRelayerInteractor } from "../noRelayerInteractor.js";
import { sessionConfig } from "../harness/sessions.js";

/**
 * Session construction and infrastructure failures (matrix §12): what an integrator sees when the
 * configuration or the environment is wrong. No proofs are built here; every rung fails before any is.
 */
describe.skipIf(!EVM_E2E)("session configuration", () => {
    let ctx: E2EContext;
    let alice: Actor;

    /** The builder needs a relayer config or a RelayerInteractor override even for self-submit sessions. */
    const builderFor = (overrides: Record<string, unknown> = {}) =>
        PoolSessionBuilder.fromConfig({ ...sessionConfig(ctx, alice), ...overrides }).withRelayerInteractor(
            createNoRelayerInteractor(),
        );

    beforeAll(async () => {
        ctx = e2eContext();
        alice = await createActor("alice");
    });

    describe("builder validation", () => {
        it("refuse a chain with no built-in deployment when none is supplied with UnsupportedChainId", async () => {
            const { deployment: _deployment, walletInteractor: _wallet, ...rest } = sessionConfig(ctx, alice);

            await expect(PoolSessionBuilder.fromConfig({ ...rest, chainId: 1_234_567 }).create()).rejects.toThrow(
                UnsupportedChainId,
            );
        });

        it("refuse a malformed RPC url with InvalidBuilderConfig", async () => {
            await expect(
                PoolSessionBuilder.fromConfig({ ...sessionConfig(ctx, alice), rpcUrl: "not a url" }).create(),
            ).rejects.toThrow(InvalidBuilderConfig);
        });

        it("refuse a protocol key of the wrong length, naming the offending field", async () => {
            const config = sessionConfig(ctx, alice);
            const bad = { ...config, protocolKeys: { ...config.protocolKeys, privateNullifyingKey: "0x1234" as Hex } };

            await expect(PoolSessionBuilder.fromConfig(bad).create()).rejects.toThrow(/privateNullifyingKey/);
        });

        it("refuse to build twice from the same builder", async () => {
            const builder = builderFor();
            await builder.create();

            await expect(builder.create()).rejects.toThrow(InvalidBuilderConfig);
        });

        it("refuse a wallet whose account is not the session owner", async () => {
            const stranger = await createActor("stranger");

            await expect(
                PoolSessionBuilder.fromConfig({ ...sessionConfig(ctx, alice), ownerAddress: stranger.address }).create(),
            ).rejects.toThrow(/does not match session ownerAddress/);
        });

        it("refuse a wallet connected to a different chain than the session's", async () => {
            await expect(
                PoolSessionBuilder.fromConfig({ ...sessionConfig(ctx, alice), chainId: 12_345 }).create(),
            ).rejects.toThrow(/Wallet chain .* does not match expected chainId/);
        });
    });

    describe("infrastructure failures", () => {
        it("report an unreachable RPC as RegistrationCheckFailed when checking registration", async () => {
            const session = await builderFor({ rpcUrl: "http://127.0.0.1:1" }).create();

            await expect(session.isKeystoreRegistered()).rejects.toThrow(RegistrationCheckFailed);
        });

        it("fail a deposit on a session whose Entrypoint address is not a contract", async () => {
            const config = sessionConfig(ctx, alice);
            const session = await builderFor({
                deployment: { ...config.deployment, entrypointAddress: alice.address as Address },
            }).create();

            await expect(session.prepareDeposit({ tokenId: NATIVE_ASSET, value: "0x1" as Hex })).rejects.toThrow();
        });

        it("fail a deposit when the circuit artifacts directory does not exist", async () => {
            const session = await builderFor({ circuitArtifactsDir: "/nonexistent/circuits" }).create();

            await expect(session.prepareDeposit({ tokenId: NATIVE_ASSET, value: "0x1" as Hex })).rejects.toThrow();
        });

        it("refuse a config that names no relayer and supplies no RelayerInteractor override", async () => {
            // Even a self-submit session needs one: the withdraw path asks it for relayers before it
            // builds anything, so the builder refuses to construct a session that could never answer.
            await expect(PoolSessionBuilder.fromConfig(sessionConfig(ctx, alice)).create()).rejects.toThrow(
                /At least one relayer is required/,
            );
        });
    });
});
