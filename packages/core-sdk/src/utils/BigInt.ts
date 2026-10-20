import { Hex } from "../types/Hex.js";

export const bigintToHex = (value: bigint): Hex => {
    return `0x${value.toString(16).padStart(64, "0")}` as Hex;
};
