export class HTTPClientBaseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HTTPClientBaseError";
    }
}

/**
 * Thrown when the fetch request itself fails (network error, timeout, abort).
 */
export class HTTPRequestFailed extends HTTPClientBaseError {
    constructor(message: string) {
        super(message);
        this.name = "HTTPRequestFailed";
    }
}

/**
 * Thrown when the server returns a non-ok HTTP status code.
 *
 * `body` carries the start of the error response body. Status codes alone
 * hide the reason — a relayer or ASP 400 puts the actual validation message
 * in the body, and without it the caller cannot tell a malformed payload
 * from a stale deployment.
 */
export class HTTPResponseError extends HTTPClientBaseError {
    readonly status: number;
    readonly statusText: string;
    readonly body?: string;

    constructor(status: number, statusText: string, body?: string) {
        const detail = body ? `: ${body.slice(0, 500)}` : "";
        super(`HTTP ${status}: ${statusText}${detail}`);
        this.name = "HTTPResponseError";
        this.status = status;
        this.statusText = statusText;
        this.body = body;
    }
}
