// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

library ProofLibV2 {
    struct TransactProof {

        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[][] pubSignals;
    }

        /// @notice Returns the public withdrawal amount from a transact proof
        /// @param _proof The transact proof struct
        /// @return The amount being withdrawn (0 for pure transfers)
        function amountOut(TransactProof calldata _proof) internal pure returns (uint256) {
        return _proof.pubSignals[5][0];
    }

    /// @notice Returns the token address for withdrawal from a transact proof
    /// @param _proof The transact proof struct
    /// @return The token address being withdrawn
    function tokenIdOut(TransactProof calldata _proof) internal pure returns (address) {
        return address(uint160(_proof.pubSignals[6][0]));
    }

}
