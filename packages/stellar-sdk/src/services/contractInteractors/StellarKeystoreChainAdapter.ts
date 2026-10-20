import { randomBytes } from "@noble/ciphers/utils.js";
import { Address as SdkAddress, xdr } from "@stellar/stellar-sdk";

import {
    addressScVal,
    bigintToHex,
    bufferToHex,
    bytesScVal,
    ContractCallError,
    ContractInteractorBaseError,
    decodeScVal,
    Eip712TypedData,
    Hash,
    Hex,
    IKeystoreChainAdapter,
    InvalidContractResult,
    IStellarRPCInteractor,
    IStellarWalletInteractor,
    KeystoreInteractor,
    RelayedRegistrationAuthorization,
    StellarAddress,
    StellarAddressSchema,
    StellarContractInteractorConfig,
    stellarErrorMessage,
    StellarKeystoreInteractorDependencies,
    StellarLog,
    u256ScVal,
    vecScVal,
    WalletNotAvailable,
} from "../../internal.js";

// Soroban's #[contractevent] macro emits topic[0] as the snake_case conversion of the Rust
// struct name (verified live against the local network's raw event responses), not the
// PascalCase struct name itself — see the matching note in StellarPoolVaultChainAdapter.ts.
/** Soroban's nominal ledger close time, used to turn a unix-seconds deadline into a ledger. */
const LEDGER_SECONDS = 5;

/** A random positive i64 — a Soroban auth nonce only has to be unused by this address. */
function randomNonce(): bigint {
    return BigInt(`0x${Buffer.from(randomBytes(8)).toString("hex")}`) & ((1n << 63n) - 1n);
}

const EVENT = {
    LEAF_INSERTED: "leaf_inserted",
    LEAF_UPDATED: "leaf_updated",
    AUTH_POLICY_SET: "auth_policy_set",
    AUTH_POLICY_UPDATED: "auth_policy_updated",
} as const;

/**
 * Stellar implementation of {@link IKeystoreChainAdapter}, ported from the reference Rust
 * contract's keystore signatures and its `#[contractevent]` struct
 * definitions (verified directly against the source, no reference client to port from).
 *
 * `signTypedData` has no Stellar equivalent — EIP-712 is an EVM-specific signing scheme, and
 * `setAuthPolicyWithSig`-style relayed registration has no ported counterpart on this chain — so
 * it throws rather than guessing at a signing scheme this SDK has no way to verify.
 */
export class StellarKeystoreChainAdapter implements IKeystoreChainAdapter<string, StellarAddress> {
    private readonly rpcInteractor: IStellarRPCInteractor;
    private readonly contractId: string;
    private readonly readSourcePublicKey: string;
    private readonly deploymentLedger?: bigint;
    private readonly walletInteractor?: IStellarWalletInteractor;

    constructor(
        config: StellarContractInteractorConfig,
        deps?: StellarKeystoreInteractorDependencies,
    ) {
        this.rpcInteractor = config.rpcInteractor;
        this.contractId = config.contractId;
        this.readSourcePublicKey = config.readSourcePublicKey;
        this.deploymentLedger = config.deploymentLedger;
        this.walletInteractor = deps?.walletInteractor;
    }

    getAddress(): StellarAddress {
        return this.contractId;
    }

    /**
     * @throws {InvalidContractResult} If the contract returns a non-U256 result.
     */
    async getNullifyingKeyHashRaw(account: StellarAddress): Promise<Hash> {
        let result: unknown;
        try {
            result = await this.simulateRead("get_nullifying_key", [addressScVal(account)]);
        } catch (error) {
            // The keystore contract's `get_nullifying_key` throws `Error::NotRegistered`
            // (contract error code 10 — confirmed against `contracts/keystore/src/lib.rs`) for
            // an unregistered account, rather than returning a zero sentinel the way an EVM
            // storage read would for an unset slot. `PoolSessionKeystore.isKeystoreRegistered`
            // is written against that EVM-shaped "0 means unregistered" contract, so translate
            // the error back into the zero sentinel here rather than let it surface as a raw
            // simulation failure for what is actually an expected, common case.
            if (error instanceof ContractCallError && error.message.includes(", #10)")) {
                return "0x0" as Hash;
            }
            throw error;
        }
        if (typeof result !== "bigint") {
            throw new InvalidContractResult("Expected U256 from get_nullifying_key");
        }
        return bigintToHex(result);
    }

    async getViewingKeyRaw(account: StellarAddress): Promise<Hash> {
        try {
            const result = await this.simulateRead("get_viewing_key", [addressScVal(account)]);
            return bufferToHex(result);
        } catch (error) {
            // Same `Error::NotRegistered` (code 10) EVM-zero-sentinel translation as
            // `getNullifyingKeyHashRaw` — see that method's doc comment for why.
            if (error instanceof ContractCallError && error.message.includes(", #10)")) {
                return ("0x" + "00".repeat(32)) as Hash;
            }
            throw error;
        }
    }

    async isKnownRootRaw(root: Hash): Promise<boolean> {
        const result = await this.simulateRead("is_known_root", [u256ScVal(root)]);
        if (typeof result !== "boolean") {
            throw new InvalidContractResult("Expected boolean from is_known_root");
        }
        return result;
    }

    async getCurrentCursor(): Promise<bigint> {
        return BigInt(await this.rpcInteractor.getLatestLedger());
    }

    async fetchLeafDeltas(
        fromCursor: bigint | undefined,
        toCursor: bigint,
    ): Promise<{
        inserted: { leafIndex: number; newLeaf: Hash }[];
        updated: { leafIndex: number; newLeaf: Hash }[];
    }> {
        const events = await this.fetchEvents(fromCursor, toCursor);
        const toDelta = (event: StellarLog): { leafIndex: number; newLeaf: Hash } => {
            const data = decodeScVal(event.data) as { index: number };
            const leaf = decodeScVal(event.topics[1]) as bigint;
            return { leafIndex: data.index, newLeaf: bigintToHex(leaf) };
        };
        return {
            inserted: events.filter((e) => e.type === EVENT.LEAF_INSERTED).map(toDelta),
            updated: events.filter((e) => e.type === EVENT.LEAF_UPDATED).map(toDelta),
        };
    }

    /**
     * Reads the latest `authDigest` from the `AuthPolicySet`/`AuthPolicyUpdated` event history —
     * same event-derived approach as EVM's `KEYSTORE_AUTH_EVENTS_ABI` (there is no raw getter on
     * either chain).
     */
    async getCurrentAuthorizerDigestRaw(account: StellarAddress): Promise<Hash | null> {
        const events = await this.fetchEvents(this.deploymentLedger, undefined);
        let latestDigest: Hash | null = null;
        for (const event of events) {
            if (event.type !== EVENT.AUTH_POLICY_SET && event.type !== EVENT.AUTH_POLICY_UPDATED) {
                continue;
            }
            const eventAccount = decodeScVal(event.topics[1]) as StellarAddress;
            if (eventAccount !== account) continue;
            const data = decodeScVal(event.data) as {
                auth_digest?: bigint;
                new_auth_digest?: bigint;
            };
            const digest = event.type === EVENT.AUTH_POLICY_SET ? data.auth_digest : data.new_auth_digest;
            if (digest !== undefined) latestDigest = bigintToHex(digest);
        }
        return latestDigest;
    }

    /** @throws {WalletNotAvailable} When no wallet is configured. */
    async encodeSetAuthPolicy(
        authDigest: Hash,
        nullifyingKeyHash: Hash,
        sequenceOffset = 1,
    ): Promise<string> {
        const owner = await this.requireSourceAccount();
        return this.rpcInteractor.buildTransaction(
            this.contractId,
            "set_auth_policy",
            [addressScVal(owner), u256ScVal(nullifyingKeyHash), u256ScVal(authDigest)],
            owner,
            sequenceOffset,
        );
    }

    /** @throws {WalletNotAvailable} When no wallet is configured. */
    async encodeUpdateAuthPolicy(
        oldAuthDigest: Hash,
        newAuthDigest: Hash,
        siblingNodes: Hash[],
    ): Promise<string> {
        const owner = await this.requireSourceAccount();
        return this.rpcInteractor.buildTransaction(
            this.contractId,
            "update_auth_policy",
            [
                addressScVal(owner),
                u256ScVal(oldAuthDigest),
                u256ScVal(newAuthDigest),
                vecScVal(siblingNodes.map((s) => u256ScVal(s))),
            ],
            owner,
        );
    }

    /** @throws {WalletNotAvailable} When no wallet is configured. */
    async encodeSetViewingKey(viewingKey: Hex, sequenceOffset = 1): Promise<string> {
        const owner = await this.requireSourceAccount();
        return this.rpcInteractor.buildTransaction(
            this.contractId,
            "set_viewing_key",
            [addressScVal(owner), bytesScVal(viewingKey)],
            owner,
            sequenceOffset,
        );
    }

    /** @throws {WalletNotAvailable} When no wallet interactor is configured. */
    async submit(tx: string): Promise<Hex> {
        if (!this.walletInteractor) {
            throw new WalletNotAvailable(
                "KeystoreInteractor requires a walletInteractor for write operations",
            );
        }
        return this.walletInteractor.sendTransaction(tx);
    }

    /**
     * @throws {ContractCallError} Always — EIP-712 is EVM-specific. Stellar's relayed registration
     *   signs a Soroban auth entry instead (see {@link buildRegistrationAuthorization}).
     */
    async signTypedData(_typedData: Eip712TypedData): Promise<Hex> {
        throw new ContractCallError(
            "signTypedData is not applicable on Stellar: EIP-712 is EVM-specific — relayed " +
                "registration signs a Soroban auth entry (buildRegistrationAuthorization)",
        );
    }

    /**
     * @inheritdoc IKeystoreChainAdapter.buildRegistrationAuthorization
     *
     * An unsigned `SorobanAuthorizationEntry` for `account` over THIS keystore's
     * `set_auth_policy(account, nullifying_key_hash, auth_digest)` — the call
     * `relay.register_and_relay` makes on the owner's behalf. The owner authorizes that nested call,
     * not the relay entrypoint: `owner.require_auth()` fires inside the keystore, and an entry naming
     * the relay call would never match. The nonce is random (single use is protocol-enforced) and
     * the signature expires at the ledger `deadline` falls in, at Soroban's ~5 s ledger cadence.
     * @throws {ContractCallError} When the latest ledger cannot be read.
     */
    async buildRegistrationAuthorization(args: {
        account: StellarAddress;
        nullifyingKeyHash: Hash;
        authDigest: Hash;
        deadline: Hex;
        chainId: number;
    }): Promise<RelayedRegistrationAuthorization> {
        let latestLedger: number;
        try {
            latestLedger = Number(BigInt(await this.rpcInteractor.getLatestLedger()));
        } catch (error) {
            throw new ContractCallError(stellarErrorMessage(error));
        }
        const secondsLeft = Number(BigInt(args.deadline)) - Math.floor(Date.now() / 1000);
        const validUntilLedger = latestLedger + Math.max(1, Math.ceil(secondsLeft / LEDGER_SECONDS));

        const entry = new xdr.SorobanAuthorizationEntry({
            credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
                new xdr.SorobanAddressCredentials({
                    address: new SdkAddress(args.account).toScAddress(),
                    nonce: xdr.Int64.fromString(randomNonce().toString()),
                    signatureExpirationLedger: validUntilLedger,
                    signature: xdr.ScVal.scvVec([]),
                }),
            ),
            rootInvocation: new xdr.SorobanAuthorizedInvocation({
                function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                    new xdr.InvokeContractArgs({
                        contractAddress: new SdkAddress(this.contractId).toScAddress(),
                        functionName: "set_auth_policy",
                        args: [addressScVal(args.account), u256ScVal(args.nullifyingKeyHash), u256ScVal(args.authDigest)],
                    }),
                ),
                subInvocations: [],
            }),
        });
        return { kind: "sorobanAuthEntry", entryXdr: entry.toXDR("base64"), validUntilLedger };
    }

    /**
     * @inheritdoc IKeystoreChainAdapter.signRegistrationAuthorization
     * @throws {ContractCallError} When handed EIP-712 typed data instead of a Soroban entry.
     * @throws {WalletNotAvailable} When no wallet is configured.
     */
    async signRegistrationAuthorization(authorization: RelayedRegistrationAuthorization): Promise<Hex> {
        if (!("kind" in authorization)) {
            throw new ContractCallError("a Stellar keystore signs a Soroban auth entry, not EIP-712 typed data");
        }
        if (!this.walletInteractor) {
            throw new WalletNotAvailable("KeystoreInteractor requires a walletInteractor to sign an auth entry");
        }
        const signed = await this.walletInteractor.signAuthEntry(authorization.entryXdr, authorization.validUntilLedger);
        return bufferToHex(Buffer.from(signed, "base64"));
    }

    private async requireSourceAccount(): Promise<string> {
        if (!this.walletInteractor) {
            throw new WalletNotAvailable(
                "KeystoreInteractor requires a walletInteractor to encode a write transaction",
            );
        }
        const [account] = await this.walletInteractor.getAccounts();
        return account;
    }

    private async simulateRead(method: string, args: Parameters<IStellarRPCInteractor["simulateRead"]>[2]) {
        try {
            return await this.rpcInteractor.simulateRead(
                this.contractId,
                method,
                args,
                this.readSourcePublicKey,
            );
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(stellarErrorMessage(error));
        }
    }

    private async fetchEvents(
        fromCursor: bigint | undefined,
        toCursor: bigint | undefined,
    ): Promise<StellarLog[]> {
        try {
            const result = await this.rpcInteractor.getEvents({
                contractId: this.contractId,
                startLedger:
                    fromCursor !== undefined ? (`0x${fromCursor.toString(16)}` as Hex) : undefined,
            });
            if (toCursor === undefined) return result.events;
            return result.events.filter((event) => BigInt(event.ledger) <= toCursor);
        } catch (error) {
            if (error instanceof ContractInteractorBaseError) throw error;
            throw new ContractCallError(stellarErrorMessage(error));
        }
    }
}

/**
 * Constructs a `KeystoreInteractor` bound to the Stellar keystore contract — wraps
 * {@link StellarKeystoreChainAdapter} around `StellarContractInteractorConfig`/
 * `StellarKeystoreInteractorDependencies`, mirroring `createEvmKeystoreInteractor`'s role.
 */
export function createStellarKeystoreInteractor(
    config: StellarContractInteractorConfig,
    deps?: StellarKeystoreInteractorDependencies,
): KeystoreInteractor<string, StellarAddress> {
    const adapter = new StellarKeystoreChainAdapter(config, deps);
    return new KeystoreInteractor(
        { adapter, deploymentBlock: config.deploymentLedger, addressSchema: StellarAddressSchema },
        { seed: deps?.seed },
    );
}
