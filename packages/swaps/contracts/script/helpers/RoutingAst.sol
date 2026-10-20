// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Vm} from "forge-std/Vm.sol";

/// @notice RC-32: mechanically reconstructs a struct's EIP-712-style encodeType string from
///   solc's own compiled AST (`out/<File>.sol/<File>.json`, requires `ast = true` in
///   foundry.toml) instead of a second hand-maintained field list -- the drift SwapRouting
///   already suffered once (its shape changed while nothing that reads it noticed, since it's
///   never part of any external function's ABI, only ever decoded from opaque bytes).
///
/// Shared by two callers that must agree byte-for-byte: `RoutingLayout.t.sol` (the drift-guard
/// test -- fails the build if a struct's actual shape and its hand-typed ROUTING_TYPEHASH()
/// string disagree) and `GenerateRoutingTypehash.s.sol` (the generator that writes that string
/// in the first place, so nobody hand-types it). Both need the exact same reconstruction, or
/// "the test checks X but the generator writes Y" becomes its own drift risk.
library RoutingAst {
    /// @dev `<StructName>(type1 name1,type2 name2,...)`, per EIP-712's encodeType for one
    ///   struct (the caller concatenates referenced struct types after the primary one).
    function encodeTypeFor(Vm vm, string memory json, string memory contractName, string memory structName)
        internal
        pure
        returns (string memory)
    {
        string memory base = string.concat(
            "$.ast.nodes[?(@.name=='", contractName, "')].nodes[?(@.name=='", structName, "')].members"
        );
        string[] memory names = abi.decode(vm.parseJson(json, string.concat(base, "[*].name")), (string[]));
        string[] memory rawTypes =
            abi.decode(vm.parseJson(json, string.concat(base, "[*].typeDescriptions.typeString")), (string[]));
        require(names.length == rawTypes.length && names.length > 0, "RoutingAst: struct not found or empty");

        string memory members = "";
        for (uint256 i = 0; i < names.length; i++) {
            members = string.concat(members, i == 0 ? "" : ",", bareType(rawTypes[i]), " ", names[i]);
        }
        return string.concat(structName, "(", members, ")");
    }

    /// @dev solc reports a struct-typed member as `"struct <Contract>.<StructName>"`; EIP-712's
    ///   encodeType wants just `<StructName>`. Elementary types (`"address"`, `"uint256"`, ...)
    ///   pass through unchanged. Generic on the qualifying contract/struct name, so a future
    ///   nested struct needs no change here.
    function bareType(string memory typeString) internal pure returns (string memory) {
        bytes memory t = bytes(typeString);
        bytes memory prefix = bytes("struct ");
        if (t.length <= prefix.length) return typeString;
        for (uint256 i = 0; i < prefix.length; i++) {
            if (t[i] != prefix[i]) return typeString;
        }

        uint256 lastDot = type(uint256).max;
        for (uint256 i = prefix.length; i < t.length; i++) {
            if (t[i] == ".") lastDot = i;
        }
        uint256 start = lastDot == type(uint256).max ? prefix.length : lastDot + 1;

        bytes memory out = new bytes(t.length - start);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = t[start + i];
        }
        return string(out);
    }
}
