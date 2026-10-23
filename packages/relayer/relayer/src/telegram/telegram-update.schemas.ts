import { z } from "zod";
import type { ReportCommand } from "../report/report-publisher";

/** The small subset of Telegram's update shape this webhook actually reads. */
export const zTelegramUpdate = z.object({
    update_id: z.number(),
    message: z
        .object({
            message_id: z.number(),
            chat: z.object({ id: z.number() }),
            text: z.string().optional(),
        })
        .optional(),
});

export type TelegramUpdate = z.infer<typeof zTelegramUpdate>;

/**
 * What an operator types in Telegram, mapped to the internal `ReportCommand` the rest of the
 * pipeline (`ReportsService`, the wire schema, the dispatcher) actually sees — this is the ONLY
 * place that mapping is defined. `profiterol` is a friendlier trigger word for
 * `current_profit_margins`; the internal name is unchanged everywhere else (logs, the Pub/Sub
 * wire event, the Telegram message prefix), so adding or renaming a trigger here never touches
 * `report-publisher.ts`, the fixture, or the dispatcher.
 */
// A Map, not a plain object: an object lookup would resolve inherited keys like "constructor" or
// "toString" to Object.prototype members, which are truthy and would pass as commands.
const COMMAND_ALIASES = new Map<string, ReportCommand>([
    ["native_asset_balances", "native_asset_balances"],
    ["current_profit_margins", "current_profit_margins"],
    ["profiterol", "current_profit_margins"],
]);

export interface ParsedCommand {
    command: ReportCommand;
    /** Reserved for future use (chain filter, tx count, ...) — always rejected in this pass, see ReportsService.handle. */
    args: string[];
}

/** Parses `/profiterol` or `native_asset_balances arg1 arg2`; returns null for anything unrecognized. */
export function parseCommand(text: string): ParsedCommand | null {
    const [typed, ...args] = text.trim().replace(/^\//, "").split(/\s+/);
    const command = COMMAND_ALIASES.get(typed);
    if (!command) return null;
    return { command, args };
}
