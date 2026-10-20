import { LoggerService } from "@nestjs/common";
import * as winston from "winston";
import { AlertTransport, stripAlertMarkers } from "./alert-transport";

const isProduction = process.env.NODE_ENV === "production";

// Custom level map: `turbo` sits ABOVE `error` — operator-page severity for
// faults that stop the relayer from doing its job at all (e.g. the signer
// wallet out of gas funds). It must stay at the top of this map so no
// LOG_LEVEL threshold (audit R-H4 pins prod at >= info) can filter it out.
//
// A `turbo` record ALSO pages the operators: the AlertTransport below publishes it to the
// `relayer-alerts` Pub/Sub topic (alert-dispatcher -> Telegram). Any other record with
// `alert: true` in its meta does the same at severity "warn". See alert-transport.ts.
const FAT_LEVELS: Record<string, number> = {
    turbo: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    verbose: 5,
};

// Map winston levels to GCP severity levels
const GCP_SEVERITY: Record<string, string> = {
    turbo: "CRITICAL",
    error: "ERROR",
    warn: "WARNING",
    info: "INFO",
    debug: "DEBUG",
    verbose: "DEBUG",
};

winston.addColors({
    turbo: "bold white redBG",
    error: "red",
    warn: "yellow",
    info: "green",
    debug: "blue",
    verbose: "cyan",
});

const fatFormat = isProduction
    ? winston.format.printf(({ level, message, context, requestId, timestamp, ...meta }) => {
          const metaObj = Object.keys(meta).length ? meta : undefined;
          return JSON.stringify({
              severity: GCP_SEVERITY[level] || "DEFAULT",
              timestamp,
              message,
              context,
              requestId,
              ...metaObj,
          });
      })
    : winston.format.printf(({ level, message, context, requestId, timestamp, ...meta }) => {
          const prefix = requestId ? `[${requestId}] ` : "";
          const ctx = context ? `[${context}] ` : "";
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
          return `${timestamp} ${level} ${prefix}${ctx}message: (${message})${metaStr}`;
      });

export const winstonConfig: winston.LoggerOptions = {
    levels: FAT_LEVELS,
    // Privacy-safe default: prod must not run at debug (audit R-H4).
    level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
    transports: [
        new winston.transports.Console({
            format: isProduction
                ? winston.format.combine(winston.format.timestamp(), stripAlertMarkers(), fatFormat)
                : winston.format.combine(
                      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
                      stripAlertMarkers(),
                      winston.format.colorize({ all: true }),
                      fatFormat
                  ),
        }),
        new AlertTransport(),
    ],
};

export class FATLogger implements LoggerService {
    private logger: winston.Logger;
    private requestId?: string;

    constructor(private context?: string) {
        this.logger = winston.createLogger(winstonConfig);
    }

    setRequestId(requestId: string | undefined) {
        this.requestId = requestId;
    }
    setContext(context: string) {
        this.context = context;
    }

    info(message: string, meta?: unknown) {
        this.logger.info(message, {
            context: this.context,
            requestId: this.requestId,
            ...this.toMetaObj(meta),
        });
    }

    // alias for NestJS LoggerService compatibility
    log(message: string, meta?: unknown) {
        this.info(message, meta);
    }

    private toMetaObj(meta: unknown): Record<string, unknown> {
        if (meta && typeof meta === "object" && !Array.isArray(meta)) {
            return meta as Record<string, unknown>;
        }
        return meta !== undefined ? { data: meta } : {};
    }

    error(message: string, meta?: unknown) {
        this.logger.error(message, {
            context: this.context,
            requestId: this.requestId,
            ...this.toMetaObj(meta),
        });
    }

    // Operator-page severity (GCP CRITICAL) — reserve for faults that stop the
    // relayer from operating at all, like an unfunded signer wallet.
    turbo(message: string, meta?: unknown) {
        this.logger.log("turbo", message, {
            context: this.context,
            requestId: this.requestId,
            ...this.toMetaObj(meta),
        });
    }

    warn(message: string, meta?: unknown) {
        this.logger.warn(message, {
            context: this.context,
            requestId: this.requestId,
            ...this.toMetaObj(meta),
        });
    }

    debug(message: string, meta?: unknown) {
        this.logger.debug(message, {
            context: this.context,
            requestId: this.requestId,
            ...this.toMetaObj(meta),
        });
    }

    verbose(message: string, meta?: unknown) {
        this.logger.verbose(message, {
            context: this.context,
            requestId: this.requestId,
            ...this.toMetaObj(meta),
        });
    }
}
