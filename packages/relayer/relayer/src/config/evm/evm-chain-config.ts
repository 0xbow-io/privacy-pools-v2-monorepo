import { BadRequestException } from "@nestjs/common";
import { privateKeyToAccount } from "viem/accounts";
import { EvmAddress, EvmAssetConfig, EvmChainConfig, EvmPrivateKey } from "../types";
import { Wei } from "../../quote/evm/unit.types";
import { chainKey } from "../chain-key";
import { ChainType } from "../enums";

/// EVM schemata
import { zEvmAddress, zEvmPrivateKey } from "./evm.config.schemas";
import { zQuoteExpirationTimeMs } from "../common.schemas";

export class EvmChainConfigWrapper {
    constructor(private readonly config: EvmChainConfig) {}

    get id() {
        return this.config.id;
    }

    get name() {
        return this.config.name;
    }

    /// Per-chain env override key, namespaced by chain type so an EVM chain and a Stellar chain
    /// sharing a numeric id don't collide on the same variable (e.g. FEE_RECEIVER_ADDRESS_EVM_1).
    private envKey(name: string): string {
        return `${name}_${chainKey(ChainType.EVM, this.config.id)}`;
    }

    rpcUrl() {
        const envRpcUrl = process.env[this.envKey("RPC_URL")];
        return envRpcUrl ? envRpcUrl : this.config.rpc_url;
    }

    entrypointContractAddress() {
        return this.config.entrypoint_contract;
    }

    relayContractAddress() {
        return this.config.relay_contract;
    }

    poolVaultContractAddress() {
        return this.config.pool_vault_contract;
    }

    allowedProcessors(): EvmAddress[] {
        return (this.config.allowed_processors ?? []) as EvmAddress[];
    }

    isAllowedProcessor(address: string): boolean {
        const target = address.toLowerCase();
        return this.allowedProcessors().some((p) => p.toLowerCase() === target);
    }

    relaySwapsContractAddress(): EvmAddress | undefined {
        const address = this.config.relay_swaps_contract;
        // Some configs use the zero address as a "no RelaySwaps here" placeholder — treat it
        // as unset so swap quoting/relaying fails closed instead of targeting 0x0.
        if (!address || /^0x0{40}$/i.test(address)) return undefined;
        return address;
    }

    signerPrivateKey(): EvmPrivateKey {
        const envPrivateKey = process.env[this.envKey("SIGNER_PRIVATE_KEY")];
        return envPrivateKey ? zEvmPrivateKey.parse(envPrivateKey) : this.config.signer_private_key;
    }

    feeReceiverAddress(): EvmAddress {
        const envFeeReceiver = process.env[this.envKey("FEE_RECEIVER_ADDRESS")];
        return envFeeReceiver ? zEvmAddress.parse(envFeeReceiver) : this.config.fee_receiver_address;
    }

    isFeeReceiverSameAsSigner(): boolean {
        return this.feeReceiverAddress().toLowerCase() === this.signerAddress().toLowerCase();
    }

    /// The relayer's own signer address on this chain (`msg.sender` of every relay) —
    /// published on `/details` as `relayerAddress` so clients don't hand-copy it.
    signerAddress(): EvmAddress {
        return privateKeyToAccount(this.signerPrivateKey()).address;
    }

    asset(address: string): EvmAssetConfig {
        const asset = this.config.supported_assets.find((a) => a.address.toLowerCase() === address.toLowerCase());
        if (asset !== undefined) {
            return asset;
        } else {
            //TODO errors
            throw new BadRequestException(`Asset ${address} not found for chain ${this.config.id}`);
        }
    }

    get allAssets() {
        return this.config.supported_assets;
    }

    assetByTicker(ticker: string): EvmAssetConfig {
        const asset = this.config.supported_assets.find((a) => a.ticker === ticker);
        if (asset !== undefined) {
            return asset;
        } else {
            //TODO errors
            throw new BadRequestException(`Asset with ticker ${ticker} not found for chain ${this.config.id}`);
        }
    }

    nativeCurrency() {
        return this.config.native_currency;
    }

    flatFeeAmount() {
        return this.config.flat_fee_amount;
    }

    /// B2 — ceiling (wei) on the client-supplied `swapValue` (the in-contract-minted LZ
    /// fee for a Mainnet-destination reshield). Env override `MAX_SWAP_VALUE_WEI_EVM_<id>` for
    /// parity with the other per-chain overrides.
    maxSwapValueWei(): Wei {
        const envVal = process.env[this.envKey("MAX_SWAP_VALUE_WEI")];
        return envVal ? Wei(BigInt(envVal)) : this.config.max_swap_value_wei;
    }

    /// Whether a cross-chain bridge can run a destination call (pool / yield deposit) on this
    /// chain. Env override `DESTINATION_CALLS_SUPPORTED_EVM_<id>` ("true" / "false").
    destinationCallsSupported(): boolean {
        const key = this.envKey("DESTINATION_CALLS_SUPPORTED");
        const envVal = process.env[key];
        if (envVal === undefined || envVal === "") return this.config.destination_calls_supported ?? false;
        if (envVal === "true") return true;
        if (envVal === "false") return false;
        throw new Error(`${key} must be "true" or "false", got "${envVal}"`);
    }

    /// Broadcast gas ceiling as a multiple of the priced gas budget (see
    /// relay_gas_budget.ts). Env override `RELAY_GAS_CAP_MULTIPLIER_EVM_<id>`.
    relayGasCapMultiplier(): bigint {
        const key = this.envKey("RELAY_GAS_CAP_MULTIPLIER");
        const envVal = process.env[key];
        const value = envVal ? Number(envVal) : this.config.relay_gas_cap_multiplier;
        if (!Number.isInteger(value) || value < 1) {
            throw new Error(`${key} must be an integer >= 1, got "${envVal ?? value}"`);
        }
        return BigInt(value);
    }

    dustRescueRecipientAddress(): EvmAddress | undefined {
        const envVal = process.env[this.envKey("DUST_RESCUE_RECIPIENT_ADDRESS")];
        return envVal ? zEvmAddress.parse(envVal) : this.config.dust_rescue_recipient_address;
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
