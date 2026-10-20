/** Base error class for all points errors. */
export class PointsBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PointsBaseError";
    }
}

/** Thrown when epoch parameters are malformed or the epochs do not tile the timeline. */
export class InvalidPointsEpochParams extends PointsBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid points epoch params: ${reason}`);
        this.name = "InvalidPointsEpochParams";
    }
}

/** Thrown when a note input to the points computation is malformed. */
export class InvalidPointsInput extends PointsBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid points input: ${reason}`);
        this.name = "InvalidPointsInput";
    }
}

/** Thrown when the points data provider configuration is invalid. */
export class InvalidPointsDataProviderConfig extends PointsBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid points data provider config: ${reason}`);
        this.name = "InvalidPointsDataProviderConfig";
    }
}

/** Thrown when the points API request fails or its response fails validation. */
export class PointsDataUnavailable extends PointsBaseError {
    /** @param reason - Description of failure. */
    constructor(reason: string) {
        super(`Points data unavailable: ${reason}`);
        this.name = "PointsDataUnavailable";
    }
}
