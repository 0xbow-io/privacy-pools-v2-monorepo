import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Hex } from "@privacy-pools-v2/evm-sdk";
import { FileStorageService, PaymentRequestStorageAdapter } from "@privacy-pools-v2/evm-sdk";

import { fulfillPaymentRequest } from "../../src/paymentRequest/fulfillPaymentRequest.js";
import { generatePaymentRequest } from "../../src/paymentRequest/generatePaymentRequest.js";
import { config } from "../../src/util/config.js";
import { createAlicePoolSession } from "../../src/util/createAlicePoolSession.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";
import { loadActiveNote } from "../../src/util/loadActiveNote.js";

/**
 * Verifies that the SDK auto-persists PaymentRequestService state to disk:
 *   - after `generatePaymentRequest`: state contains the new request with status=OPEN
 *   - after Bob fulfills + Alice runs discoverNotes: status flips to FULFILLED and
 *     `fulfilledByCommitments` includes the new commitment.
 *
 * The verification reads the storage file via an INDEPENDENT
 * `PaymentRequestStorageAdapter` (not the one inside Alice's session) so
 * we exercise the actual file-write contract, not just in-memory state.
 */
const STORAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "payment-request");
const STORAGE_FILE = "payment-request-storage-test";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const amount = `0x${parseEther(amountArg).toString(16)}` as Hex;

    // Independent reader — same FileStorageService config Alice's session uses.
    // Adapter key now includes ownerAddress (audit M-5), so we derive Alice's
    // address here to read the same slot.
    const aliceAddress = privateKeyToAccount(config.alice.privateKey as `0x${string}`)
        .address as Hex;
    const storageReader = new PaymentRequestStorageAdapter(
        config.chainId,
        new FileStorageService({ dirPath: STORAGE_DIR, filename: STORAGE_FILE }),
        aliceAddress,
    );
    await storageReader.clearState();

    const alice = await createAlicePoolSession({
        persistentStorage: { type: "file", dirPath: STORAGE_DIR, filename: STORAGE_FILE },
    });
    const bob = await createBobPoolSession();

    // Step 1 — Alice generates. SDK writes file.
    console.log("Alice generates payment request...");
    const paymentRequest = await generatePaymentRequest(alice.poolSession, {
        amount,
        tokenId: config.tokenId,
    });
    console.log(`  paymentId=${paymentRequest.paymentId}  tag=${paymentRequest.tag}`);

    // Step 2 — read the persisted file via an independent reader.
    const stateAfterGenerate = await storageReader.getState();
    if (!stateAfterGenerate || stateAfterGenerate.requests.length === 0) {
        throw new Error(
            "Post-condition violated: storage file is empty after generatePaymentRequest. " +
                "→ SDK should auto-persist on generate.",
        );
    }
    const persisted = stateAfterGenerate.requests.find(
        (r) => r.paymentId === paymentRequest.paymentId,
    );
    if (!persisted) {
        throw new Error(
            `Post-condition violated: persisted state has ${stateAfterGenerate.requests.length} request(s) but ` +
                `none matches paymentId ${paymentRequest.paymentId}.`,
        );
    }
    if (persisted.status !== "OPEN") {
        throw new Error(`Persisted request status is ${persisted.status}, expected OPEN`);
    }
    if (persisted.fulfilledByCommitments.length !== 0) {
        throw new Error(
            `Persisted request has ${persisted.fulfilledByCommitments.length} fulfilledByCommitments, expected 0`,
        );
    }
    if (persisted.tag !== paymentRequest.tag) {
        throw new Error(`Persisted tag ${persisted.tag} ≠ in-memory tag ${paymentRequest.tag}`);
    }
    console.log(`  ✓ persisted OPEN — ${stateAfterGenerate.requests.length} request(s) on disk`);

    // Step 3 — Bob fulfills.
    const inputNote = await loadActiveNote({
        poolSession: bob.poolSession,
        tokenId: config.tokenId,
        minValue: amount,
        ownerLabel: "Bob",
    });
    console.log(`Bob fulfills (input ${inputNote.commitment})...`);
    const { prepared, receipt } = await fulfillPaymentRequest(bob.poolSession, paymentRequest, [
        inputNote.commitment,
    ]);
    if (!receipt.status) throw new Error("Fulfillment reverted");
    const recipientCommitment = prepared.executeOptions.recipientPendingNotes[0]?.commitment;
    if (!recipientCommitment) throw new Error("No recipient pending note returned");
    console.log(`  recipient commitment ${recipientCommitment}`);

    // Step 4 — Alice runs discoverNotes; SDK marks the request fulfilled and persists.
    console.log("Alice discovers...");
    await alice.poolSession.discoverNotes();

    // Step 5 — re-read persisted state.
    const stateAfterDiscover = await storageReader.getState();
    if (!stateAfterDiscover) throw new Error("Storage state vanished after discoverNotes");
    const fulfilledRecord = stateAfterDiscover.requests.find(
        (r) => r.paymentId === paymentRequest.paymentId,
    );
    if (!fulfilledRecord) throw new Error("Request missing from storage after discoverNotes");
    if (fulfilledRecord.status !== "FULFILLED") {
        throw new Error(
            `Post-condition violated: persisted status is ${fulfilledRecord.status}, expected FULFILLED. ` +
                "→ NoteDiscoveryService should call markFulfilled when a tag-matching note is found.",
        );
    }
    if (
        !fulfilledRecord.fulfilledByCommitments
            .map((c) => c.toLowerCase())
            .includes(recipientCommitment.toLowerCase())
    ) {
        throw new Error(
            `Post-condition violated: fulfilledByCommitments ${JSON.stringify(fulfilledRecord.fulfilledByCommitments)} ` +
                `does not include ${recipientCommitment}.`,
        );
    }
    console.log(`  ✓ persisted FULFILLED — fulfilledByCommitments=[${fulfilledRecord.fulfilledByCommitments.join(", ")}]`);

    console.log("\n✓ paymentRequest storage ok — generate → OPEN, fulfill → FULFILLED");
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
