import { join } from "node:path";

import {
  ASPClient,
  CryptoService,
  EntrypointInteractor,
  Groth16Prover,
  HTTPClient,
  KeystoreInteractor,
  KeystoreManager,
  LocalCircuitArtifacts,
  MerkleService,
  NoteManager,
  PoolSessionFactory,
  PoolVaultInteractor,
  PoseidonHashService,
  ProofService,
  RelayerInteractor,
  ViemRPCInteractor,
  WitnessPreparationService,
} from "@privacy-pools-v2/evm-sdk";
import type {
  Hash,
  Hex,
  IASPDataProvider,
  IHashService,
  LabelStatus,
} from "@privacy-pools-v2/evm-sdk";
import { sepolia } from "viem/chains";

import type { TestActor, TestContext } from "./types.js";

/**
 * Builds an in-memory ASP data provider backed by the test context's ASP state.
 * Captures `ctx.aspLeaves` and `ctx.aspRoot` by reference at call time.
 */
function buildInMemoryASPProvider(
  aspLeaves: Hash[],
  aspRoot: Hash,
  aspPublicKey: Hex,
): IASPDataProvider {
  return {
    getRoot: async () => aspRoot,
    getLeaves: async () => aspLeaves,
    getLabelStatus: async () => ({ status: "approved" }) as LabelStatus,
    getASPPublicKey: async () => aspPublicKey,
  } satisfies IASPDataProvider;
}

/**
 * Creates a fully-wired PoolSession for a test actor.
 * Uses in-memory ASP data from the test context instead of files/HTTP.
 */
export async function createTestSession(
  actor: TestActor,
  ctx: TestContext,
): Promise<void> {
  const { config } = ctx;

  const rpcInteractor = ViemRPCInteractor.create({
    rpcUrl: config.rpcUrl,
    chain: sepolia,
  });

  const entrypointInteractor = new EntrypointInteractor({
    rpcInteractor,
    contractAddress: config.entrypointAddress,
  });

  const keystoreInteractor = new KeystoreInteractor({
    rpcInteractor,
    contractAddress: config.keystoreAddress,
  });

  const hashService = await PoseidonHashService.create();

  const merkleService = new MerkleService({ hashService });

  const witnessPreparationService = new WitnessPreparationService({
    hashService,
    merkleService,
  });

  const groth16Prover = new Groth16Prover();

  const circuitArtifactsDir = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "packages",
    "circuits",
    "build",
  );
  const circuitArtifacts = new LocalCircuitArtifacts({ baseDir: circuitArtifactsDir });

  const proofService = new ProofService({
    circuitArtifacts,
    groth16Prover,
  });

  const cryptoService = new CryptoService();
  const noteManager = new NoteManager({});

  const keystoreManager = new KeystoreManager({
    privateNullifyingKey: actor.privateNullifyingKey,
    privateRevocableKey: actor.privateRevocableKey,
    viewingPrivateKey: actor.viewingPrivateKey,
    viewingPublicKey: actor.viewingPublicKey,
  });

  const poolVaultInteractor = new PoolVaultInteractor({
    rpcInteractor,
    contractAddress: config.poolAddress,
  });

  // Snapshot ASP state at session creation time
  const aspLeaves = [...ctx.aspLeaves];
  const aspRoot = ctx.aspRoot;

  const aspDataProvider = buildInMemoryASPProvider(
    aspLeaves,
    aspRoot,
    config.aspPublicKey,
  );

  const aspClient = new ASPClient({
    providers: [aspDataProvider],
    merkleService,
    publicKey: config.aspPublicKey,
  });

  const httpClient = new HTTPClient();
  const relayerInteractor = new RelayerInteractor({
    relayers: [
      {
        name: "0xBow Relayer",
        url: config.relayerUrl,
        address: config.relayerAddress,
        processorAddress: config.relayerProcessorAddress,
        chainId: config.chainId,
        chainType: "evm",
        status: "active",
      },
    ],
    httpClient,
  });

  const poolSession = PoolSessionFactory.create({
    ownerAddress: actor.address,
    chainId: config.chainId,
    poolAddress: config.poolAddress,
    cryptoService,
    witnessPreparationService,
    proofService,
    entrypointInteractor,
    noteManager,
    keystoreManager,
    keystoreInteractor,
    hashService,
    poolVaultInteractor,
    aspClient,
    relayerInteractor,
    rpcInteractor,
  });

  // Attach services to the actor
  actor.poolSession = poolSession;
  actor.rpcInteractor = rpcInteractor;
  actor.hashService = hashService;
  actor.cryptoService = cryptoService;
  actor.poolVaultInteractor = poolVaultInteractor;

  console.log(`  [${actor.name}] Session created`);
}

/**
 * Recreates the actor's PoolSession with the current ASP state.
 * Preserves the actor's account export (note state) across the refresh.
 */
export async function refreshSession(
  actor: TestActor,
  ctx: TestContext,
): Promise<void> {
  // Save current account state
  const savedExport = actor.accountExport ?? actor.poolSession.exportAccount();

  await createTestSession(actor, ctx);

  // Re-import the saved state into the new session
  actor.poolSession.importAccount(savedExport);
  actor.accountExport = savedExport;

  console.log(`  [${actor.name}] Session refreshed with updated ASP state`);
}
