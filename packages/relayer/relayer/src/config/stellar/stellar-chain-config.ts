import { BadRequestException } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarAddress, StellarChainConfig } from "../types";
import { StellarSecretKey } from "./stellar.types";
import { zStellarAddress, zStellarSecretKey } from "./stellar.config.schemas";
import { zQuoteExpirationTimeMs } from "../common.schemas";

export class StellarChainConfigWrapper {
    constructor(private readonly config: StellarChainConfig) {}

    get id() {
        return this.config.id;
    }

    get name() {
        return this.config.name;
    }

    /// Per-chain env override key, namespaced by chain type so a Stellar chain and an EVM chain
    /// sharing a numeric id don't collide on the same variable (e.g. FEE_RECEIVER_ADDRESS_STELLAR_1).
    private envKey(name: string): string {
        return `${name}_STELLAR_${this.config.id}`;
    }

    networkPassphrase(): string {
        return this.config.network_passphrase;
    }

    rpcUrl(): string {
        const envRpcUrl = process.env[this.envKey("RPC_URL")];
        return envRpcUrl ? envRpcUrl : this.config.rpc_url;
    }

    poolContractId(): StellarAddress {
        return this.config.pool_contract;
    }

    relayContractId(): StellarAddress {
        return this.config.relay_contract;
    }

    keystoreContractId(): StellarAddress {
        return this.config.keystore_contract;
    }

    aspRegistryContractId(): StellarAddress {
        return this.config.asp_registry_contract;
    }

    signerSecretKey(): StellarSecretKey {
        const envSecretKey = process.env[this.envKey("SIGNER_SECRET_KEY")];
        return envSecretKey ? zStellarSecretKey.parse(envSecretKey) : this.config.signer_secret_key;
    }

    feeReceiverAddress(): StellarAddress {
        const envFeeReceiver = process.env[this.envKey("FEE_RECEIVER_ADDRESS")];
        return envFeeReceiver ? zStellarAddress.parse(envFeeReceiver) : this.config.fee_receiver_address;
    }

    /// The relayer's own signer address on this chain (the `relayer` of every `relay()` call) —
    /// published on `/details` as `relayerAddress` so clients don't hand-copy it, mirroring
    /// EvmChainConfigWrapper.signerAddress().
    signerAddress(): StellarAddress {
        return Keypair.fromSecret(this.signerSecretKey()).publicKey();
    }

    asset(address: string) {
        const asset = this.config.supported_assets.find((a) => a.address === address);
        if (asset !== undefined) {
            return asset;
        } else {
            throw new BadRequestException(`Asset ${address} not found for chain ${this.config.id}`);
        }
    }

    /** The yield router of `asset` when it is a yield share token, else undefined. */
    yieldRouterFor(asset: string): StellarAddress | undefined {
        return this.config.supported_assets.find((a) => a.address === asset)?.yield_router;
    }

    get allAssets() {
        return this.config.supported_assets;
    }

    assetByTicker(ticker: string) {
        const asset = this.config.supported_assets.find((a) => a.ticker === ticker);
        if (asset !== undefined) {
            return asset;
        } else {
            throw new BadRequestException(`Asset with ticker ${ticker} not found for chain ${this.config.id}`);
        }
    }

    /** The flat fee for `asset` in its own base units (a yield share's: its underlying's), or the chain default. */
    flatFeeAmount(asset?: string) {
        const own = asset === undefined ? undefined : this.config.supported_assets.find((a) => a.address === asset);
        return own?.flat_fee_amount ?? this.config.flat_fee_amount;
    }

    quoteExpirationMs(): number {
        const envVal = process.env.QUOTE_EXPIRATION_MS;
        if (envVal === undefined) return this.config.quote_expiration_ms;

        const parsed = zQuoteExpirationTimeMs.safeParse(envVal);
        if (!parsed.success) {
            console.warn(
                `Invalid QUOTE_EXPIRATION_MS="${envVal}": ${parsed.error.issues[0].message}. ` +
                `Using config default (${this.config.quote_expiration_ms}ms).`
            );
            return this.config.quote_expiration_ms;
        }
        return parsed.data;
    }
}
