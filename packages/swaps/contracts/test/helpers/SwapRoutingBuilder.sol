// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {RelaySwaps} from "../../src/RelaySwaps.sol";
import {IRelaySwaps} from "../../src/IRelaySwaps.sol";

/// @notice Shared test builder for `SwapRouting` literals. Solidity struct literals
///   require every field, so a field added to `SwapRouting` previously meant touching
///   every construction site across the test suite. This collapses that to one place:
///   call `defaultRouting()` (a struct with every field zero/empty — Solidity's own
///   default for an uninitialized `memory` struct) and set only the fields a given test
///   actually cares about, since `memory` structs are mutable. A future new field then
///   needs a change here only, not at every call site.
/// @dev `RelaySwaps.SwapRouting` and `IRelaySwaps.SwapRouting` are structurally identical
///   but distinct Solidity types (no implicit conversion between differently-named
///   structs), mirroring the dual `_buildTransactParams` overloads in RelaySwaps.t.sol —
///   hence two builders, one per type.
library SwapRoutingBuilder {
    function defaultRouting() internal pure returns (RelaySwaps.SwapRouting memory) {}

    function defaultIRelaySwapsRouting() internal pure returns (IRelaySwaps.SwapRouting memory) {}
}
