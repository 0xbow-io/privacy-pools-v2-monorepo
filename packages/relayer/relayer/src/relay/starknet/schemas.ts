import { z } from "zod";

// TODO starknet — placeholder schemas matching the empty-object placeholder types in
// ./types.ts. These exist so IRelayService's per-operation schema properties (used by the
// now-chain-aware relay validation pipes, see ../relay-validation.pipe.ts) have something
// real to resolve for ChainType.STARKNET, even though every operation still 501s in
// starknet.relay.service.ts.
export const zStarknetRelayRequest = z.object({}).passthrough();
