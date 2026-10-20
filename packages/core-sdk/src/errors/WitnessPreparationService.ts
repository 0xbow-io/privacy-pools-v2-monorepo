export class WitnessPreparationServiceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WitnessPreparationServiceError";
    }
}

export class InvalidDepositWitnessInputs extends WitnessPreparationServiceError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidDepositWitnessInputs";
    }
}

export class InvalidTransactWitnessInputs extends WitnessPreparationServiceError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidTransactWitnessInputs";
    }
}

export class InvalidRagequitWitnessInputs extends WitnessPreparationServiceError {
    constructor(message: string) {
        super(message);
        this.name = "InvalidRagequitWitnessInputs";
    }
}

export class WitnessPreparationFailed extends WitnessPreparationServiceError {
    constructor(message: string) {
        super(message);
        this.name = "WitnessPreparationFailed";
    }
}
