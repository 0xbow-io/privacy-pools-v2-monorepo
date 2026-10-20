/** Base error class for all `PoolSessionBuilder` failures. */
export class PoolSessionBuilderBaseError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionBuilderBaseError";
    }
}

/** Thrown when the builder config fails structural or cross-field validation. */
export class InvalidBuilderConfig extends PoolSessionBuilderBaseError {
    constructor(reason: string) {
        super(`Invalid builder config: ${reason}`);
        this.name = "InvalidBuilderConfig";
    }
}

/** Thrown when the builder is invoked for a chainId that has no entry in `DEPLOYMENTS` and no explicit `deployment` override. */
export class UnsupportedChainId extends PoolSessionBuilderBaseError {
    constructor(chainId: number) {
        super(
            `No canonical deployment registered for chainId ${chainId}. Pass \`deployment\` explicitly or extend DEPLOYMENTS.`,
        );
        this.name = "UnsupportedChainId";
    }
}
