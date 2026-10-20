import { Circomkit } from "circomkit";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { assertDevKeysAllowed } from "./devKeysGuard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CircuitConfig {
  file: string;
  template: string;
  params?: number[];
  pubs: string[];
}

async function main() {
  // it's always the last argument, and total argument count may
  // depend on how is the script invoked
  const command = process.argv[process.argv.length - 1];
  if (!["contract", "setup", "compile", "clear"].includes(command)) {
    console.log("unrecognized command: ", command);
    process.exit(1);
  }
  if (command === "setup") {
    assertDevKeysAllowed();
  }
  const circuitsPath = join(__dirname, "..", "circuits.json");
  const circuits: Record<string, CircuitConfig> = JSON.parse(
    readFileSync(circuitsPath, "utf-8"),
  );

  const circomkit = new Circomkit({
    version: "2.2.3",
    protocol: "groth16",
    prime: "bn128",
    include: ["./node_modules", "./node_modules/circomlib/circuits"],
    inspect: true,
  });

  const circuitNames = Object.keys(circuits);
  console.log(`${command}-ing ${circuitNames.length} circuits...`);

  for (const name of circuitNames) {
    if (command == "compile") {
      const config = circuits[name];
      console.log(`\nCompiling ${name}...`);
      await circomkit.compile(name, config);
      console.log(`  ✓ ${name} compiled`);
    } else {
      console.log(`\n${command}-ing ${name}...`);
      await circomkit[command](name);
      console.log(`  ✓ ${name} ${command} complete`);
    }
  }

  console.log(`\n✓ All ${circuitNames.length} circuits compiled successfully`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("command failed:", e);
    process.exit(1);
  });
