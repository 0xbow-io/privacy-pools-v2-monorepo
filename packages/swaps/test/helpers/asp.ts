import type { IASPDataProvider, PublicKey } from "@privacy-pools-v2/evm-sdk";

/**
 * Dummy X25519 ASP public key (32 bytes) shared by the mainnet smoke-test ASP
 * stand-ins. A deposit must encrypt its screening payload to *some* ASP public
 * key, but the pool never verifies that ciphertext, so a fixed dummy is fine for
 * tests that run without a live ASP service. Single source of truth for both
 * {@link offlineAspDataProvider} and `LocalASPTreeService`.
 */
export const DUMMY_ASP_PUBLIC_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as PublicKey;

/**
 * Inert ASP data provider for suites that only need a deposit to be *built*, not
 * screened. Supplies the dummy public key so the deposit ciphertext can be formed,
 * but every read throws: `getNoteEvents`/`getEventSnapshot` failures make discovery
 * fall back to on-chain RPC (which finds the real deposit), and `getLabelStatus`
 * throwing leaves a freshly-deposited note in its true, pre-screening PENDING state
 * — no "approved" verdict is ever fabricated.
 *
 * Use `LocalASPTreeService` instead when a suite must force approval (e.g. withdraw,
 * reshield, ragequit flows that need ACTIVE notes).
 */
export const offlineAspDataProvider: IASPDataProvider = {
  getASPPublicKey: async () => DUMMY_ASP_PUBLIC_KEY,
  getRoot: async () =>
    Promise.reject(new Error("offline ASP: getRoot unavailable")),
  getLeaves: async () =>
    Promise.reject(new Error("offline ASP: getLeaves unavailable")),
  getLabelStatus: async () =>
    Promise.reject(new Error("offline ASP: getLabelStatus unavailable")),
  getEventSnapshot: async () =>
    Promise.reject(new Error("offline ASP: getEventSnapshot unavailable")),
  getNoteEvents: async () =>
    Promise.reject(new Error("offline ASP: getNoteEvents unavailable")),
};
