// Dedicated entry point for the stealth-address module (multi-scheme:
// canonical ERC-5564 0x0001 + FluidKey variant 0xfffe). Exposed under the `@privacy-pools-v2/evm-sdk/stealth` subpath rather
// than the main barrel because the module carries its own branded primitive
// types (`Hex`, `EvmAddress`, ...) that intentionally differ from the SDK's
// top-level `Hex`/`Address`; keeping it on a separate entry avoids the name
// collision and the heavy barrel side-effects. Mirrors the `./batch-fee` entry.
export * from "./stealth/index.js";
