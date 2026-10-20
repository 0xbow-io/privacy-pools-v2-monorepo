#!/usr/bin/env python3
"""
Generate _getVkNxM() functions for TransactVerifier.sol from vkey JSON files.

Usage:
    python3 scripts/generate-transact-verifier-vkeys.py

Reads all 25 transact_NxM/groth16_vkey.json files from build/ and outputs
the Solidity function block that should replace lines 268+ in TransactVerifier.sol.
Also verifies that shared constants (alpha, beta, gamma) are consistent across all vkeys.
"""

import json
import os
import sys

BUILD_DIR = os.path.join(os.path.dirname(__file__), '..', 'build')


def format_uint256(value: str) -> str:
    """Format a large integer string with underscore separators for Solidity readability."""
    s = str(value)
    # Insert underscores every 3 digits from the right
    result = []
    for i, c in enumerate(reversed(s)):
        if i > 0 and i % 3 == 0:
            result.append('_')
        result.append(c)
    return ''.join(reversed(result))


def load_vkey(n: int, m: int) -> dict:
    """Load a vkey JSON for transact_NxM."""
    path = os.path.join(BUILD_DIR, f'transact_{n}x{m}', 'groth16_vkey.json')
    if not os.path.exists(path):
        print(f"ERROR: Missing vkey file: {path}", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def extract_shared_constants(vkey: dict) -> dict:
    """Extract alpha, beta, gamma from a vkey for consistency checking."""
    return {
        'alpha': vkey['vk_alpha_1'][:2],
        'beta': vkey['vk_beta_2'][:2],
        'gamma': vkey['vk_gamma_2'][:2],
    }


def generate_vk_function(n: int, m: int, vkey: dict) -> str:
    """Generate a _getVkNxM() function from a vkey JSON."""
    d = vkey['vk_delta_2']
    ic_points = vkey['IC']
    n_public = vkey['nPublic']

    # delta format: Solidity [x1, x2, y1, y2] from JSON [[x2, x1], [y2, y1], [1, 0]]
    delta = [d[0][1], d[0][0], d[1][1], d[1][0]]

    # IC: each point is [x, y, 1], we take x and y, flatten to [x0, y0, x1, y1, ...]
    ic_flat = []
    for pt in ic_points:
        ic_flat.append(pt[0])
        ic_flat.append(pt[1])

    num_ic_coords = len(ic_flat)
    num_ic_points = len(ic_points)

    lines = []
    lines.append(f'  function _getVk{n}x{m}() internal pure returns (uint256[4] memory delta, uint256[] memory ic) {{')
    lines.append(f'    delta = [')
    lines.append(f'      uint256({format_uint256(delta[0])}),')
    lines.append(f'      uint256({format_uint256(delta[1])}),')
    lines.append(f'      uint256({format_uint256(delta[2])}),')
    lines.append(f'      uint256({format_uint256(delta[3])})')
    lines.append(f'    ];')
    lines.append(f'')
    lines.append(f'    ic = new uint256[]({num_ic_coords}); // {num_ic_points} points * 2 coordinates')

    for i, val in enumerate(ic_flat):
        lines.append(f'    ic[{i}] = {format_uint256(val)};')

    lines.append(f'  }}')
    return '\n'.join(lines)


def verify_shared_constants(all_vkeys: list[tuple[int, int, dict]]):
    """Verify alpha, beta, gamma are identical across all vkeys."""
    reference = None
    ref_name = None
    for n, m, vkey in all_vkeys:
        constants = extract_shared_constants(vkey)
        if reference is None:
            reference = constants
            ref_name = f'transact_{n}x{m}'
        else:
            for key in ['alpha', 'beta', 'gamma']:
                if constants[key] != reference[key]:
                    print(f"ERROR: {key} mismatch between {ref_name} and transact_{n}x{m}!", file=sys.stderr)
                    print(f"  {ref_name}: {reference[key]}", file=sys.stderr)
                    print(f"  transact_{n}x{m}: {constants[key]}", file=sys.stderr)
                    sys.exit(1)
    print(f"Shared constants (alpha, beta, gamma) verified consistent across all 25 circuits.", file=sys.stderr)

    # Also print the shared constants for reference
    vkey = all_vkeys[0][2]
    a = vkey['vk_alpha_1']
    print(f"  ALPHAX = {a[0]}", file=sys.stderr)
    print(f"  ALPHAY = {a[1]}", file=sys.stderr)


def main():
    # Load all 25 vkeys
    all_vkeys = []
    for n in range(1, 6):
        for m in range(1, 6):
            vkey = load_vkey(n, m)
            all_vkeys.append((n, m, vkey))

    # Verify shared constants
    verify_shared_constants(all_vkeys)

    # Generate all _getVk functions
    functions = []
    for n, m, vkey in all_vkeys:
        functions.append(generate_vk_function(n, m, vkey))

    # Output
    print('\n\n'.join(functions))

    print(f"\nGenerated 25 _getVkNxM() functions.", file=sys.stderr)


if __name__ == '__main__':
    main()
