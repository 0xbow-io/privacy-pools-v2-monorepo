import {
    BASE_FEE,
    Contract,
    Keypair,
    nativeToScVal,
    rpc,
    scValToNative,
    TransactionBuilder,
    xdr,
} from "@stellar/stellar-sdk";

import type { Hex } from "@privacy-pools-v2/core-sdk";

import type { AspRootPublisher } from "../internal.js";

const DEFAULT_TX_TIMEOUT_SECONDS = 30;
/** A local standalone network closes a ledger about every second; testnet every ~5 s. A short poll
 * returns a few hundred ms after the ledger instead of up to 2 s later, at a handful of extra reads. */
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_WAIT_TIMEOUT_MS = 60000;

export interface StellarAspRootPublisherConfig {
    rpcUrl: string;
    networkPassphrase: string;
    aspRegistryContractId: string;
    /** Raw StrKey secret seed ("S...") for the identity holding the registry's `postman` role. */
    signerSecretKey: string;
    log?: (line: string) => void;
}

/**
 * Publishes association-set roots to a Stellar `asp-registry` contract via `update_asp_root`,
 * signed by the configured postman keypair. Resolves only once the transaction is confirmed.
 *
 * Deliberately talks to `@stellar/stellar-sdk` directly rather than depending on
 * `@privacy-pools-v2/stellar-sdk` — `mock-asp` must not depend on either chain SDK, the same
 * reasoning `EvmAspRootPublisher` follows by using raw `viem` instead of `evm-sdk` (a chain-sdk
 * package that itself pulls in mock-asp for e2e testing would otherwise form a cycle).
 */
export class StellarAspRootPublisher implements AspRootPublisher {
    private readonly config: StellarAspRootPublisherConfig;
    private readonly server: rpc.Server;
    private readonly keypair: Keypair;

    constructor(config: StellarAspRootPublisherConfig) {
        this.config = config;
        this.server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
        this.keypair = Keypair.fromSecret(config.signerSecretKey);
    }

    /**
     * @inheritdoc AspRootPublisher.publishRoot
     * @throws {Error} When the registry rejects the root (e.g. the signer is not the postman).
     */
    async publishRoot(root: bigint, cid: Hex): Promise<{ txId: string }> {
        const postman = this.keypair.publicKey();
        const preparedTx = await this.buildAndSimulate(postman, [
            nativeToScVal(postman, { type: "address" }),
            nativeToScVal(root, { type: "u256" }),
            xdr.ScVal.scvBytes(Buffer.from(cid.slice(2), "hex")),
        ]);
        preparedTx.sign(this.keypair);
        const sendResult = await this.server.sendTransaction(preparedTx);
        if (sendResult.status === "ERROR") {
            const code = sendResult.errorResult?.result?.().switch?.().name;
            throw new Error(`update_asp_root rejected: ${code ?? "unknown error"}`);
        }
        await this.waitForConfirmation(sendResult.hash);
        return { txId: sendResult.hash };
    }

    /**
     * @inheritdoc AspRootPublisher.readLatestRoot
     * @returns `null` when the registry has no root yet (`latest_asp_root` errors on an empty set).
     */
    async readLatestRoot(): Promise<bigint | null> {
        try {
            const postman = this.keypair.publicKey();
            const account = await this.server.getAccount(postman);
            const tx = new TransactionBuilder(account, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
            })
                .addOperation(new Contract(this.config.aspRegistryContractId).call("latest_asp_root"))
                .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
                .build();
            const simResult = await this.server.simulateTransaction(tx);
            if (rpc.Api.isSimulationError(simResult) || !simResult.result) return null;
            return scValToNative(simResult.result.retval) as bigint;
        } catch {
            return null;
        }
    }

    private async buildAndSimulate(sourcePublicKey: string, args: xdr.ScVal[]) {
        const contract = new Contract(this.config.aspRegistryContractId);
        const account = await this.server.getAccount(sourcePublicKey);
        const tx = new TransactionBuilder(account, {
            fee: BASE_FEE,
            networkPassphrase: this.config.networkPassphrase,
        })
            .addOperation(contract.call("update_asp_root", ...args))
            .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
            .build();
        const simResult = await this.server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(simResult)) {
            throw new Error(`update_asp_root simulation failed: ${simResult.error}`);
        }
        return rpc.assembleTransaction(tx, simResult).build();
    }

    private async waitForConfirmation(unprefixedHash: string): Promise<void> {
        const start = Date.now();
        let logged = false;
        while (Date.now() - start < DEFAULT_WAIT_TIMEOUT_MS) {
            const result = await this.server.getTransaction(unprefixedHash);
            if (result.status === "SUCCESS") return;
            if (result.status === "FAILED") {
                throw new Error(`update_asp_root reverted (tx ${unprefixedHash})`);
            }
            if (!logged) {
                this.config.log?.(`[mock-asp] waiting for tx ${unprefixedHash} to confirm...`);
                logged = true;
            }
            await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
        }
        throw new Error(`update_asp_root confirmation timed out (tx ${unprefixedHash})`);
    }
}
