import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICES } from "../src/config/env.js";
import { buildRegistry } from "./spec-to-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECS_DIR = join(HERE, "..", "specs");
const OUT = join(HERE, "..", "registry.generated.json");

async function main() {
  const specs = SERVICES.map((service) => ({
    service,
    raw: JSON.parse(readFileSync(join(SPECS_DIR, `${service}.json`), "utf8")),
  }));
  const registry = await buildRegistry(specs);
  writeFileSync(OUT, JSON.stringify(registry, null, 2));
  console.log(`wrote ${OUT} with ${registry.operations.length} operations`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
