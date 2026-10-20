#!/bin/bash
# zkFuzz runner for Privacy Pools v2 circuits
# Supports fuzzing individual circuits or all circuits in batch

set -e

# === Configuration ===
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PACKAGE_ROOT/../.." && pwd)"

CIRCOMLIB="$REPO_ROOT/node_modules/.pnpm/circomlib@2.0.5/node_modules"
CIRCOMLIB_CIRCUITS="$REPO_ROOT/node_modules/.pnpm/circomlib@2.0.5/node_modules/circomlib/circuits"
ZKKIT="$REPO_ROOT/node_modules/.pnpm/@zk-kit+binary-merkle-root.circom@2.0.0/node_modules"
CIRCUITS_DIR="$PACKAGE_ROOT/circuits"
OUTPUT_DIR="$PACKAGE_ROOT/fuzz-output"

# Circuits available for fuzzing (matches circuits.json)
# Note: For transact variants, we only need to fuzz a representative subset since they share the same template
CORE_CIRCUITS=("deposit" "ragequit" "transact_2x2")
ALL_TRANSACT_VARIANTS=(
    "transact_1x1" "transact_1x2" "transact_1x3" "transact_1x4" "transact_1x5"
    "transact_2x1" "transact_2x2" "transact_2x3" "transact_2x4" "transact_2x5"
    "transact_3x1" "transact_3x2" "transact_3x3" "transact_3x4" "transact_3x5"
    "transact_4x1" "transact_4x2" "transact_4x3" "transact_4x4" "transact_4x5"
    "transact_5x1" "transact_5x2" "transact_5x3" "transact_5x4" "transact_5x5"
)

# === Defaults ===
TIMEOUT=""
VERBOSE=false
SAVE_OUTPUT=true

# === Functions ===
usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS] [CIRCUIT]

Fuzz Privacy Pools v2 circuits using zkfuzz.

Arguments:
  CIRCUIT              Circuit name to fuzz. Options:
                         - deposit
                         - ragequit
                         - transact_NxM (e.g., transact_2x2, transact_1x5)
                       If omitted, defaults to 'ragequit'

Options:
  -a, --all            Fuzz all core circuits (deposit, ragequit, transact_2x2)
  -A, --all-variants   Fuzz ALL circuits including all transact variants (slow!)
  -t, --timeout SEC    Set timeout in seconds per circuit
  -o, --output DIR     Output directory for counterexamples (default: fuzz-output/)
  -n, --no-save        Don't save counterexample outputs
  -v, --verbose        Verbose output
  -l, --list           List all available circuits
  -h, --help           Show this help message

Examples:
  $(basename "$0")                     # Fuzz ragequit (default)
  $(basename "$0") deposit             # Fuzz deposit circuit
  $(basename "$0") transact_2x2        # Fuzz specific transact variant
  $(basename "$0") -a                  # Fuzz all core circuits
  $(basename "$0") -a -t 300           # Fuzz all core circuits, 5min timeout each
  $(basename "$0") -A                  # Fuzz everything (27 circuits)

Circuit file mappings:
  deposit      -> main/deposit.circom
  ragequit     -> main/ragequit.circom
  transact_*   -> main/transact_*.circom (25 variants)

EOF
    exit 0
}

list_circuits() {
    echo "Available circuits:"
    echo ""
    echo "Core circuits (recommended for fuzzing):"
    for c in "${CORE_CIRCUITS[@]}"; do
        echo "  - $c"
    done
    echo ""
    echo "All transact variants:"
    for c in "${ALL_TRANSACT_VARIANTS[@]}"; do
        echo "  - $c"
    done
    exit 0
}

circuit_to_path() {
    local circuit="$1"
    case "$circuit" in
        deposit)
            echo "main/deposit.circom"
            ;;
        ragequit)
            echo "main/ragequit.circom"
            ;;
        transact_*)
            echo "main/${circuit}.circom"
            ;;
        *)
            echo "ERROR: Unknown circuit '$circuit'" >&2
            echo "Use -l to list available circuits" >&2
            exit 1
            ;;
    esac
}

run_zkfuzz() {
    local circuit="$1"
    local circuit_path
    circuit_path=$(circuit_to_path "$circuit")

    local full_path="$CIRCUITS_DIR/$circuit_path"
    if [[ ! -f "$full_path" ]]; then
        echo "ERROR: Circuit file not found: $full_path" >&2
        exit 1
    fi

    echo "========================================"
    echo "Fuzzing: $circuit"
    echo "Path:    $circuit_path"
    echo "========================================"

    local cmd="zkfuzz --prime bn128"

    if [[ "$SAVE_OUTPUT" == true ]]; then
        mkdir -p "$OUTPUT_DIR"
        cmd="$cmd --save_output"
    fi

    cmd="$cmd -l \"$CIRCOMLIB\" -l \"$CIRCOMLIB_CIRCUITS\" -l \"$ZKKIT\" \"$full_path\""

    if [[ "$VERBOSE" == true ]]; then
        echo "Command: $cmd"
    fi

    if [[ -n "$TIMEOUT" ]]; then
        echo "Timeout: ${TIMEOUT}s"
        timeout "$TIMEOUT" bash -c "$cmd" || {
            local exit_code=$?
            if [[ $exit_code -eq 124 ]]; then
                echo "Timeout reached for $circuit (${TIMEOUT}s)"
                return 0
            else
                return $exit_code
            fi
        }
    else
        eval "$cmd"
    fi

    echo ""
}

# === Parse Arguments ===
CIRCUITS_TO_FUZZ=()
FUZZ_ALL=false
FUZZ_ALL_VARIANTS=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage
            ;;
        -l|--list)
            list_circuits
            ;;
        -a|--all)
            FUZZ_ALL=true
            shift
            ;;
        -A|--all-variants)
            FUZZ_ALL_VARIANTS=true
            shift
            ;;
        -t|--timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -n|--no-save)
            SAVE_OUTPUT=false
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -*)
            echo "Unknown option: $1" >&2
            echo "Use -h for help" >&2
            exit 1
            ;;
        *)
            CIRCUITS_TO_FUZZ+=("$1")
            shift
            ;;
    esac
done

# === Determine circuits to fuzz ===
if [[ "$FUZZ_ALL_VARIANTS" == true ]]; then
    CIRCUITS_TO_FUZZ=("deposit" "ragequit" "${ALL_TRANSACT_VARIANTS[@]}")
    echo "Fuzzing ALL circuits (${#CIRCUITS_TO_FUZZ[@]} total)"
elif [[ "$FUZZ_ALL" == true ]]; then
    CIRCUITS_TO_FUZZ=("${CORE_CIRCUITS[@]}")
    echo "Fuzzing core circuits (${#CIRCUITS_TO_FUZZ[@]} total)"
elif [[ ${#CIRCUITS_TO_FUZZ[@]} -eq 0 ]]; then
    # Default to ragequit for backwards compatibility
    CIRCUITS_TO_FUZZ=("ragequit")
fi

# === Verify zkfuzz is installed ===
if ! command -v zkfuzz &> /dev/null; then
    echo "ERROR: zkfuzz not found in PATH" >&2
    echo "Install it from: https://github.com/babyproofofficial/zkfuzz" >&2
    exit 1
fi

# === Run fuzzing ===
FAILED=()
PASSED=()

for circuit in "${CIRCUITS_TO_FUZZ[@]}"; do
    if run_zkfuzz "$circuit"; then
        PASSED+=("$circuit")
    else
        FAILED+=("$circuit")
    fi
done

# === Summary ===
echo ""
echo "========================================"
echo "Fuzzing Summary"
echo "========================================"
echo "Passed: ${#PASSED[@]}"
echo "Failed: ${#FAILED[@]}"

if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo ""
    echo "Failed circuits:"
    for circuit in "${FAILED[@]}"; do
        echo "  - $circuit"
    done
    exit 1
fi

echo ""
echo "All circuits fuzzed successfully!"
