import {
    createWalletClient,
    http,
    publicActions,
} from "viem";
import { RPC_RETRY_COUNT, RPC_TIMEOUT_MS } from "../chain.service/evm.chain.service";

export function getWallet(rpc_url: string) {
    // Same bounded transport as EVMChainService.client(): rate-provider reads
    // (Curve spot + historic checks) sit on the quote hot path, so they must
    // not inherit viem's 10s x 4-attempt defaults either.
    const client = createWalletClient({
        transport: http(rpc_url, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }),
    }).extend(publicActions);
    return client;
}
