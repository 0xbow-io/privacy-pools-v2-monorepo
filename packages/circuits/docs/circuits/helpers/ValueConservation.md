# ValueConservation Helper Circuit

## Overview

The `ValueConservation` helper circuit enforces global value conservation, per-label value conservation, and output-label inheritance across transaction inputs and outputs. This maintains lineage separation (taint containment) while ensuring economic correctness.

Per AW-M-01, the template is **self-defending** on value ranges: it range-checks every value input at entry, so callers no longer need to guarantee `< 2^128` upstream.

Per AW-L-01, the template also enforces **output-label inheritance**: every `outputLabel[j]` must match some `inputLabel[i]`. Without this, a zero-value output could carry any label and trivially satisfy the per-label check (`0 ≤ 0`), letting an attacker emit Ragequit events with arbitrary labels.

### Design

The circuit implements **three independent invariants**:

1. **Global Conservation:** Total input value = total output value + withdrawals
2. **Per-Label Conservation:** For each label, input value ≥ output value
3. **Output Label Inheritance:** Each `outputLabel[j]` equals some `inputLabel[i]`

This implementation only checks output labels for per-label conservation. This is more efficient because:
- If an input label doesn't appear in outputs, those inputs contribute to `amountOut` (validated by global conservation)
- Only labels that appear in outputs need per-label verification

## Signal Specification

### Parameters

| Parameter | Description |
|-----------|-------------|
| `nInputs` | Number of input notes (must be ≥ 1) |
| `mOutputs` | Number of output notes (must be ≥ 1) |

### Input Signals

| Signal | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `inputValues[nInputs]` | Private | Range-checked `< 2^128` (enforced internally via `Num2Bits(128)`) | Values of input notes |
| `inputLabels[nInputs]` | Private | Field elements | Labels of input notes |
| `outputValues[mOutputs]` | Private | Range-checked `< 2^128` (enforced internally via `Num2Bits(128)`) | Values of output notes |
| `outputLabels[mOutputs]` | Private | Field elements | Labels of output notes |
| `amountOut` | Private | Range-checked `< 2^128` (enforced internally via `Num2Bits(128)`) | Public withdrawal amount (0 for pure transfer) |

### Output Signals

**None** - This is a pure constraint template with no output signals.

### Intermediate Signals

| Signal | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `inputSum[nInputs]` | Internal | Cumulative input sums | Running sum of input values |
| `outputSum[mOutputs]` | Internal | Cumulative output sums | Running sum of output values |
| `totalIn` | Internal | Field element | Total input value |
| `totalOut` | Internal | Field element | Total output value (includes amountOut) |
| `inputAccum[mOutputs][nInputs+1]` | Internal | 2D array of field elements | Accumulator for matching inputs per output label |

## Circuit Logic

### Algorithm

Value conservation operates at two levels, preceded by a self-defending range-check pass.

### 0. Range checks (AW-M-01)

At template entry, every value input is constrained to fit in 128 bits:

```
SECURITY (AW-M-01): self-defending range checks
for i from 0 to nInputs-1:
    Num2Bits(128)(inputValues[i])
for j from 0 to mOutputs-1:
    Num2Bits(128)(outputValues[j])
Num2Bits(128)(amountOut)
```

Without these, the per-label `LessEqThan(128)` check below could be fooled by near-prime field elements that wrap mod p inside the comparator's internal `Num2Bits`. Range-checking up front makes the template safe for any caller, including the planned note-merge and settlement circuits that do not currently exist.

### 1. Global Value Conservation

**Sum all input values:**
```
inputSum[0] = inputValues[0]
for i from 1 to nInputs-1:
    inputSum[i] = inputSum[i-1] + inputValues[i]
totalIn = inputSum[nInputs-1]
```

**Sum all output values:**
```
outputSum[0] = outputValues[0]
for i from 1 to mOutputs-1:
    outputSum[i] = outputSum[i-1] + outputValues[i]
totalOut = outputSum[mOutputs-1] + amountOut
```

**Enforce global conservation:**
```
CONSTRAINT: totalIn === totalOut
```

This prevents value creation or destruction globally.

### 2. Per-Label Value Conservation

For each output label L (for `outIdx` from 0 to `mOutputs-1`):

**a) Initialize accumulator:**
```
inputAccum[outIdx][0] = 0
```

**b) Sum all inputs with matching label:**
```
for inIdx from 0 to nInputs-1:
    // Check if input label matches this output's label
    labelMatches[outIdx][inIdx] = IsEqual()
    labelMatches[outIdx][inIdx].in[0] = inputLabels[inIdx]
    labelMatches[outIdx][inIdx].in[1] = outputLabels[outIdx]

    // Conditional accumulation via arithmetic:
    // If labels match (out=1): add inputValues[inIdx]
    // If labels don't match (out=0): add 0
    inputAccum[outIdx][inIdx+1] = inputAccum[outIdx][inIdx] +
                                   inputValues[inIdx] * labelMatches[outIdx][inIdx].out
```

**c) Verify inputs ≥ outputs for this label:**
```
conservationChecks[outIdx] = LessEqThan(128)
conservationChecks[outIdx].in[0] = outputValues[outIdx]  // output value
conservationChecks[outIdx].in[1] = inputAccum[outIdx][nInputs]  // sum of matching inputs

CONSTRAINT: conservationChecks[outIdx].out === 1
```

### 3. Output Label Inheritance (AW-L-01)

After per-label conservation, every output label must be inherited from at least one input. We reuse the `labelMatches[outIdx][inIdx]` components already built for per-label conservation and assert that the sum of matches for each output is non-zero, via `IsZero`:

```
SECURITY (AW-L-01): every output label must be inherited from some input
for o from 0 to mOutputs-1:
    matches = sum over i of labelMatches[o][i].out  // boolean signals, sum ≤ nInputs
    labelInherited[o] = IsZero()
    labelInherited[o].in <== matches
    CONSTRAINT: labelInherited[o].out === 0   // i.e. matches !== 0
```

Why `IsZero` instead of `GreaterEqThan` / `LessEqThan`:
- Operates on field elements directly. No internal `Num2Bits`, so no field-wrap risk (same class as AW-M-01).
- The match sum is at most `nInputs` (≤ 5 in production), trivially fits in field; no range check needed.
- ~3 constraints per output, with no extra `IsEqual` components since `labelMatches` is reused from per-label conservation.

**Accepted residual: amplification.** A user holding one legitimate note with label L can produce many zero-value outputs labeled L. The invariant only requires existence of at least one matching input. This is documented in the AW-L-01 fixes spec as out of scope; closing it would require disallowing zero-value outputs or moving to value-weighted matching.

## Implementation Details

### Constraint Count

`ValueConservation` is a helper template; it is not compiled in isolation in production. Constraint counts depend on the `(nInputs, mOutputs)` instantiation chosen by the caller.

For end-to-end constraint counts of the production circuits that wire `ValueConservation` in (`deposit`, `ragequit`, every `transact_NxM`), see the [Config E benchmark](../../../../docs/tech-design/circuits/circuits-benchmark.md). The deltas this helper contributes per call are:

- `+128` non-linear per input value range check (`nInputs` total)
- `+128` non-linear per output value range check (`mOutputs` total)
- `+128` non-linear for `amountOut` range check (constant)
- `~135` non-linear per `LessEqThan(128)` per output (`mOutputs` total)
- `~3` non-linear per `IsZero` for output-label inheritance (`mOutputs` total)
- `~1` non-linear per `IsEqual` label match (`nInputs × mOutputs`)

**Scaling Pattern:**
- Constraint count scales approximately as `O(nInputs × mOutputs)` for label-matching and `O(nInputs + mOutputs)` for range checks.
- Each `IsEqual` component adds ~1 constraint
- Each `LessEqThan(128)` component adds ~135 constraints
- Each `Num2Bits(128)` component adds ~128 constraints
- Each `IsZero` component adds ~3 constraints
- Base overhead: summation logic + global conservation

### Components Used

- **Num2Bits(128):** Used `nInputs + mOutputs + 1` times for self-defending range checks at template entry (AW-M-01).
- **IsEqual():** Used `nInputs × mOutputs` times to check label matching.
- **LessEqThan(128):** Used `mOutputs` times for per-label conservation checks.
  - 128 bits ensures values < 2^128 (safe for standard token amounts)
- **IsZero():** Used `mOutputs` times for output-label-inheritance checks (AW-L-01). Reuses the existing `labelMatches` sum, so no extra `IsEqual` components.

## Integration Guide

### Caller responsibilities

Per AW-M-01, callers do **not** need to range-check input/output values or `amountOut` upstream. The template is self-defending: every value input is constrained to `< 2^128` at entry.

Callers that already range-check values at point of use (e.g. `Transact` does `Num2Bits(128)` per note value for commitment-side reasons) may keep those checks as defense in depth; the duplication costs ~128 constraints per signal and adds no soundness risk.

### Example Usage

```circom
// Standard transaction: 2 inputs, 2 outputs
component conservation = ValueConservation(2, 2);

// Connect input notes — values may be raw field elements;
// ValueConservation will range-check them internally.
conservation.inputValues[0] <== inputNote1.value;
conservation.inputValues[1] <== inputNote2.value;
conservation.inputLabels[0] <== inputNote1.label;
conservation.inputLabels[1] <== inputNote2.label;

// Connect output notes
conservation.outputValues[0] <== outputNote1.value;
conservation.outputValues[1] <== outputNote2.value;
conservation.outputLabels[0] <== outputNote1.label;
conservation.outputLabels[1] <== outputNote2.label;

// Connect public amount
conservation.amountOut <== publicAmountOut;
```

### TypeScript Reference

Corresponding TypeScript implementation from `test/common/index.ts`:

```typescript
export function verifyValueConservation(
  inputValues: bigint[],
  inputLabels: bigint[],
  outputValues: bigint[],
  outputLabels: bigint[],
  amountOut: bigint,
): {
  globalValid: boolean;
  perLabelValid: boolean;
  labelBreakdown: Map<bigint, { inputSum: bigint; outputSum: bigint }>;
} {
  // ===== GLOBAL VALUE CONSERVATION =====
  const totalIn = inputValues.reduce((sum, val) => sum + val, BigInt(0));
  const totalOut =
    outputValues.reduce((sum, val) => sum + val, BigInt(0)) + amountOut;
  const globalValid = totalIn === totalOut;

  // ===== PER-LABEL VALUE CONSERVATION =====
  const labelBreakdown = new Map<
    bigint,
    { inputSum: bigint; outputSum: bigint }
  >();
  const allLabels = new Set([...inputLabels, ...outputLabels]);

  let perLabelValid = true;
  for (const label of Array.from(allLabels)) {
    // Sum inputs for this label
    const inputSum = inputValues
      .filter((_, i) => inputLabels[i] === label)
      .reduce((sum, val) => sum + val, BigInt(0));

    // Sum outputs for this label
    const outputSum = outputValues
      .filter((_, i) => outputLabels[i] === label)
      .reduce((sum, val) => sum + val, BigInt(0));

    labelBreakdown.set(label, { inputSum, outputSum });

    // Check per-label conservation: inputs >= outputs
    if (inputSum < outputSum) {
      perLabelValid = false;
    }
  }

  return { globalValid, perLabelValid, labelBreakdown };
}
```

## Tests
### Running Tests

```bash
# Run all ValueConservation tests
pnpm test -- --grep "ValueConservation"

# Compile specific configurations
circom circuits/test/ValueConservation_2_2.circom --r1cs --wasm --sym \
  --output build/helpers/ValueConservation_2_2 -l node_modules
```

For change history see `git log -- packages/circuits/docs/circuits/helpers/ValueConservation.md` and the related circuit source files under `packages/circuits/circuits/templates/helpers/`.
