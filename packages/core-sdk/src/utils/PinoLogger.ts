import type { LoggerOptions } from "pino";
import pino from "pino";

import type { ILogger } from "../internal.js";

const prettyTransport: LoggerOptions["transport"] = {
    target: "pino-pretty",
    options: {
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname,service",
        messageFormat: "{if service}[{service}] {end}{msg}",
    },
};

export class PinoLogger implements ILogger {
    private readonly pino: pino.Logger;

    private constructor(instance: pino.Logger) {
        this.pino = instance;
    }

    static create(options?: LoggerOptions): ILogger {
        return new PinoLogger(
            pino({
                level: "silent",
                transport: prettyTransport,
                ...options,
            }),
        );
    }

    child(service: string): ILogger {
        return new PinoLogger(this.pino.child({ service }));
    }

    get level(): string {
        return this.pino.level;
    }

    set level(l: string) {
        this.pino.level = l;
    }

    debug(msg: string, obj?: object): void {
        if (obj) this.pino.debug(obj, msg);
        else this.pino.debug(msg);
    }

    info(msg: string, obj?: object): void {
        if (obj) this.pino.info(obj, msg);
        else this.pino.info(msg);
    }

    warn(msg: string, obj?: object): void {
        if (obj) this.pino.warn(obj, msg);
        else this.pino.warn(msg);
    }

    error(msg: string, obj?: object): void {
        if (obj) this.pino.error(obj, msg);
        else this.pino.error(msg);
    }

    fatal(msg: string, obj?: object): void {
        if (obj) this.pino.fatal(obj, msg);
        else this.pino.fatal(msg);
    }
}
