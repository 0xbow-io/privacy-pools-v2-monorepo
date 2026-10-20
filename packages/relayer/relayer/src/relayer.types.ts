import { Bytes } from "./relay/evm/types";
import { Hash } from "viem";
import { ChainType } from "./config/enums";
import { EvmAddress, EvmChainId } from "./config/evm/evm.types";
import { BPS, Gas, Wei } from "./quote/evm/unit.types";

export interface IBaseFeeCommitment {
    data: `0x${string}`;
    asset: EvmAddress;
    expiration: number;
    feeAmount: Wei;
}

export interface IWithdrawalFeeCommitment extends IBaseFeeCommitment {
    recipient: EvmAddress;
    amountSent: Wei;
    amountReceived: Wei;
}

export interface ISwapFeeCommitment extends IBaseFeeCommitment {
    recipient: EvmAddress;
    amountSent: Wei;
}

export interface ISignedTransferFeeCommitment extends IBaseFeeCommitment {
    signedRelayerCommitment: `0x${string}`;
}

export interface ISignedWithdrawalFeeCommitment extends IWithdrawalFeeCommitment {
    signedRelayerCommitment: `0x${string}`;
}

// -========- Batch withdrawal fee commitment -========-

// The wire shape carried in a batch quote/relay. `data` ABI-encodes the whole
// `PayoutRouting[]` (one routing per batch item). The EIP-712 signature also
// binds `totalAmountSent`/`totalAmountReceived`, which are recomputed from the
// proofs at relay time (not carried on the wire).
//
// `relayCost`, `feeBps` and `flatFee` are the signed fee-model parameters: each
// item pays a NORMAL single-tx fee `min(maxRelayFee, relayCost + (feeBps > 0 ?
// amountOut*feeBps/10000 : flatFee))`. The SDK recomputes each item's fee from
// these to verify the relayer's split, so a greedy relayer cannot re-concentrate
// the whole batch fee onto one cherry-pickable item.
export interface IBatchWithdrawalFeeCommitment {
    data: `0x${string}`;
    asset: EvmAddress;
    expiration: number;
    totalFee: Wei;
    maxRelayFee: Wei;
    relayCost: Wei;
    feeBps: BPS;
    flatFee: Wei;
}

export interface ISignedBatchWithdrawalFeeCommitment extends IBatchWithdrawalFeeCommitment {
    signedRelayerCommitment: `0x${string}`;
}

export interface ISignedSwapFeeCommitment extends ISwapFeeCommitment {
    signedRelayerCommitment: `0x${string}`;
}

export type ITransferFeeCommitment = IBaseFeeCommitment;

export interface IAsset {
    address: EvmAddress;
    ticker: string;
}

// TODO: rename all property names to snake_case across details types
export interface IAssetConfig extends IAsset {
    fixedFeeAmount: Wei;
    feeBPS?: BPS;
}

export interface IChainContracts {
    entrypoint: EvmAddress;
    poolVault: EvmAddress;
    relay: EvmAddress;
    relaySwaps?: EvmAddress;
}

export interface IYieldWrapper {
    ppToken: EvmAddress;
    underlying: EvmAddress;
    router: EvmAddress;
    zap: EvmAddress;
    ppDecimals: number;
    underlyingDecimals: number;
    underlyingSymbol: string;
}

export interface IChainConfig {
    id: EvmChainId;
    name: string;
    type: ChainType;
    contracts: IChainContracts;
    swapsSupported: boolean;
    destinationCallsSupported: boolean;
    assets: IAssetConfig[];
    relayerAddress: EvmAddress;
    processors: EvmAddress[];
    yield: IYieldWrapper[];
    maxSwapValueWei: Wei;
}

export interface IFullConfig {
    version: string;
    chains: IChainConfig[];
}

export interface IBaseQuoteRequest {
    asset: EvmAddress;
    commit: boolean;
}

export type ITransferQuoteRequest = IBaseQuoteRequest;

export interface IWithdrawalQuoteRequest extends IBaseQuoteRequest {
    amount: Wei;
    recipient?: EvmAddress;
    extraGas?: boolean;
}

export interface IBaseQuoteResponse {
    txCost: Gas;
    gasPrice: Wei;
    feeAmount: Wei;
}

export interface ITransferQuoteResponse extends IBaseQuoteResponse {
    processor: EvmAddress;
    feeCommitment?: ISignedTransferFeeCommitment;
}

export interface IWithdrawalQuoteResponse extends IBaseQuoteResponse {
    processor: EvmAddress;
    amountSent: Wei;
    amountReceived: Wei;
    extraGasTxCost?: Gas;
    extraGasFundAmount?: Gas;
    feeCommitment?: ISignedWithdrawalFeeCommitment;
}

export interface ITransactProof {
    pA: [bigint, bigint];
    pB: [[bigint, bigint], [bigint, bigint]];
    pC: [bigint, bigint];
    pubSignals: bigint[][];
}

export interface INoteData {
    hint: Bytes;
    data: Bytes;
}

export interface IBaseRelayRequest {
    proof: ITransactProof;
    noteData: INoteData[];
}

export interface IWithdrawalRelayRequest extends IBaseRelayRequest {
    signedFeeCommitment: ISignedWithdrawalFeeCommitment;
    // Optional alternate transact processor (e.g. PPRouter). When absent, the
    // relayer uses the default PrivacyPoolRelay. Must be in allowed_processors.
    processorAddress?: EvmAddress;
    // Optional client-supplied slippage floor (in the UNDERLYING token) for the
    // PPRouter `withdrawToUnderlying` redeem leg. Carried by the concrete EVM
    // request/schema/DTO/service; declared here for interface consistency.
    // Defaults to 0n at the chain-service layer when absent; ignored unless
    // `processorAddress` is set.
    minUnderlyingOut?: bigint;
}

export interface ITransferRelayRequest extends IBaseRelayRequest {
    signedFeeCommitment: ISignedTransferFeeCommitment;
}

export interface ISwapRelayRequest extends IBaseRelayRequest {
    signedSwapCommitment: ISignedSwapFeeCommitment;
}

// The keystore auth-policy registration leg carried by a register-and-withdrawal request.
// `authDigest`/`nullifyingKeyHash` are uint256 (carried as hex on the wire, coerced to bigint
// at the chain-service layer); `deadline` bounds how long the signed authorization is valid
// (the contract reverts Keystore_SignatureExpired past it).
export interface IKeystoreRegistration {
    account: EvmAddress;
    authDigest: `0x${string}`;
    nullifyingKeyHash: `0x${string}`;
    deadline: `0x${string}`;
    signature: `0x${string}`;
}

export interface IRegisterAndWithdrawalRelayRequest extends IWithdrawalRelayRequest {
    registration: IKeystoreRegistration;
}

export interface IRelayResponse {
    txHash: Hash;
    error?: string;
    // See zEvmRelayResponse's doc comment (relay/evm/schemas.ts) — swap-relay-with-
    // dustRescue only, distinct from `error`.
    dustRescueWarning?: string;
}

