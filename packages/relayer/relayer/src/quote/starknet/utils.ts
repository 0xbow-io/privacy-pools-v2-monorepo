import { BadRequestException } from "@nestjs/common";
import { StarknetChainId } from "./types";

export function validateStarknetChainId(chainName: string): StarknetChainId {
    if (chainName === "sn_main") {
        return StarknetChainId.Starknet;
    } else if (chainName === "sn_sepolia") {
        return StarknetChainId.Sepolia;
    } else {
        throw new BadRequestException(`${chainName}: invalid chain name.`);
    }
}
