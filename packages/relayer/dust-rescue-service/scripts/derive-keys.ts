/**
 * Offline, one-off key derivation for the dust-rescue signer (dust_collection_service_design.org
 * §6 / dust_collection_service_detailed_design.org §10, unified 2026-08-18 per issue #222's
 * design — see dust_unification_feasibility_and_plan.org). NOT part of the deployed image —
 * run manually once by an operator, against a root seed that then lives only in Secret
 * Manager under offline-derivation-only access. Neither running service (relayer nor
 * dust-rescue-service) ever touches the root seed itself.
 *
 * A single role, not two: the same address both catches every swept dust source (the
 * relayer's `dust_rescue_recipient_address`, and the destination-chain target of dust #1's
 * LiFi forward) AND signs the eventual rescue deposit (`DUST_RESCUE_SIGNER_PRIVATE_KEY`).
 * An earlier two-key design (a non-signing "Child 0" catch address separate from a
 * signing "Child 1") turned out unworkable: `Entrypoint.deposit()` pulls funds via
 * `safeTransferFrom(msg.sender, ...)`, so whoever signs the deposit must already hold the
 * tokens — nothing ever moved funds between two separate addresses.
 *
 * Usage:
 *   pnpm --filter @privacy-pools-v2/dust-rescue-service exec tsx scripts/derive-keys.ts <hex-seed>
 *
 * <hex-seed> is a 0x-prefixed hex string (32+ bytes recommended), supplied by the
 * operator at run time — never hardcoded, never committed, never logged in full.
 *
 * Output:
 *   Address     -> relayer's `dust_rescue_recipient_address` config (public)
 *   Private key -> dust-rescue-service's `DUST_RESCUE_SIGNER_PRIVATE_KEY` secret
 */
import { HDKey } from "@scure/bip32";
import { hdKeyToAccount } from "viem/accounts";
import { hexToBytes, type Hex } from "viem";

function main(): void {
    const seedHex = process.argv[2];
    if (!seedHex || !seedHex.startsWith("0x")) {
        console.error("Usage: tsx scripts/derive-keys.ts <0x-prefixed-hex-seed>");
        process.exit(1);
    }

    const seed = hexToBytes(seedHex as Hex);
    const root = HDKey.fromMasterSeed(seed);

    // Single dust-rescue signer. Standard BIP-44 path, account 0, address index 0.
    const account = hdKeyToAccount(root, { path: "m/44'/60'/0'/0/0" });
    const key = root.derive("m/44'/60'/0'/0/0");
    if (!key.privateKey) {
        throw new Error("Failed to derive dust-rescue signer private key");
    }
    const privateKeyHex = `0x${Buffer.from(key.privateKey).toString("hex")}`;

    console.log("Address (-> relayer's dust_rescue_recipient_address, public):");
    console.log(`  ${account.address}`);
    console.log("");
    console.log("Private key (-> dust-rescue-service's DUST_RESCUE_SIGNER_PRIVATE_KEY,");
    console.log("Secret Manager ONLY — never commit, never log elsewhere):");
    console.log(`  ${privateKeyHex}`);
}

main();
