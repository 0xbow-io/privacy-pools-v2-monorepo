import type { Address, Hex } from "viem";

// Sepolia contract addresses (V6 deployment — post audit-fix da34680)
export const SEPOLIA_CONTRACTS = {
    entrypoint: "0x8445493038708311e55a526587d6ec4338377df0" as Address,
    keystore: "0xbb52626b05aad8950c6e90397aef3c3cab7d9ed1" as Address,
    aspRegistry: "0xfb68cc6b6572c130bc65e98b8df549cf05bb7665" as Address,
    poolVault: "0xc131a029e8096fd427c2c2fd489b77c80b21574a" as Address,
    accessRouter: "0xeef474ef89d5b24b2aca3a6ea70296e7ccf61805" as Address,
    relayContract: "0xce551cec9dc9643dc5d7ff8f3015602ef38f2761" as Address,
} as const;

export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Max tree depths (from circuits.json: transact_NxM params = [nInputs, mOutputs, 18, 14, 14])
export const MAX_DEPTHS = { state: 18, keystore: 14, asp: 14 } as const;

// Native ETH sentinel address used by the contracts
export const NATIVE_ASSET = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
export const NATIVE_ASSET_ID = BigInt(NATIVE_ASSET);

// OpenZeppelin role hash for POSTMAN_ROLE in AccessRouter
export const POSTMAN_ROLE_HASH = "0x67bf1f13d02b19255ab652c6b587de65b84296a60f6aee2d0db7817882a1270f" as Hex;

// V6 deployer — has POSTMAN_ROLE and other admin roles on the forked Sepolia state
export const DEPLOYER_ADDRESS = "0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39" as Address;

// Relayer signer address (anvil account 0 — matches signer_private_key in relayer.config.json)
export const RELAYER_SIGNER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

// Env vars
export const RPC_URL = process.env.RPC_URL!;
export const CIRCUIT_ARTIFACTS_DIR = process.env.CIRCUIT_ARTIFACTS_DIR ?? "./circuit-artifacts";
export const POSTMAN_ADDRESS = (process.env.POSTMAN_ADDRESS ?? DEPLOYER_ADDRESS) as Address;
