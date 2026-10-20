pragma circom 2.2.3;

include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

/**
 * @title ValueConservation
 * @notice Enforces per-label AND global value conservation in transactions,
 *         plus output-label inheritance from inputs.
 * @dev Three invariants:
 *      1. Global: sum(inputValues) === sum(outputValues) + amountOut
 *      2. Per-Label: For each label L, sum(inputValues[L]) >= sum(outputValues[L])
 *      3. Label Inheritance: Every outputLabel[j] must equal some inputLabel[i].
 *         Without this, a zero-value output can carry any label and slip
 *         through the trivial 0 <= 0 per-label check (AW-L-01 fix).
 *
 * This is a pure constraint template with no output signals.
 *
 * @param nInputs Number of input notes (must be >= 1)
 * @param mOutputs Number of output notes (must be >= 1, typically 2)
 */
template ValueConservation(nInputs, mOutputs) {

    // ======================== INPUT SIGNALS ========================

    signal input inputValues[nInputs];      // Values of input notes
    signal input inputLabels[nInputs];      // Labels of input notes
    signal input outputValues[mOutputs];    // Values of output notes
    signal input outputLabels[mOutputs];    // Labels of output notes
    signal input amountOut;                 // Withdrawal amount (0 for pure transfer)

    // ======================== INTERMEDIATE SIGNALS ========================

    // Global conservation signals
    signal inputSum[nInputs];               // Cumulative input sums
    signal outputSum[mOutputs];             // Cumulative output sums
    signal totalIn;                         // Total input value
    signal totalOut;                        // Total output value (includes amountOut)

    // Per-label conservation signals (for each output label)
    signal inputAccum[mOutputs][nInputs + 1];    // Accumulator for matching inputs per output label
    signal outputAccum[mOutputs][mOutputs + 1];  // Accumulator for matching outputs per output label

    // ======================== COMPONENTS ========================

    component inputValueRangeChecks[nInputs];           // Range checks on input values
    component outputValueRangeChecks[mOutputs];         // Range checks on output values
    component amountOutRangeCheck;                       // Range check on amountOut
    component labelMatches[mOutputs][nInputs];          // Check if input label matches output label
    component outputLabelMatches[mOutputs][mOutputs];   // Check if output labels match each other
    component conservationChecks[mOutputs];              // Verify inputs >= outputs per label
    component labelInherited[mOutputs];                  // Verify each output label is present in some input

    // ======================== CONSTRAINT LOGIC ========================

    // ===== RANGE CHECKS =====
    //
    // SECURITY: Range-check every value at template entry to make
    // this template self-defending. The per-label LessEqThan(128) comparator
    // below uses Num2Bits internally on a computed difference, which can wrap
    // mod p if any input exceeds 128 bits. By constraining each input to fit
    // in 128 bits first, we ensure callers that do not range-check upstream
    // (e.g. planned note-merge or settlement circuits) cannot fool the
    // comparator with near-prime field values.
    for (var i = 0; i < nInputs; i++) {
        inputValueRangeChecks[i] = Num2Bits(128);
        inputValueRangeChecks[i].in <== inputValues[i];
    }
    for (var o = 0; o < mOutputs; o++) {
        outputValueRangeChecks[o] = Num2Bits(128);
        outputValueRangeChecks[o].in <== outputValues[o];
    }
    amountOutRangeCheck = Num2Bits(128);
    amountOutRangeCheck.in <== amountOut;

    // ===== GLOBAL VALUE CONSERVATION =====

    // Sum all input values
    inputSum[0] <== inputValues[0];
    for (var i = 1; i < nInputs; i++) {
        inputSum[i] <== inputSum[i-1] + inputValues[i];
    }
    totalIn <== inputSum[nInputs - 1];

    // Sum all output values
    outputSum[0] <== outputValues[0];
    for (var i = 1; i < mOutputs; i++) {
        outputSum[i] <== outputSum[i-1] + outputValues[i];
    }

    totalOut <== outputSum[mOutputs - 1] + amountOut;

    // No value creation or destruction allowed
    totalIn === totalOut;

    // ===== PER-LABEL VALUE CONSERVATION =====

    // For each output label, verify that sum of inputs with that label >= sum of ALL outputs with that label
    // Note: This redundantly checks the same label multiple times if outputs share labels,
    //       but all checks will produce the same result, ensuring correctness.
    for (var outIdx = 0; outIdx < mOutputs; outIdx++) {
        // Initialize accumulator for inputs with this output's label
        inputAccum[outIdx][0] <== 0;

        // Sum all inputs that have the same label as this output
        for (var inIdx = 0; inIdx < nInputs; inIdx++) {
            // Check if input label matches this output's label
            labelMatches[outIdx][inIdx] = IsEqual();
            labelMatches[outIdx][inIdx].in[0] <== inputLabels[inIdx];
            labelMatches[outIdx][inIdx].in[1] <== outputLabels[outIdx];

            // If labels match (out=1): add inputValues[inIdx]
            // If labels don't match (out=0): add 0
            // This is safe because IsEqual.out is constrained to be boolean
            inputAccum[outIdx][inIdx + 1] <== inputAccum[outIdx][inIdx] +
                                               inputValues[inIdx] * labelMatches[outIdx][inIdx].out;
        }

        // Initialize accumulator for outputs with this output's label
        outputAccum[outIdx][0] <== 0;

        // Sum ALL outputs that have the same label as this output (including itself)
        for (var otherOutIdx = 0; otherOutIdx < mOutputs; otherOutIdx++) {
            // Check if other output's label matches this output's label
            outputLabelMatches[outIdx][otherOutIdx] = IsEqual();
            outputLabelMatches[outIdx][otherOutIdx].in[0] <== outputLabels[otherOutIdx];
            outputLabelMatches[outIdx][otherOutIdx].in[1] <== outputLabels[outIdx];

            // If labels match (out=1): add outputValues[otherOutIdx]
            // If labels don't match (out=0): add 0
            outputAccum[outIdx][otherOutIdx + 1] <== outputAccum[outIdx][otherOutIdx] +
                                                      outputValues[otherOutIdx] * outputLabelMatches[outIdx][otherOutIdx].out;
        }

        // Verify: inputSum >= outputSum for this label
        // This ensures no value creation within a label
        conservationChecks[outIdx] = LessEqThan(128);
        conservationChecks[outIdx].in[0] <== outputAccum[outIdx][mOutputs];  // sum of ALL outputs with this label
        conservationChecks[outIdx].in[1] <== inputAccum[outIdx][nInputs];    // sum of ALL inputs with this label

        conservationChecks[outIdx].out === 1;
    }

    // ===== OUTPUT LABEL INHERITANCE =====
    //
    // SECURITY: every output label must be inherited from some input.
    // We reuse labelMatches[o][i] (already instantiated above for per-label
    // conservation) and assert via IsZero that the sum of matches per output
    // is non-zero. IsZero operates on field elements directly, so no Num2Bits
    // and no range-check footgun. Sum of at most nInputs booleans fits
    // trivially in field.
    for (var o = 0; o < mOutputs; o++) {
        var matches = 0;
        for (var i = 0; i < nInputs; i++) {
            matches += labelMatches[o][i].out;
        }
        labelInherited[o] = IsZero();
        labelInherited[o].in <== matches;
        labelInherited[o].out === 0;
    }
}
