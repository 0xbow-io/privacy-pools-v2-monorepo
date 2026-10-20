import { fileURLToPath } from "url";

// The committed proving and verification keys in build/ are the output of the phase-2
// trusted-setup ceremony (see CEREMONY.md). `circomkit setup` replaces them with a fresh
// single-contributor dev setup that the deployed verifiers reject, so it only runs behind
// an explicit opt-in, for circuit development.
export function assertDevKeysAllowed(): void {
  if (process.env.ALLOW_DEV_KEYS === "1") return;
  console.error(
    "Refusing to run circomkit setup: it would overwrite the trusted-setup ceremony keys in build/ " +
      "with single-contributor dev keys that the deployed verifiers reject.\n" +
      "Set ALLOW_DEV_KEYS=1 to generate dev keys for circuit development (see CEREMONY.md).",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assertDevKeysAllowed();
}
