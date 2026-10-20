import type { Hex } from "@privacy-pools-v2/evm-sdk";
import { parseEther } from "viem";

import { generatePaymentRequest } from "../../src/paymentRequest/generatePaymentRequest.js";
import { config } from "../../src/util/config.js";
import { createBobPoolSession } from "../../src/util/createBobPoolSession.js";

async function main(): Promise<void> {
    const amountArg = process.argv[2] ?? config.depositAmount;
    const amount = `0x${parseEther(amountArg).toString(16)}` as Hex;

    const bob = await createBobPoolSession();
    const request = await generatePaymentRequest(bob.poolSession, {
        amount,
        tokenId: config.tokenId,
    });

    if (!request.paymentId || !request.tag || !request.paymentPubKey) {
        throw new Error("PaymentRequest missing one of paymentId/tag/paymentPubKey");
    }
    if (request.noteAddressHashes.length === 0) {
        throw new Error("noteAddressHashes is empty — sender would have no slots to spend into");
    }
    // The shareable request must NOT carry any secret: noteAddressHash = Poseidon(addr, secret),
    // so a leaked (hash, secret) pair would let anyone confirm the recipient's address.
    if ("noteSecretsMap" in request) {
        throw new Error(
            "PaymentRequest must not expose noteSecretsMap — secrets stay recipient-local",
        );
    }
    if (request.amount !== amount || request.tokenId !== config.tokenId) {
        throw new Error("Returned request does not echo input fields");
    }
    // #600. The sender's expiry guard can only work if the stamp actually reaches the shareable
    // payload, and `generatePaymentRequest` builds that payload field by field — so an omission
    // type-checks (the field is optional) and reads downstream as "predates expiry, never lapses",
    // silently disarming the guard while the recipient still drops the request from its scan set.
    // That is exactly how it shipped once. Asserted here rather than only in unit tests because
    // this check runs a REAL PoolSession against a real PaymentRequestService, so it exercises the
    // actual stamping path instead of a mocked one.
    if (!request.expiresAt) {
        throw new Error(
            "PaymentRequest missing expiresAt — the sender-side expiry guard would never fire",
        );
    }
    if (BigInt(request.expiresAt) <= BigInt(Date.now())) {
        throw new Error(
            `PaymentRequest expiresAt ${request.expiresAt} is already in the past at generation`,
        );
    }
    console.log(
        `✓ generatePaymentRequest ok — tag=${request.tag} slots=${request.noteAddressHashes.length}`,
    );
    process.exit(0);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
