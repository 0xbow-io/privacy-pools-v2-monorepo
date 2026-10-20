import type { Hash, Hex, AccountExport } from "@privacy-pools-v2/evm-sdk";

import type {
    TestActor,
    TestContext,
    DepositResult,
    TransferResult,
    WithdrawResult,
} from "./types.js";
import { sendAndConfirm } from "./tx.js";
import { addLeafAndUpdateRoot } from "./asp.js";
import { refreshSession } from "./session.js";

// ─── Register Keystore ──────────────────────────────────────────────────────

/**
 * Registers the actor's keys in the on-chain keystore.
 * Sends setAuthPolicy and setViewingKey transactions.
 */
export async function registerKeystore(actor: TestActor): Promise<void> {
    console.log(`  [${actor.name}] Registering keystore...`);

    const registration = await actor.poolSession.prepareRegisterKeystore();

    if (registration.alreadyRegistered) {
        console.log(`  [${actor.name}] Keystore already registered`);
        return;
    }

    const { keystoreCalldata, viewingKeyCalldata } = registration;
    if (!keystoreCalldata) {
        throw new Error("Unexpected: keystoreCalldata is null for unregistered keystore");
    }

    await sendAndConfirm(
        actor.walletClient,
        {
            to: keystoreCalldata.to as Hex,
            data: keystoreCalldata.data as Hex,
            value: BigInt(keystoreCalldata.value),
        },
        actor.rpcInteractor,
    );

    if (viewingKeyCalldata) {
        await sendAndConfirm(
            actor.walletClient,
            {
                to: viewingKeyCalldata.to as Hex,
                data: viewingKeyCalldata.data as Hex,
                value: BigInt(viewingKeyCalldata.value),
            },
            actor.rpcInteractor,
        );
    }

    console.log(`  [${actor.name}] Keystore registered`);
}

// ─── Deposit ─────────────────────────────────────────────────────────────────

/**
 * Deposits ETH into the privacy pool for the given actor.
 * Returns the note commitment and label needed for ASP activation.
 */
export async function deposit(
    actor: TestActor,
    amount: bigint,
    ctx: TestContext,
): Promise<DepositResult> {
    const depositValue = `0x${amount.toString(16)}` as Hex;

    console.log(`  [${actor.name}] Preparing deposit...`);

    const result = await actor.poolSession.prepareDeposit({
        tokenId: ctx.config.tokenId,
        value: depositValue,
    });

    // Send approval tx if needed (ERC-20 only, not for native ETH)
    if (result.approvalTx) {
        await sendAndConfirm(
            actor.walletClient,
            {
                to: result.approvalTx.to as Hex,
                data: result.approvalTx.data as Hex,
                value: BigInt(result.approvalTx.value),
            },
            actor.rpcInteractor,
        );
    }

    // Send deposit tx (with retries + simulate on final failure)
    await sendAndConfirm(
        actor.walletClient,
        {
            to: result.to as Hex,
            data: result.callData as Hex,
            value: BigInt(result.msgValue),
        },
        actor.rpcInteractor,
        `${actor.name} deposit`,
        ctx.config.rpcUrl,
    );

    // Export account state for subsequent operations
    actor.accountExport = actor.poolSession.exportAccount();

    console.log(`  [${actor.name}] Deposited — commitment: ${result.receipt.commitment}`);

    return {
        commitment: result.receipt.commitment as Hash,
        label: result.receipt.label as Hash,
    };
}

// ─── Activate Deposit ────────────────────────────────────────────────────────

/**
 * Activates a deposit by updating the ASP root with the note's label,
 * then refreshes sessions for the specified actors so they can use the new root.
 */
export async function activateDeposit(
    labels: Hash | Hash[],
    actorsToRefresh: TestActor[],
    ctx: TestContext,
): Promise<void> {
    const labelArray = Array.isArray(labels) ? labels : [labels];

    for (const label of labelArray) {
        await addLeafAndUpdateRoot(label, ctx);
    }

    for (const actor of actorsToRefresh) {
        await refreshSession(actor, ctx);
    }
}

// ─── Transfer ────────────────────────────────────────────────────────────────

/**
 * Transfers funds from sender to recipient within the privacy pool.
 * Patches sender's notes, generates proof, and submits the transaction.
 */
export async function transfer(
    sender: TestActor,
    recipient: TestActor,
    amount: bigint,
    ctx: TestContext,
): Promise<TransferResult> {
    const transferAmount = `0x${amount.toString(16)}` as Hex;

    console.log(`  [${sender.name}] Preparing transfer to ${recipient.name}...`);

    // Patch notes with on-chain timestamps and status
    const accountExport = sender.accountExport ?? sender.poolSession.exportAccount();
    await patchNotes(accountExport, sender);

    // Re-import patched state
    sender.poolSession.importAccount(accountExport);

    // Find an active note to spend (prefer one with sufficient value)
    const activeNotes = accountExport.notes.filter((n) => n.status === "ACTIVE");
    if (activeNotes.length === 0) {
        console.log(`  [${sender.name}] Notes dump:`, accountExport.notes.map((n) => ({ commitment: n.commitment.slice(0, 10), status: n.status, value: n.value })));
        throw new Error(`[${sender.name}] No ACTIVE notes available for transfer`);
    }
    const sortedNotes = activeNotes.sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
    const inputNote = sortedNotes.find((n) => BigInt(n.value) >= amount);
    if (!inputNote) {
        const largest = sortedNotes[0];
        throw new Error(
            `[${sender.name}] No ACTIVE note with sufficient value for transfer: ` +
            `need ${transferAmount}, largest available is ${largest.value}`,
        );
    }

    console.log(`  [${sender.name}] Using note ${inputNote.commitment.slice(0, 10)}... (value: ${inputNote.value}) for transfer of ${transferAmount}`);

    // Compute recipient noteAddressHash
    const recipientNoteSecret = sender.cryptoService.generateSecret();
    const recipientNoteAddressHash = sender.hashService.hash([
        recipient.address,
        recipientNoteSecret,
    ]);

    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

    // The SDK generates the sender's change note secret internally and
    // adds the change note to NoteManager automatically.
    const result = await sender.poolSession.prepareTransfer({
        inputCommitments: [inputNote.commitment as Hex],
        recipientNoteAddressHash,
        amount: transferAmount,
        tokenId: ctx.config.tokenId,
        relayAddress: sender.address,
        feeAmount: "0x0" as Hex,
        processorAddress: ZERO_ADDRESS,
    });

    // Submit via relayer
    console.log(`  [${sender.name}] Submitting transfer via relayer...`);
    const txHash = await sender.poolSession.relayTransfer(result.relayOptions[0]);

    const receipt = await sender.rpcInteractor.waitForTransactionReceipt(txHash as Hex);
    if (receipt.status === "reverted") {
        throw new Error(`[${sender.name}] Transfer transaction reverted: ${txHash}`);
    }

    // Export updated state (SDK already added the fee-adjusted change note)
    sender.accountExport = sender.poolSession.exportAccount();

    // Read the actual change note value (post relayer fee deduction)
    const changeNote = sender.accountExport.notes.find(
        (n) => n.status === "PENDING" && n.label === inputNote.label && n.commitment !== inputNote.commitment,
    );
    const changeValue = changeNote ? BigInt(changeNote.value) : 0n;

    console.log(
        `  [${sender.name}] Transferred to ${recipient.name} — ` +
        `recipient: ${result.recipientReceipt.commitment}, ` +
        `change: ${changeNote?.commitment ?? "none"} (value: ${changeValue})`,
    );

    return {
        recipientCommitment: result.recipientReceipt.commitment as Hash,
        changeCommitment: (changeNote?.commitment ?? result.changeReceipt.commitment) as Hash,
        changeValue,
        recipientNoteData: {
            label: inputNote.label as Hash,
            value: transferAmount,
            tokenId: ctx.config.tokenId,
            noteSecret: recipientNoteSecret as Hex,
        },
    };
}

// ─── Import Received Note ────────────────────────────────────────────────────

/**
 * Imports a received note into the recipient's session so they can spend it.
 * Constructs the note from transfer result data (the SDK does not add output
 * notes to the sender's NoteManager, so we build it from known parameters).
 */
export async function importReceivedNote(
    recipient: TestActor,
    transferResult: TransferResult,
): Promise<void> {
    const { recipientCommitment, recipientNoteData } = transferResult;

    // Merge the received note into the recipient's existing state.
    // importAccount clears all notes, so we must export first and append.
    const currentExport = recipient.accountExport ?? recipient.poolSession.exportAccount();

    const newNote = {
        commitment: recipientCommitment,
        label: recipientNoteData.label,
        value: recipientNoteData.value,
        tokenId: recipientNoteData.tokenId,
        noteSecret: recipientNoteData.noteSecret,
        ownerAddress: recipient.address,
        isOwned: true,
        status: "PENDING" as const,
        createdAtBlock: "0x0" as Hex,
        spentAtBlock: null,
        txHash: "0x0" as Hash,
    } as AccountExport["notes"][0];

    const mergedExport: AccountExport = {
        notes: [...currentExport.notes, newNote],
        syncCursor: currentExport.syncCursor,
    };

    recipient.poolSession.importAccount(mergedExport);
    recipient.accountExport = recipient.poolSession.exportAccount();

    console.log(
        `  [${recipient.name}] Imported received note: ${recipientCommitment}`,
    );
}

// ─── Withdraw ────────────────────────────────────────────────────────────────

/**
 * Withdraws funds from the privacy pool to the actor's wallet.
 * Submits the transaction via the relayer.
 */
export async function withdraw(
    actor: TestActor,
    amount: bigint,
    ctx: TestContext,
): Promise<WithdrawResult> {
    const withdrawAmount = `0x${amount.toString(16)}` as Hex;
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;

    console.log(`  [${actor.name}] Preparing withdraw...`);

    // Patch notes
    const accountExport = actor.accountExport ?? actor.poolSession.exportAccount();
    await patchNotes(accountExport, actor);

    actor.poolSession.importAccount(accountExport);

    // Find an active note with sufficient value for the requested withdrawal
    console.log(`  [${actor.name}] Notes after patch:`, accountExport.notes.map((n) => ({ c: n.commitment.slice(0, 10), status: n.status, value: n.value })));
    const activeNotes = accountExport.notes.filter((n) => n.status === "ACTIVE");
    if (activeNotes.length === 0) {
        throw new Error(`[${actor.name}] No ACTIVE notes available for withdrawal`);
    }
    const sortedNotes = activeNotes.sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)));
    const inputNote = sortedNotes.find((n) => BigInt(n.value) >= amount) ?? sortedNotes[0];

    console.log(`  [${actor.name}] Using note ${inputNote.commitment} (value: ${inputNote.value}) for withdraw of ${withdrawAmount}`);

    const result = await actor.poolSession.prepareWithdraw({
        inputCommitments: [inputNote.commitment as Hex],
        amount: withdrawAmount,
        tokenId: ctx.config.tokenId,
        recipientAddress: actor.address,
        relayAddress: actor.address,
        feeAmount: "0x0" as Hex,
        feeRecipient: ZERO_ADDRESS,
        processorAddress: ZERO_ADDRESS,
    });

    // Submit via relayer
    console.log(`  [${actor.name}] Submitting withdrawal via relayer...`);
    const txHash = await actor.poolSession.relayWithdraw(result.relayerOptions[0]);

    const receipt = await actor.rpcInteractor.waitForTransactionReceipt(txHash as Hex);
    if (receipt.status === "reverted") {
        throw new Error(`[${actor.name}] Withdraw transaction reverted: ${txHash}`);
    }

    // Export updated state
    actor.accountExport = actor.poolSession.exportAccount();

    console.log(
        `  [${actor.name}] Withdrawn — amountOut: ${result.amountOut}, change: ${result.changeReceipt.commitment}`,
    );

    return {
        changeCommitment: result.changeReceipt.commitment as Hash,
        amountOut: result.amountOut as Hex,
    };
}

// ─── Ragequit ────────────────────────────────────────────────────────────────

/**
 * Emergency exit — ragequits a specific note, bypassing ASP compliance.
 * Funds are sent to the actor's wallet.
 */
export async function ragequit(
    actor: TestActor,
    commitment: Hash,
    ctx?: TestContext,
): Promise<void> {
    console.log(`  [${actor.name}] Preparing ragequit for ${commitment}...`);

    // Import account state if available
    const accountExport = actor.accountExport ?? actor.poolSession.exportAccount();
    actor.poolSession.importAccount(accountExport);

    const result = await actor.poolSession.prepareRageQuit({ commitment });

    await sendAndConfirm(
        actor.walletClient,
        {
            to: result.to as Hex,
            data: result.callData as Hex,
        },
        actor.rpcInteractor,
        `${actor.name} ragequit`,
        ctx?.config.rpcUrl,
    );

    // Export updated state and patch the ragequit note to EXITED.
    // The SDK's prepareRageQuit does not update the note status (it only
    // prepares the calldata), so we patch it after on-chain confirmation.
    actor.accountExport = actor.poolSession.exportAccount();
    const exitedNote = actor.accountExport.notes.find(
        (n) => n.commitment === commitment,
    );
    if (exitedNote) {
        exitedNote.status = "EXITED" as typeof exitedNote.status;
    }
    actor.poolSession.importAccount(actor.accountExport);

    console.log(`  [${actor.name}] Ragequit complete — value: ${result.value}`);
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Patches notes in an account export with on-chain timestamps and correct status.
 * Mirrors the logic in `update-local-account.ts`:
 * 1. Fetches commitment timestamp from chain
 * 2. Checks nullifier to detect spent notes
 * 3. Updates status: PENDING → ACTIVE (if committed), or → SPENT (if nullified)
 */
async function patchNotes(
    accountExport: AccountExport,
    actor: TestActor,
): Promise<void> {
    for (const note of accountExport.notes) {
        // Skip terminal states
        if (note.status === "SPENT" || note.status === "EXITED") continue;

        // Fetch on-chain commitment timestamp
        if (note.createdAtBlock === "0x0" || !note.createdAtBlock) {
            note.createdAtBlock = await actor.poolVaultInteractor.getCommitmentTimestamp(
                note.commitment as Hash,
            );
        }

        // If not yet committed on-chain, skip
        if (!note.createdAtBlock || BigInt(note.createdAtBlock) === 0n) continue;

        // Check nullifier to detect spent notes
        const nullifierHash = actor.hashService.hash([
            actor.privateNullifyingKey,
            note.commitment,
        ]);
        const nullifierTs = await actor.poolVaultInteractor.getNullifierTimestamp(
            nullifierHash as Hash,
        );

        if (BigInt(nullifierTs) !== 0n) {
            note.status = "SPENT" as typeof note.status;
            note.spentAtBlock = nullifierTs;
        } else if (note.status === "PENDING") {
            note.status = "ACTIVE" as typeof note.status;
            note.spentAtBlock = null;
        }
    }
}
