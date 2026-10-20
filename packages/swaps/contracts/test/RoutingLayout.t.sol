// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {MockPool} from "../src/MockPool.sol";
import {RelaySwaps, IPool, IEntrypoint} from "../src/RelaySwaps.sol";
import {RoutingAst} from "../script/helpers/RoutingAst.sol";

/// @notice RC-32 drift guard: SwapRouting's ABI shape must never change without
///   ROUTING_TYPEHASH being updated to match. The finding's root cause was exactly this —
///   the struct's field list drifted across a compiler-visible-only change (no external
///   function ever takes SwapRouting as a parameter; it only ever appears as opaque
///   `bytes` decoded inside execute()), so nothing caught the five live deployments
///   falling out of sync with the SDK/relayer encoders until a user's proof had already
///   been spent generating a call that panics mid-decode.
///
/// Reads the struct's actual compiled shape via `RoutingAst` (solc's own AST —
/// `out/<File>.sol/<File>.json`, built with `ast = true` in foundry.toml) and asserts its
/// hash matches ROUTING_TYPEHASH(). RelaySwaps.sol no longer hand-types the encodeType
/// string this hashes against either — `GenerateRoutingTypehash.s.sol` (same `RoutingAst`
/// helper) generates `src/generated/RoutingTypehash.sol` from the same AST read this test
/// performs, so a struct change that isn't followed by re-running that script fails here,
/// on the same PR — not six weeks later against a stale deployment.
///
/// It also asserts RelaySwaps.sol's own SwapRouting/DustRescue definitions (the ones
/// execute() actually decodes against) agree with IRelaySwaps.sol's copies. The interface
/// is not inherited by RelaySwaps (`contract RelaySwaps is ReentrancyGuard, Ownable`, no
/// `IRelaySwaps`), so the two struct definitions are two independently hand-maintained
/// copies today — a second, narrower version of the same drift risk this whole finding is
/// about, caught here as a side effect of already reading both files' ASTs.
contract RoutingLayoutTest is Test {
    RelaySwaps internal relaySwaps;

    function setUp() public {
        MockPool pool = new MockPool();
        relaySwaps =
            new RelaySwaps(IPool(address(pool)), IEntrypoint(address(pool)), makeAddr("owner"), makeAddr("router"));
    }

    function test_routingTypehashMatchesCompiledStructShape() public view {
        string memory implJson = vm.readFile("out/RelaySwaps.sol/RelaySwaps.json");
        string memory encodeType = string.concat(
            RoutingAst.encodeTypeFor(vm, implJson, "RelaySwaps", "SwapRouting"),
            RoutingAst.encodeTypeFor(vm, implJson, "RelaySwaps", "DustRescue")
        );
        assertEq(
            relaySwaps.ROUTING_TYPEHASH(),
            keccak256(bytes(encodeType)),
            "ROUTING_TYPEHASH() disagrees with SwapRouting's actual compiled shape - rerun GenerateRoutingTypehash.s.sol"
        );
    }

    function test_interfaceStructMirrorsImplementation() public view {
        string memory implJson = vm.readFile("out/RelaySwaps.sol/RelaySwaps.json");
        string memory ifaceJson = vm.readFile("out/IRelaySwaps.sol/IRelaySwaps.json");

        assertEq(
            RoutingAst.encodeTypeFor(vm, implJson, "RelaySwaps", "SwapRouting"),
            RoutingAst.encodeTypeFor(vm, ifaceJson, "IRelaySwaps", "SwapRouting"),
            "RelaySwaps.SwapRouting and IRelaySwaps.SwapRouting have drifted apart - IRelaySwaps is not `is`-inherited, so nothing else catches this"
        );
        assertEq(
            RoutingAst.encodeTypeFor(vm, implJson, "RelaySwaps", "DustRescue"),
            RoutingAst.encodeTypeFor(vm, ifaceJson, "IRelaySwaps", "DustRescue"),
            "RelaySwaps.DustRescue and IRelaySwaps.DustRescue have drifted apart - IRelaySwaps is not `is`-inherited, so nothing else catches this"
        );
    }
}
