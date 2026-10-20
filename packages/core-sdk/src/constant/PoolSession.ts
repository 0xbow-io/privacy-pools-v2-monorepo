import type { Address, Hex } from "../internal.js";

/** Sentinel address used by the Entrypoint to represent native ETH deposits. */
export const NATIVE_ASSET_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

/** Empty ciphertext passed to the deposit function — no encrypted payload at deposit time. */
export const EMPTY_CIPHERTEXT = "0x" as Hex;

/**
 * Empty NoteData published on-chain when the depositor or sender opts out of
 * a discoverable payload. `data` is `0x` (zero-length bytes) so the calldata
 * carries no fingerprint that the ASP or chain explorers can correlate to a
 * specific SDK build or test fixture.
 */
export const EMPTY_NOTE_DATA = {
    hint: ("0x" + "00".repeat(32)) as Hex,
    data: "0x" as Hex,
};
