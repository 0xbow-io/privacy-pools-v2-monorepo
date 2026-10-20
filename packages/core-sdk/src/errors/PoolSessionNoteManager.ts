export class PoolSessionNoteManagerBaseError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionNoteManagerBaseError";
    }
}

export class InvalidAddNoteParams extends PoolSessionNoteManagerBaseError {
    constructor(message: string) {
        super(`Invalid addNotes parameters: ${message}`);
        this.name = "InvalidAddNoteParams";
    }
}

export class InvalidMarkNoteSpentParams extends PoolSessionNoteManagerBaseError {
    constructor(message: string) {
        super(`Invalid markNotesSpent parameters: ${message}`);
        this.name = "InvalidMarkNoteSpentParams";
    }
}

export class InvalidMarkNoteExitedParams extends PoolSessionNoteManagerBaseError {
    constructor(message: string) {
        super(`Invalid markNotesExited parameters: ${message}`);
        this.name = "InvalidMarkNoteExitedParams";
    }
}

/**
 * Most often raised when `addNotes` is called before the broadcast tx has
 * mined. Integrator should await the receipt and retry.
 */
export class NoteCommitmentNotMined extends PoolSessionNoteManagerBaseError {
    constructor(commitment: string) {
        super(
            `Commitment ${commitment} is not yet on-chain — wait for the broadcast tx to mine and retry`,
        );
        this.name = "NoteCommitmentNotMined";
    }
}
