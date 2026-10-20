import type { Account, Chain, Transport, WalletClient } from "viem";
import type {
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    PoolSession,
    PoolVaultInteractor,
    ViemRPCInteractor,
    MerkleService,
    AccountExport,
} from "@privacy-pools-v2/evm-sdk";

import type { TestConfig } from "../setup/env.js";

/** WalletClient with account bound — allows sendTransaction without passing account. */
export type BoundWalletClient = WalletClient<Transport, Chain, Account>;

/** An ephemeral user created fresh for each test run. */
export type TestActor = {
    name: string;
    privateKey: Hex;
    address: Hex;
    walletClient: BoundWalletClient;
    // Privacy keys
    privateNullifyingKey: Hex;
    privateRevocableKey: Hex;
    viewingPrivateKey: Hex;
    viewingPublicKey: Hex;
    // SDK session (set after createTestSession)
    poolSession: PoolSession;
    rpcInteractor: ViemRPCInteractor;
    hashService: IHashService;
    cryptoService: ICryptoService;
    poolVaultInteractor: PoolVaultInteractor;
    // Mutable state — updated after each operation
    accountExport?: AccountExport;
};

/** Shared context for all tests within a scenario. */
export type TestContext = {
    faucetWallet: BoundWalletClient;
    faucetAddress: Hex;
    postmanWallet: BoundWalletClient;
    postmanAddress: Hex;
    rpcInteractor: ViemRPCInteractor;
    hashService: IHashService;
    merkleService: MerkleService;
    actors: TestActor[];
    // In-memory ASP state
    aspLeaves: Hash[];
    aspRoot: Hash;
    config: TestConfig;
};

/** Result of a deposit operation. */
export type DepositResult = {
    commitment: Hash;
    label: Hash;
};

/** Result of a transfer operation. */
export type TransferResult = {
    recipientCommitment: Hash;
    changeCommitment: Hash;
    /** Actual value of the change note after relayer fee deduction. */
    changeValue: bigint;
    /** Data needed for the recipient to reconstruct their received note. */
    recipientNoteData: {
        label: Hash;
        value: Hex;
        tokenId: Hex;
        noteSecret: Hex;
    };
};

/** Result of a withdraw operation. */
export type WithdrawResult = {
    changeCommitment: Hash;
    amountOut: Hex;
};
