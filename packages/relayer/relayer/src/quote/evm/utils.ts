import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EvmAddress } from "../../config/evm/evm.types";

export const JSONStringifyBigInt = (json_string: object) => {
    return JSON.stringify(json_string, (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
};

export function getAddressFromBigInt(address: bigint) {
    // Pad to 20 bytes: addresses whose first byte is < 0x10 (e.g. Optimism USDC
    // 0x0b2C639c...) lose their leading zero in toString(16) and fail viem's
    // getAddress length check.
    return getAddress(`0x${address.toString(16).padStart(40, "0")}`) as EvmAddress;
}

interface FeeReceiverConfig {
    feeReceiverAddress(): string;
    isFeeReceiverSameAsSigner(): boolean;
    signerPrivateKey(): `0x${string}`;
}

// Selects who receives the token-denominated fee. When a relay funds an ETH nativeGas
// top-up as msg.value from the signer wallet, the fee must land on that same signer
// address (unless it's already configured to be the fee receiver) so the token
// reimbursement actually offsets the ETH the signer fronted — otherwise the signer hot
// wallet drains on every relay that carries nativeGas > 0 (audit F-242). Shared by
// quote-time commitment building (evm.quote.service.ts) and relay-time re-validation
// (evm.relay.service.ts) so the two can never diverge again — the original F-242 bug
// was exactly this logic existing once (withdrawal path) and not the other (swap path).
export function resolveFeeReceiver(configService: FeeReceiverConfig, nativeGas: bigint): EvmAddress {
    const configuredReceiver = configService.feeReceiverAddress();
    if (nativeGas > 0n && !configService.isFeeReceiverSameAsSigner()) {
        const signer = privateKeyToAccount(configService.signerPrivateKey());
        return signer.address;
    }
    return configuredReceiver as EvmAddress;
}
