/** Structured logger used across SDK services. */
export interface ILogger {
    /** Creates a child logger scoped to a named service. */
    child(service: string): ILogger;
    /** The current minimum log level. */
    level: string;
    /** Logs a debug-level message with optional structured context. */
    debug(msg: string, obj?: object): void;
    /** Logs an info-level message with optional structured context. */
    info(msg: string, obj?: object): void;
    /** Logs a warning-level message with optional structured context. */
    warn(msg: string, obj?: object): void;
    /** Logs an error-level message with optional structured context. */
    error(msg: string, obj?: object): void;
    /** Logs a fatal-level message with optional structured context. */
    fatal(msg: string, obj?: object): void;
}
