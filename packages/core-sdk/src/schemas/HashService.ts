import { z } from "zod";

import { HexSchema } from "./common.js";

export const HashInputSchema = z.array(HexSchema).min(1, "At least one input is required");
