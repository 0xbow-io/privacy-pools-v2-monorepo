/** Base error class for all PaymentRequestService-related errors. */
export class PaymentRequestBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PaymentRequestBaseError";
    }
}

/** Thrown when generate parameters fail schema validation. */
export class InvalidPaymentRequestParams extends PaymentRequestBaseError {
    /** @param message - Description of the validation failure. */
    constructor(message: string) {
        super(`Invalid payment request params: ${message}`);
        this.name = "InvalidPaymentRequestParams";
    }
}

/** Thrown when a payment request with the given paymentId doesn't exist. */
export class PaymentRequestNotFoundError extends PaymentRequestBaseError {
    /** @param paymentId - The paymentId that was not found. */
    constructor(paymentId: string) {
        super(`Payment request not found: ${paymentId}`);
        this.name = "PaymentRequestNotFoundError";
    }
}

/** Thrown when payment-request state supplied to `importState` fails schema validation. */
export class InvalidPaymentRequestState extends PaymentRequestBaseError {
    /** @param message - Description of the validation failure. */
    constructor(message: string) {
        super(`Invalid payment request state: ${message}`);
        this.name = "InvalidPaymentRequestState";
    }
}

/**
 * Thrown when a sender tries to fulfill a payment request whose `expiresAt` has passed.
 *
 * Fulfilling a lapsed request would succeed on-chain but risk being invisible to the recipient:
 * they stop scanning for it shortly after it expires, so the note can land in the pool
 * undiscovered through the payment-request path. Refusing up front is what turns a silent loss
 * into a clear failure.
 *
 * The wording is deliberately "stops scanning shortly after", not "has stopped": the recipient
 * keeps scanning for a grace period past `expiresAt` (see `SCAN_EXPIRY_GRACE_MS`) precisely so a
 * payment already in flight when the deadline passed is still found. Claiming the recipient has
 * already given up would be stating something stronger than the code does.
 */
export class PaymentRequestExpired extends PaymentRequestBaseError {
    /**
     * @param expiresAt - The request's expiry timestamp (unix ms, hex).
     * @param nowMs - The current time (unix ms).
     */
    constructor(expiresAt: string, nowMs: bigint) {
        super(
            `Payment request expired at ${BigInt(expiresAt)} (now ${nowMs}); the recipient stops ` +
                `scanning for it shortly after, so a payment may not be discovered. Ask for a new request.`,
        );
        this.name = "PaymentRequestExpired";
    }
}
