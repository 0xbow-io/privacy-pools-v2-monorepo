export class NoteComputationServiceBaseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NoteComputationServiceBaseError";
    }
}

export class PayloadEncodeError extends NoteComputationServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "PayloadEncodeError";
    }
}

export class PayloadDecodeError extends NoteComputationServiceBaseError {
    constructor(message: string) {
        super(message);
        this.name = "PayloadDecodeError";
    }
}
