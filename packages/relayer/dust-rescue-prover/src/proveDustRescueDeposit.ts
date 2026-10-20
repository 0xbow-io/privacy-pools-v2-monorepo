import {
    CryptoService,
    createEvmEntrypointInteractor,
    DEPLOYMENTS,
    NoteComputationService,
    PoolSessionBuilder,
    PoseidonHashService,
    ViemRPCInteractor,
    bigintToHex,
    type Address,
    type DeploymentAddresses,
    type Hex,
    type RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";
import {
    deriveStealthAddress,
    deriveStealthSharedSecret,
    encodeStealthDepositPayload,
    generateEphemeralKeyPair,
    resolveRecipient,
    type Hex as StealthHex,
    type RecipientIdentifier,
} from "@privacy-pools-v2/evm-sdk/stealth";
import { randomBytes } from "node:crypto";
import { bytesToHex } from "viem";

import type { DustRescueProverConfig, ProveDustRescueDepositJob, ProveDustRescueDepositResult } from "./types.js";

/** Placeholder relayer entry so `PoolSessionBuilder`'s schema validation is satisfied.
 * Never actually invoked: this module only calls `prepareDepositFor`, which needs no
 * relayer round-trip. */
function placeholderRelayer(chainId: number): RelayerInfo {
    return {
        name: "dust-rescue-prover-internal",
        url: "http://localhost",
        chainId,
        chainType: "evm",
        status: "active",
        address: "0x0000000000000000000000000000000000000001",
        processorAddress: "0x0000000000000000000000000000000000000001",
    } as RelayerInfo;
}

function resolveDeployment(
    destinationChainId: number,
    override?: DustRescueProverConfig["deployment"]
): DeploymentAddresses {
    if (override) return override as DeploymentAddresses;
    const preset = DEPLOYMENTS[destinationChainId];
    if (!preset) {
        throw new Error(
            `dust-rescue-prover: destination chain ${destinationChainId} has no known Entrypoint deployment (pass config.deployment explicitly)`
        );
    }
    return preset;
}

/**
 * Inverts the swept (delivered) amount into the note value that, once
 * `Entrypoint.deposit` adds its own live vetting fee back on top, totals no
 * more than what the rescue wallet actually holds. The rescue wallet only
 * ever receives `sweptAmount` — sizing the note at that figure directly
 * (the pre-fix behavior) left every deposit short by exactly the fee,
 * deterministically, since the Entrypoint pulls `value + value*bps/10000`
 * from the sender (finding #8). Flooring both divisions means the result
 * satisfies `noteValue + fee <= sweptAmount` always, never the reverse —
 * same formula and argument `PoolSessionReshieldCrosschain
 * .estimateReshieldCrosschainAmount` already relies on for the same reason.
 *
 * @throws {Error} If the inverted note value falls below the Entrypoint's
 *   configured minimum deposit amount for this asset.
 */
export function computeRescueNoteValue(sweptAmount: bigint, vettingFeeBPS: bigint, minAmount: bigint): bigint {
    const noteValue = (sweptAmount * 10_000n) / (10_000n + vettingFeeBPS);
    if (noteValue < minAmount) {
        throw new Error(
            `dust-rescue-prover: swept amount ${sweptAmount} nets to a note value of ${noteValue} ` +
                `after the ${vettingFeeBPS}bps vetting fee, below the Entrypoint's minimum deposit ${minAmount}`
        );
    }
    return noteValue;
}

/**
 * Computes the rescue deposit proof, derives a fresh stealth address for the
 * recipient, and packs the encrypted note payload into the deposit's own
 * `noteData.data` (`encodeStealthDepositPayload`, `@privacy-pools-v2/evm-sdk/stealth`)
 * — the "Camouflaged dust-rescue delivery" design
 * (`cross_chain_reshield_plan.org`, superseding an earlier
 * `RelaySwaps.rescueDust`/`DustRescued` event that publicly tagged rescue
 * deposits and shrank their anonymity set). The recipient decrypts it via the
 * same ECDH shared secret they independently recompute upon matching the
 * stealth address (`deriveStealthSharedSecret` / `recoverStealthSharedSecret`;
 * the SDK's normal NoteData/viewing-key discovery cannot apply to a stealth
 * identity, since deposit ownership never appears in plaintext on-chain,
 * unlike a withdrawal payout — see `docs/tech-design/sdk/stealth.md` §8).
 * Returns a single, ordinary `Entrypoint.deposit(proof, noteData, aspCiphertext)`
 * call — the exact same call shape any third-party `depositFor` caller
 * already uses, no distinct selector or event — pure compute, no chain-signing
 * key touched here; the caller (the relayer's orchestrator) submits it with
 * its own signer.
 *
 * @throws {Error} If `destinationChainId` has no known deployment and no
 *   `config.deployment` override is supplied, if the swept amount nets to
 *   below the Entrypoint's minimum deposit once its vetting fee is inverted
 *   out (see {@link computeRescueNoteValue}), or if the underlying SDK calls
 *   (ASP fetch, witness/proof generation) fail.
 */
export async function proveDustRescueDeposit(
    job: ProveDustRescueDepositJob,
    config: DustRescueProverConfig
): Promise<ProveDustRescueDepositResult> {
    const deployment = resolveDeployment(job.destinationChainId, config.deployment);

    // Throwaway, read-only interactor just to price the note correctly — mirrors how
    // PoolSessionBuilder/PoolSessionReshieldCrosschain each build their own dedicated
    // EntrypointInteractor per chain rather than sharing one across chains.
    const entrypointInteractor = createEvmEntrypointInteractor({
        rpcInteractor: ViemRPCInteractor.create({ rpcUrl: config.rpcUrl }),
        contractAddress: deployment.entrypointAddress,
    });
    const assetConfig = await entrypointInteractor.getAssetConfig(job.tokenId);
    const noteValue = bigintToHex(
        computeRescueNoteValue(
            BigInt(job.sweptAmount),
            BigInt(assetConfig.vettingFeeBPS),
            BigInt(assetConfig.minAmount)
        )
    );

    // Casts the wire-shaped identifier into the stealth module's own branded type. The
    // two shapes are structurally identical (see types.ts); this is the one boundary
    // point where the cast happens, mirroring `stealth/relayBridge.ts`'s containment
    // pattern for the opposite direction.
    const recipientIdentifier = job.recipientIdentifier as unknown as RecipientIdentifier;
    const metaAddress = resolveRecipient(recipientIdentifier);
    const ephemeral = generateEphemeralKeyPair(metaAddress.scheme);
    const { stealthAddress, announcement } = deriveStealthAddress(metaAddress, ephemeral, metaAddress.scheme);
    const sharedSecret = deriveStealthSharedSecret(metaAddress, ephemeral, metaAddress.scheme);

    // Fresh, throwaway protocol keys for this module's OWN depositor identity —
    // irrelevant to the resulting note's ownership (bound entirely to `noteAddressHash`
    // below, via `prepareDepositFor`'s "blind" cold-start path), so a random keyset per
    // call is fine: nothing here is ever reused for spending, only for building the
    // deposit proof as a sender. Reuses the same primitives PoolSessionBuilder itself
    // uses (CryptoService + PoseidonHashService + NoteComputationService) rather than
    // reimplementing key derivation.
    const cryptoService = new CryptoService();
    const hashService = await PoseidonHashService.create();
    const noteComputationService = new NoteComputationService({ hashService, cryptoService });
    const viewingKeyPair = cryptoService.generateEphemeralKeyPair();
    const protocolKeys = {
        privateNullifyingKey: cryptoService.generateSecret(),
        privateRevocableKey: cryptoService.generateSecret(),
        revocableKeyIndex: "0x0" as Hex,
        viewingPrivateKey: viewingKeyPair.privateKey,
        viewingPublicKey: viewingKeyPair.publicKey,
    };

    const session = await PoolSessionBuilder.create({
        chainId: job.destinationChainId,
        rpcUrl: config.rpcUrl,
        ownerAddress: "0x0000000000000000000000000000000000000001",
        deployment,
        protocolKeys,
        aspUrl: config.aspUrl,
        relayers: [placeholderRelayer(job.destinationChainId)],
        circuitArtifactsDir: config.circuitArtifactsDir,
    });

    // Compute the label before calling prepareDepositFor so the stealth noteData can be
    // built with the correct label and passed in — the PoolVault verifies
    // context == keccak256(abi.encode(noteData)) % SNARK_SCALAR_FIELD, so whatever
    // noteData is submitted on-chain must be exactly what was used to compute the proof's
    // context. Generating depositSecret and label externally (using the same primitives
    // prepareDepositInternal uses) breaks the circular dependency.
    const noteSecret = cryptoService.generateSecret();
    const depositSecret = cryptoService.generateSecret();
    const noteAddressHash = noteComputationService.computeNoteAddressHash(
        stealthAddress as unknown as Address,
        noteSecret
    );
    const precommitment = noteComputationService.computePrecommitment(
        noteAddressHash,
        job.tokenId as Address,
        noteValue
    );
    const label = noteComputationService.computeLabel(precommitment, depositSecret);

    // Build the full note payload (noteSecret + value + tokenId + label) the recipient
    // needs to reconstruct a spendable note, encrypted under the stealth-derived shared
    // secret instead of a viewing key.
    const notePayloadBytes = noteComputationService.encodeNotePayload({
        noteSecret,
        value: noteValue,
        tokenId: job.tokenId,
        label,
    });
    const encryptedNotePayload = cryptoService.encrypt(
        notePayloadBytes,
        bytesToHex(sharedSecret) as unknown as Parameters<typeof cryptoService.encrypt>[1]
    );

    // Pack ephemeral pubkey + view tag + encrypted payload into a single opaque blob —
    // this is what makes the deposit indistinguishable from an ordinary one.
    const stealthPayload = encodeStealthDepositPayload({
        schemeId: announcement.schemeId,
        ephemeralPubKey: announcement.ephemeralPubKey,
        viewTag: announcement.viewTag,
        encryptedNoteSecret: encryptedNotePayload as unknown as StealthHex,
    });

    // Fresh random hint, matching the SDK's own anonymous-discovery convention.
    const hint = `0x${bytesToHex(randomBytes(32)).slice(2)}` as Hex;
    const noteData = { hint, data: stealthPayload as unknown as Hex };

    // Pass both noteData and depositSecret so prepareDepositInternal computes context from
    // the stealth noteData and uses the same depositSecret to derive the same label —
    // otherwise the proof's context and the submitted noteData would diverge and the
    // PoolVault would revert with PoolVault_ProofContextMismatch.
    const depositResult = await session.prepareDepositFor({
        tokenId: job.tokenId,
        value: noteValue,
        noteAddressHash,
        noteData,
        depositSecret,
    });

    return {
        stealthAddress: stealthAddress as unknown as Address,
        noteValue,
        depositCallData: depositResult.depositTx.data,
        depositTarget: depositResult.depositTx.to,
        depositMsgValue: depositResult.depositTx.value,
        approvalTx: depositResult.approvalTx,
        approvalTxs: depositResult.approvalTxs,
    };
}
