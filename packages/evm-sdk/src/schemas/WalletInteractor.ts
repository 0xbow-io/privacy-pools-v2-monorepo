import z from "zod";

import { AddressSchema } from "../internal.js";

export const GetAccountsResultSchema = z.array(AddressSchema).min(1);
