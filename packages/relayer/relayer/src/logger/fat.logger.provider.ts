import { Inject, Injectable, Scope } from "@nestjs/common";
import { INQUIRER } from "@nestjs/core";
import { ClsService } from "nestjs-cls";
import { FATLogger } from "./fat.logger";

@Injectable({ scope: Scope.TRANSIENT })
export class FATLoggerService extends FATLogger {
    constructor(
        @Inject(INQUIRER) parentClass: object,
        private readonly cls: ClsService
    ) {
        super(parentClass?.constructor?.name);
    }

    private getRequestId(): string | undefined {
        return this.cls.get("requestId");
    }

    info(message: string, meta?: unknown) {
        this.setRequestId(this.getRequestId());
        super.info(message, meta);
    }

    log(message: string, meta?: unknown) {
        this.info(message, meta);
    }

    error(message: string, meta?: unknown) {
        this.setRequestId(this.getRequestId());
        super.error(message, meta);
    }

    turbo(message: string, meta?: unknown) {
        this.setRequestId(this.getRequestId());
        super.turbo(message, meta);
    }

    warn(message: string, meta?: unknown) {
        this.setRequestId(this.getRequestId());
        super.warn(message, meta);
    }

    debug(message: string, meta?: unknown) {
        this.setRequestId(this.getRequestId());
        super.debug(message, meta);
    }

    verbose(message: string, meta?: unknown) {
        this.setRequestId(this.getRequestId());
        super.verbose(message, meta);
    }
}
