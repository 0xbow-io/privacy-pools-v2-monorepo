#!/bin/bash
#
# Run benchmarks for multiple tree depth configurations.
#
# This script iterates through different configurations, updates circuits.json,
# compiles all circuits, generates proving keys, and runs benchmarks.
#
# Configurations:
#   A (32/32/32) - Maximum capacity baseline
#   B (32/24/24) - Reduced keystore/ASP
#   C (24/20/20) - Balanced reduction
#   D (18/14/14) - Production config
#
# Usage: ./scripts/run-all-benchmarks.sh [config]
#
# Examples:
#   ./scripts/run-all-benchmarks.sh        # Run all configurations
#   ./scripts/run-all-benchmarks.sh D      # Run only config D (production)
#   ./scripts/run-all-benchmarks.sh A B    # Run configs A and B
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BENCHMARKS_DIR="$PROJECT_DIR/benchmarks"

# Get config depths - compatible with bash 3
get_config() {
  case "$1" in
    A) echo "32_32_32" ;;
    B) echo "32_24_24" ;;
    C) echo "24_20_20" ;;
    D) echo "18_14_14" ;;
    *) echo "" ;;
  esac
}

# Parse arguments - if none provided, run all configs
if [ $# -eq 0 ]; then
  SELECTED_CONFIGS="A B C D"
else
  SELECTED_CONFIGS="$*"
fi

echo "========================================"
echo "Privacy Pools V2 Multi-Config Benchmarks"
echo "========================================"
echo ""
echo "Selected configurations: $SELECTED_CONFIGS"
echo ""

# Ensure benchmarks directory exists
mkdir -p "$BENCHMARKS_DIR"

# Store original circuits.json to restore at the end
ORIGINAL_CONFIG=$(cat "$PROJECT_DIR/circuits.json")

cleanup() {
  echo ""
  echo "Restoring original circuits.json..."
  echo "$ORIGINAL_CONFIG" > "$PROJECT_DIR/circuits.json"
  echo "Done."
}

# Restore original config on exit
trap cleanup EXIT

cd "$PROJECT_DIR"

for config_name in $SELECTED_CONFIGS; do
  config=$(get_config "$config_name")

  if [ -z "$config" ]; then
    echo "ERROR: Unknown configuration '$config_name'"
    echo "Valid configurations: A, B, C, D"
    exit 1
  fi

  echo ""
  echo "========================================"
  echo "Configuration $config_name: $config"
  echo "========================================"
  echo ""

  # Parse depths from config string
  state=$(echo "$config" | cut -d'_' -f1)
  keystore=$(echo "$config" | cut -d'_' -f2)
  asp=$(echo "$config" | cut -d'_' -f3)

  echo "State depth: $state"
  echo "Keystore depth: $keystore"
  echo "ASP depth: $asp"
  echo ""

  # Step 1: Update circuits.json
  echo "[1/4] Updating circuits.json..."
  node scripts/update-depths.js "$state" "$keystore" "$asp"

  # Step 2: Clean previous build artifacts
  echo "[2/4] Cleaning build artifacts..."
  pnpm clean 2>/dev/null || rm -rf build

  # Step 3: Compile and setup
  echo "[3/4] Compiling circuits and generating proving keys..."
  echo "  This may take several minutes..."
  pnpm compile:all
  pnpm setup:all

  # Step 4: Run benchmarks
  echo "[4/4] Running benchmarks..."
  pnpm test:benchmark

  # Find the most recent benchmark file and rename it
  LATEST_BENCHMARK=$(ls -t "$BENCHMARKS_DIR"/benchmark-results-*.json 2>/dev/null | head -1)
  if [ -n "$LATEST_BENCHMARK" ]; then
    mv "$LATEST_BENCHMARK" "$BENCHMARKS_DIR/benchmark-config-${config_name}-${config}.json"
    echo ""
    echo "Results saved to: benchmarks/benchmark-config-${config_name}-${config}.json"
  fi

  echo ""
  echo "Configuration $config_name complete!"
done

echo ""
echo "========================================"
echo "All benchmarks complete!"
echo "========================================"
echo ""
echo "Results saved in: $BENCHMARKS_DIR/"
ls -la "$BENCHMARKS_DIR"/benchmark-config-*.json 2>/dev/null || echo "(No benchmark files found)"
