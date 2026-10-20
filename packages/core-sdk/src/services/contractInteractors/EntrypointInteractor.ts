import type { ZodType } from "zod";

import type {
    Address,
    AssetConfig,
    EVMProof,
    Hash,
    Hex,
    IEntrypointChainAdapter,
    IEntrypointInteractor,
    NoteData,
    PreparedTransaction,
} from "../../internal.js";
import { bigintToHex, InvalidAddressArgument, makeAllowanceArgsSchema } from "../../internal.js";

interface EntrypointInteractorConfig<TTx, TAddress, TProof> {
    adapter: IEntrypointChainAdapter<TTx, TAddress, TProof>;
    /** Validates address arguments before they reach the adapter. */
    addressSchema: ZodType<TAddress>;
}

/**
 * Interactions with an Entrypoint-shaped contract, generic over the chain's prepared-transaction
 * type `TTx`, address type `TAddress`, and on-chain proof type `TProof`. Chain-specific mechanics
 * (reads, calldata/XDR encoding, submission) live entirely in the injected
 * {@link IEntrypointChainAdapter} — this class owns only input validation and `Hex` conversion.
 * See `PoolVaultInteractor`'s class doc for the full split rationale.
 *
 * Construct the EVM instantiation via `createEvmEntrypointInteractor` (in
 * `EvmEntrypointChainAdapter.ts`, not a static method here — kept out of this file so importing
 * `EntrypointInteractor` alone never pulls in viem/ABI constants for a Stellar-only bundle).
 */
export class EntrypointInteractor<TTx = PreparedTransaction, TAddress = Address, TProof = EVMProof>
    implements IEntrypointInteractor<TTx, TAddress, TProof>
{
    private readonly adapter: IEntrypointChainAdapter<TTx, TAddress, TProof>;
    private readonly addressSchema: ZodType<TAddress>;
    private readonly allowanceArgsSchema: ReturnType<typeof makeAllowanceArgsSchema<TAddress>>;

    constructor(config: EntrypointInteractorConfig<TTx, TAddress, TProof>) {
        this.adapter = config.adapter;
        this.addressSchema = config.addressSchema;
        this.allowanceArgsSchema = makeAllowanceArgsSchema(config.addressSchema);
    }

    /** @inheritdoc IEntrypointInteractor.getAddress */
    getAddress(): TAddress {
        return this.adapter.getAddress();
    }

    /** @inheritdoc IEntrypointInteractor.getPoolVaultAddress */
    async getPoolVaultAddress(): Promise<TAddress> {
        return this.adapter.getPoolVaultAddressRaw();
    }

    /** @inheritdoc IEntrypointInteractor.getASPRegistryAddress */
    async getASPRegistryAddress(): Promise<TAddress> {
        return this.adapter.getASPRegistryAddressRaw();
    }

    /** @inheritdoc IEntrypointInteractor.getAssetConfig
     * @throws {InvalidAddressArgument} When the asset address is invalid.
     */
    async getAssetConfig(asset: TAddress): Promise<AssetConfig> {
        const validatedAsset = this.addressSchema.safeParse(asset);
        if (!validatedAsset.success) {
            throw new InvalidAddressArgument(validatedAsset.error.issues[0].message);
        }
        return this.adapter.getAssetConfigRaw(asset);
    }

    /** @inheritdoc IEntrypointInteractor.getAllowance
     * @throws {InvalidAddressArgument} When any address argument is invalid.
     */
    async getAllowance(token: TAddress, owner: TAddress, spender: TAddress): Promise<Hash> {
        const validated = this.allowanceArgsSchema.safeParse({ token, owner, spender });
        if (!validated.success) {
            throw new InvalidAddressArgument(validated.error.issues[0].message);
        }
        return bigintToHex(await this.adapter.getAllowanceRaw(token, owner, spender));
    }

    /** @inheritdoc IEntrypointInteractor.encodeDeposit */
    encodeDeposit(
        proof: TProof,
        noteData: NoteData,
        aspCiphertext: Hex,
        msgValue: Hex,
        asset: TAddress,
    ): Promise<TTx> {
        return this.adapter.encodeDeposit(proof, noteData, aspCiphertext, msgValue, asset);
    }

    /** @inheritdoc IEntrypointInteractor.encodeApprove */
    encodeApprove(token: TAddress, amount: Hex): Promise<TTx> {
        return this.adapter.encodeApprove(token, amount);
    }

    /** @inheritdoc IEntrypointInteractor.submitTransaction */
    async submitTransaction(tx: TTx): Promise<Hex> {
        return this.adapter.submit(tx);
    }
}
